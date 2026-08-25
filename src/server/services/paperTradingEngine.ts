import type { AppSettings, Trade, TradeFill } from '../../core/types.ts';
import { buildExitPlan, NO_FILTERS, SCALE_OUT } from '../../core/execution/exitPlan.ts';
import { migrateTrade } from '../../core/execution/tradeMigration.ts';
import { round } from '../../core/risk/index.ts';
import { feeFor, netPnl, roundTripFee, stopFillPrice, marketExitPrice } from '../../core/risk/costs.ts';
import { nextProtectiveStop } from '../../core/risk/stops.ts';
import type { EventBus } from '../events.ts';
import { logger } from '../logger.ts';
import type { Repository } from '../store/index.ts';
import type { AuditService } from './auditService.ts';
import type { SettingsService } from './settingsService.ts';

export { SCALE_OUT };

export interface PaperBalance {
  capital: number;
  available: number;
  invested: number;
  realizedPnl: number;
}

/**
 * Simulador de execução — e a régua com que o resto do sistema é julgado.
 *
 * Ele só serve para alguma coisa se for pessimista: cobra corretagem nas duas
 * pontas, faz o stop preencher abaixo do gatilho e nunca deixa a entrada
 * preencher melhor que o preço combinado. Um simulador otimista aprova
 * estratégia que o mercado reprova, e a conta descobre isso com dinheiro.
 */
export class PaperTradingEngine {
  private readonly repository: Repository;
  private readonly bus: EventBus;
  private readonly audit: AuditService;
  private readonly settings: SettingsService;
  private open = new Map<string, Trade>();
  /** avisado sempre que uma operação encerra — alimenta o diário de decisões */
  private onClosed: ((trade: Trade) => Promise<unknown>) | null = null;

  constructor(
    repository: Repository,
    bus: EventBus,
    audit: AuditService,
    settings: SettingsService,
  ) {
    this.repository = repository;
    this.bus = bus;
    this.audit = audit;
    this.settings = settings;
  }

  setOnClosed(handler: (trade: Trade) => Promise<unknown>): void {
    this.onClosed = handler;
  }

  async load(): Promise<void> {
    const trades = await this.repository.listTrades();
    for (const raw of trades) {
      // operação gravada por uma versão anterior pode não ter os campos novos;
      // sem normalizar, o primeiro cálculo com ela vira NaN em silêncio
      const trade = migrateTrade(raw);
      if (trade.status === 'PENDING' || trade.status === 'OPEN') this.open.set(trade.id, trade);
    }
  }

  getOpenTrades(): Trade[] {
    return [...this.open.values()];
  }

  getTrade(id: string): Trade | null {
    return this.open.get(id) ?? null;
  }

  track(trade: Trade): void {
    if (trade.status === 'PENDING' || trade.status === 'OPEN') this.open.set(trade.id, trade);
    else this.open.delete(trade.id);
  }

  private guard(): AppSettings['guard'] {
    return this.settings.get().guard;
  }

  /** Cancela a ordem pendente quando o setup morre antes de acionar. */
  async cancelPending(setupId: string, reason: string): Promise<void> {
    for (const trade of this.open.values()) {
      if (trade.setupId !== setupId || trade.status !== 'PENDING') continue;
      trade.status = 'CANCELLED';
      trade.outcome = 'MANUAL';
      trade.closeReason = reason;
      trade.closedAt = new Date().toISOString();
      trade.updatedAt = trade.closedAt;
      await this.persist(trade);
      await this.audit.record({
        action: 'PAPER_TRADE_CANCELLED',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: trade.setupId,
        tradeId: trade.id,
        detail: { reason },
      });
    }
  }

  async onPrice(symbol: string, price: number): Promise<void> {
    for (const trade of this.open.values()) {
      if (trade.symbol !== symbol || trade.mode !== 'PAPER') continue;
      await this.step(trade, price);
    }
  }

  /**
   * Encerramento a mercado — o botão "encerrar agora" da tela e o pânico.
   * Sai pelo preço de mercado com escorregamento e paga a taxa, como sairia
   * de verdade.
   */
  async closeAtMarket(trade: Trade, price: number, reason: string): Promise<Trade> {
    const costs = this.guard();
    if (trade.status === 'PENDING') {
      trade.status = 'CANCELLED';
      trade.outcome = 'MANUAL';
      trade.closeReason = reason;
      trade.closedAt = new Date().toISOString();
      await this.persist(trade);
      await this.audit.record({
        action: 'PAPER_TRADE_CANCELLED',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: trade.setupId,
        tradeId: trade.id,
        detail: { reason },
      });
      return trade;
    }

    if (trade.status !== 'OPEN' || trade.remainingQuantity <= 0) return trade;

    const exitPrice = marketExitPrice(price, costs);
    this.closePortion(trade, 'MANUAL', exitPrice, trade.remainingQuantity);
    trade.outcome = 'MANUAL';
    trade.closeReason = reason;
    trade.status = 'CLOSED';
    trade.remainingQuantity = 0;
    trade.closedAt = new Date().toISOString();
    await this.persist(trade);
    await this.audit.record({
      action: 'PAPER_TRADE_CLOSED_MANUALLY',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: { reason, exitPrice, pnl: trade.realizedPnl },
    });
    if (this.onClosed) await this.onClosed(trade);
    return trade;
  }

