import type { Trade } from '../../core/types.ts';
import { round, roundDownToStep, formatQuantity } from '../../core/risk/index.ts';
import { netPnl } from '../../core/risk/costs.ts';
import { restoEhPo } from '../../core/execution/posicaoReal.ts';
import {
  BinanceError,
  cancelAllOpenOrders,
  invalidateAccountCache,
  getAccountBalances,
  getSymbolFilters,
  newOrder,
} from '../binance/rest.ts';
import {
  cancelAllFuturesOrders,
  futuresMarketExit,
  getFuturesPositions,
} from '../binance/futures.ts';
import type { EventBus } from '../events.ts';
import { logger } from '../logger.ts';
import type { Repository } from '../store/index.ts';
import type { AuditService } from './auditService.ts';
import { ExecutionError } from './executionService.ts';
import type { MarketDataService } from './marketDataService.ts';
import type { PaperTradingEngine } from './paperTradingEngine.ts';
import type { SettingsService } from './settingsService.ts';

/**
 * Encerrar uma posição na mão.
 *
 * Faltava. O sistema sabia abrir e sabia esperar alvo ou stop, mas não tinha
 * caminho nenhum para o usuário dizer "sai agora" — e a hora em que se quer
 * sair costuma ser exatamente a hora em que o plano deixou de valer.
 *
 * Em conta real a ordem importa: primeiro cancela o bracket, senão a venda a
 * mercado disputa a mesma moeda com o stop que ainda está no livro e uma das
 * duas é recusada por saldo.
 */
export class CloseService {
  private readonly repository: Repository;
  private readonly paper: PaperTradingEngine;
  private readonly market: MarketDataService;
  private readonly audit: AuditService;
  private readonly settings: SettingsService;
  private readonly bus: EventBus;
  private readonly onClosed: (trade: Trade) => Promise<unknown>;

  constructor(
    repository: Repository,
    paper: PaperTradingEngine,
    market: MarketDataService,
    audit: AuditService,
    settings: SettingsService,
    bus: EventBus,
    onClosed: (trade: Trade) => Promise<unknown>,
  ) {
    this.repository = repository;
    this.paper = paper;
    this.market = market;
    this.audit = audit;
    this.settings = settings;
    this.bus = bus;
    this.onClosed = onClosed;
  }

  /**
   * Como devolver a tese ao radar quando a ordem morre sem comprar.
   *
   * Injetado em vez de importado porque o encerramento não conhece o scanner
   * — e não deveria: o que ele sabe é que a ordem saiu sem executar. Quem
   * decide o que isso significa para o radar é quem ligou os dois.
   */
  private releaseSetup: ((setupId: string) => Promise<void>) | null = null;

  setOnOrderCancelled(handler: (setupId: string) => Promise<void>): void {
    this.releaseSetup = handler;
  }

  async findTrade(tradeId: string): Promise<Trade | null> {
    const trades = await this.repository.listTrades();
    return trades.find((trade) => trade.id === tradeId) ?? null;
  }

  /** Encerra uma posição pelo preço de agora. Serve para o botão e para o pânico. */
  async close(tradeId: string, reason: string): Promise<Trade> {
    const trade = await this.findTrade(tradeId);
    if (!trade) throw new ExecutionError('Operação não encontrada', 404);
    if (trade.mode !== this.settings.get().mode) {
      throw new ExecutionError('Esta operação pertence a outra conta. Selecione a conta correta para encerrá-la.', 409);
    }
    /*
     * Encerrar não pergunta qual aba está aberta.
     *
     * Esta trava fazia sentido quando havia uma modalidade por vez: sair de
     * uma posição exigia estar "nela". Agora a carteira lista as duas juntas,
     * de propósito — e uma posição que aparece na tela com um botão
     * "Cancelar" que responde "troque de modalidade" é o pior momento
     * possível para pedir um passo a mais: é justamente quando se quer sair.
     *
     * O caminho já sabe se virar sozinho: `closeOnExchange` roteia por
     * `trade.market`, e o cliente REST escolhe a corretora pelo caminho da
     * chamada. Nada aqui dependia da modalidade em exibição além do bloqueio.
     */
    if (trade.status === 'CLOSED' || trade.status === 'CANCELLED') {
      throw new ExecutionError('Esta operação já está encerrada');
    }

    if (trade.mode === 'PAPER') {
      const price = this.market.getPrice(trade.symbol) ?? trade.averageFillPrice ?? trade.entryPrice;
      return this.paper.closeAtMarket(trade, price, reason);
    }
    return this.closeOnExchange(trade, reason);
  }

