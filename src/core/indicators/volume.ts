import type { Candle } from '../types.ts';
import { sma } from './ema.ts';

export interface VolumeProfile {
  volume: number;
  average: (number | null)[];
  relative: (number | null)[];
}

/**
 * Volume relativo = volume da barra ÷ média das barras ANTERIORES.
 * Excluir a própria barra evita que um volume climático dilua a si mesmo.
 */
export function volumeProfile(candles: Candle[], period = 20): VolumeProfile {
  const volumes = candles.map((c) => c.volume);
  const average = sma(volumes, period);
  const relative: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i += 1) {
    const previousAverage = average[i - 1];
    if (previousAverage === null || previousAverage === undefined || previousAverage === 0) continue;
    relative[i] = (volumes[i] as number) / previousAverage;
  }
  return { volume: volumes[volumes.length - 1] ?? 0, average, relative };
}

/** Compara o volume vendedor recente com o anterior (queda = pressão sumindo). */
export function sellingVolumeFading(candles: Candle[], window = 3): boolean {
  return pressureFading(candles, 'SELLING', window);
}

/**
 * O espelho: volume COMPRADOR sumindo. É o que autoriza vender um repique —
 * a alta que continua sem comprador é a alta que devolve.
 */
export function buyingVolumeFading(candles: Candle[], window = 3): boolean {
  return pressureFading(candles, 'BUYING', window);
}

function pressureFading(candles: Candle[], kind: 'BUYING' | 'SELLING', window: number): boolean {
  if (candles.length < window * 2) return false;
  const slice = candles.slice(-window * 2);
  const older = slice.slice(0, window);
  const recent = slice.slice(window);
  const inDirection = (c: Candle): boolean => (kind === 'SELLING' ? c.close < c.open : c.close > c.open);
  const volumeOf = (list: Candle[]): number =>
    list.reduce((acc, c) => acc + (inDirection(c) ? c.volume : 0), 0);
  const before = volumeOf(older);
  const now = volumeOf(recent);
  if (before === 0) return false;
  return now < before * 0.8;
}