  private async step(trade: Trade, price: number): Promise<void> {
    const costs = this.guard();
    let changed = false;

    if (trade.status === 'PENDING') {
      if (price > trade.entryPrice) return;
      // ordem limitada preenche no preço combinado, nunca melhor: assumir
      // preenchimento no fundo do pavio é o otimismo que quebra o backtest
      const fillPrice = trade.entryPrice;
      trade.status = 'OPEN';
      trade.filledQuantity = trade.requestedQuantity;
      trade.remainingQuantity = trade.requestedQuantity;
      trade.averageFillPrice = fillPrice;
      trade.notional = round(fillPrice * trade.requestedQuantity, 2);
      trade.feesPaid = round(feeFor(fillPrice, trade.requestedQuantity, costs.feePercent), 6);
      trade.highWaterPrice = fillPrice;
      trade.fills.push(fill('ENTRY', fillPrice, trade.requestedQuantity));
      changed = true;
      await this.audit.record({
        action: 'PAPER_TRADE_FILLED',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: trade.setupId,
        tradeId: trade.id,
        detail: { fillPrice, quantity: trade.requestedQuantity, taxa: trade.feesPaid },
      });
    }

    const entry = trade.averageFillPrice ?? trade.entryPrice;
    if (entry <= 0) return;

    if (trade.highWaterPrice === null || price > trade.highWaterPrice) {
      trade.highWaterPrice = price;
      changed = true;
    }

    const excursion = ((price - entry) / entry) * 100;
    if (excursion > trade.maxFavorablePercent) {
      trade.maxFavorablePercent = round(excursion, 2);
      changed = true;
    }
    if (excursion < trade.maxAdversePercent) {
      trade.maxAdversePercent = round(excursion, 2);
      changed = true;
    }

    // proteção antes de qualquer saída: o stop que subiu pode ser o que executa
    if (await this.moveProtectiveStop(trade, price)) changed = true;

    if (price <= trade.stopLoss && trade.remainingQuantity > 0) {
      const exitPrice = stopFillPrice(trade.stopLoss, costs);
      const hadTarget = trade.fills.some((item) => item.kind.startsWith('TARGET'));
      this.closePortion(trade, 'STOP', exitPrice, trade.remainingQuantity);
      trade.outcome = 'STOP';
      trade.closeReason =
        trade.protectiveStop !== null
          ? hadTarget
            ? 'stop de proteção depois do alvo 1'
            : 'stop que acompanhava o preço'
          : 'stop original';
      changed = true;
    } else {
      // o mesmo plano de saída que a conta real executa — uma fonte só
      const plan = buildExitPlan({
        quantity: trade.filledQuantity,
        target1: trade.target1,
        target2: trade.target2,
        target3: trade.target3,
        shares: SCALE_OUT,
        filters: NO_FILTERS,
      });
      const last = plan.tranches[plan.tranches.length - 1];
      for (const tranche of plan.tranches) {
        if (price < tranche.price) continue;
        if (trade.fills.some((item) => item.kind === tranche.kind)) continue;
        const quantity =
          tranche === last
            ? trade.remainingQuantity
            : Math.min(tranche.quantity, trade.remainingQuantity);
        if (quantity <= 0) continue;
        this.closePortion(trade, tranche.kind, tranche.price, quantity);
        trade.outcome = tranche.kind as Trade['outcome'];
        changed = true;
      }
    }

    // segunda passada: o alvo 1 pode ter preenchido agora mesmo, e é esse
    // preenchimento que autoriza levar o stop para o empate. Sem isto a
    // proteção só entraria no próximo tique — tempo em que o preço volta.
    if (trade.remainingQuantity > 1e-10 && trade.status === 'OPEN') {
      if (await this.moveProtectiveStop(trade, price)) changed = true;
    }

    // saída temporal: tese que não andou no prazo devolve o capital para a
    // próxima. Só vale antes do alvo 1 — depois dele quem manda é o stop que
    // já subiu, e cortar uma operação que está ganhando é o erro oposto.
    if (
      costs.timeStopHours > 0 &&
      trade.status === 'OPEN' &&
      trade.remainingQuantity > 1e-10 &&
      !trade.fills.some((item) => item.kind.startsWith('TARGET'))
    ) {
      const openFor = Date.now() - new Date(trade.openedAt).getTime();
      if (openFor >= costs.timeStopHours * 3_600_000) {
        this.closePortion(trade, 'MANUAL', marketExitPrice(price, costs), trade.remainingQuantity);
        trade.outcome = 'MANUAL';
        trade.closeReason = `Saída temporal: ${costs.timeStopHours}h sem alcançar o alvo 1`;
        changed = true;
      }
    }

    if (trade.remainingQuantity <= 1e-10 && trade.status === 'OPEN') {
      trade.status = 'CLOSED';
      trade.closedAt = new Date().toISOString();
      trade.remainingQuantity = 0;
      await this.audit.record({
        action: 'PAPER_TRADE_CLOSED',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: trade.setupId,
        tradeId: trade.id,
        detail: { outcome: trade.outcome, pnl: trade.realizedPnl, taxa: trade.feesPaid },
      });
      await this.persist(trade);
      if (this.onClosed) await this.onClosed(trade);
      return;
    }

    if (changed) await this.persist(trade);
  }

