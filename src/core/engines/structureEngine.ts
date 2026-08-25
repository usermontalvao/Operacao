import type { Candle, IndicatorSnapshot, StructureSnapshot, TrendState } from '../types.ts';
import {
  buildLevels,
  classifyStructure,
  detectBreakout,
  findSwings,
  isConsolidating,
  nearestAbove,
  nearestBelow,
  pullbackFromHigh,
} from '../structure/index.ts';

/**
 * Tendência = alinhamento de médias confirmado pela estrutura de topos e
 * fundos. Uma coisa sem a outra gera sinal em mercado lateral.
 */
export function classifyTrend(indicators: IndicatorSnapshot, structure: string): TrendState {
  const { ema20, ema50, ema200, close } = indicators;
  if (ema20 === null || ema50 === null) return 'SIDEWAYS';

  const stackedUp = ema20 > ema50 && (ema200 === null || ema50 > ema200);
  const stackedDown = ema20 < ema50 && (ema200 === null || ema50 < ema200);

  if (stackedUp && close > ema50 && structure !== 'LH_LL') return 'UP';
  if (stackedDown && close < ema50 && structure !== 'HH_HL') return 'DOWN';
  return 'SIDEWAYS';
}

export function computeStructure(
  candles: Candle[],
  indicators: IndicatorSnapshot,
): StructureSnapshot {
  const swings = findSwings(candles, 2);
  const marketStructure = classifyStructure(swings);
  const atrPercent = indicators.atrPercent ?? 1;
  const supports = buildLevels(candles, swings, 'LOW', atrPercent);
  const resistances = buildLevels(candles, swings, 'HIGH', atrPercent);
  const close = indicators.close;

  const window = candles.slice(-30);
  const recentHigh = window.length > 0 ? Math.max(...window.map((c) => c.high)) : close;
  const recentLow = window.length > 0 ? Math.min(...window.map((c) => c.low)) : close;

  return {
    timeframe: indicators.timeframe,
    trend: classifyTrend(indicators, marketStructure),
    structure: marketStructure,
    swings,
    supports,
    resistances,
    nearestSupport: nearestBelow(supports, close),
    nearestResistance: nearestAbove(resistances, close),
    breakout: detectBreakout(candles, resistances, atrPercent),
    consolidating: isConsolidating(candles, indicators.atr14 ?? 0),
    pullbackPercent: pullbackFromHigh(candles),
    recentHigh,
    recentLow,
  };
}
