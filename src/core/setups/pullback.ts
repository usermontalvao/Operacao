import type { DetectorInput } from '../analysis.ts';
import { type Side, bestOf, directionOf, gainPerUnit, isFavorable, worstOf } from '../direction.ts';
import type { Candle, PriceLevel, SetupCandidate } from '../types.ts';
import { isBearishRejection, isBullishRejection } from '../structure/index.ts';
import { buyingVolumeFading, sellingVolumeFading } from '../indicators/index.ts';
import { buildTargets, normalizeEntryZone } from './shared.ts';

/**
 * PULLBACK EM TENDÊNCIA
 * Tendência de alta no timeframe âncora, preço corrigindo até uma região de
 * suporte ou até a média, com o vendedor perdendo força. É o setup com melhor
 * assimetria porque a invalidação fica logo abaixo da região defendida.
 */
export function detectPullback(input: DetectorInput): SetupCandidate | null {
  return detectTrendPullback(input, 'BUY');
}

/**
 * REPIQUE EM TENDÊNCIA DE BAIXA — o espelho, só disponível em futuros.
 *
 * Mesma tese, virada: tendência de baixa na âncora, preço repicando até uma
 * resistência ou até a média, com o comprador perdendo força. A invalidação
 * fica logo acima da região que rejeitou o preço.
 */
export function detectRallyPullback(input: DetectorInput): SetupCandidate | null {
  return detectTrendPullback(input, 'SELL');
}

function detectTrendPullback(input: DetectorInput, side: Side): SetupCandidate | null {
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
  if (anchor.structure.trend !== (short ? 'DOWN' : 'UP')) return null;
  if (structure.trend === (short ? 'UP' : 'DOWN')) return null;

  // quanto o preço já andou CONTRA a tendência desde o extremo recente
  const retracePercent = short ? structure.bouncePercent : structure.pullbackPercent;
  if (retracePercent === null || retracePercent < 0.8 || retracePercent > 18) return null;

  // colado no extremo não é correção, é continuação — o ponto de entrada
  // ainda não nasceu
  const extreme = short ? structure.recentLow : structure.recentHigh;
  if (!isFavorable(side, extreme - direction * atrValue * 0.6, close)) return null;

  const level: PriceLevel | null = short ? structure.nearestResistance : structure.nearestSupport;
  const ema20 = indicators.ema20;
  const ema50 = indicators.ema50;

  // a borda do nível que o preço encontra vindo do lado dele
  const levelEdge = level === null ? null : short ? level.low : level.high;
  const nearLevel = levelEdge !== null && gainPerUnit(side, levelEdge, close) <= atrValue * 2;
  const nearMovingAverage =
    (ema20 !== null && Math.abs(close - ema20) <= atrValue * 1.2) ||
    (ema50 !== null && Math.abs(close - ema50) <= atrValue * 1.2);
  if (!nearLevel && !nearMovingAverage) return null;

  // RSI normalizado: a faixa espelhada é 100 − a original
  const rsiValue = indicators.rsi14;
  if (rsiValue === null) return null;
  const rsiFloor = short ? 38 : 34;
  const rsiCeiling = short ? 66 : 62;
  if (rsiValue < rsiFloor || rsiValue > rsiCeiling) return null;

  const volumeFading = short ? buyingVolumeFading(candles) : sellingVolumeFading(candles);
  const defense = short ? isBearishRejection(last) : isBullishRejection(last);
  if (!volumeFading && !defense) return null;

  const base = level?.price ?? ema20 ?? close;
  const recent = candles.slice(-6);
  const swingExtreme = short
    ? Math.max(...recent.map((c: Candle) => c.high))
    : Math.min(...recent.map((c: Candle) => c.low));
  // a borda de trás da zona é a menos funda das duas candidatas, e a da
  // frente é a menos ambiciosa — as duas medidas no sentido da operação
  const [entryLow, entryHigh] = normalizeEntryZone(
    bestOf(side, base - direction * atrValue * 0.35, close - direction * atrValue * 1.2),
    worstOf(side, close + direction * atrValue * 0.25, base + direction * atrValue * 0.9),
    close,
  );
  const entryPrice = (entryLow + entryHigh) / 2;

  // o stop fica além do nível defendido E do extremo recente, o que for mais longe
  const levelStop = short ? level?.high ?? base : level?.low ?? base;
  const beyond = short
    ? Math.max(levelStop, swingExtreme)
    : Math.min(levelStop, swingExtreme);
  const stopLoss = beyond - direction * atrValue * 0.5;
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

  const macdTurning =
    indicators.macd !== null &&
    indicators.macdPrev !== null &&
    (short
      ? indicators.macd.histogram < indicators.macdPrev.histogram
      : indicators.macd.histogram > indicators.macdPrev.histogram);

  const reasons: string[] = [
    `Tendência de ${short ? 'baixa' : 'alta'} no ${anchor.timeframe}`,
    short
      ? `Repique de ${retracePercent.toFixed(1)}% desde o fundo recente`
      : `Correção de ${retracePercent.toFixed(1)}% desde o topo recente`,
  ];
  if (nearLevel && level) {
    reasons.push(
      `Preço na região de ${short ? 'resistência' : 'suporte'} do ${trigger.timeframe} (${level.touches} toques)`,
    );
  }
  if (nearMovingAverage) reasons.push('Preço encostando na média móvel de referência');
  if (volumeFading) reasons.push(`Volume ${short ? 'comprador' : 'vendedor'} diminuindo`);
  if (defense) reasons.push(`Candle de ${short ? 'exaustão compradora' : 'defesa compradora'}`);
  if (macdTurning) reasons.push(`MACD virando ${short ? 'negativo' : 'positivo'}`);
  reasons.push(`RSI normalizado em ${rsiValue.toFixed(0)}`);

  return {
    symbol: input.analysis.symbol,
    side,
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
      levelQuality: level?.quality ?? 0.45,
      volumeConfirmation: volumeFading,
      momentumTurning: macdTurning || (short ? rsiValue < 55 : rsiValue > 45),
      trendAligned: true,
    },
  };
}
