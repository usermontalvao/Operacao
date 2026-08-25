import type { Candle, PriceLevel, SwingPoint } from '../types.ts';

interface Cluster {
  prices: number[];
  lastTouchTime: number;
  lastIndex: number;
}

/**
 * Agrupa pivôs próximos em zonas. A tolerância acompanha a volatilidade:
 * em ativo agitado, dois topos a 0,5% de distância são o mesmo nível.
 */
export function buildLevels(
  candles: Candle[],
  swings: SwingPoint[],
  kind: 'HIGH' | 'LOW',
  atrPercent: number,
): PriceLevel[] {
  const points = swings.filter((s) => s.kind === kind);
  if (points.length === 0 || candles.length === 0) return [];

  const tolerance = Math.min(Math.max(atrPercent * 0.6, 0.3), 2.5) / 100;
  const clusters: Cluster[] = [];

  for (const point of points) {
    const target = clusters.find((cluster) => {
      const reference = average(cluster.prices);
      return Math.abs(point.price - reference) / reference <= tolerance;
    });
    if (target) {
      target.prices.push(point.price);
      target.lastTouchTime = Math.max(target.lastTouchTime, point.time);
      target.lastIndex = Math.max(target.lastIndex, point.index);
    } else {
      clusters.push({ prices: [point.price], lastTouchTime: point.time, lastIndex: point.index });
    }
  }

  const totalBars = candles.length;
  return clusters
    .map((cluster) => {
      const price = average(cluster.prices);
      const low = Math.min(...cluster.prices);
      const high = Math.max(...cluster.prices);
      const touches = cluster.prices.length;
      const recency = 1 - Math.min((totalBars - cluster.lastIndex) / totalBars, 1);
      const width = price === 0 ? 1 : (high - low) / price;
      const tightness = 1 - Math.min(width / tolerance, 1) * 0.4;
      const touchScore = Math.min(touches / 3, 1);
      return {
        kind: kind === 'HIGH' ? ('RESISTANCE' as const) : ('SUPPORT' as const),
        price,
        low,
        high,
        touches,
        lastTouchTime: cluster.lastTouchTime,
        quality: clamp01(touchScore * 0.5 + recency * 0.3 + tightness * 0.2),
      };
    })
    .sort((a, b) => b.quality - a.quality);
}

export function nearestBelow(levels: PriceLevel[], price: number): PriceLevel | null {
  const candidates = levels.filter((level) => level.price < price);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, level) => (level.price > best.price ? level : best));
}

export function nearestAbove(levels: PriceLevel[], price: number): PriceLevel | null {
  const candidates = levels.filter((level) => level.price > price);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, level) => (level.price < best.price ? level : best));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
