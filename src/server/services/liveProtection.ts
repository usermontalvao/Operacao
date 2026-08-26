import type { AppSettings, SymbolFilters, Trade } from '../../core/types.ts';
import { sideLabel } from '../../core/direction.ts';
import { buildExitPlan, SCALE_OUT, type ExitPlan } from '../../core/execution/exitPlan.ts';
import { formatPrice, formatQuantity } from '../../core/risk/index.ts';
import { quantidadeVendavel } from '../../core/execution/posicaoReal.ts';
import { cancelOrderList, getAccountBalances, marketSell, newOcoSellOrder } from '../binance/rest.ts';
import {
  cancelAllFuturesOrders,
  futuresMarketExit,
  futuresStopOrder,
  futuresTakeProfitOrder,
} from '../binance/futures.ts';
import { logger } from '../logger.ts';
import type { AuditService } from './auditService.ts';
import type { SettingsService } from './settingsService.ts';

export interface ProtectionResult {
  armed: boolean;
  kind: ExitPlan['kind'] | 'NONE';
  listIds: string[];
  notes: string[];
}

/**
 * Quem garante que a posição aberta tem alvo e stop NA CORRETORA.
 *
 * Três coisas moram aqui porque as três dependem do mesmo par cancelar/recriar:
 *  - executar na conta real o mesmo plano de saída do papel;
 *  - subir o stop sem, no caminho, mandar uma ordem de compra (era o que o
 *    OTOCO fazia: ele nasce com uma ordem de trabalho de COMPRA);
 *  - cobrir a posição que a entrada preencheu pela metade, situação em que o
 *    OTOCO ainda não armou nada.
 *
 * Entre cancelar a proteção velha e a nova entrar no livro existe uma janela
 * em que a posição está descoberta. Não dá para eliminá-la — a corretora
 * prende o saldo na ordem existente. Dá para não sair dela em silêncio: toda
 * falha termina em venda a mercado ou em alarme gravado.
 */
export class LiveProtection {
  private readonly audit: AuditService;
  private readonly settings: SettingsService;

  constructor(audit: AuditService, settings: SettingsService) {
    this.audit = audit;
    this.settings = settings;
  }

  private guard(): AppSettings['guard'] {
    return this.settings.get().guard;
  }

  /**
   * Quanto do ativo está livre na conta agora.
   *
   * Falha de leitura devolve a quantidade da operação: ficar sem proteção
   * porque a consulta de saldo não respondeu seria trocar um risco pequeno
   * (ordem recusada) pelo maior de todos (posição sem stop).
   */
  private async livreNaCarteira(trade: Trade, filters: SymbolFilters): Promise<number> {
    try {
      const balances = await getAccountBalances();
      return balances.find((item) => item.asset === filters.baseAsset)?.free ?? 0;
    } catch (error) {
      logger.warn('Saldo do ativo não pôde ser lido antes de proteger', {
        tradeId: trade.id,
        error: (error as Error).message,
      });
      return trade.remainingQuantity;
    }
  }

