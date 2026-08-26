import type { AppSettings, MarketKind, Trade, TradeFill } from '../../core/types.ts';
import {
  excursionPercent,
  isFavorable,
  reachedTarget,
  stopBreached,
} from '../../core/direction.ts';
import { liquidationPrice } from '../../core/risk/futures.ts';
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

  private guard(trade: Trade): AppSettings['guard'] {
    // A conta exibida no topo pode ser REAL enquanto ainda há uma posição
    // DEMO sendo acompanhada. Custos e proteções pertencem à operação, não à
    // tela atualmente selecionada.
    return this.settings.forMode(trade.mode, trade.market).guard;
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
      // No DEMO, a decisão manual é uma entrada imediata. Ordens antigas que
      // ficaram PENDING pela regra anterior são corrigidas no primeiro tique,
      // sem aumentar o orçamento de risco originalmente aprovado.
      if (trade.status === 'PENDING' && !trade.automatic) {
        await this.fillPendingAtMarket(trade, price);
      }
      await this.step(trade, price);
    }
  }

  /** Operações de papel abertas numa modalidade — a demo de cada mercado. */
  getOpenTradesIn(market: MarketKind): Trade[] {
    return [...this.open.values()].filter((trade) => trade.market === market);
  }

  /**
   * Encerramento a mercado — o botão "encerrar agora" da tela e o pânico.
   * Sai pelo preço de mercado com escorregamento e paga a taxa, como sairia
   * de verdade.
   */
  async closeAtMarket(trade: Trade, price: number, reason: string): Promise<Trade> {
    const costs = this.guard(trade);
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

    const exitPrice = marketExitPrice(price, costs, trade.side);
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
    const costs = this.guard(trade);
    let changed = false;

    if (trade.status === 'PENDING') {
      // a ordem limitada só preenche quando o preço chega nela: caindo até a
      // entrada no comprado, subindo até ela no vendido
      if (isFavorable(trade.side, price, trade.entryPrice)) return;
      // ordem limitada preenche no preço combinado, nunca melhor: assumir
      // preenchimento no fundo do pavio é o otimismo que quebra o backtest
      const fillPrice = trade.entryPrice;
      this.applyEntryFill(trade, fillPrice, trade.requestedQuantity);
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

    // "topo" é o preço mais favorável já visto — o fundo, quando se está vendido
    if (trade.highWaterPrice === null || isFavorable(trade.side, price, trade.highWaterPrice)) {
      trade.highWaterPrice = price;
      changed = true;
    }

    const excursion = excursionPercent(trade.side, entry, price);
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

    /*
     * A liquidação vem ANTES do stop, sempre.
     *
     * Numa posição alavancada a corretora não espera o stop: quando a margem
     * acaba, ela fecha. Simular o stop primeiro produziria uma demo em que
     * nenhuma posição é liquidada — exatamente o erro que a demo existe para
     * não deixar acontecer.
     */
    if (
      trade.market === 'FUTURES' &&
      trade.liquidationPrice !== null &&
      trade.remainingQuantity > 0 &&
      stopBreached(trade.side, price, trade.liquidationPrice)
    ) {
      this.closePortion(trade, 'STOP', trade.liquidationPrice, trade.remainingQuantity);
      trade.outcome = 'STOP';
      trade.closeReason = `LIQUIDADA pela corretora em ${trade.liquidationPrice.toPrecision(6)} — a margem acabou antes do stop`;
      trade.status = 'CLOSED';
      trade.remainingQuantity = 0;
      trade.closedAt = new Date().toISOString();
      await this.audit.record({
        action: 'PAPER_TRADE_LIQUIDATED',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: trade.setupId,
        tradeId: trade.id,
        detail: {
          preco: trade.liquidationPrice,
          alavancagem: trade.leverage,
          margem: trade.initialMargin,
          pnl: trade.realizedPnl,
        },
      });
      await this.persist(trade);
      if (this.onClosed) await this.onClosed(trade);
      return;
    }

    if (stopBreached(trade.side, price, trade.stopLoss) && trade.remainingQuantity > 0) {
      const exitPrice = stopFillPrice(trade.stopLoss, costs, trade.side);
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
        if (!reachedTarget(trade.side, price, tranche.price)) continue;
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
        this.closePortion(
          trade,
          'MANUAL',
          marketExitPrice(price, costs, trade.side),
          trade.remainingQuantity,
        );
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
   * Converte uma ordem manual PAPER antiga em posição ao preço de agora.
   *
   * Se o mercado andou contra a tese desde a confirmação, a quantidade cai
   * para que o prejuízo estimado no stop nunca ultrapasse o orçamento que o
   * usuário aprovou originalmente. Entrar agora não é licença para arriscar
   * mais só porque a entrada ficou pior.
   */
  private async fillPendingAtMarket(trade: Trade, price: number): Promise<void> {
    if (trade.status !== 'PENDING' || trade.mode !== 'PAPER' || price <= 0) return;
    const costs = this.guard(trade);
    const stopFill = stopFillPrice(trade.stopLoss, costs, trade.side);
    const oldPerUnitRisk = -netPnl({
      entryPrice: trade.entryPrice,
      exitPrice: stopFill,
      quantity: 1,
      feePercent: costs.feePercent,
      side: trade.side,
    });
    const newPerUnitRisk = -netPnl({
      entryPrice: price,
      exitPrice: stopFill,
      quantity: 1,
      feePercent: costs.feePercent,
      side: trade.side,
    });
    if (!(newPerUnitRisk > 0)) {
      await this.closeAtMarket(
        trade,
        price,
        'Ordem manual cancelada: o preço atual já invalidou o stop da tese',
      );
      return;
    }

    const plannedQuantity = trade.requestedQuantity;
    const originalRiskBudget = Math.max(oldPerUnitRisk, 0) * plannedQuantity;
    const quantity = round(
      Math.min(
        plannedQuantity,
        originalRiskBudget > 0 ? originalRiskBudget / newPerUnitRisk : plannedQuantity,
      ),
      8,
    );
    if (!(quantity > 0)) return;

    const previousEntry = trade.entryPrice;
    this.applyEntryFill(trade, price, quantity);
    trade.riskAmount = round(newPerUnitRisk * quantity, 2);
    await this.audit.record({
      action: 'PAPER_MANUAL_FILLED_AT_MARKET',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: {
        entradaPlanejada: previousEntry,
        entradaReal: price,
        quantidadePlanejada: plannedQuantity,
        quantidadeExecutada: quantity,
        riscoNoStop: trade.riskAmount,
      },
    });
    await this.persist(trade);
  }

  /** Aplica o preenchimento de entrada; limite e mercado usam a mesma conta. */
  private applyEntryFill(trade: Trade, fillPrice: number, quantity: number): void {
    const costs = this.guard(trade);
    const openedAt = new Date().toISOString();
    trade.status = 'OPEN';
    trade.requestedQuantity = quantity;
    trade.filledQuantity = quantity;
    trade.remainingQuantity = quantity;
    trade.entryPrice = fillPrice;
    trade.averageFillPrice = fillPrice;
    trade.notional = round(fillPrice * quantity, 2);
    trade.initialMargin =
      trade.market === 'FUTURES'
        ? round(trade.notional / Math.max(trade.leverage, 1), 2)
        : trade.notional;
    trade.feesPaid = round(feeFor(fillPrice, quantity, costs.feePercent), 6);
    trade.highWaterPrice = fillPrice;
    trade.openedAt = openedAt;
    if (trade.market === 'FUTURES') {
      trade.liquidationPrice = liquidationPrice({
        side: trade.side,
        entryPrice: fillPrice,
        quantity,
        leverage: trade.leverage,
        marginMode: trade.marginMode ?? 'ISOLATED',
      });
    }
    trade.fills.push(fill('ENTRY', fillPrice, quantity));
  }

  /**
   * Sobe o stop quando há lucro para proteger. Só sobe — e nunca acima do
   * preço, senão a proteção viraria uma venda imediata.
   */
  private async moveProtectiveStop(trade: Trade, price: number): Promise<boolean> {
    if (trade.status !== 'OPEN' || trade.remainingQuantity <= 0) return false;
    const guard = this.guard(trade);
    if (!guard.breakevenAfterTarget1 && guard.trailingStopPercent <= 0) return false;

    const entry = trade.averageFillPrice ?? trade.entryPrice;
    const moved = nextProtectiveStop(
      {
        entryPrice: entry,
        currentStop: trade.stopLoss,
        highWaterPrice: trade.highWaterPrice ?? price,
        currentPrice: price,
        target1Filled: trade.fills.some((item) => item.kind === 'TARGET1'),
        side: trade.side,
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

    const feePercent = this.guard(trade).feePercent;
    trade.remainingQuantity = round(trade.remainingQuantity - amount, 10);
    trade.realizedPnl = round(
      trade.realizedPnl +
        netPnl({ entryPrice: entry, exitPrice: price, quantity: amount, feePercent, side: trade.side }),
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
 *
 * Em futuros o que fica parado é a MARGEM, não o notional: uma posição de 300
 * USDT com 3x prende 100. Contar o notional inteiro faria a demo alavancada
 * ficar sem caixa na primeira operação e nunca abrir a segunda — uma demo que
 * não se parece com a conta que ela simula.
 *
 * A modalidade separa as carteiras: a demo de spot e a de futuros são contas
 * diferentes, com capital próprio, como já acontece entre PAPER e LIVE.
 */
export function paperBalance(
  trades: Trade[],
  capital: number,
  market: MarketKind = 'SPOT',
): PaperBalance {
  let realizedPnl = 0;
  let invested = 0;
  const committed = (trade: Trade, value: number): number =>
    trade.market === 'FUTURES' && trade.leverage > 1 ? value / trade.leverage : value;
  for (const trade of trades) {
    if (trade.mode !== 'PAPER' || trade.market !== market) continue;
    if (trade.status === 'CLOSED') realizedPnl += trade.realizedPnl;
    if (trade.status === 'PENDING') invested += committed(trade, trade.notional);
    if (trade.status === 'OPEN') {
      const entry = trade.averageFillPrice ?? trade.entryPrice;
      invested += committed(trade, entry * trade.remainingQuantity);
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
