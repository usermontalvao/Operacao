import type { DetectorInput } from '../analysis.ts';
import type { Candle, SetupCandidate } from '../types.ts';
import { buildTargets, normalizeEntryZone } from './shared.ts';

/**
 * BREAKOUT + RETEST
 * Não basta romper. O sistema espera o preço voltar ao nível rompido e o
 * antigo teto virar chão. Quem compra o rompimento paga caro e leva o
 * pavio; quem compra o reteste tem invalidação a poucos passos.
 */
export function detectBreakoutRetest(input: DetectorInput): SetupCandidate | null {
  const { trigger, anchor } = input;
  const indicators = trigger.indicators;
  const structure = trigger.structure;
  const atrValue = indicators.atr14;
  const close = indicators.close;
  const breakout = structure.breakout;

  if (atrValue === null || atrValue <= 0 || !breakout) return null;
  if (breakout.failed) return null;
  // encostar no nível não basta: o comprador tem de ter aparecido depois do toque
  if (!breakout.confirmed || breakout.barsSinceConfirmation === null) return null;
  if (breakout.barsSinceBreakout < 1 || breakout.barsSinceBreakout > 10) return null;
  // confirmação velha já não é gatilho: o preço andou sem a gente
  if (breakout.barsSinceConfirmation > 4) return null;
  if (anchor.structure.trend === 'DOWN') return null;

  const level = breakout.level;
  // o nível rompido tem de estar sendo defendido agora
  if (close < level.low) return null;
  if (close > level.high + atrValue * 1.8) return null;

  const breakoutCandle = trigger.candles[breakout.breakoutIndex];
  const breakoutVolumeRatio = relativeVolumeAt(trigger.candles, breakout.breakoutIndex);
  if (breakoutVolumeRatio !== null && breakoutVolumeRatio < 1.1) return null;

  const [entryLow, entryHigh] = normalizeEntryZone(
    level.low - atrValue * 0.1,
    level.high + atrValue * 0.35,
    close,
  );
  const entryPrice = (entryLow + entryHigh) / 2;
  const stopLoss = level.low - atrValue * 0.9;
  if (stopLoss >= entryLow) return null;

  const consolidationHeight = Math.max(level.price - structure.recentLow, atrValue * 2);
  const measuredMove = level.high + consolidationHeight;
  const targets = buildTargets(
    entryPrice,
    stopLoss,
    structure.resistances,
    Math.max(structure.recentHigh, measuredMove),
    atrValue,
  );
  if (!targets) return null;

  const reasons: string[] = [
    `Rompimento da resistência de ${level.price.toPrecision(6)} no ${trigger.timeframe}`,
    `Reteste do nível ${breakout.barsSinceBreakout} candle(s) depois`,
    ...breakout.confirmationReasons,
  ];
  if (breakoutVolumeRatio !== null) {
    reasons.push(`Volume ${breakoutVolumeRatio.toFixed(1)}x a média no rompimento`);
  }
  if (breakoutCandle) {
    reasons.push(`Fechamento do rompimento em ${breakoutCandle.close.toPrecision(6)}`);
  }
  if (anchor.structure.trend === 'UP') reasons.push(`Tendência de alta no ${anchor.timeframe}`);

  return {
    symbol: input.analysis.symbol,
    timeframe: trigger.timeframe,
    anchorTimeframe: anchor.timeframe,
    setupType: 'BREAKOUT_RETEST',
    entryLow,
    entryHigh,
    stopLoss,
    target1: targets.target1,
    target2: targets.target2,
    target3: targets.target3,
    reasons,
    levelPrice: level.price,
    qualityHints: {
      levelQuality: level.quality,
      volumeConfirmation: (breakoutVolumeRatio ?? 0) >= 1.3,
      momentumTurning: (indicators.rsi14 ?? 50) > 50,
      trendAligned: anchor.structure.trend === 'UP',
    },
  };
}

function relativeVolumeAt(candles: Candle[], index: number, period = 20): number | null {
  if (index <= 0 || index >= candles.length) return null;
  const start = Math.max(0, index - period);
  const window = candles.slice(start, index);
  if (window.length === 0) return null;
  const average = window.reduce((acc, c) => acc + c.volume, 0) / window.length;
  if (average <= 0) return null;
  return (candles[index] as Candle).volume / average;
}
