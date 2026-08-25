import type { AppSettings, SymbolFilters, Trade } from '../../core/types.ts';
import { round } from '../../core/risk/index.ts';
import { feeFor, netPnl } from '../../core/risk/costs.ts';
import { nextProtectiveStop } from '../../core/risk/stops.ts';
import { getOrderById, getOrderList, getSymbolFilters } from '../binance/rest.ts';
import type { UserDataStream } from '../binance/userStream.ts';
import { averageFillPrice, type OrderExecutionEvent } from '../binance/userEvents.ts';
import type { EventBus } from '../events.ts';
import { logger } from '../logger.ts';
import type { Repository } from '../store/index.ts';
import type { AuditService } from './auditService.ts';
import type { LiveProtection } from './liveProtection.ts';
import type { MarketDataService } from './marketDataService.ts';
import type { PaperTradingEngine } from './paperTradingEngine.ts';
import type { SettingsService } from './settingsService.ts';

/**
 * Ritmo da reconciliação. Quando o fluxo da conta está de pé, a consulta deixa
 * de ser a fonte da notícia e passa a ser só a conferência — pode ser rara.
 * Sem o fluxo, ela volta a ser a única forma de saber que a ordem executou.
 */
const POLL_WITH_STREAM_MS = 60_000;
const POLL_WITHOUT_STREAM_MS = 20_000;

/** Estado de uma ordem, venha da consulta ou do fluxo — a conta é a mesma. */
interface OrderState {
  orderId: string;
  side: 'BUY' | 'SELL';
  isStop: boolean;
  executedQuantity: number;
  averagePrice: number;
}

/**
 * Espelha no banco o que a corretora já executou.
 *
 * O ponto delicado é não contar a mesma execução duas vezes: a consulta
 * devolve a quantidade ACUMULADA da ordem, não o que mudou desde a última
 * volta. Por isso cada preenchimento gravado carrega o id da ordem — o que já
 * foi contabilizado sai da conta antes de somar o resto.
 */
export class LiveTradeMonitor {
  private readonly repository: Repository;
  private readonly paper: PaperTradingEngine;
  private readonly bus: EventBus;
  private readonly audit: AuditService;
  private readonly settings: SettingsService;
  private readonly market: MarketDataService;
  private readonly onClosed: (trade: Trade) => Promise<unknown>;
  private readonly protection: LiveProtection;
  private readonly stream: UserDataStream | null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  /** primeira vez que cada operação foi vista parcialmente preenchida e a descoberto */
  private exposedSince = new Map<string, number>();

