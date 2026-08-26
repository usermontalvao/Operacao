import type { DetectorInput } from '../analysis.ts';
import { type Side, directionOf, isFavorable, worstOf } from '../direction.ts';
import type { Candle, PriceLevel, SetupCandidate } from '../types.ts';
import { isBearishRejection, isBullishRejection } from '../structure/index.ts';
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
  return detectLevelReversal(input, 'BUY');
}

/**
 * REVERSÃO EM RESISTÊNCIA — o espelho, só disponível em futuros.
 *
 * Mesma exigência de quatro confirmações. Não é vender toda alta: é vender
 * onde uma resistência já provada rejeitou o preço com volume.
 */
export function detectResistanceReversal(input: DetectorInput): SetupCandidate | null {
  return detectLevelReversal(input, 'SELL');
}

function detectLevelReversal(input: DetectorInput, side: Side): SetupCandidate | null {
  const { trigger, anchor } = input;
  const short = side === 'SELL';
  const indicators = trigger.indicators;
  const structure = trigger.structure;
  const atrValue = indicators.atr14;
  const close = indicators.close;
  const candles = trigger.candles;
  const last = candles[candles.length - 1];
  const direction = directionOf(side);

  if (atrValue === null || atrValue <= 0 || !last) return null;

  const level = pickLevel(short ? structure.resistances : structure.supports, last, atrValue, side);
  if (!level || level.quality < 0.5 || level.touches < 2) return null;

  const reasons: string[] = [];
  let confirmations = 0;

  const rsiValue = indicators.rsi14;
  const rsiPrevious = previousRsi(candles);
  const rsiExtreme = short ? 64 : 36;
  const rsiTurning =
    rsiValue !== null &&
    rsiPrevious !== null &&
    (short ? rsiPrevious > rsiExtreme && rsiValue < rsiPrevious : rsiPrevious < rsiExtreme && rsiValue > rsiPrevious);
  if (rsiTurning && rsiValue !== null && rsiPrevious !== null) {
    confirmations += 1;
    reasons.push(
      `RSI saindo de ${short ? 'sobrecomprado' : 'sobrevendido'} (${rsiPrevious.toFixed(0)} → ${rsiValue.toFixed(0)})`,
    );
  }
  if (short ? isBearishRejection(last) : isBullishRejection(last)) {
    confirmations += 1;
    reasons.push('Candle de rejeição com fechamento forte');
  }
  if ((indicators.relativeVolume ?? 0) >= 1.1) {
    confirmations += 1;
    reasons.push(
      `Volume ${(indicators.relativeVolume ?? 0).toFixed(1)}x a média na ${short ? 'rejeição' : 'defesa'}`,
    );
  }
  if (
    indicators.macd !== null &&
    indicators.macdPrev !== null &&
    (short
      ? indicators.macd.histogram < indicators.macdPrev.histogram
      : indicators.macd.histogram > indicators.macdPrev.histogram)
  ) {
    confirmations += 1;
    reasons.push(`Histograma do MACD ${short ? 'perdendo força' : 'melhorando'}`);
  }
  if (anchor.structure.trend !== (short ? 'UP' : 'DOWN')) {
    confirmations += 1;
    reasons.push(`Timeframe ${anchor.timeframe} sem tendência de ${short ? 'alta' : 'baixa'}`);
  }
  if (indicators.bollinger !== null) {
    const band = short ? indicators.bollinger.upper : indicators.bollinger.lower;
    const pierced = short ? last.high >= band : last.low <= band;
    const returned = short ? close < band : close > band;
    if (pierced && returned) {
      confirmations += 1;
      reasons.push(`Preço voltou da banda ${short ? 'superior' : 'inferior'} de Bollinger`);
    }
  }

  if (confirmations < REQUIRED_CONFIRMATIONS) return null;

  reasons.unshift(
    `${short ? 'Resistência' : 'Suporte'} de ${level.price.toPrecision(6)} com ${level.touches} toques`,
  );

  const far = short ? level.high : level.low;
  const near = short ? level.low : level.high;
  const [entryLow, entryHigh] = normalizeEntryZone(
    far,
    worstOf(side, close + direction * atrValue * 0.2, near + direction * atrValue * 0.6),
    close,
  );
  const entryPrice = (entryLow + entryHigh) / 2;
  const beyond = short ? Math.max(last.high, level.high) : Math.min(last.low, level.low);
  const stopLoss = beyond - direction * atrValue * 0.7;
  const entryEdge = short ? entryHigh : entryLow;
  if (!isFavorable(side, entryEdge, stopLoss)) return null;

  const targets = buildTargets(
    entryPrice,
    stopLoss,
    short ? structure.supports : structure.resistances,
    short ? structure.recentLow : structure.recentHigh,
    atrValue,
    side,
  );
  if (!targets) return null;

  return {
    symbol: input.analysis.symbol,
    side,
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
    levelPrice: level.price,
    qualityHints: {
      levelQuality: level.quality,
      volumeConfirmation: (indicators.relativeVolume ?? 0) >= 1.1,
      momentumTurning: true,
      trendAligned: anchor.structure.trend === (short ? 'DOWN' : 'UP'),
    },
  };
}

/**
 * O nível que a última barra realmente encostou: pela mínima quando se
 * procura defesa de suporte, pela máxima quando se procura rejeição em
 * resistência.
 */
function pickLevel(levels: PriceLevel[], last: Candle, atrValue: number, side: Side): PriceLevel | null {
  const touched = levels.filter((level) =>
    side === 'SELL'
      ? last.high >= level.low - atrValue * 0.5 && last.close <= level.high + atrValue * 0.2
      : last.low <= level.high + atrValue * 0.5 && last.close >= level.low - atrValue * 0.2,
  );
  if (touched.length === 0) return null;
  return touched.reduce((best, level) => (level.quality > best.quality ? level : best));
}
