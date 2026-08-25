import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AppSettings, SymbolFilters, Trade, TradeSetup, TradingMode } from '../../core/types.ts';
import {
  computeSizing,
  formatPrice,
  formatQuantity,
  round,
  validateOrder,
} from '../../core/risk/index.ts';
import type { SizingResult } from '../../core/risk/index.ts';
import { netRiskReward } from '../../core/risk/costs.ts';
import { sanitizeTargets } from '../../core/risk/stops.ts';
import { config, environmentForMode, readCredentials } from '../config.ts';
import type { EventBus } from '../events.ts';
import { logger } from '../logger.ts';
import type { Repository } from '../store/index.ts';
import {
  BinanceError,
  getAccountBalances,
  getActiveEnvironment,
  getSymbolFilters,
  getUsdtBrlRate,
  newOtocoOrder,
  testOrder,
} from '../binance/rest.ts';
import type { AuditService } from './auditService.ts';
import type { MarketDataService } from './marketDataService.ts';
import { paperBalance, type PaperTradingEngine } from './paperTradingEngine.ts';
import type { RiskService } from './riskService.ts';
import type { SettingsService } from './settingsService.ts';

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/** Injetáveis para teste: em produção falam com a Binance de verdade. */
export interface ExecutionDependencies {
  loadFilters: (symbol: string) => Promise<SymbolFilters | null>;
  loadUsdtBalance: () => Promise<{ free: number; locked: number }>;
  loadBrlRate: () => Promise<number | null>;
}

const defaultDependencies: ExecutionDependencies = {
  loadFilters: async (symbol) => (await getSymbolFilters([symbol])).get(symbol) ?? null,
  loadUsdtBalance: async () => {
    const balances = await getAccountBalances();
    const usdt = balances.find((item) => item.asset === 'USDT');
    return { free: usdt?.free ?? 0, locked: usdt?.locked ?? 0 };
  },
  loadBrlRate: getUsdtBrlRate,
};

export class ExecutionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ExecutionError';
    this.status = status;
  }
}

export interface PreviewRequest {
  setupId: string;
  quoteAmount?: number;
  percentOfCapital?: number;
}

export interface CapitalView {
  capital: number;
  available: number;
  source: string;
  currency: 'USDT';
  brlRate: number | null;
}

export interface PreviewResult {
  setup: TradeSetup;
  mode: TradingMode;
  entryPrice: number;
  currentPrice: number;
  capital: number;
  available: number;
  brlRate: number | null;
  sizing: SizingResult;
  filters: SymbolFilters | null;
  filterErrors: string[];
  blockers: string[];
  warnings: string[];
  /** R/R já descontadas corretagem e escorregamento — é este que decide */
  netRiskReward: number;
  canExecute: boolean;
  /** só com este token o servidor aceita criar a ordem */
  confirmationToken: string | null;
  expiresAt: string | null;
}

export interface ExecuteRequest {
  setupId: string;
  confirmationToken: string;
  idempotencyKey: string;
}

/** Conteúdo assinado do token: é exatamente o que o usuário viu na tela. */
interface ConfirmationPayload {
  setupId: string;
  quantity: number;
  entryPrice: number;
  quoteAmount: number;
  stopLoss: number;
  target1: number;
  mode: TradingMode;
  expiresAt: number;
  automatic: boolean;
}

/**
 * Único caminho por onde uma ordem pode nascer.
 *
 * Duas invariantes que o resto do sistema depende:
 *  1. Ordem em conta REAL só sai com token assinado a partir de um preview que
 *     o usuário confirmou. Nenhum cron, alerta ou robô chega aqui.
 *  2. A compra automática existe apenas para PAPER e TESTNET — o modo LIVE é
 *     recusado explicitamente, não por configuração.
 */
export class ExecutionService {
  private readonly repository: Repository;
  private readonly settings: SettingsService;
  private readonly market: MarketDataService;
  private readonly paper: PaperTradingEngine;
  private readonly audit: AuditService;
  private readonly bus: EventBus;
  private readonly risk: RiskService;
  private readonly dependencies: ExecutionDependencies;
  private readonly inFlight = new Map<string, Promise<Trade>>();
  /** avisado quando o robô compra — o scanner tira o setup do radar */
  private onBought: ((setup: TradeSetup) => Promise<unknown>) | null = null;

