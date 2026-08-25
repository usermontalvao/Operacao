import { randomUUID } from 'node:crypto';
import type { DecisionRecord, Trade, TradeSetup } from '../../core/types.ts';
import { postMortemOf } from '../../core/journal/postMortem.ts';
import { logger } from '../logger.ts';
import type { Repository } from '../store/index.ts';

/**
 * Diário de decisões. Toda operação encerrada vira uma linha que guarda o que
 * o sistema enxergava quando decidiu (score, componentes, indicadores) ao lado
 * do que realmente aconteceu. É essa tabela que responde depois: qual fator
 * estava certo e qual estava errado.
 */
export class DecisionJournal {
  private readonly repository: Repository;

  constructor(repository: Repository) {
    this.repository = repository;
  }

  async record(trade: Trade): Promise<DecisionRecord | null> {
    if (trade.status !== 'CLOSED') return null;
    try {
      const setups = await this.repository.listSetups();
      const setup = setups.find((item) => item.id === trade.setupId);
      if (!setup) {
        logger.warn('Operação encerrada sem setup correspondente', { tradeId: trade.id });
        return null;
      }
      const decision = buildDecision(trade, setup);
      await this.repository.saveDecision(decision);
      return decision;
    } catch (error) {
      logger.error('Falha ao gravar decisão', { error: (error as Error).message });
      return null;
    }
  }
}

export function buildDecision(trade: Trade, setup: TradeSetup): DecisionRecord {
  const closedAt = trade.closedAt ?? new Date().toISOString();
  const durationMinutes =
    (new Date(closedAt).getTime() - new Date(trade.openedAt).getTime()) / 60_000;

  return {
    id: randomUUID(),
    tradeId: trade.id,
    setupId: setup.id,
    symbol: trade.symbol,
    mode: trade.mode,
    setupType: setup.setupType,
    timeframe: setup.timeframe,
    anchorTimeframe: setup.anchorTimeframe,
    score: setup.score,
    classification: setup.classification,
    riskReward: setup.riskReward,
    automatic: trade.automatic === true,
    components: setup.scoreBreakdown.components,
    penalties: setup.scoreBreakdown.penalties,
    reasons: setup.reasons,
    evidence: setup.evidence,
    btcContext: setup.btcContext,
    extended: setup.extended,
    entryPrice: trade.averageFillPrice ?? trade.entryPrice,
    stopLoss: trade.stopLoss,
    target1: trade.target1,
    outcome: trade.outcome,
    realizedPnl: trade.realizedPnl,
    realizedPnlPercent: trade.realizedPnlPercent,
    maxFavorablePercent: trade.maxFavorablePercent,
    maxAdversePercent: trade.maxAdversePercent,
    durationMinutes: Math.round(durationMinutes),
    openedAt: trade.openedAt,
    closedAt,
    postMortem: postMortemOf({
      entryPrice: trade.averageFillPrice ?? trade.entryPrice,
      // o stop pode ter subido durante a operação; a autópsia é sobre o plano
      // original, que é o que decidiu o tamanho da posição
      stopLoss: trade.protectiveStop === null ? trade.stopLoss : setup.stopLoss,
      target1: trade.target1,
      maxFavorablePercent: trade.maxFavorablePercent,
      maxAdversePercent: trade.maxAdversePercent,
      realizedPnlPercent: trade.realizedPnlPercent,
      outcome: trade.outcome,
      durationMinutes,
    }),
  };
}
