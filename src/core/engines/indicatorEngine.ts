import type { Candle, IndicatorSnapshot, Timeframe } from '../types.ts';
import { atr, bollinger, ema, macd, rsi, volumeProfile } from '../indicators/index.ts';

function lastOf<T>(series: (T | null)[]): T | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function at<T>(series: (T | null)[], index: number): T | null {
  const value = series[index];
  return value === undefined ? null : value;
}

/**
 * Calcula a fotografia de indicadores de um timeframe.
 * Recebe SOMENTE candles fechados: o candle em formação mudaria o RSI a cada
 * tick e faria o setup piscar sem que nada tenha acontecido de fato.
 */
export function computeIndicators(candles: Candle[], timeframe: Timeframe): IndicatorSnapshot {
  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1];
  const close = last?.close ?? 0;

  const atrSeries = atr(candles, 14);
  const atr14 = lastOf(atrSeries);
  const macdSeries = macd(closes);
  const volume = volumeProfile(candles, 20);

  const macdLast = lastOf(macdSeries);
  const macdPrevIndex = macdSeries.length - 2;
  const macdPrev = macdPrevIndex >= 0 ? at(macdSeries, macdPrevIndex) : null;

  const changePercent =
    last && last.open > 0 ? ((last.close - last.open) / last.open) * 100 : 0;

  return {
    timeframe,
    close,
    ema20: lastOf(ema(closes, 20)),
    ema50: lastOf(ema(closes, 50)),
    ema200: lastOf(ema(closes, 200)),
    rsi14: lastOf(rsi(closes, 14)),
    macd: macdLast,
    macdPrev,
    atr14,
    atrPercent: atr14 !== null && close > 0 ? (atr14 / close) * 100 : null,
    bollinger: lastOf(bollinger(closes, 20, 2)),
    volume: last?.volume ?? 0,
    volumeAverage20: lastOf(volume.average),
    relativeVolume: lastOf(volume.relative),
    changePercent,
    candleCount: candles.length,
  };
}

/** RSI da barra anterior — usado para detectar saída de sobrevendido. */
export function previousRsi(candles: Candle[], period = 14): number | null {
  const series = rsi(candles.map((c) => c.close), period);
  const value = series[series.length - 2];
  return value === undefined ? null : value;
}