  constructor(
    repository: Repository,
    settings: SettingsService,
    market: MarketDataService,
    paper: PaperTradingEngine,
    audit: AuditService,
    bus: EventBus,
    risk: RiskService,
    dependencies: ExecutionDependencies = defaultDependencies,
  ) {
    this.repository = repository;
    this.settings = settings;
    this.market = market;
    this.paper = paper;
    this.audit = audit;
    this.bus = bus;
    this.risk = risk;
    this.dependencies = dependencies;
  }

  setOnBought(handler: (setup: TradeSetup) => Promise<unknown>): void {
    this.onBought = handler;
  }

  /** Capital sempre em USDT — o valor em reais é só apresentação. */
  async getCapital(): Promise<CapitalView> {
    const settings = this.settings.get();
    const brlRate = await this.dependencies.loadBrlRate();

    if (settings.mode === 'PAPER') {
      const trades = await this.repository.listTrades();
      const base = this.paperCapitalInUsdt(settings.risk.paperCapital, settings.risk.paperCapitalCurrency, brlRate);
      const balance = paperBalance(trades, base);
      return {
        capital: balance.capital,
        available: balance.available,
        source: 'PAPER',
        currency: 'USDT',
        brlRate,
      };
    }

    const usdt = await this.dependencies.loadUsdtBalance();
    return {
      capital: round(usdt.free + usdt.locked, 2),
      available: round(usdt.free, 2),
      source: environmentForMode(settings.mode).name === 'testnet' ? 'BINANCE_TESTNET' : 'BINANCE',
      currency: 'USDT',
      brlRate,
    };
  }

  private paperCapitalInUsdt(
    amount: number,
    currency: 'USDT' | 'BRL',
    brlRate: number | null,
  ): number {
    if (currency === 'USDT') return amount;
    if (!brlRate || brlRate <= 0) return amount; // sem cotação, não inventa conversão
    return round(amount / brlRate, 2);
  }

  /** Passo 1 do fluxo de compra: mostra a conta exata antes de qualquer ordem. */
  async preview(request: PreviewRequest, setup: TradeSetup, automatic = false): Promise<PreviewResult> {
    const settings = this.settings.get();
    const mode = settings.mode;
    const currentPrice = this.market.getPrice(setup.symbol) ?? setup.currentPrice;
    const entryPrice = clampToZone(currentPrice, setup);

    const capitalView = await this.getCapital();
    const requested =
      request.quoteAmount ??
      (request.percentOfCapital
        ? round((capitalView.available * request.percentOfCapital) / 100, 2)
        : 0);

    // R/R líquido: é ele que decide se a operação vale, não o bruto da tela
    const netRR = netRiskReward({
      entryPrice,
      stopLoss: setup.stopLoss,
      target: setup.target1,
      costs: settings.guard,
    });

    const snapshot = await this.risk.snapshot(capitalView.capital);
    const openTrades = this.paper.getOpenTrades();
    const firstGate = this.risk.gate({
      snapshot,
      symbol: setup.symbol,
      quoteAmount: requested,
      netRiskReward: netRR,
      openTrades,
    });

    // mercado nervoso não bloqueia a compra, encolhe a compra
    const quoteAmount =
      firstGate.sizeFactor < 1 ? round(requested * firstGate.sizeFactor, 2) : requested;
    const gate =
      firstGate.sizeFactor < 1
        ? this.risk.gate({
            snapshot,
            symbol: setup.symbol,
            quoteAmount,
            netRiskReward: netRR,
            openTrades,
          })
        : firstGate;

    const sizing = computeSizing(
      { setup, quoteAmount, entryPrice, capital: capitalView.capital },
      settings.risk,
    );

    let filters: SymbolFilters | null = null;
    const filterErrors: string[] = [];
    try {
      filters = await this.dependencies.loadFilters(setup.symbol);
      if (filters) {
        const validation = validateOrder(filters, sizing.quantity, entryPrice);
        filterErrors.push(...validation.errors);
        if (validation.valid) sizing.quantity = validation.quantity;
      }
    } catch (error) {
      filterErrors.push(`Não foi possível validar os filtros da Binance: ${(error as Error).message}`);
    }

    const blockers = [
      ...(await this.collectBlockers({
        setup,
        mode,
        quoteAmount,
        available: capitalView.available,
        capital: capitalView.capital,
        sizingBlockers: sizing.blockReasons,
      })),
      ...gate.blockers,
    ];

    const warnings = [...sizing.warnings, ...gate.warnings];
    if (setup.extended) {
      warnings.push('Setup marcado como ESTICADO — o preço já se afastou do ponto de invalidação');
    }

    const canExecute = blockers.length === 0 && filterErrors.length === 0 && sizing.quantity > 0;
    const expiresAt = canExecute ? Date.now() + CONFIRMATION_TTL_MS : null;

    return {
      setup,
      mode,
      entryPrice,
      currentPrice,
      capital: capitalView.capital,
      available: capitalView.available,
      brlRate: capitalView.brlRate,
      sizing,
      filters,
      filterErrors,
      blockers,
      warnings,
      netRiskReward: netRR,
      canExecute,
      confirmationToken: expiresAt
        ? this.signConfirmation({
            setupId: setup.id,
            quantity: sizing.quantity,
            entryPrice,
            quoteAmount: round(sizing.quantity * entryPrice, 2),
            stopLoss: setup.stopLoss,
            target1: setup.target1,
            mode,
            expiresAt,
            automatic,
          })
        : null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    };
  }