  /**
   * Encerra tudo que estiver aberto — o botão de pânico.
   *
   * TUDO quer dizer as duas modalidades. Fechar só a que está na tela seria a
   * pior meia-verdade do painel: quem aperta este botão está saindo do
   * mercado, não organizando uma aba, e ficaria com posição alavancada aberta
   * achando que tinha encerrado. A conta continua sendo a que está em
   * exibição — demo e real são carteiras diferentes de verdade.
   */
  async closeAll(reason: string): Promise<{ closed: string[]; failed: Array<{ id: string; error: string }> }> {
    const { mode } = this.settings.get();
    const open = this.paper.getOpenTrades().filter((trade) => trade.mode === mode);
    const closed: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const trade of open) {
      try {
        await this.close(trade.id, reason);
        closed.push(trade.id);
      } catch (error) {
        failed.push({ id: trade.id, error: (error as Error).message });
      }
    }
    this.audit.record({
      action: 'PANIC_CLOSE_ALL',
      mode: this.settings.get().mode,
      detail: { reason, encerradas: closed.length, falhas: failed },
    });
    return { closed, failed };
  }

  private async closeOnExchange(trade: Trade, reason: string): Promise<Trade> {
    if (trade.market === 'FUTURES') return this.closeFuturesPosition(trade, reason);

    /*
     * 1) esvazia o livro do par para soltar a moeda.
     *
     * Antes só a lista da ENTRADA era cancelada. Só que quem segura a moeda
     * depois do preenchimento é a proteção — e ela é recriada com ids novos
     * que nem sempre chegaram ao banco. O resultado, visto em 26/08/2026: a
     * posição inteira presa numa ordem que o registro não conhecia, e
     * "Encerrar" respondendo "Saldo insuficiente para vender" com a carteira
     * cheia. Cancelar tudo o que está aberto no par não tem esse ponto cego,
     * e encerrar é exatamente o momento em que nada deve sobrar no livro.
     */
    try {
      await cancelAllOpenOrders(trade.symbol);
    } catch (error) {
      logger.warn('Livro do par não pôde ser limpo ao encerrar', {
        tradeId: trade.id,
        error: (error as Error).message,
      });
    }
    // o saldo guardado é de ANTES do cancelamento, quando a moeda ainda
    // estava presa; ler o cache aqui recriaria o próprio erro que acabou
    // de ser corrigido
    invalidateAccountCache();

    if (trade.status === 'PENDING' || trade.remainingQuantity <= 0) {
      trade.status = 'CANCELLED';
      trade.outcome = 'MANUAL';
      trade.closeReason = reason;
      trade.closedAt = new Date().toISOString();
      trade.updatedAt = trade.closedAt;
      await this.persist(trade);
      // a tese volta para o radar: a ordem saiu sem comprar nada, e o setup
      // carimbado como "EM OPERAÇÃO" some da mesa para sempre
      if (this.releaseSetup) await this.releaseSetup(trade.setupId);
      this.audit.record({
        action: 'LIVE_ORDER_CANCELLED',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: trade.setupId,
        tradeId: trade.id,
        detail: { reason },
      });
      return trade;
    }

    // 2) vende só o que a conta realmente tem — o resto seria ordem recusada
    const filters = (await getSymbolFilters([trade.symbol], trade.market)).get(trade.symbol);
    if (!filters) throw new ExecutionError('Filtros do par indisponíveis — não dá para vender agora', 503);

    const balances = await getAccountBalances();
    const free = balances.find((item) => item.asset === filters.baseAsset)?.free ?? 0;
    const sellable = roundDownToStep(Math.min(trade.remainingQuantity, free), filters.stepSize);

    if (sellable <= 0 || sellable < filters.minQty) {
      throw new ExecutionError(
        `Saldo de ${filters.baseAsset} insuficiente para vender (livre ${free}, mínimo ${filters.minQty})`,
      );
    }

    const price = this.market.getPrice(trade.symbol) ?? trade.averageFillPrice ?? trade.entryPrice;
    if (filters.applyMinToMarket && sellable * price < filters.minNotional) {
      throw new ExecutionError(
        `Venda de ${(sellable * price).toFixed(2)} USDT abaixo do mínimo da Binance (${filters.minNotional})`,
      );
    }

    let response;
    try {
      response = await newOrder({
        symbol: trade.symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: formatQuantity(sellable, filters),
        newClientOrderId: `${trade.clientOrderId}x`.slice(0, 36),
      });
    } catch (error) {
      const message =
        error instanceof BinanceError
          ? `Binance recusou a venda: ${error.message} (código ${error.code})`
          : (error as Error).message;
      this.audit.record({
        action: 'MANUAL_CLOSE_FAILED',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: trade.setupId,
        tradeId: trade.id,
        detail: { message },
      });
      throw new ExecutionError(message, 502);
    }

    // 3) o resultado vem dos preenchimentos reais, não do preço que a tela mostrava
    const executed = Number(response.executedQty);
    const quoteQty = Number(response.cummulativeQuoteQty);
    const averagePrice = executed > 0 && quoteQty > 0 ? quoteQty / executed : price;
    const commission = (response.fills ?? []).reduce(
      (total, item) => total + Number(item.commission || 0),
      0,
    );
    const entry = trade.averageFillPrice ?? trade.entryPrice;
    const feePercent = this.settings.get().guard.feePercent;

    trade.realizedPnl = round(
      trade.realizedPnl +
        netPnl({ entryPrice: entry, exitPrice: averagePrice, quantity: executed, feePercent, side: trade.side }),
      2,
    );
    trade.feesPaid = round(trade.feesPaid + (commission > 0 ? commission : averagePrice * executed * (feePercent / 100)), 6);
    trade.remainingQuantity = round(Math.max(trade.remainingQuantity - executed, 0), 10);
    trade.realizedPnlPercent =
      trade.notional > 0 ? round((trade.realizedPnl / trade.notional) * 100, 2) : 0;
    trade.fills.push({
      kind: 'MANUAL',
      price: round(averagePrice, 8),
      quantity: executed,
      time: new Date().toISOString(),
      orderId: String(response.orderId),
      commission: commission > 0 ? commission : undefined,
    });
    trade.outcome = 'MANUAL';
    trade.closeReason = reason;
    /*
     * A venda a mercado pode deixar uma fração que existe na carteira, mas
     * que a Binance nunca aceitará em outra ordem. Isso não é uma posição em
     * andamento: é pó. Esperar o monitor periódico reconhecê-lo deixava o
     * card aberto por até um minuto, mostrando US$ 0,22 como se fosse a
     * operação inteira e dividindo o lucro total por essa sobra.
     *
     * Os filtros já estão em mãos neste ponto, portanto o encerramento pode e
     * deve terminar na mesma resposta que confirmou a venda.
     */
    const sobraEhPo = restoEhPo(trade.remainingQuantity, averagePrice, filters);
    if (trade.remainingQuantity <= 1e-10 || sobraEhPo) {
      const sobra = trade.remainingQuantity;
      trade.status = 'CLOSED';
      trade.remainingQuantity = 0;
      trade.closedAt = new Date().toISOString();
      if (sobra > 1e-10) {
        this.audit.record({
          action: 'LIVE_TRADE_DUST_CLOSED',
          mode: trade.mode,
          symbol: trade.symbol,
          setupId: trade.setupId,
          tradeId: trade.id,
          detail: {
            sobra,
            minimoDeLote: filters.minQty,
            nocionalMinimo: filters.minNotional,
            resultado: trade.realizedPnl,
            motivo: 'a sobra foi reconhecida no próprio encerramento manual',
          },
        });
      }
    }
    trade.updatedAt = new Date().toISOString();

    await this.persist(trade);
    this.audit.record({
      action: 'MANUAL_CLOSE_EXECUTED',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: { reason, quantidade: executed, preco: averagePrice, pnl: trade.realizedPnl },
    });
    if (trade.status === 'CLOSED') await this.onClosed(trade);
    return trade;
  }

  /**
   * Encerrar uma posição de FUTUROS.
   *
   * A ordem das etapas é a mesma do spot e pelo mesmo motivo: primeiro o
   * livro é limpo, senão a saída a mercado disputa a posição com o stop
   * `closePosition` que ainda está armado e uma das duas é recusada.
   *
   * A quantidade sai da POSIÇÃO na corretora, não do que está gravado aqui:
   * uma parcial que executou e ainda não foi reconciliada faria a saída pedir
   * mais do que existe — e `reduceOnly` recusa a ordem inteira, não o excesso.
   */
  private async closeFuturesPosition(trade: Trade, reason: string): Promise<Trade> {
    try {
      await cancelAllFuturesOrders(trade.symbol);
    } catch (error) {
      logger.warn('Livro de futuros não pôde ser limpo ao encerrar', {
        tradeId: trade.id,
        error: (error as Error).message,
      });
    }

    if (trade.status === 'PENDING' || trade.remainingQuantity <= 0) {
      trade.status = 'CANCELLED';
      trade.outcome = 'MANUAL';
      trade.closeReason = reason;
      trade.closedAt = new Date().toISOString();
      trade.updatedAt = trade.closedAt;
      await this.persist(trade);
      // a tese volta para o radar: a ordem saiu sem comprar nada, e o setup
      // carimbado como "EM OPERAÇÃO" some da mesa para sempre
      if (this.releaseSetup) await this.releaseSetup(trade.setupId);
      this.audit.record({
        action: 'LIVE_ORDER_CANCELLED',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: trade.setupId,
        tradeId: trade.id,
        detail: { reason, mercado: 'FUTURES' },
      });
      return trade;
    }

    const filters = (await getSymbolFilters([trade.symbol], trade.market)).get(trade.symbol);
    if (!filters) throw new ExecutionError('Filtros do par indisponíveis — não dá para sair agora', 503);

    const positions = await getFuturesPositions(trade.symbol);
    const live = Math.abs(positions.find((item) => item.symbol === trade.symbol)?.positionAmt ?? 0);
    const closable = roundDownToStep(Math.min(trade.remainingQuantity, live), filters.stepSize);

    if (closable <= 0) {
      // não há posição na corretora: o que sobrou aqui é registro, e insistir
      // numa ordem reduceOnly sem posição só produz -2022
      trade.remainingQuantity = 0;
      trade.status = 'CLOSED';
      trade.outcome = 'MANUAL';
      trade.closeReason = `${reason} — a posição já não existia na corretora`;
      trade.closedAt = new Date().toISOString();
      await this.persist(trade);
      await this.onClosed(trade);
      return trade;
    }

    let response;
    try {
      response = await futuresMarketExit({
        symbol: trade.symbol,
        positionSide: trade.side,
        quantity: formatQuantity(closable, filters),
        clientOrderId: `${trade.clientOrderId}x`.slice(0, 36),
      });
    } catch (error) {
      const message =
        error instanceof BinanceError
          ? `Binance recusou o encerramento: ${error.message} (código ${error.code})`
          : (error as Error).message;
      this.audit.record({
        action: 'MANUAL_CLOSE_FAILED',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: trade.setupId,
        tradeId: trade.id,
        detail: { message, mercado: 'FUTURES' },
      });
      throw new ExecutionError(message, 502);
    }

    const executed = Number(response.executedQty);
    const average = Number(response.avgPrice) > 0 ? Number(response.avgPrice) : Number(response.price);
    const price = average > 0 ? average : this.market.getPrice(trade.symbol) ?? trade.entryPrice;
    const entry = trade.averageFillPrice ?? trade.entryPrice;
    const feePercent = this.settings.get().guard.feePercent;

    trade.realizedPnl = round(
      trade.realizedPnl +
        netPnl({ entryPrice: entry, exitPrice: price, quantity: executed, feePercent, side: trade.side }),
      2,
    );
    trade.feesPaid = round(trade.feesPaid + price * executed * (feePercent / 100), 6);
    trade.remainingQuantity = round(Math.max(trade.remainingQuantity - executed, 0), 10);
    trade.realizedPnlPercent =
      trade.notional > 0 ? round((trade.realizedPnl / trade.notional) * 100, 2) : 0;
    trade.fills.push({
      kind: 'MANUAL',
      price: round(price, 8),
      quantity: executed,
      time: new Date().toISOString(),
      orderId: String(response.orderId),
    });
    trade.outcome = 'MANUAL';
    trade.closeReason = reason;
    if (trade.remainingQuantity <= 1e-10) {
      trade.status = 'CLOSED';
      trade.closedAt = new Date().toISOString();
    }
    trade.updatedAt = new Date().toISOString();

    await this.persist(trade);
    this.audit.record({
      action: 'MANUAL_CLOSE_EXECUTED',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: { reason, mercado: 'FUTURES', quantidade: executed, preco: price, pnl: trade.realizedPnl },
    });
    if (trade.status === 'CLOSED') await this.onClosed(trade);
    return trade;
  }

  private async persist(trade: Trade): Promise<void> {
    await this.repository.saveTrade(trade);
    this.paper.track(trade);
    this.bus.broadcast({ type: 'trade', payload: trade });
  }
}
