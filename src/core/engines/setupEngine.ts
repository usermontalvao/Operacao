import type { DetectorInput, SymbolAnalysis, TimeframeAnalysis } from '../analysis.ts';
import {
  type Side,
  gainPerUnit,
  isFavorable,
  reachedTarget,
  stopBreached,
} from '../direction.ts';
import type {
  AppSettings,
  MarketContext,
  SetupCandidate,
  SetupEvidence,
  SetupVisualState,
  Timeframe,
  TradeSetup,
} from '../types.ts';
import {
  detectBreakdownRetest,
  detectBreakoutRetest,
  detectCollapseBurst,
  detectMomentumBurst,
  detectPullback,
  detectRallyPullback,
  detectResistanceReversal,
  detectSupportReversal,
} from '../setups/index.ts';
import { checkExtension, fingerprintOf } from '../setups/index.ts';
import { averageEntry, computeRiskReward, passesRiskReward, round } from '../risk/index.ts';
import { scoreMomentumBurst, scoreSetup } from './scoreEngine.ts';

export interface GenerateSetupsInput {
  analysis: SymbolAnalysis;
  context: MarketContext | null;
  settings: AppSettings;
  now: Date;
  makeId: () => string;
}

/** Os quatro detectores medidos, do lado comprado. */
const LONG_DETECTORS = [
  detectPullback,
  detectBreakoutRetest,
  detectSupportReversal,
  detectMomentumBurst,
];

/**
 * Os mesmos quatro, espelhados. Só entram em campo quando a modalidade é
 * futuros E a venda a descoberto está liberada: em spot não existe posição
 * vendida, e mostrar no radar uma tese que não dá para executar é convite a
 * tentar executá-la por fora.
 */
const SHORT_DETECTORS = [
  detectRallyPullback,
  detectBreakdownRetest,
  detectResistanceReversal,
  detectCollapseBurst,
];

/** O timeframe âncora define o viés; o gatilho define o ponto de entrada. */
export function anchorFor(trigger: Timeframe, fallback: Timeframe): Timeframe {
  if (trigger === '15m' || trigger === '1h') return '4h';
  if (trigger === '4h') return '1d';
  return fallback;
}

/**
 * Roda todos os detectores em todos os timeframes de gatilho e devolve
 * os setups já pontuados e filtrados por risco/retorno.
 */
export function generateSetups(input: GenerateSetupsInput): TradeSetup[] {
  const { analysis, context, settings, now, makeId } = input;
  const results: TradeSetup[] = [];

  for (const triggerTimeframe of settings.scanner.triggerTimeframes) {
    const trigger = analysis.timeframes[triggerTimeframe];
    if (!trigger) continue;
    const anchorTimeframe = anchorFor(triggerTimeframe, settings.scanner.anchorTimeframe);
    const anchor = analysis.timeframes[anchorTimeframe] ?? trigger;

    const detectors =
      settings.market === 'FUTURES' && settings.futures.allowShort
        ? [...LONG_DETECTORS, ...SHORT_DETECTORS]
        : LONG_DETECTORS;

    for (const detector of detectors) {
      const detectorInput: DetectorInput = { analysis, trigger, anchor, context };
      const candidate = detector(detectorInput);
      if (!candidate) continue;
      const setup = buildSetup({ candidate, trigger, anchor, analysis, context, settings, now, makeId });
      if (setup) results.push(setup);
    }
  }

  return dedupe(results);
}

interface BuildSetupInput {
  candidate: SetupCandidate;
  trigger: TimeframeAnalysis;
  anchor: TimeframeAnalysis;
  analysis: SymbolAnalysis;
  context: MarketContext | null;
  settings: AppSettings;
  now: Date;
  makeId: () => string;
}

