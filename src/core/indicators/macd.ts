import type { MacdPoint } from '../types.ts';
import { ema } from './ema.ts';

export function macd(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): (MacdPoint | null)[] {
  const out: (MacdPoint | null)[] = new Array(values.length).fill(null);
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);

  const macdLine: number[] = [];
  const macdIndex: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const f = fast[i];
    const s = slow[i];
    if (f === null || s === null || f === undefined || s === undefined) continue;
    macdLine.push(f - s);
    macdIndex.push(i);
  }
  if (macdLine.length === 0) return out;

  const signalLine = ema(macdLine, signalPeriod);
  for (let i = 0; i < macdLine.length; i += 1) {
    const signal = signalLine[i];
    if (signal === null || signal === undefined) continue;
    const target = macdIndex[i] as number;
    const value = macdLine[i] as number;
    out[target] = { macd: value, signal, histogram: value - signal };
  }
  return out;
}
