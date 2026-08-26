import type { AppSettings, SymbolFilters, Trade } from '../../core/types.ts';
import { isFavorable } from '../../core/direction.ts';
import { round } from '../../core/risk/index.ts';
import { feeFor, netPnl } from '../../core/risk/costs.ts';
import { nextProtectiveStop } from '../../core/risk/stops.ts';
import {
  moedaBaseDoPar,
  quantidadeQueEntrou,
  restoEhPo,
} from '../../core/execution/posicaoReal.ts';
import {
  getMyTrades,
  getOrderById,
  getOrderList,
  getSymbolFilters,
  type MyTrade,
} from '../binance/rest.ts';
import { getFuturesOrderById } from '../binance/futures.ts';
import type { AccountStreams, MarketExecutionEvent } from '../binance/accountStreams.ts';
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
  /**
   * Taxa cobrada nesta execução e em que moeda. Sem BNB, a Binance cobra a
   * comissão da COMPRA na moeda comprada — e aí a quantidade que entra na
   * carteira é menor que a preenchida. Ignorar isso fazia toda ordem de venda
   * pedir mais do que existe.
   */
  commission?: number;
  commissionAsset?: string | null;
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
  private readonly streams: AccountStreams | null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  /** primeira vez que cada operação foi vista parcialmente preenchida e a descoberto */
  private exposedSince = new Map<string, number>();
  /**
   * Quantidade que a proteção de futuros cobre agora, por operação.
   *
   * Sem esta lembrança, uma entrada preenchida pela metade faria o monitor
   * cancelar e recriar alvo e stop a CADA volta da reconciliação — e cada
   * ciclo desses tem uma janela em que a posição fica descoberta. Rearmar é
   * caro: só se faz quando a quantidade em mãos mudou de verdade.
   */
  private protectedQuantity = new Map<string, number>();

  constructor(
    repository: Repository,
    paper: PaperTradingEngine,
    bus: EventBus,
    audit: AuditService,
    settings: SettingsService,
    market: MarketDataService,
    protection: LiveProtection,
    onClosed: (trade: Trade) => Promise<unknown>,
    streams: AccountStreams | null = null,
  ) {
    this.repository = repository;
    this.paper = paper;
    this.bus = bus;
    this.audit = audit;
    this.settings = settings;
    this.market = market;
    this.protection = protection;
    this.onClosed = onClosed;
    this.streams = streams;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.streams?.on('execution', ({ event }: MarketExecutionEvent) => void this.onExecution(event));
    this.scheduleNextTick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * O intervalo acompanha a saúde do fluxo: sem fluxo, a consulta acelera.
   *
   * A pergunta é por MODALIDADE, e essa distinção não é detalhe. Havia um
   * fluxo só, de spot; com ele de pé o monitor relaxava para um minuto — e a
   * posição de futuros, cujo fluxo nem existia, passava esse minuto inteiro
   * parada em AGUARDANDO depois de a corretora já ter preenchido a ordem.
   */
  private coberto(): boolean {
    const streams = this.streams;
    if (!streams) return false;
    const emAndamento = this.paper.getOpenTrades().filter((trade) => trade.mode !== 'PAPER');
    if (emAndamento.length === 0) return true;
    return emAndamento.every((trade) => streams.isLive(trade.market ?? 'SPOT'));
  }

  private scheduleNextTick(): void {
    if (this.stopped) return;
    const delay = this.coberto() ? POLL_WITH_STREAM_MS : POLL_WITHOUT_STREAM_MS;
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
      commission: event.commission,
      commissionAsset: event.commissionAsset,
    });
    if (!changed) return;

    await this.settle(trade);
    /*
     * Gravar de novo DEPOIS de armar a proteção.
     *
     * `rearm` escreve em `trade.protectionListIds` os ids das ordens de alvo
     * e stop que acabaram de nascer na corretora. Como o `settle` acima já
     * tinha rodado, esses ids ficavam só na memória do processo — e o banco
     * guardava `null`. No reinício seguinte a operação voltava sem saber onde
     * estava a própria proteção, a reconciliação não tinha o que consultar, e
     * uma posição JÁ ENCERRADA pelo stop continuava aberta no painel para
     * sempre, inflando o patrimônio pelo valor dela.
     */
    if (trade.status === 'OPEN' && (await this.ensureProtection(trade))) {
      await this.settle(trade);
    }
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
    if (trade.market === 'FUTURES') return this.syncFuturesTrade(trade);
    try {
      const lists = [...new Set([trade.clientOrderId, ...(trade.protectionListIds ?? [])])];
      /*
       * Os ids que já estão em mãos entram ANTES de perguntar pela lista.
       *
       * A lista era a única fonte de ids, então bastava um `getOrderList`
       * falhar — lista expirada, -2013, um 429 momentâneo — para a volta
       * inteira não olhar ordem nenhuma. A operação ficava em AGUARDANDO para
       * sempre, com a ordem preenchida na corretora, e nada no log além de um
       * debug. O id da entrada foi gravado no envio: ele não depende de a
       * lista responder.
       */
      const orderIds = new Set<string>(trade.exchangeOrderIds);
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

      // a verdade da corretora, não só as ordens que este servidor lembra
      if (await this.aplicarNegociosExecutados(trade)) changed = true;

      if (trade.status === 'OPEN') {
        // antes de proteger: o que sobrou ainda é posição, ou já é pó? Armar
        // stop para uma fração que a corretora não aceita vender só produz
        // recusa — e foi assim que uma operação encerrada de fato ficou
        // aberta no painel, dividindo o resultado por um resto de meio centavo
        if (await this.encerrarSePo(trade)) changed = true;
      }

      if (trade.status === 'OPEN') {
        if (await this.ensureProtection(trade)) changed = true;
        const price = this.market.getPrice(trade.symbol);
        if (price !== null) {
          if (trade.highWaterPrice === null || isFavorable(trade.side, price, trade.highWaterPrice)) {
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
   * Reconciliação em FUTUROS.
   *
   * Não há lista OCO para consultar: o que existe é um punhado de ids de
   * ordem — a entrada e as ordens de proteção que este servidor mandou. A
   * conta em si é a mesma do spot (`applyOrderState`), e é de propósito: o
   * jeito de não divergir entre os dois mercados é os dois passarem pela
   * mesma contabilidade.
   */
  private async syncFuturesTrade(trade: Trade): Promise<void> {
    try {
      const ids = [...new Set([...trade.exchangeOrderIds, ...(trade.protectionListIds ?? [])])];
      let changed = false;

      for (const orderId of ids) {
        let order;
        try {
          order = await getFuturesOrderById(trade.symbol, orderId);
        } catch (error) {
          logger.debug('Ordem de futuros não encontrada na reconciliação', {
            tradeId: trade.id,
            orderId,
            error: (error as Error).message,
          });
          continue;
        }

        // entrada que a corretora encerrou sem executar nada
        if (
          trade.status === 'PENDING' &&
          trade.exchangeOrderIds.includes(orderId) &&
          (order.status === 'CANCELED' || order.status === 'EXPIRED' || order.status === 'REJECTED')
        ) {
          trade.status = 'CANCELLED';
          trade.closeReason = 'ordem de entrada encerrada na corretora sem executar';
          trade.closedAt = new Date().toISOString();
          changed = true;
          continue;
        }

        const executed = Number(order.executedQty);
        if (!Number.isFinite(executed) || executed <= 0) continue;
        const average = Number(order.avgPrice) > 0 ? Number(order.avgPrice) : Number(order.price);
        if (!Number.isFinite(average) || average <= 0) continue;

        const applied = await this.applyOrderState(trade, {
          orderId,
          side: order.side === 'SELL' ? 'SELL' : 'BUY',
          isStop: order.type.includes('STOP'),
          executedQuantity: executed,
          averagePrice: average,
        });
        if (applied) changed = true;
      }

      if (trade.status === 'OPEN') {
        // antes de proteger: o que sobrou ainda é posição, ou já é pó? Armar
        // stop para uma fração que a corretora não aceita vender só produz
        // recusa — e foi assim que uma operação encerrada de fato ficou
        // aberta no painel, dividindo o resultado por um resto de meio centavo
        if (await this.encerrarSePo(trade)) changed = true;
      }

      if (trade.status === 'OPEN') {
        if (await this.ensureProtection(trade)) changed = true;
        const price = this.market.getPrice(trade.symbol);
        if (price !== null) {
          if (trade.highWaterPrice === null || isFavorable(trade.side, price, trade.highWaterPrice)) {
            trade.highWaterPrice = price;
            changed = true;
          }
          if (await this.moveLiveStop(trade, price)) changed = true;
        }
      }

      if (!changed) return;
      await this.settle(trade);
    } catch (error) {
      logger.warn('Não foi possível sincronizar a posição de futuros', {
        tradeId: trade.id,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Reconciliação pelos NEGÓCIOS, não pelas ordens.
   *
   * A conferência por ordem tem um ponto cego estrutural: ela só pergunta
   * por ordens que este servidor gravou. Tudo que executa fora dessa lista
   * fica invisível — a proteção cujo id não chegou ao banco, a venda de
   * emergência, e principalmente uma venda feita à mão pelo aplicativo da
   * Binance. O sintoma é sempre o mesmo e é caro: a posição já não existe na
   * corretora, o painel segue mostrando ela aberta, e o patrimônio aparece
   * inflado pelo valor de algo que já foi vendido.
   *
   * `myTrades` responde pelo PAR: todo negócio executado, com preço, taxa e
   * id da ordem. Agrupando por ordem, o resultado entra pela mesma
   * contabilidade de sempre — e como ela desconta o que já foi gravado
   * naquele id, nada é contado duas vezes.
   */
  private async aplicarNegociosExecutados(trade: Trade): Promise<boolean> {
    let negocios: MyTrade[];
    try {
      negocios = await getMyTrades(trade.symbol, 50);
    } catch (error) {
      logger.debug('Negócios do par indisponíveis na reconciliação', {
        tradeId: trade.id,
        error: (error as Error).message,
      });
      return false;
    }

    const abertura = Date.parse(trade.openedAt);
    const porOrdem = new Map<
      string,
      { quantidade: number; financeiro: number; comissao: number; moeda: string; compra: boolean }
    >();
    for (const negocio of negocios) {
      // negócio anterior à operação é de outra vida deste par
      if (Number.isFinite(abertura) && negocio.time < abertura - 60_000) continue;
      const chave = String(negocio.orderId);
      const atual = porOrdem.get(chave) ?? {
        quantidade: 0,
        financeiro: 0,
        comissao: 0,
        moeda: negocio.commissionAsset,
        compra: negocio.isBuyer,
      };
      atual.quantidade += Number(negocio.qty);
      atual.financeiro += Number(negocio.quoteQty);
      atual.comissao += Number(negocio.commission);
      porOrdem.set(chave, atual);
    }

    let mudou = false;
    for (const [orderId, somado] of porOrdem) {
      if (somado.quantidade <= 0) continue;
      // nada de novo nesta ordem: não gasta uma consulta para descobrir o tipo
      if (somado.quantidade - this.processedQuantity(trade, orderId) <= 1e-10) continue;

      /*
       * O TIPO da ordem decide se a saída foi STOP ou ALVO.
       *
       * `myTrades` diz o que foi negociado, não por qual ordem — e chamar de
       * "alvo atingido" uma saída que foi stop não erra o resultado, erra a
       * ESTATÍSTICA: o diário e o desempenho agrupam por esse rótulo, e um
       * prejuízo arquivado como alvo contamina a taxa de acerto que decide se
       * a estratégia continua ligada. A consulta só sai para ordem que trouxe
       * quantidade nova, que é rara.
       */
      let isStop = false;
      if (!somado.compra) {
        try {
          const ordem = await getOrderById(trade.symbol, orderId);
          isStop = ordem.type.includes('STOP');
        } catch {
          // sem o tipo, o rótulo cai no padrão; o resultado financeiro não muda
        }
      }

      const aplicado = await this.applyOrderState(trade, {
        orderId,
        side: somado.compra ? 'BUY' : 'SELL',
        isStop,
        executedQuantity: somado.quantidade,
        averagePrice: somado.financeiro / somado.quantidade,
        commission: somado.comissao,
        commissionAsset: somado.moeda,
      });
      if (aplicado) mudou = true;
    }
    return mudou;
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

    // ENTRADA é a ordem do lado da tese; SAÍDA é a do lado contrário. Enquanto
    // só existia compra, "BUY = entrada" era verdade por acidente — numa
    // posição vendida essa leitura registraria cada saída como se fosse uma
    // nova entrada, dobrando a posição no papel e zerando o resultado.
    if (state.side === trade.side) {
      const previousFilled = trade.filledQuantity;
      const previousEntry = trade.averageFillPrice ?? 0;
      const filled = round(previousFilled + delta, 10);
      /*
       * O que ENTRA na carteira pode ser menos do que o que foi preenchido.
       *
       * Sem BNB, a Binance cobra a comissão da compra na moeda comprada: de
       * 1158,1 JASMY preenchidos, chegam 1156,94. A quantidade preenchida
       * continua sendo a cheia — ela é o que a corretora acumula na ordem, e
       * é por ela que este método evita contar o mesmo negócio duas vezes. O
       * que muda é a POSIÇÃO EM MÃOS, que é o número de toda ordem de venda.
       * Enquanto os dois eram o mesmo, alvo, stop e venda de emergência
       * pediam mais do que existia e voltavam recusados.
       */
      const emMaos = quantidadeQueEntrou({
        preenchida: delta,
        comissao: state.commission ?? 0,
        moedaDaComissao: state.commissionAsset ?? null,
        moedaBase: moedaBaseDoPar(trade.symbol),
      });
      // preço médio ponderado: compra parcial em duas levas tem duas contas
      trade.averageFillPrice = round((previousEntry * previousFilled + averagePrice * delta) / filled, 8);
      trade.filledQuantity = filled;
      trade.remainingQuantity = round(trade.remainingQuantity + emMaos, 10);
      trade.notional = round((trade.averageFillPrice as number) * filled, 2);
      trade.feesPaid = round(trade.feesPaid + feeFor(averagePrice, delta, feePercent), 6);
      trade.status = 'OPEN';
      /*
       * A operação REABRIU — o carimbo de encerramento tem de sair junto.
       *
       * A reconciliação marca CANCELLED quando vê a lista da entrada como
       * ALL_DONE enquanto a ordem ainda está pendente, e isso acontece um
       * instante ANTES de o preenchimento chegar. O preenchimento então
       * corrigia o status para OPEN e deixava para trás um `closedAt` de
       * segundos antes da entrada.
       *
       * O estrago não é cosmético: `closedAt` é a data que datava a operação
       * como perda para o descanso pós-perda, para o resultado do dia e para a
       * ordem da curva de patrimônio. A PEPE encerrou às 14:57 e ficou
       * carimbada como 14:53 — o descanso começou a contar quatro minutos
       * antes de existir prejuízo.
       */
      trade.closedAt = null;
      trade.closeReason = null;
      if (trade.highWaterPrice === null) trade.highWaterPrice = averagePrice;
      trade.fills.push({
        kind: 'ENTRY',
        price: round(averagePrice, 8),
        quantity: delta,
        time: new Date().toISOString(),
        orderId,
      });
      this.audit.record({
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
      trade.realizedPnl +
        netPnl({ entryPrice: entry, exitPrice: averagePrice, quantity: delta, feePercent, side: trade.side }),
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

  /**
   * A posição virou pó — não há mais o que encerrar.
   *
   * A taxa cobrada na moeda comprada deixa uma fração para trás, e a fração
   * costuma ficar abaixo do mínimo de lote (ou dos 5 USDT de nocional) que a
   * corretora aceita. Sem esta pergunta a operação fica ABERTA para sempre
   * segurando algo que nenhuma ordem consegue tocar — e a tela passa a
   * dividir o resultado por esse resto: foi assim que um lucro de US$ 0,14
   * apareceu como "+1400%".
   */
  private async encerrarSePo(trade: Trade): Promise<boolean> {
    if (trade.status !== 'OPEN' || trade.filledQuantity <= 0) return false;
    const price =
      this.market.getPrice(trade.symbol) ?? trade.averageFillPrice ?? trade.entryPrice;
    let filters;
    try {
      filters = (await getSymbolFilters([trade.symbol], trade.market)).get(trade.symbol);
    } catch {
      return false;
    }
    if (!filters) return false;
    if (!restoEhPo(trade.remainingQuantity, price, filters)) return false;

    const sobra = trade.remainingQuantity;
    trade.status = 'CLOSED';
    trade.remainingQuantity = 0;
    trade.closedAt = trade.closedAt ?? new Date().toISOString();
    trade.closeReason =
      trade.closeReason ??
      `posição zerada — sobraram ${sobra} ${filters.baseAsset}, abaixo do mínimo negociável da Binance`;
    this.audit.record({
      action: 'LIVE_TRADE_DUST_CLOSED',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: {
        motivo: 'o resto da posição não alcança o mínimo de lote nem o nocional mínimo',
        sobra,
        minimoDeLote: filters.minQty,
        nocionalMinimo: filters.minNotional,
        resultado: trade.realizedPnl,
      },
    });
    return true;
  }

  /** Grava, avisa a tela e fecha o ciclo quando a operação encerrou. */
  private async settle(trade: Trade): Promise<void> {
    await this.encerrarSePo(trade);
    trade.updatedAt = new Date().toISOString();
    await this.repository.saveTrade(trade);
    this.paper.track(trade);
    this.bus.broadcast({ type: 'trade', payload: trade });
    if (trade.status === 'CLOSED' || trade.status === 'CANCELLED') {
      this.exposedSince.delete(trade.id);
      this.protectedQuantity.delete(trade.id);
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

    /*
     * Em futuros não existe bracket: a entrada vai sozinha e a posição nasce
     * DESPROTEGIDA. Aqui não há o que esperar — e esperar seria o erro. A
     * espera do spot existe porque lá o OTOCO ainda pode armar sozinho quando
     * o resto da entrada preencher; em futuros isso nunca acontece.
     */
    if (trade.market === 'FUTURES') {
      const covered = this.protectedQuantity.get(trade.id) ?? 0;
      const matchesPosition = Math.abs(covered - trade.remainingQuantity) <= 1e-10;
      if (hasProtection && matchesPosition) return false;

      const filters = (await getSymbolFilters([trade.symbol], trade.market)).get(trade.symbol);
      if (!filters) return false;
      const why = hasProtection
        ? 'proteção de futuros ajustada à quantidade em mãos'
        : 'posição de futuros aberta sem proteção — alvo e stop só existem depois do preenchimento';
      const armed = await this.protection.rearm(trade, filters, trade.stopLoss, why);
      if (armed.armed) {
        this.protectedQuantity.set(trade.id, trade.remainingQuantity);
      } else {
        this.protectedQuantity.delete(trade.id);
        await this.protection.panicSell(trade, filters, why);
      }
      return true;
    }

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

    const filters = (await getSymbolFilters([trade.symbol], trade.market)).get(trade.symbol);
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
        side: trade.side,
      },
      {
        breakevenAfterTarget1: guard.breakevenAfterTarget1,
        trailingStopPercent: guard.trailingStopPercent,
        feePercent: guard.feePercent,
      },
    );
    if (moved === null) return false;

    const filters: SymbolFilters | undefined = (await getSymbolFilters([trade.symbol], trade.market)).get(
      trade.symbol,
    );
    if (!filters) return false;

    const from = trade.stopLoss;
    const result = await this.protection.rearm(trade, filters, moved, 'stop de proteção subindo');
    if (!result.armed) {
      this.protectedQuantity.delete(trade.id);
      await this.protection.panicSell(trade, filters, 'proteção não pôde ser recriada');
      return true;
    }
    this.protectedQuantity.set(trade.id, trade.remainingQuantity);

    trade.stopLoss = moved;
    trade.protectiveStop = moved;
    this.audit.record({
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