function buildSetup(input: BuildSetupInput): TradeSetup | null {
  const { candidate, trigger, anchor, analysis, context, settings, now, makeId } = input;

  const side = candidate.side;
  const entryPrice = averageEntry(candidate.entryLow, candidate.entryHigh);
  const riskReward = computeRiskReward(entryPrice, candidate.stopLoss, candidate.target1, side);
  if (!passesRiskReward(riskReward, settings.risk.minimumRiskReward)) return null;

  // stop colado demais infla o R/R e vira estopada no primeiro ruído
  const atrValue = trigger.indicators.atr14 ?? 0;
  if (atrValue > 0 && -gainPerUnit(side, entryPrice, candidate.stopLoss) < atrValue * 0.45) {
    return null;
  }

  const burst = candidate.setupType === 'MOMENTUM_BURST';

  // "Esticado" é aviso para quem compra repique: o preço já se afastou do
  // ponto onde a tese nasce. Na entrada por explosão o preço afastado É a
  // tese — marcar isso como defeito seria recusar o setup por ser ele mesmo.
  const extension = burst
    ? { extended: false, reasons: [] }
    : checkExtension(trigger.indicators, trigger.candles, side);
  const dailyAnalysis = analysis.timeframes['1d'];
  if (!burst && dailyAnalysis) {
    const dailyExtension = checkExtension(dailyAnalysis.indicators, dailyAnalysis.candles, side);
    if (dailyExtension.extended) {
      extension.extended = true;
      extension.reasons.push(...dailyExtension.reasons);
    }
  }

  const scoreInput = { candidate, trigger, anchor, context, riskReward, extension };
  const breakdown = burst ? scoreMomentumBurst(scoreInput) : scoreSetup(scoreInput);
  if (breakdown.total < settings.risk.minimumScoreToShow) return null;

  const price = analysis.price > 0 ? analysis.price : trigger.indicators.close;
  const createdAt = now.toISOString();
  // a explosão tem validade de uma barra: ou o preço é pego junto do
  // fechamento que a gerou, ou a tese medida já não é aquela
  const ttlMinutes = burst
    ? Math.min(settings.scanner.setupTtlMinutes, minutesOf(candidate.timeframe))
    : settings.scanner.setupTtlMinutes;
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();

  const setup: TradeSetup = {
    id: makeId(),
    symbol: candidate.symbol,
    side,
    market: settings.market,
    timeframe: candidate.timeframe,
    anchorTimeframe: candidate.anchorTimeframe,
    setupType: candidate.setupType,
    currentPrice: price,
    entryLow: round(candidate.entryLow, 8),
    entryHigh: round(candidate.entryHigh, 8),
    stopLoss: round(candidate.stopLoss, 8),
    target1: round(candidate.target1, 8),
    target2: candidate.target2 === null ? null : round(candidate.target2, 8),
    target3: candidate.target3 === null ? null : round(candidate.target3, 8),
    riskReward,
    score: breakdown.total,
    classification: breakdown.classification,
    scoreBreakdown: breakdown,
    reasons: candidate.reasons,
    btcContext: context?.state ?? 'BTC_NEUTRAL',
    status: breakdown.total >= settings.risk.minimumScoreToAlert ? 'ACTIVE' : 'WATCHING',
    visualState: 'AGUARDANDO',
    extended: extension.extended,
    extensionReasons: extension.reasons,
    evidence: buildEvidence(candidate, trigger, anchor, context),
    fingerprint: fingerprintOf(
      candidate.symbol,
      candidate.setupType,
      candidate.timeframe,
      candidate.levelPrice,
      side,
    ),
    invalidationNote: null,
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    ignoredAt: null,
  };

  setup.visualState = resolveVisualState(setup, price);
  return setup;
}

/** Retrato dos números no instante do sinal, para auditar o acerto depois. */
function buildEvidence(
  candidate: SetupCandidate,
  trigger: TimeframeAnalysis,
  anchor: TimeframeAnalysis,
  context: MarketContext | null,
): SetupEvidence {
  const indicators = trigger.indicators;
  const atrValue = indicators.atr14;
  const ema20 = indicators.ema20;
  return {
    rsi14: indicators.rsi14,
    atrPercent: indicators.atrPercent,
    relativeVolume: indicators.relativeVolume,
    macdHistogram: indicators.macd?.histogram ?? null,
    distanceToEma20InAtr:
      ema20 !== null && atrValue !== null && atrValue > 0
        ? round((indicators.close - ema20) / atrValue, 2)
        : null,
    triggerTrend: trigger.structure.trend,
    anchorTrend: anchor.structure.trend,
    anchorStructure: anchor.structure.structure,
    levelQuality: round(candidate.qualityHints.levelQuality, 3),
    volumeConfirmation: candidate.qualityHints.volumeConfirmation,
    momentumTurning: candidate.qualityHints.momentumTurning,
    btcScoreModifier: context?.scoreModifier ?? 0,
  };
}

