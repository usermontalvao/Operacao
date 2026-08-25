import type { Candle } from '../types.ts';
import { wilderSmooth } from './ema.ts';

export function trueRange(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i] as Candle;
    if (i === 0) {
      out.push(c.high - c.low);
      continue;
    }
    const prevClose = (candles[i - 1] as Candle).close;
    out.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  return out;
}

/** ATR de Wilder alinhado ao array de candles. */
export function atr(candles: Candle[], period = 14): (number | null)[] {
  if (candles.length === 0) return [];
  return wilderSmooth(trueRange(candles), period);
}