  /**
   * Deixa a corretora com exatamente a proteção que o plano pede para a
   * quantidade que está na mão agora.
   */
  async rearm(
    trade: Trade,
    filters: SymbolFilters,
    stopPrice: number,
    why: string,
  ): Promise<ProtectionResult> {
    if (trade.remainingQuantity <= 0) {
      return { armed: false, kind: 'NONE', listIds: [], notes: ['sem posição'] };
    }

    if (trade.market === 'FUTURES') return this.rearmFutures(trade, filters, stopPrice, why);

    await this.cancelExisting(trade);

    /*
     * O plano é feito sobre o que a CARTEIRA tem, não sobre o que a operação
     * diz ter.
     *
     * Sem BNB para pagar taxa, a Binance cobra a comissão da compra na moeda
     * comprada: entram 1156,94 de um preenchimento de 1158,1. Pedir o número
     * bruto não produz uma venda menor — produz recusa. Em 26/08/2026 isso
     * derrubou as três ordens de proteção E a venda de emergência, e uma
     * posição real passou 23 minutos sem stop. O encerramento manual já
     * limitava pela carteira; era o único lugar que limitava.
     */
    const emMaos = await this.livreNaCarteira(trade, filters);
    const quantity = quantidadeVendavel(trade.remainingQuantity, emMaos, filters.stepSize);
    if (quantity <= 0) {
      const nota = `Carteira tem ${emMaos} ${filters.baseAsset} — nada a proteger`;
      await this.alarm(trade, why, [nota]);
      return { armed: false, kind: 'NONE', listIds: [], notes: [nota] };
    }

    const guard = this.guard();
    const plan = buildExitPlan({
      quantity,
      target1: trade.target1,
      target2: guard.liveScaleOut ? trade.target2 : null,
      target3: guard.liveScaleOut ? trade.target3 : null,
      shares: guard.liveScaleOut ? SCALE_OUT : [1, 0, 0],
      filters: {
        stepSize: filters.stepSize,
        minQty: filters.minQty,
        minNotional: filters.minNotional,
      },
    });

    const stopTrigger = formatPrice(stopPrice, filters);
    const stopLimit = formatPrice(stopPrice - filters.tickSize, filters);
    const listIds: string[] = [];
    const notes = [...plan.notes];
    let placed = 0;

    for (const [index, tranche] of plan.tranches.entries()) {
      const listId = this.listIdFor(trade, index);
      try {
        const result = await newOcoSellOrder({
          symbol: trade.symbol,
          listClientOrderId: listId,
          quantity: formatQuantity(tranche.quantity, filters),
          takeProfitPrice: formatPrice(tranche.price, filters),
          stopPrice: stopTrigger,
          stopLimitPrice: stopLimit,
        });
        listIds.push(result.listClientOrderId || listId);
        placed += tranche.quantity;
      } catch (error) {
        notes.push(`${tranche.kind} recusado: ${(error as Error).message}`);
        logger.warn('Parcela de proteção recusada', {
          tradeId: trade.id,
          tranche: tranche.kind,
          error: (error as Error).message,
        });
      }
    }

    const uncovered = quantity - placed;
    if (uncovered > 0 && listIds.length > 0) {
      // sobrou posição sem cobertura: uma trava só, no alvo 1, é melhor que nada
      const rescued = await this.placeSingle(trade, filters, uncovered, stopTrigger, stopLimit);
      if (rescued) {
        listIds.push(rescued);
        notes.push('Sobra coberta por uma trava única no alvo 1');
      }
    }

    trade.protectionListIds = listIds;
    trade.exitPlanKind = plan.kind;

    if (listIds.length === 0) {
      await this.alarm(trade, why, notes);
      return { armed: false, kind: 'NONE', listIds, notes };
    }

    await this.audit.record({
      action: 'LIVE_PROTECTION_ARMED',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: {
        motivo: why,
        plano: plan.kind,
        parcelas: plan.tranches.map((item) => ({ alvo: item.kind, quantidade: item.quantity })),
        stop: stopTrigger,
        listas: listIds,
        observacoes: notes,
      },
    });
    return { armed: true, kind: plan.kind, listIds, notes };
  }

  /**
   * Proteção de uma posição de FUTUROS.
   *
   * Não existe OCO aqui. O que existe é:
   *   - UM stop `closePosition` de mercado, que fecha o que houver e some
   *     sozinho quando a posição zera. É o mais parecido com o OCO do spot, e
   *     é o único desenho em que uma saída parcial não deixa um stop com
   *     quantidade velha pronto para inverter a posição;
   *   - uma ordem limitada `reduceOnly` por alvo.
   *
   * O gatilho do stop é o preço de MARCA, o mesmo que a corretora usa para
   * liquidar. Preso ao último negócio, um pavio isolado dispararia o stop sem
   * ter chegado perto da liquidação.
   */
  private async rearmFutures(
    trade: Trade,
    filters: SymbolFilters,
    stopPrice: number,
    why: string,
  ): Promise<ProtectionResult> {
    const quantity = trade.remainingQuantity;
    const guard = this.guard();

    // o livro do par é zerado inteiro: ordens reduceOnly que sobraram de um
    // rearme anterior não somem sozinhas e disputariam a mesma posição
    try {
      await cancelAllFuturesOrders(trade.symbol);
    } catch (error) {
      logger.warn('Livro de futuros não pôde ser limpo antes do rearme', {
        tradeId: trade.id,
        error: (error as Error).message,
      });
    }
    trade.protectionListIds = [];

    const plan = buildExitPlan({
      quantity,
      target1: trade.target1,
      target2: guard.liveScaleOut ? trade.target2 : null,
      target3: guard.liveScaleOut ? trade.target3 : null,
      shares: guard.liveScaleOut ? SCALE_OUT : [1, 0, 0],
      filters: {
        stepSize: filters.stepSize,
        minQty: filters.minQty,
        minNotional: filters.minNotional,
      },
    });

    const ids: string[] = [];
    const notes = [...plan.notes];

    // o stop primeiro, e SEMPRE: entre proteger o capital e perseguir o alvo,
    // a ordem de envio decide o que existe se a segunda chamada falhar
    let stopArmed = false;
    try {
      const stop = await futuresStopOrder({
        symbol: trade.symbol,
        positionSide: trade.side,
        stopPrice: formatPrice(stopPrice, filters),
        clientOrderId: this.listIdFor(trade, 0),
      });
      ids.push(String(stop.orderId));
      stopArmed = true;
    } catch (error) {
      notes.push(`Stop recusado: ${(error as Error).message}`);
    }

    for (const [index, tranche] of plan.tranches.entries()) {
      try {
        const order = await futuresTakeProfitOrder({
          symbol: trade.symbol,
          positionSide: trade.side,
          quantity: formatQuantity(tranche.quantity, filters),
          price: formatPrice(tranche.price, filters),
          clientOrderId: this.listIdFor(trade, index + 1),
        });
        ids.push(String(order.orderId));
      } catch (error) {
        notes.push(`${tranche.kind} recusado: ${(error as Error).message}`);
      }
    }

    trade.protectionListIds = ids;
    trade.exitPlanKind = plan.kind;

    if (!stopArmed) {
      await this.alarm(trade, why, notes);
      return { armed: false, kind: 'NONE', listIds: ids, notes };
    }

    await this.audit.record({
      action: 'LIVE_PROTECTION_ARMED',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: {
        mercado: 'FUTURES',
        lado: sideLabel(trade.side),
        motivo: why,
        plano: plan.kind,
        parcelas: plan.tranches.map((item) => ({ alvo: item.kind, quantidade: item.quantity })),
        stop: stopPrice,
        ordens: ids,
        observacoes: notes,
      },
    });
    return { armed: true, kind: plan.kind, listIds: ids, notes };
  }