  private async collectBlockers(input: {
    setup: TradeSetup;
    mode: TradingMode;
    quoteAmount: number;
    available: number;
    capital: number;
    sizingBlockers: string[];
  }): Promise<string[]> {
    const { setup, mode, quoteAmount, available, capital } = input;
    const settings = this.settings.get();
    const blockers = [...input.sizingBlockers];

    if (quoteAmount > available) {
      blockers.push(`Saldo insuficiente: disponível ${available.toFixed(2)} USDT`);
    }
    if (setup.status === 'INVALIDATED' || setup.status === 'EXPIRED') {
      blockers.push('Este setup não está mais válido');
    }

    const openTrades = this.paper.getOpenTrades().filter((trade) => trade.mode === mode);
    if (openTrades.length >= settings.risk.maxOpenTrades) {
      blockers.push(`Limite de ${settings.risk.maxOpenTrades} operações abertas atingido`);
    }
    if (openTrades.some((trade) => trade.setupId === setup.id)) {
      blockers.push('Já existe uma operação aberta para este setup');
    }

    const dailyLoss = await this.dailyLoss(mode);
    const dailyLimit = capital * (settings.risk.dailyLossLimitPercent / 100);
    if (dailyLoss < 0 && Math.abs(dailyLoss) >= dailyLimit) {
      blockers.push(
        `Limite de perda diária atingido (${dailyLoss.toFixed(2)} de ${dailyLimit.toFixed(2)})`,
      );
    }

    if (mode !== 'PAPER') {
      const environment = environmentForMode(mode);
      if (!environment.hasCredentials) {
        blockers.push(
          mode === 'LIVE'
            ? 'Configure BINANCE_API_KEY e BINANCE_API_SECRET no servidor para operar em conta real'
            : 'Configure BINANCE_TESTNET_API_KEY e BINANCE_TESTNET_API_SECRET para usar o testnet',
        );
      }
      if (getActiveEnvironment().name !== environment.name) {
        blockers.push('O ambiente da Binance ainda está trocando — tente de novo em instantes');
      }
    }
    return blockers;
  }

  /** Passo 2: só executa com o token da confirmação que o usuário aprovou. */
  async execute(request: ExecuteRequest, setup: TradeSetup): Promise<Trade> {
    const existing = this.inFlight.get(request.idempotencyKey);
    if (existing) return existing;

    const promise = this.runExecution(request, setup);
    this.inFlight.set(request.idempotencyKey, promise);
    try {
      return await promise;
    } finally {
      setTimeout(() => this.inFlight.delete(request.idempotencyKey), 60_000).unref?.();
    }
  }

