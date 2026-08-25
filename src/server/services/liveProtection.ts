import type { AppSettings, SymbolFilters, Trade } from '../../core/types.ts';
import { buildExitPlan, SCALE_OUT, type ExitPlan } from '../../core/execution/exitPlan.ts';
import { formatPrice, formatQuantity } from '../../core/risk/index.ts';
import { cancelOrderList, marketSell, newOcoSellOrder } from '../binance/rest.ts';
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
   * Deixa a corretora com exatamente a proteção que o plano pede para a
   * quantidade que está na mão agora.
   */
  async rearm(
    trade: Trade,
    filters: SymbolFilters,
    stopPrice: number,
    why: string,
  ): Promise<ProtectionResult> {
    const quantity = trade.remainingQuantity;
    if (quantity <= 0) return { armed: false, kind: 'NONE', listIds: [], notes: ['sem posição'] };

    await this.cancelExisting(trade);

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

  /** Vende a mercado o que ficou descoberto — último recurso, nunca silencioso. */
  async panicSell(trade: Trade, filters: SymbolFilters, why: string): Promise<boolean> {
    if (trade.remainingQuantity <= 0) return false;
    try {
      await marketSell(
        trade.symbol,
        formatQuantity(trade.remainingQuantity, filters),
        this.listIdFor(trade, 99),
      );
      await this.audit.record({
        action: 'LIVE_PANIC_SELL',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: trade.setupId,
        tradeId: trade.id,
        detail: { motivo: why, quantidade: trade.remainingQuantity },
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