  /** Encerra a mercado o que ficou descoberto — último recurso, nunca silencioso. */
  async panicSell(trade: Trade, filters: SymbolFilters, why: string): Promise<boolean> {
    if (trade.remainingQuantity <= 0) return false;
    /*
     * A última rede não pode cair pelo mesmo motivo que derrubou as outras.
     *
     * Em 26/08/2026 as três ordens de proteção foram recusadas por saldo
     * insuficiente — e esta venda, que existe justamente para salvar o que
     * sobrou, pediu o mesmo número bruto e levou a mesma recusa. Em futuros
     * não há taxa em moeda-base: a posição é a que a corretora diz que é.
     */
    const quantity =
      trade.market === 'FUTURES'
        ? trade.remainingQuantity
        : quantidadeVendavel(
            trade.remainingQuantity,
            await this.livreNaCarteira(trade, filters),
            filters.stepSize,
          );
    if (quantity <= 0) {
      await this.alarm(trade, `${why} — carteira sem ${filters.baseAsset} para vender`, [
        `operação diz ter ${trade.remainingQuantity}, a conta não tem nada vendável`,
      ]);
      return false;
    }
    try {
      if (trade.market === 'FUTURES') {
        await cancelAllFuturesOrders(trade.symbol);
        await futuresMarketExit({
          symbol: trade.symbol,
          positionSide: trade.side,
          quantity: formatQuantity(quantity, filters),
          clientOrderId: this.listIdFor(trade, 98),
        });
      } else {
        await marketSell(trade.symbol, formatQuantity(quantity, filters), this.listIdFor(trade, 99));
      }
      await this.audit.record({
        action: 'LIVE_PANIC_SELL',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: trade.setupId,
        tradeId: trade.id,
        detail: { motivo: why, quantidade: quantity, naOperacao: trade.remainingQuantity },
      });
      return true;
    } catch (error) {
      await this.alarm(trade, `${why} — e a venda a mercado também falhou`, [
        (error as Error).message,
      ]);
      return false;
    }
  }

  private async placeSingle(
    trade: Trade,
    filters: SymbolFilters,
    quantity: number,
    stopTrigger: string,
    stopLimit: string,
  ): Promise<string | null> {
    try {
      const result = await newOcoSellOrder({
        symbol: trade.symbol,
        listClientOrderId: this.listIdFor(trade, 90),
        quantity: formatQuantity(quantity, filters),
        takeProfitPrice: formatPrice(trade.target1, filters),
        stopPrice: stopTrigger,
        stopLimitPrice: stopLimit,
      });
      return result.listClientOrderId;
    } catch {
      return null;
    }
  }

  private async cancelExisting(trade: Trade): Promise<void> {
    const lists = [...new Set([...(trade.protectionListIds ?? []), trade.clientOrderId])];
    for (const listId of lists) {
      try {
        await cancelOrderList(trade.symbol, listId);
      } catch (error) {
        // lista já encerrada ou inexistente é o caso comum, não é erro
        logger.debug('Lista de proteção não cancelada', {
          tradeId: trade.id,
          listId,
          error: (error as Error).message,
        });
      }
    }
    trade.protectionListIds = [];
  }

  /** Id único e curto: a Binance recusa repetido e corta acima de 36 caracteres. */
  private listIdFor(trade: Trade, index: number): string {
    const stamp = Date.now().toString(36).slice(-6);
    return `${trade.clientOrderId}x${stamp}${index}`.slice(0, 36);
  }

  private async alarm(trade: Trade, why: string, notes: string[]): Promise<void> {
    await this.audit.record({
      action: 'PROTECTIVE_STOP_FAILED',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: {
        alerta: 'POSIÇÃO SEM PROTEÇÃO NA CORRETORA — encerre manualmente',
        motivo: why,
        observacoes: notes,
      },
    });
    logger.error('Posição sem proteção na corretora', { tradeId: trade.id, symbol: trade.symbol, why });
  }
}
