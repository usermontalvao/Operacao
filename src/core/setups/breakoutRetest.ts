import type { DetectorInput } from '../analysis.ts';
import { type Side, bestOf, directionOf, gainPerUnit, isFavorable } from '../direction.ts';
import type { Candle, SetupCandidate } from '../types.ts';
import { buildTargets, normalizeEntryZone } from './shared.ts';

/**
 * BREAKOUT + RETEST
 * Não basta romper. O sistema espera o preço voltar ao nível rompido e o
 * antigo teto virar chão. Quem compra o rompimento paga caro e leva o
 * pavio; quem compra o reteste tem invalidação a poucos passos.
 */
export function detectBreakoutRetest(input: DetectorInput): SetupCandidate | null {
  return detectBreakRetest(input, 'BUY');
}

/**
 * PERDA DE SUPORTE + RETESTE — o espelho, só disponível em futuros.
 *
 * O antigo chão vira teto: o preço perde o suporte, volta a encostar nele por
 * baixo e é rejeitado. A invalidação fica logo acima do nível perdido.
 */
export function detectBreakdownRetest(input: DetectorInput): SetupCandidate | null {
  return detectBreakRetest(input, 'SELL');
}

function detectBreakRetest(input: DetectorInput, side: Side): SetupCandidate | null {
  const { trigger, anchor } = input;
  const short = side === 'SELL';
  const indicators = trigger.indicators;
  const structure = trigger.structure;
  const atrValue = indicators.atr14;
  const close = indicators.close;
  const direction = directionOf(side);
  const event = short ? structure.breakdown : structure.breakout;

  if (atrValue === null || atrValue <= 0 || !event) return null;
  if (event.failed) return null;
  // encostar no nível não basta: o lado que rompeu tem de ter aparecido de
  // novo depois do toque
  if (!event.confirmed || event.barsSinceConfirmation === null) return null;
  if (event.barsSinceBreakout < 1 || event.barsSinceBreakout > 10) return null;
  // confirmação velha já não é gatilho: o preço andou sem a gente
  if (event.barsSinceConfirmation > 4) return null;
  if (anchor.structure.trend === (short ? 'UP' : 'DOWN')) return null;

  const level = event.level;
  // a borda que o preço rompeu (vira o novo piso do comprado, o novo teto do
  // vendido) e a borda de trás, que só é ultrapassada quando a tese morre
  const far = short ? level.low : level.high;
  const near = short ? level.high : level.low;

  // o nível rompido tem de estar sendo defendido agora
  if (isFavorable(side, near, close)) return null;
  if (gainPerUnit(side, far, close) > atrValue * 1.8) return null;

  const eventCandle = trigger.candles[event.breakoutIndex];
  const eventVolumeRatio = relativeVolumeAt(trigger.candles, event.breakoutIndex);
  if (eventVolumeRatio !== null && eventVolumeRatio < 1.1) return null;

  const [entryLow, entryHigh] = normalizeEntryZone(
    near - direction * atrValue * 0.1,
    far + direction * atrValue * 0.35,
    close,
  );
  const entryPrice = (entryLow + entryHigh) / 2;
  const stopLoss = near - direction * atrValue * 0.9;
  const entryEdge = short ? entryHigh : entryLow;
  if (!isFavorable(side, entryEdge, stopLoss)) return null;

  // projeção do movimento: a altura da consolidação, jogada a partir do nível
  const consolidationHeight = Math.max(
    Math.abs(level.price - (short ? structure.recentHigh : structure.recentLow)),
    atrValue * 2,
  );
  const measuredMove = far + direction * consolidationHeight;
  const targets = buildTargets(
    entryPrice,
    stopLoss,
    short ? structure.supports : structure.resistances,
    // o alvo estrutural mais distante é o extremo recente OU a projeção da
    // consolidação — vale o que for mais longe no sentido da operação
    bestOf(side, short ? structure.recentLow : structure.recentHigh, measuredMove),
    atrValue,
    side,
  );
  if (!targets) return null;

  const reasons: string[] = [
    short
      ? `Perda do suporte de ${level.price.toPrecision(6)} no ${trigger.timeframe}`
      : `Rompimento da resistência de ${level.price.toPrecision(6)} no ${trigger.timeframe}`,
    `Reteste do nível ${event.barsSinceBreakout} candle(s) depois`,
    ...event.confirmationReasons,
  ];
  if (eventVolumeRatio !== null) {
    reasons.push(`Volume ${eventVolumeRatio.toFixed(1)}x a média no rompimento`);
  }
  if (eventCandle) {
    reasons.push(`Fechamento do rompimento em ${eventCandle.close.toPrecision(6)}`);
  }
  if (anchor.structure.trend === (short ? 'DOWN' : 'UP')) {
    reasons.push(`Tendência de ${short ? 'baixa' : 'alta'} no ${anchor.timeframe}`);
  }

  return {
    symbol: input.analysis.symbol,
    side,
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
      volumeConfirmation: (eventVolumeRatio ?? 0) >= 1.3,
      momentumTurning: short ? (indicators.rsi14 ?? 50) < 50 : (indicators.rsi14 ?? 50) > 50,
      trendAligned: anchor.structure.trend === (short ? 'DOWN' : 'UP'),
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
