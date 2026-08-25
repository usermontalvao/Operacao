import type { PriceLevel } from '../types.ts';

export interface TargetSet {
  target1: number;
  target2: number | null;
  target3: number | null;
}

/**
 * Alvos saem primeiro da estrutura (resistências reais acima) e só caem em
 * múltiplos do risco quando não há nada mapeado no caminho.
 */
export function buildTargets(
  entryPrice: number,
  stopLoss: number,
  resistances: PriceLevel[],
  recentHigh: number,
  atrValue: number,
): TargetSet | null {
  const risk = entryPrice - stopLoss;
  if (risk <= 0) return null;

  const structural = resistances
    .map((level) => level.price)
    .concat(recentHigh)
    .filter((price) => price > entryPrice + Math.max(risk * 0.8, atrValue * 0.5))
    .sort((a, b) => a - b);

  const target1 = structural[0] ?? entryPrice + risk * 2;
  const target2 =
    structural.find((price) => price > target1 * 1.008 && price - entryPrice >= risk * 2) ??
    entryPrice + risk * 3.2;
  const target3Candidate =
    structural.find((price) => price > target2 * 1.008 && price - entryPrice >= risk * 3.5) ??
    entryPrice + risk * 4.5;

  const ordered = ensureAscending([target1, target2, target3Candidate]);
  return { target1: ordered[0], target2: ordered[1], target3: ordered[2] };
}

function ensureAscending(values: number[]): [number, number, number] {
  const [a, b, c] = values as [number, number, number];
  const second = b > a * 1.001 ? b : a * 1.02;
  const third = c > second * 1.001 ? c : second * 1.02;
  return [a, second, third];
}

/** Zona de entrada nunca pode nascer invertida nem colada demais. */
export function normalizeEntryZone(low: number, high: number, price: number): [number, number] {
  const entryLow = Math.min(low, high);
  const entryHigh = Math.max(low, high);
  if (entryHigh - entryLow < price * 0.0005) {
    return [price * 0.998, price * 1.002];
  }
  return [entryLow, entryHigh];
}

export function fingerprintOf(
  symbol: string,
  setupType: string,
  timeframe: string,
  levelPrice: number,
): string {
  return `${symbol}:${setupType}:${timeframe}:${levelPrice.toPrecision(6)}`;
}
