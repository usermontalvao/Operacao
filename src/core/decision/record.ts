import type { PolicySnapshot } from '../policy/snapshot.ts';
import type { SetupType, Timeframe, TradingMode } from '../types.ts';
import type { DecisionCode, DecisionReason, EntryDecision, FunnelStage } from './types.ts';

/**
 * Decisão de entrada como ela fica gravada.
 *
 * Uma linha por "situação", não por tick. O robô considera o mesmo setup a
 * cada varredura; gravar tudo produziria milhares de linhas idênticas que
 * escondem justamente a informação procurada — quando a situação MUDOU.
 */
export interface EntryDecisionRecord {
  id: string;
  setupId: string;
  symbol: string;
  timeframe: Timeframe;
  setupType: SetupType;
  mode: TradingMode;
  score: number;
  allowed: boolean;
  code: DecisionCode;
  stage: FunnelStage;
  blockers: DecisionReason[];
  warnings: DecisionReason[];
  currentPrice: number;
  entryLow: number;
  entryHigh: number;
  distanceToEntryPercent: number;
  /** assinatura da situação: mesma assinatura = mesma linha */
  fingerprint: string;
  /** quantas vezes a mesma situação se repetiu */
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  policy: PolicySnapshot | null;
}

/**
 * Assinatura da situação.
 *
 * Junta o setup, o motivo e o quanto o preço está longe da zona — em faixas de
 * meio por cento. A faixa é o que evita duas armadilhas opostas: sem ela, cada
 * centavo de oscilação cria uma linha nova; com faixa grande demais, o preço
 * atravessa a zona inteira sem que nada seja registrado.
 */
export function decisionFingerprint(decision: EntryDecision, score: number): string {
  const faixa = Math.round(decision.distanceToEntryPercent * 2) / 2;
  const motivos = decision.blockers.map((blocker) => blocker.code).join(',') || 'ALLOWED';
  return `${decision.setupId}|${motivos}|${faixa.toFixed(1)}|${score}`;
}

export function buildDecisionRecord(input: {
  decision: EntryDecision;
  setupType: SetupType;
  timeframe: Timeframe;
  mode: TradingMode;
  score: number;
  policy: PolicySnapshot | null;
  id: string;
}): EntryDecisionRecord {
  const { decision, score } = input;
  return {
    id: input.id,
    setupId: decision.setupId,
    symbol: decision.symbol,
    timeframe: input.timeframe,
    setupType: input.setupType,
    mode: input.mode,
    score,
    allowed: decision.allowed,
    code: decision.code,
    stage: decision.stage,
    blockers: decision.blockers,
    warnings: decision.warnings,
    currentPrice: decision.currentPrice,
    entryLow: decision.entryLow,
    entryHigh: decision.entryHigh,
    distanceToEntryPercent: decision.distanceToEntryPercent,
    fingerprint: decisionFingerprint(decision, score),
    occurrences: 1,
    firstSeenAt: decision.evaluatedAt,
    lastSeenAt: decision.evaluatedAt,
    policy: input.policy,
  };
}

/**
 * Junta a repetição na linha que já existe.
 *
 * Devolve null quando não há nada a gravar — a mesma situação vista de novo
 * dentro da janela. É esse null que impede a auditoria de virar um diário de
 * ticks.
 */
export function mergeRepeatedDecision(
  existing: EntryDecisionRecord,
  next: EntryDecisionRecord,
  windowMs: number,
): EntryDecisionRecord | null {
  if (existing.fingerprint !== next.fingerprint) return next;
  const lastSeen = new Date(existing.lastSeenAt).getTime();
  const now = new Date(next.lastSeenAt).getTime();
  if (now - lastSeen < windowMs) return null;
  return {
    ...existing,
    occurrences: existing.occurrences + 1,
    lastSeenAt: next.lastSeenAt,
    currentPrice: next.currentPrice,
    distanceToEntryPercent: next.distanceToEntryPercent,
  };
}

/** Janela padrão de deduplicação: repetição só volta ao disco de 15 em 15 min. */
export const DECISION_DEDUP_WINDOW_MS = 15 * 60_000;
