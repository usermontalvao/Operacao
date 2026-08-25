import type { BollingerPoint } from '../types.ts';
import { sma, standardDeviation } from './ema.ts';

export function bollinger(
  values: number[],
  period = 20,
  multiplier = 2,
): (BollingerPoint | null)[] {
  const out: (BollingerPoint | null)[] = new Array(values.length).fill(null);
  const middleSeries = sma(values, period);
  const deviation = standardDeviation(values, period);
  for (let i = 0; i < values.length; i += 1) {
    const middle = middleSeries[i];
    const dev = deviation[i];
    if (middle === null || dev === null || middle === undefined || dev === undefined) continue;
    const upper = middle + multiplier * dev;
    const lower = middle - multiplier * dev;
    out[i] = { upper, middle, lower, width: middle === 0 ? 0 : (upper - lower) / middle };
  }
  return out;
}