  constructor(
    repository: Repository,
    paper: PaperTradingEngine,
    bus: EventBus,
    audit: AuditService,
    settings: SettingsService,
    market: MarketDataService,
    protection: LiveProtection,
    onClosed: (trade: Trade) => Promise<unknown>,
    stream: UserDataStream | null = null,
  ) {
    this.repository = repository;
    this.paper = paper;
    this.bus = bus;
    this.audit = audit;
    this.settings = settings;
    this.market = market;
    this.protection = protection;
    this.onClosed = onClosed;
    this.stream = stream;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stream?.on('execution', (event: OrderExecutionEvent) => void this.onExecution(event));
    this.scheduleNextTick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** O intervalo acompanha a saúde do fluxo: sem fluxo, a consulta acelera. */
  private scheduleNextTick(): void {
    if (this.stopped) return;
    const delay = this.stream?.isLive() ? POLL_WITH_STREAM_MS : POLL_WITHOUT_STREAM_MS;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNextTick());
    }, delay);
    this.timer.unref?.();
  }

  /**
   * Execução avisada pela corretora no instante em que aconteceu.
   *
   * Enquanto isto não existia, uma ordem podia preencher e passar até vinte
   * segundos sem que o sistema soubesse: tempo em que o stop não sobe, a
   * proteção não é armada e a posição não tem dono. A consulta continua
   * rodando por trás, e contar duas vezes não é risco — cada preenchimento
   * gravado carrega o id da ordem, e o que já entrou sai da conta.
   */
  private async onExecution(event: OrderExecutionEvent): Promise<void> {
    const trade = this.paper
      .getOpenTrades()
      .find(
        (item) =>
          item.mode !== 'PAPER' &&
          item.symbol === event.symbol &&
          (item.exchangeOrderIds.includes(String(event.orderId)) ||
            event.clientOrderId.startsWith(item.clientOrderId)),
      );
    if (!trade) return;

    const price = averageFillPrice(event);
    if (price === null) return;

    const changed = await this.applyOrderState(trade, {
      orderId: String(event.orderId),
      side: event.side,
      isStop: event.orderType.includes('STOP'),
      executedQuantity: event.cumulativeFilledQuantity,
      averagePrice: price,
    });
    if (!changed) return;

    await this.settle(trade);
    if (trade.status === 'OPEN') await this.ensureProtection(trade);
  }

  private guard(): AppSettings['guard'] {
    return this.settings.get().guard;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    const pending = this.paper.getOpenTrades().filter((trade) => trade.mode !== 'PAPER');
    if (pending.length === 0) return;

    this.running = true;
    try {
      for (const trade of pending) await this.syncTrade(trade);
    } finally {
      this.running = false;
    }
  }

  /** Quanto de uma ordem já virou preenchimento gravado. */
  private processedQuantity(trade: Trade, orderId: string): number {
    return trade.fills
      .filter((item) => item.orderId === orderId)
      .reduce((total, item) => total + item.quantity, 0);
  }

  private async syncTrade(trade: Trade): Promise<void> {
    try {
      const lists = [...new Set([trade.clientOrderId, ...(trade.protectionListIds ?? [])])];
      const orderIds = new Set<string>();
      for (const listId of lists) {
        try {
          const list = await getOrderList(listId);
          for (const reference of list.orders) orderIds.add(String(reference.orderId));
          if (listId === trade.clientOrderId && list.listOrderStatus === 'ALL_DONE' && trade.status === 'PENDING') {
            trade.status = 'CANCELLED';
            trade.closeReason = 'ordem de entrada encerrada na corretora sem executar';
            trade.closedAt = new Date().toISOString();
          }
        } catch (error) {
          logger.debug('Lista não encontrada na reconciliação', {
            tradeId: trade.id,
            listId,
            error: (error as Error).message,
          });
        }
      }

      let changed = trade.status === 'CANCELLED';
      for (const orderId of orderIds) {
        const order = await getOrderById(trade.symbol, orderId);
        const executed = Number(order.executedQty);
        if (!Number.isFinite(executed) || executed <= 0) continue;

        const quoteQty = Number(order.cummulativeQuoteQty);
        const averagePrice = quoteQty > 0 && executed > 0 ? quoteQty / executed : Number(order.price);
        if (!Number.isFinite(averagePrice) || averagePrice <= 0) continue;

        const applied = await this.applyOrderState(trade, {
          orderId,
          side: order.side === 'SELL' ? 'SELL' : 'BUY',
          isStop: order.type.includes('STOP'),
          executedQuantity: executed,
          averagePrice,
        });
        if (applied) changed = true;
      }

      if (trade.status === 'OPEN') {
        if (await this.ensureProtection(trade)) changed = true;
        const price = this.market.getPrice(trade.symbol);
        if (price !== null) {
          if (trade.highWaterPrice === null || price > trade.highWaterPrice) {
            trade.highWaterPrice = price;
            changed = true;
          }
          if (await this.moveLiveStop(trade, price)) changed = true;
        }
      }

      if (!changed) return;
      await this.settle(trade);
    } catch (error) {
      logger.warn('Não foi possível sincronizar a ordem na Binance', {
        tradeId: trade.id,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Contabilidade de uma ordem — a mesma para a consulta e para o fluxo.
   *
   * A quantidade que chega é sempre a ACUMULADA da ordem, nunca o pedaço novo.
   * Por isso o que já foi gravado com aquele id sai da conta antes de somar o
   * resto: é o que permite as duas fontes conviverem sem contar duas vezes o
   * mesmo negócio.
   */
  private async applyOrderState(trade: Trade, state: OrderState): Promise<boolean> {
    const already = this.processedQuantity(trade, state.orderId);
    const delta = round(state.executedQuantity - already, 10);
    if (delta <= 1e-10) return false;

    const feePercent = this.guard().feePercent;
    const { orderId, averagePrice } = state;

    if (state.side === 'BUY') {
      const previousFilled = trade.filledQuantity;
      const previousEntry = trade.averageFillPrice ?? 0;
      const filled = round(previousFilled + delta, 10);
      // preço médio ponderado: compra parcial em duas levas tem duas contas
      trade.averageFillPrice = round((previousEntry * previousFilled + averagePrice * delta) / filled, 8);
      trade.filledQuantity = filled;
      trade.remainingQuantity = round(trade.remainingQuantity + delta, 10);
      trade.notional = round((trade.averageFillPrice as number) * filled, 2);
      trade.feesPaid = round(trade.feesPaid + feeFor(averagePrice, delta, feePercent), 6);
      trade.status = 'OPEN';
      if (trade.highWaterPrice === null) trade.highWaterPrice = averagePrice;
      trade.fills.push({
        kind: 'ENTRY',
        price: round(averagePrice, 8),
        quantity: delta,
        time: new Date().toISOString(),
        orderId,
      });
      await this.audit.record({
        action: 'LIVE_ORDER_FILLED',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: trade.setupId,
        tradeId: trade.id,
        detail: { price: averagePrice, quantidade: delta, acumulado: filled },
      });
      return true;
    }

    const entry = trade.averageFillPrice ?? trade.entryPrice;
    // soma, nunca substitui: saída em duas partes tem dois resultados
    trade.realizedPnl = round(
      trade.realizedPnl + netPnl({ entryPrice: entry, exitPrice: averagePrice, quantity: delta, feePercent }),
      2,
    );
    trade.feesPaid = round(trade.feesPaid + feeFor(averagePrice, delta, feePercent), 6);
    trade.remainingQuantity = round(Math.max(trade.remainingQuantity - delta, 0), 10);
    trade.realizedPnlPercent =
      trade.notional > 0 ? round((trade.realizedPnl / trade.notional) * 100, 2) : 0;
    trade.fills.push({
      kind: state.isStop ? 'STOP' : this.nextTargetKind(trade),
      price: round(averagePrice, 8),
      quantity: delta,
      time: new Date().toISOString(),
      orderId,
    });
    trade.outcome = state.isStop ? 'STOP' : (this.lastFillKind(trade) as Trade['outcome']);
    if (trade.remainingQuantity <= 1e-10) {
      trade.status = 'CLOSED';
      trade.closedAt = new Date().toISOString();
    }
    return true;
  }

  /**
   * Qual alvo esta venda representa. Com a saída em partes há três ordens de
   * alvo na corretora, e gravar todas como TARGET1 apagaria a diferença entre
   * a conta real e o papel — que é justamente o que se quer poder comparar.
   */
  private nextTargetKind(trade: Trade): 'TARGET1' | 'TARGET2' | 'TARGET3' {
    const used = new Set(trade.fills.map((item) => item.kind));
    if (!used.has('TARGET1')) return 'TARGET1';
    if (!used.has('TARGET2')) return 'TARGET2';
    return 'TARGET3';
  }

  private lastFillKind(trade: Trade): string {
    return trade.fills[trade.fills.length - 1]?.kind ?? 'TARGET1';
  }

  /** Grava, avisa a tela e fecha o ciclo quando a operação encerrou. */
  private async settle(trade: Trade): Promise<void> {
    trade.updatedAt = new Date().toISOString();
    await this.repository.saveTrade(trade);
    this.paper.track(trade);
    this.bus.broadcast({ type: 'trade', payload: trade });
    if (trade.status === 'CLOSED' || trade.status === 'CANCELLED') {
      this.exposedSince.delete(trade.id);
      if (trade.status === 'CLOSED') await this.onClosed(trade);
    }
  }

  /**
   * Fecha a brecha do OTOCO.
   *
   * O bracket da Binance só coloca alvo e stop no livro quando a ordem de
   * entrada preenche por INTEIRO. Preenchimento parcial deixa o que já foi
   * comprado sem nenhuma proteção, e a posição pode ficar assim enquanto o
   * resto da entrada não executa — o que pode nunca acontecer. Passado o prazo
   * do disjuntor, o sistema para de esperar: cancela o que restou da entrada e
   * arma a proteção para a quantidade que está na mão.
   *
   * Também é aqui que a conta real passa a executar o mesmo 50/30/20 do papel.
   */
  private async ensureProtection(trade: Trade): Promise<boolean> {
    if (trade.remainingQuantity <= 0) return false;
    const guard = this.guard();

    const hasProtection = (trade.protectionListIds ?? []).length > 0;
    const wantsScaleOut = guard.liveScaleOut && trade.target2 !== null;
    const entryIncomplete = trade.filledQuantity + 1e-10 < trade.requestedQuantity;

    if (hasProtection && !entryIncomplete) return false;

    if (entryIncomplete) {
      const since = this.exposedSince.get(trade.id);
      if (since === undefined) {
        this.exposedSince.set(trade.id, Date.now());
        return false;
      }
      if (Date.now() - since < Math.max(guard.partialFillGuardSeconds, 15) * 1000) return false;
    } else if (!wantsScaleOut && hasProtection) {
      return false;
    }

    const filters = (await getSymbolFilters([trade.symbol])).get(trade.symbol);
    if (!filters) return false;

    const why = entryIncomplete
      ? 'entrada preenchida pela metade — o OTOCO não arma proteção nesse caso'
      : 'plano de saída da conta real igualado ao do papel';
    const result = await this.protection.rearm(trade, filters, trade.stopLoss, why);
    this.exposedSince.delete(trade.id);

    if (!result.armed) {
      await this.protection.panicSell(trade, filters, why);
      return true;
    }
    return true;
  }

  /**
   * Sobe o stop que está NA corretora.
   *
   * Trocar a proteção exige cancelar antes de recriar, e entre as duas coisas
   * a posição fica descoberta. Quando nem a recriação funciona, o sistema
   * vende a mercado em vez de deixar a posição solta — e, em qualquer caso,
   * a auditoria registra.
   *
   * Nasce desligado. Só liga quem entendeu esse compromisso.
   */
  private async moveLiveStop(trade: Trade, price: number): Promise<boolean> {
    const guard = this.guard();
    if (!guard.manageLiveStops) return false;
    if (trade.remainingQuantity <= 0) return false;

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

    const filters: SymbolFilters | undefined = (await getSymbolFilters([trade.symbol])).get(
      trade.symbol,
    );
    if (!filters) return false;

    const from = trade.stopLoss;
    const result = await this.protection.rearm(trade, filters, moved, 'stop de proteção subindo');
    if (!result.armed) {
      await this.protection.panicSell(trade, filters, 'proteção não pôde ser recriada');
      return true;
    }

    trade.stopLoss = moved;
    trade.protectiveStop = moved;
    await this.audit.record({
      action: 'PROTECTIVE_STOP_MOVED',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: { de: from, para: trade.stopLoss, plano: result.kind, listas: result.listIds },
    });
    return true;
  }
}