  /**
   * Compra automática.
   *
   * Em PAPER e TESTNET o robô age livre. Em conta real precisa das DUAS
   * chaves giradas: a variável do servidor e o armar do painel, que expira
   * sozinho. Trava só na interface é trava que um clique desfaz; trava só no
   * servidor é trava que ninguém consegue conferir na hora.
   */
  async executeAutomatic(setup: TradeSetup): Promise<Trade | null> {
    const settings = this.settings.get();
    if (!settings.autoTrade.enabled) return null;

    // nunca empilha: mesmo setup ou mesmo ativo já em carteira encerra aqui
    const alreadyOpen = this.paper
      .getOpenTrades()
      .some((trade) => trade.setupId === setup.id || trade.symbol === setup.symbol);
    if (alreadyOpen) return null;

    if (settings.mode === 'LIVE') {
      const denial = liveAutoTradeDenial(settings);
      if (denial !== null) {
        await this.audit.record({
          action: 'AUTO_TRADE_BLOCKED_LIVE',
          mode: settings.mode,
          symbol: setup.symbol,
          setupId: setup.id,
          detail: { motivo: denial },
        });
        return null;
      }
    }

    // teto absoluto por ordem: o percentual do capital pode crescer sozinho
    // quando a carteira cresce; este número não
    const capitalView = await this.getCapital();
    const desired = round((capitalView.available * settings.autoTrade.percentOfCapital) / 100, 2);
    const quoteAmount = Math.min(desired, settings.autoTrade.maxNotionalPerTrade);

    const preview = await this.preview({ setupId: setup.id, quoteAmount }, setup, true);
    if (!preview.canExecute || !preview.confirmationToken) {
      await this.audit.record({
        action: 'AUTO_TRADE_SKIPPED',
        mode: settings.mode,
        symbol: setup.symbol,
        setupId: setup.id,
        detail: { blockers: preview.blockers, filterErrors: preview.filterErrors },
      });
      return null;
    }

    const trade = await this.execute(
      {
        setupId: setup.id,
        confirmationToken: preview.confirmationToken,
        idempotencyKey: `auto${setup.id.replace(/-/g, '').slice(0, 20)}`,
      },
      setup,
    );

    await this.audit.record({
      action: 'AUTO_TRADE_EXECUTED',
      mode: settings.mode,
      symbol: setup.symbol,
      setupId: setup.id,
      tradeId: trade.id,
      detail: {
        score: setup.score,
        riskRewardLiquido: preview.netRiskReward,
        quantidade: trade.requestedQuantity,
        valor: trade.notional,
      },
    });
    // o setup precisa sair do radar aqui também, senão ele expira sozinho mais
    // tarde e cancela a ordem que o próprio robô acabou de abrir
    if (this.onBought) await this.onBought(setup);
    return trade;
  }

