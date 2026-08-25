import type { DetectorInput } from '../analysis.ts';
import type { Candle, SetupCandidate } from '../types.ts';
import { isBullishRejection } from '../structure/index.ts';
import { sellingVolumeFading } from '../indicators/index.ts';
import { buildTargets, normalizeEntryZone } from './shared.ts';

/**
 * PULLBACK EM TENDÊNCIA
 * Tendência de alta no timeframe âncora, preço corrigindo até uma região de
 * suporte ou até a média, com o vendedor perdendo força. É o setup com melhor
 * assimetria porque a invalidação fica logo abaixo da região defendida.
 */
export function detectPullback(input: DetectorInput): SetupCandidate | null {
  const { trigger, anchor } = input;
  const indicators = trigger.indicators;
  const structure = trigger.structure;
  const atrValue = indicators.atr14;
  const close = indicators.close;
  const candles = trigger.candles;
  const last = candles[candles.length - 1];

  if (atrValue === null || atrValue <= 0 || !last) return null;
  if (anchor.structure.trend !== 'UP') return null;
  if (structure.trend === 'DOWN') return null;

  const pullbackPercent = structure.pullbackPercent;
  if (pullbackPercent === null || pullbackPercent < 0.8 || pullbackPercent > 18) return null;
  if (close > structure.recentHigh - atrValue * 0.6) return null;

  const support = structure.nearestSupport;
  const ema20 = indicators.ema20;
  const ema50 = indicators.ema50;

  const nearSupport = support !== null && close - support.high <= atrValue * 2;
  const nearMovingAverage =
    (ema20 !== null && Math.abs(close - ema20) <= atrValue * 1.2) ||
    (ema50 !== null && Math.abs(close - ema50) <= atrValue * 1.2);
  if (!nearSupport && !nearMovingAverage) return null;

  const rsiValue = indicators.rsi14;
  if (rsiValue === null || rsiValue < 34 || rsiValue > 62) return null;

  const volumeFading = sellingVolumeFading(candles);
  const buyerDefense = isBullishRejection(last);
  if (!volumeFading && !buyerDefense) return null;

  const base = support?.price ?? ema20 ?? close;
  const swingLow = Math.min(...candles.slice(-6).map((c: Candle) => c.low));
  const [entryLow, entryHigh] = normalizeEntryZone(
    Math.max(base - atrValue * 0.35, close - atrValue * 1.2),
    Math.min(close + atrValue * 0.25, base + atrValue * 0.9),
    close,
  );
  const entryPrice = (entryLow + entryHigh) / 2;
  const stopLoss = Math.min(support?.low ?? base, swingLow) - atrValue * 0.5;
  if (stopLoss >= entryLow) return null;

  const targets = buildTargets(
    entryPrice,
    stopLoss,
    structure.resistances,
    structure.recentHigh,
    atrValue,
  );
  if (!targets) return null;

  const macdTurning =
    indicators.macd !== null &&
    indicators.macdPrev !== null &&
    indicators.macd.histogram > indicators.macdPrev.histogram;

  const reasons: string[] = [
    `Tendência de alta no ${anchor.timeframe}`,
    `Correção de ${pullbackPercent.toFixed(1)}% desde o topo recente`,
  ];
  if (nearSupport && support) {
    reasons.push(`Preço na região de suporte do ${trigger.timeframe} (${support.touches} toques)`);
  }
  if (nearMovingAverage) reasons.push('Preço encostando na média móvel de referência');
  if (volumeFading) reasons.push('Volume vendedor diminuindo');
  if (buyerDefense) reasons.push('Candle de defesa compradora');
  if (macdTurning) reasons.push('MACD virando positivo');
  reasons.push(`RSI normalizado em ${rsiValue.toFixed(0)}`);

  return {
    symbol: input.analysis.symbol,
    timeframe: trigger.timeframe,
    anchorTimeframe: anchor.timeframe,
    setupType: 'PULLBACK',
    entryLow,
    entryHigh,
    stopLoss,
    target1: targets.target1,
    target2: targets.target2,
    target3: targets.target3,
    reasons,
    levelPrice: base,
    qualityHints: {
      levelQuality: support?.quality ?? 0.45,
      volumeConfirmation: volumeFading,
      momentumTurning: macdTurning || rsiValue > 45,
      trendAligned: true,
    },
  };
}