/**
 * Um setup por tipo, ativo e LADO: fica o de maior score.
 *
 * O lado entra na chave porque comprado e vendido no mesmo ativo são teses
 * opostas, não duas versões da mesma. Sem ele, a que chegasse depois apagaria
 * a outra em silêncio — e qual das duas sobreviveria dependeria da ordem em
 * que os detectores rodaram.
 */
function dedupe(setups: TradeSetup[]): TradeSetup[] {
  const best = new Map<string, TradeSetup>();
  for (const setup of setups) {
    const key = `${setup.symbol}:${setup.setupType}:${setup.side}`;
    const current = best.get(key);
    if (!current || setup.score > current.score) best.set(key, setup);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

export function resolveVisualState(setup: TradeSetup, price: number): SetupVisualState {
  const side: Side = setup.side;
  if (setup.status === 'INVALIDATED' || stopBreached(side, price, setup.stopLoss)) {
    return 'INVALIDADO';
  }
  if (setup.extended) return 'ESTICADO';
  if (price >= setup.entryLow && price <= setup.entryHigh) return 'COMPRAVEL';
  // "já foi" no sentido da operação: acima da zona no comprado, abaixo no vendido
  const aheadEdge = side === 'SELL' ? setup.entryLow : setup.entryHigh;
  const behindEdge = side === 'SELL' ? setup.entryHigh : setup.entryLow;
  const ahead = isFavorable(side, price, aheadEdge);
  if (
    setup.setupType === 'BREAKOUT_RETEST' &&
    ahead &&
    !reachedTarget(side, price, setup.target1)
  ) {
    return 'ROMPENDO';
  }
  if (ahead) {
    const distancePercent = Math.abs(((price - aheadEdge) / aheadEdge) * 100);
    if (distancePercent <= 1.5) return 'QUASE_LA';
  }
  if (isFavorable(side, behindEdge, price)) {
    const gap = Math.abs(((behindEdge - price) / behindEdge) * 100);
    if (gap <= 1.5) return 'QUASE_LA';
  }
  if (setup.setupType === 'BREAKOUT_RETEST') return 'RETESTANDO';
  if (setup.score >= 80) return 'SETUP_ATIVO';
  return 'AGUARDANDO';
}

/**
 * Atualiza o setup diante de um novo preço. É aqui que ele morre: stop
 * perdido antes da entrada, alvo atingido sem você, ou tempo esgotado.
 */
export function applyPriceUpdate(setup: TradeSetup, price: number, now: Date): TradeSetup {
  if (setup.status === 'BOUGHT' || setup.status === 'INVALIDATED' || setup.status === 'EXPIRED') {
    return setup;
  }

  const updated: TradeSetup = { ...setup, currentPrice: price, updatedAt: now.toISOString() };

  if (stopBreached(setup.side, price, setup.stopLoss)) {
    updated.status = 'INVALIDATED';
    updated.invalidationNote = `Invalidação atingida em ${price.toPrecision(6)} antes da entrada`;
    updated.visualState = 'INVALIDADO';
    return updated;
  }

  if (reachedTarget(setup.side, price, setup.target1)) {
    updated.status = 'EXPIRED';
    updated.invalidationNote = 'Alvo 1 atingido sem entrada — a oportunidade passou';
    updated.visualState = 'AGUARDANDO';
    return updated;
  }

  if (price >= setup.entryLow && price <= setup.entryHigh && setup.status !== 'TRIGGERED') {
    updated.status = 'TRIGGERED';
  }

  if (now.getTime() > new Date(setup.expiresAt).getTime()) {
    updated.status = 'EXPIRED';
    updated.invalidationNote = 'Setup expirou sem acionar o gatilho';
    return updated;
  }

  updated.visualState = resolveVisualState(updated, price);
  return updated;
}


function minutesOf(timeframe: Timeframe): number {
  if (timeframe === '15m') return 15;
  if (timeframe === '4h') return 240;
  if (timeframe === '1d') return 1440;
  return 60;
}