  private async runExecution(request: ExecuteRequest, setup: TradeSetup): Promise<Trade> {
    const settings = this.settings.get();
    const mode = settings.mode;
    const clientOrderId = buildClientOrderId(request.idempotencyKey);

    // clique duplo: a operação já existe, devolve a mesma em vez de duplicar
    const trades = await this.repository.listTrades();
    const duplicate = trades.find(
      (trade) => trade.mode === mode && trade.clientOrderId === clientOrderId,
    );
    if (duplicate) {
      await this.audit.record({
        action: 'ORDER_DUPLICATE_IGNORED',
        mode,
        symbol: setup.symbol,
        setupId: setup.id,
        tradeId: duplicate.id,
        detail: { clientOrderId },
      });
      return duplicate;
    }

    const payload = this.verifyConfirmation(request.confirmationToken);
    if (payload.setupId !== setup.id) {
      throw new ExecutionError('A confirmação é de outro setup');
    }
    if (payload.mode !== mode) {
      throw new ExecutionError('O modo de operação mudou depois da confirmação — refaça');
    }
    if (payload.stopLoss !== setup.stopLoss || payload.target1 !== setup.target1) {
      throw new ExecutionError('O plano do setup mudou depois da confirmação — refaça');
    }

    const capitalView = await this.getCapital();
    const blockers = await this.collectBlockers({
      setup,
      mode,
      quoteAmount: payload.quoteAmount,
      available: capitalView.available,
      capital: capitalView.capital,
      sizingBlockers: [],
    });
    if (blockers.length > 0) throw new ExecutionError(blockers[0] as string);

    const filters = await this.dependencies.loadFilters(setup.symbol);
    if (filters) {
      const validation = validateOrder(filters, payload.quantity, payload.entryPrice);
      if (!validation.valid) throw new ExecutionError(validation.errors[0] as string);
    }

    await this.audit.record({
      action: payload.automatic ? 'AUTO_ORDER_CONFIRMED' : 'ORDER_CONFIRMED',
      mode,
      symbol: setup.symbol,
      setupId: setup.id,
      detail: {
        quantity: payload.quantity,
        entryPrice: payload.entryPrice,
        stopLoss: setup.stopLoss,
        target1: setup.target1,
        quoteAmount: payload.quoteAmount,
      },
    });

    // alvo que o mercado não entrega é o mesmo que não ter alvo: a parcela
    // ficaria pendurada para sempre. Descartado aqui, quem manda passa a ser
    // o stop que sobe.
    const targets = sanitizeTargets({
      entryPrice: payload.entryPrice,
      target1: setup.target1,
      target2: setup.target2,
      target3: setup.target3,
      maxTargetPercent: settings.guard.maxTargetPercent,
    });
    if (targets.dropped.length > 0) {
      await this.audit.record({
        action: 'TARGETS_SANITIZED',
        mode,
        symbol: setup.symbol,
        setupId: setup.id,
        detail: { descartados: targets.dropped, teto: `${settings.guard.maxTargetPercent}%` },
      });
    }

    const now = new Date().toISOString();
    const trade: Trade = {
      id: randomUUID(),
      setupId: setup.id,
      automatic: payload.automatic,
      symbol: setup.symbol,
      mode,
      side: 'BUY',
      setupType: setup.setupType,
      timeframe: setup.timeframe,
      score: setup.score,
      status: 'PENDING',
      outcome: 'OPEN',
      requestedQuantity: payload.quantity,
      filledQuantity: 0,
      remainingQuantity: 0,
      entryPrice: payload.entryPrice,
      averageFillPrice: null,
      stopLoss: setup.stopLoss,
      target1: targets.target1,
      target2: targets.target2,
      target3: targets.target3,
      notional: payload.quoteAmount,
      riskAmount: round(payload.quantity * Math.max(payload.entryPrice - setup.stopLoss, 0), 2),
      realizedPnl: 0,
      realizedPnlPercent: 0,
      maxFavorablePercent: 0,
      maxAdversePercent: 0,
      feesPaid: 0,
      highWaterPrice: null,
      protectiveStop: null,
      closeReason: null,
      fills: [],
      exchangeOrderIds: [],
      clientOrderId,
      openedAt: now,
      closedAt: null,
      updatedAt: now,
    };

    if (mode === 'PAPER') {
      await this.repository.saveTrade(trade);
      this.paper.track(trade);
      this.bus.broadcast({ type: 'trade', payload: trade });
      await this.audit.record({
        action: 'PAPER_TRADE_CREATED',
        mode,
        symbol: setup.symbol,
        setupId: setup.id,
        tradeId: trade.id,
        detail: { quantity: trade.requestedQuantity, entryPrice: trade.entryPrice },
      });
      // se o preço já está na zona, a ordem preenche na hora
      const price = this.market.getPrice(setup.symbol);
      if (price !== null) await this.paper.onPrice(setup.symbol, price);
      return this.paper.getOpenTrades().find((item) => item.id === trade.id) ?? trade;
    }

    return this.sendToBinance(trade, setup, filters);
  }

