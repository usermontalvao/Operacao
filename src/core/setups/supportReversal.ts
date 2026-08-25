import type { DetectorInput } from '../analysis.ts';
import type { Candle, SetupCandidate } from '../types.ts';
import { isBullishRejection } from '../structure/index.ts';
import { previousRsi } from '../engines/indicatorEngine.ts';
import { buildTargets, normalizeEntryZone } from './shared.ts';

const REQUIRED_CONFIRMATIONS = 4;

/**
 * REVERSÃO EM SUPORTE
 * O setup mais perigoso da lista, então é o mais exigente: só passa com
 * quatro confirmações simultâneas. A ideia não é pegar toda faca caindo,
 * é comprar onde um suporte já provado foi defendido com volume.
 */
export function detectSupportReversal(input: DetectorInput): SetupCandidate | null {
  const { trigger, anchor } = input;
  const indicators = trigger.indicators;
  const structure = trigger.structure;
  const atrValue = indicators.atr14;
  const close = indicators.close;
  const candles = trigger.candles;
  const last = candles[candles.length - 1];

  if (atrValue === null || atrValue <= 0 || !last) return null;

  const support = pickSupport(structure.supports, last, atrValue);
  if (!support || support.quality < 0.5 || support.touches < 2) return null;

  const reasons: string[] = [];
  let confirmations = 0;

  const rsiValue = indicators.rsi14;
  const rsiPrevious = previousRsi(candles);
  if (rsiValue !== null && rsiPrevious !== null && rsiPrevious < 36 && rsiValue > rsiPrevious) {
    confirmations += 1;
    reasons.push(`RSI saindo de sobrevendido (${rsiPrevious.toFixed(0)} → ${rsiValue.toFixed(0)})`);
  }
  if (isBullishRejection(last)) {
    confirmations += 1;
    reasons.push('Candle de rejeição com fechamento forte');
  }
  if ((indicators.relativeVolume ?? 0) >= 1.1) {
    confirmations += 1;
    reasons.push(`Volume ${(indicators.relativeVolume ?? 0).toFixed(1)}x a média na defesa`);
  }
  if (
    indicators.macd !== null &&
    indicators.macdPrev !== null &&
    indicators.macd.histogram > indicators.macdPrev.histogram
  ) {
    confirmations += 1;
    reasons.push('Histograma do MACD melhorando');
  }
  if (anchor.structure.trend !== 'DOWN') {
    confirmations += 1;
    reasons.push(`Timeframe ${anchor.timeframe} sem tendência de baixa`);
  }
  if (
    indicators.bollinger !== null &&
    last.low <= indicators.bollinger.lower &&
    close > indicators.bollinger.lower
  ) {
    confirmations += 1;
    reasons.push('Preço recuperou a banda inferior de Bollinger');
  }

  if (confirmations < REQUIRED_CONFIRMATIONS) return null;

  reasons.unshift(`Suporte de ${support.price.toPrecision(6)} com ${support.touches} toques`);

  const [entryLow, entryHigh] = normalizeEntryZone(
    support.low,
    Math.min(close + atrValue * 0.2, support.high + atrValue * 0.6),
    close,
  );
  const entryPrice = (entryLow + entryHigh) / 2;
  const stopLoss = Math.min(last.low, support.low) - atrValue * 0.7;
  if (stopLoss >= entryLow) return null;

  const targets = buildTargets(
    entryPrice,
    stopLoss,
    structure.resistances,
    structure.recentHigh,
    atrValue,
  );
  if (!targets) return null;

  return {
    symbol: input.analysis.symbol,
    timeframe: trigger.timeframe,
    anchorTimeframe: anchor.timeframe,
    setupType: 'SUPPORT_REVERSAL',
    entryLow,
    entryHigh,
    stopLoss,
    target1: targets.target1,
    target2: targets.target2,
    target3: targets.target3,
    reasons,
    levelPrice: support.price,
    qualityHints: {
      levelQuality: support.quality,
      volumeConfirmation: (indicators.relativeVolume ?? 0) >= 1.1,
      momentumTurning: true,
      trendAligned: anchor.structure.trend === 'UP',
    },
  };
}

function pickSupport(
  supports: DetectorInput['trigger']['structure']['supports'],
  last: Candle,
  atrValue: number,
) {
  const touched = supports.filter(
    (level) => last.low <= level.high + atrValue * 0.5 && last.close >= level.low - atrValue * 0.2,
  );
  if (touched.length === 0) return null;
  return touched.reduce((best, level) => (level.quality > best.quality ? level : best));
}
