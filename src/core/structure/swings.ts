import type { Candle, SwingPoint } from '../types.ts';

/**
 * Pivôs fractais: um topo é uma barra cuja máxima supera as `strength` barras
 * de cada lado. Simples, determinístico e suficiente para o MVP.
 */
export function findSwings(candles: Candle[], strength = 2): SwingPoint[] {
  const points: SwingPoint[] = [];
  if (candles.length < strength * 2 + 1) return points;

  for (let i = strength; i < candles.length - strength; i += 1) {
    const candle = candles[i] as Candle;
    let isHigh = true;
    let isLow = true;
    for (let j = i - strength; j <= i + strength; j += 1) {
      if (j === i) continue;
      const other = candles[j] as Candle;
      if (other.high >= candle.high) isHigh = false;
      if (other.low <= candle.low) isLow = false;
    }
    if (isHigh) {
      points.push({ index: i, time: candle.openTime, price: candle.high, kind: 'HIGH' });
    }
    if (isLow) {
      points.push({ index: i, time: candle.openTime, price: candle.low, kind: 'LOW' });
    }
  }
  return points;
}

export function lastSwings(swings: SwingPoint[], kind: 'HIGH' | 'LOW', count: number): SwingPoint[] {
  return swings.filter((s) => s.kind === kind).slice(-count);
}