  /**
   * Sobe o stop quando há lucro para proteger. Só sobe — e nunca acima do
   * preço, senão a proteção viraria uma venda imediata.
   */
  private async moveProtectiveStop(trade: Trade, price: number): Promise<boolean> {
    if (trade.status !== 'OPEN' || trade.remainingQuantity <= 0) return false;
    const guard = this.guard();
    if (!guard.breakevenAfterTarget1 && guard.trailingStopPercent <= 0) return false;

    const entry = trade.averageFillPrice ?? trade.entryPrice;
    const moved = nextProtectiveStop(
      {
        entryPrice: entry,
        currentStop: trade.stopLoss,
        highWaterPrice: trade.highWaterPrice ?? price,
        currentPrice: price,
        target1Filled: trade.fills.some((item) => item.kind === 'TARGET1'),
      },
      {
        breakevenAfterTarget1: guard.breakevenAfterTarget1,
        trailingStopPercent: guard.trailingStopPercent,
        feePercent: guard.feePercent,
      },
    );
    if (moved === null) return false;

    const from = trade.stopLoss;
    trade.stopLoss = round(moved, 8);
    trade.protectiveStop = trade.stopLoss;
    await this.audit.record({
      action: 'PROTECTIVE_STOP_MOVED',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: { de: from, para: trade.stopLoss, preco: price },
    });
    return true;
  }

  /** Uma saída parcial: resultado já líquido da corretagem das duas pontas. */
  private closePortion(trade: Trade, kind: TradeFill['kind'], price: number, quantity: number): void {
    const entry = trade.averageFillPrice ?? trade.entryPrice;
    const amount = Math.min(quantity, trade.remainingQuantity);
    if (amount <= 0) return;

    const feePercent = this.guard().feePercent;
    trade.remainingQuantity = round(trade.remainingQuantity - amount, 10);
    trade.realizedPnl = round(
      trade.realizedPnl + netPnl({ entryPrice: entry, exitPrice: price, quantity: amount, feePercent }),
      2,
    );
    // a taxa da entrada foi cobrada inteira no preenchimento; aqui entra só a da venda
    trade.feesPaid = round(trade.feesPaid + feeFor(price, amount, feePercent), 6);
    trade.realizedPnlPercent =
      trade.notional > 0 ? round((trade.realizedPnl / trade.notional) * 100, 2) : 0;
    trade.fills.push(fill(kind, price, amount));
  }

  private async persist(trade: Trade): Promise<void> {
    trade.updatedAt = new Date().toISOString();
    this.track(trade);
    try {
      await this.repository.saveTrade(trade);
    } catch (error) {
      logger.error('Falha ao gravar operação', { error: (error as Error).message });
    }
    this.bus.broadcast({ type: 'trade', payload: trade });
  }
}

function fill(kind: TradeFill['kind'], price: number, quantity: number): TradeFill {
  return { kind, price: round(price, 8), quantity: round(quantity, 8), time: new Date().toISOString() };
}

/**
 * Capital disponível no modo papel: aporte inicial + resultado − o que está
 * parado nas posições. O investido usa a quantidade que ainda resta, não o
 * valor original — depois de uma saída parcial, metade do dinheiro já voltou.
 */
export function paperBalance(trades: Trade[], capital: number): PaperBalance {
  let realizedPnl = 0;
  let invested = 0;
  for (const trade of trades) {
    if (trade.mode !== 'PAPER') continue;
    if (trade.status === 'CLOSED') realizedPnl += trade.realizedPnl;
    if (trade.status === 'PENDING') invested += trade.notional;
    if (trade.status === 'OPEN') {
      const entry = trade.averageFillPrice ?? trade.entryPrice;
      invested += entry * trade.remainingQuantity;
      // o resultado já realizado de uma saída parcial volta para o caixa
      realizedPnl += trade.realizedPnl;
    }
  }
  return {
    capital: round(capital + realizedPnl, 2),
    available: round(capital + realizedPnl - invested, 2),
    invested: round(invested, 2),
    realizedPnl: round(realizedPnl, 2),
  };
}

/** Exposto para teste: taxa de ida e volta de uma saída. */
export { roundTripFee };