  private async sendToBinance(
    trade: Trade,
    setup: TradeSetup,
    filters: SymbolFilters | null,
  ): Promise<Trade> {
    if (!filters) throw new ExecutionError('Filtros do par indisponíveis — ordem não enviada', 503);
    if (!readCredentials(environmentForMode(trade.mode).name)) {
      throw new ExecutionError('Credenciais não configuradas para este modo', 401);
    }

    const quantity = formatQuantity(trade.requestedQuantity, filters);
    const entry = formatPrice(trade.entryPrice, filters);
    const takeProfit = formatPrice(trade.target1, filters);
    const stopTrigger = formatPrice(trade.stopLoss, filters);
    // preço limite do stop um tick abaixo do gatilho: reduz o risco de a ordem
    // ficar parada no livro quando o mercado desce rápido
    const stopLimit = formatPrice(trade.stopLoss - filters.tickSize, filters);

    try {
      await testOrder({
        symbol: trade.symbol,
        side: 'BUY',
        type: 'LIMIT',
        timeInForce: 'GTC',
        quantity,
        price: entry,
        newClientOrderId: `${trade.clientOrderId}t`,
      });

      const result = await newOtocoOrder({
        symbol: trade.symbol,
        listClientOrderId: trade.clientOrderId,
        workingQuantity: quantity,
        workingPrice: entry,
        pendingQuantity: quantity,
        takeProfitPrice: takeProfit,
        stopPrice: stopTrigger,
        stopLimitPrice: stopLimit,
      });

      trade.exchangeOrderIds = result.orders.map((order) => String(order.orderId));
      trade.updatedAt = new Date().toISOString();
      await this.repository.saveTrade(trade);
      this.paper.track(trade);
      this.bus.broadcast({ type: 'trade', payload: trade });

      await this.audit.record({
        action: 'ORDER_SENT',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: setup.id,
        tradeId: trade.id,
        detail: {
          orderListId: result.orderListId,
          listStatus: result.listOrderStatus,
          orders: trade.exchangeOrderIds,
        },
      });
      return trade;
    } catch (error) {
      const message =
        error instanceof BinanceError
          ? `Binance recusou a ordem: ${error.message} (código ${error.code})`
          : (error as Error).message;
      await this.audit.record({
        action: 'ORDER_FAILED',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: setup.id,
        tradeId: trade.id,
        detail: { message },
      });
      logger.error('Falha ao enviar ordem', { symbol: trade.symbol, message });
      throw new ExecutionError(message, 502);
    }
  }

  private async dailyLoss(mode: TradingMode): Promise<number> {
    const trades = await this.repository.listTrades();
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    return trades
      .filter(
        (trade) => trade.mode === mode && trade.closedAt && new Date(trade.closedAt) >= start,
      )
      .reduce((acc, trade) => acc + trade.realizedPnl, 0);
  }

  private signConfirmation(payload: ConfirmationPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', config.appSecret).update(body).digest('hex');
    return `${body}.${signature}`;
  }

  private verifyConfirmation(token: string): ConfirmationPayload {
    const [body, signature] = token.split('.');
    if (!body || !signature) throw new ExecutionError('Confirmação inválida — refaça a operação');

    const expected = createHmac('sha256', config.appSecret).update(body).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ExecutionError('Os valores da confirmação não conferem com o que foi aprovado');
    }

    let payload: ConfirmationPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ConfirmationPayload;
    } catch {
      throw new ExecutionError('Confirmação ilegível — refaça a operação');
    }
    if (Date.now() > payload.expiresAt) {
      throw new ExecutionError('A confirmação expirou — os preços mudaram, refaça a operação');
    }
    return payload;
  }
}

/**
 * Por que o robô não pode comprar na conta real agora. null = pode.
 * Ordem proposital: a trava do servidor é a primeira, porque é a única que a
 * interface não consegue desfazer sozinha.
 */
export function liveAutoTradeDenial(settings: AppSettings): string | null {
  if (!config.allowLiveAutoTrade) {
    return 'ALLOW_LIVE_AUTOTRADE não está ligado no .env do servidor';
  }
  if (!settings.autoTrade.allowLive) {
    return 'a compra automática em conta real não foi liberada nos ajustes';
  }
  const armedUntil = settings.autoTrade.liveArmedUntil;
  if (armedUntil === null) return 'o robô não está armado para a conta real';
  if (new Date(armedUntil).getTime() <= Date.now()) {
    return `o armamento da conta real venceu em ${armedUntil}`;
  }
  return null;
}

/** A entrada nunca sai da zona aprovada, mesmo com o preço correndo. */
function clampToZone(price: number, setup: TradeSetup): number {
  if (price < setup.entryLow) return setup.entryLow;
  if (price > setup.entryHigh) return setup.entryHigh;
  return price;
}

export function buildClientOrderId(idempotencyKey: string): string {
  const safe = idempotencyKey.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return `csh${safe}`.slice(0, 36);
}
