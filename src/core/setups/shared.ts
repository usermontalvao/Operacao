import { type Side, directionOf, gainPerUnit } from '../direction.ts';
import type { PriceLevel } from '../types.ts';

export interface TargetSet {
  target1: number;
  target2: number | null;
  target3: number | null;
}

/**
 * Alvos saem primeiro da estrutura (os níveis reais que estão no caminho) e
 * só caem em múltiplos do risco quando não há nada mapeado à frente.
 *
 * "À frente" depende do lado: para quem compra são as resistências acima e o
 * topo recente; para quem vende são os suportes abaixo e o fundo recente. O
 * resto da conta é o mesmo, medido em distância percorrida a favor.
 */
export function buildTargets(
  entryPrice: number,
  stopLoss: number,
  obstacles: PriceLevel[],
  extreme: number,
  atrValue: number,
  side: Side = 'BUY',
): TargetSet | null {
  const risk = -gainPerUnit(side, entryPrice, stopLoss);
  if (risk <= 0) return null;
  const direction = directionOf(side);

  const minimumDistance = Math.max(risk * 0.8, atrValue * 0.5);
  const structural = obstacles
    .map((level) => level.price)
    .concat(extreme)
    .filter((price) => gainPerUnit(side, entryPrice, price) > minimumDistance)
    // o mais próximo primeiro, sempre no sentido da operação
    .sort((a, b) => gainPerUnit(side, entryPrice, a) - gainPerUnit(side, entryPrice, b));

  const target1 = structural[0] ?? entryPrice + direction * risk * 2;
  const target2 =
    structural.find(
      (price) =>
        gainPerUnit(side, target1, price) > Math.abs(target1) * 0.008 &&
        gainPerUnit(side, entryPrice, price) >= risk * 2,
    ) ?? entryPrice + direction * risk * 3.2;
  const target3Candidate =
    structural.find(
      (price) =>
        gainPerUnit(side, target2, price) > Math.abs(target2) * 0.008 &&
        gainPerUnit(side, entryPrice, price) >= risk * 3.5,
    ) ?? entryPrice + direction * risk * 4.5;

  const ordered = ensureOrdered([target1, target2, target3Candidate], side);
  return { target1: ordered[0], target2: ordered[1], target3: ordered[2] };
}

/** Cada alvo tem de estar mais longe que o anterior — no sentido da operação. */
function ensureOrdered(values: number[], side: Side): [number, number, number] {
  const direction = directionOf(side);
  const [a, b, c] = values as [number, number, number];
  const second = gainPerUnit(side, a, b) > Math.abs(a) * 0.001 ? b : a * (1 + direction * 0.02);
  const third =
    gainPerUnit(side, second, c) > Math.abs(second) * 0.001 ? c : second * (1 + direction * 0.02);
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
  side: Side = 'BUY',
): string {
  const suffix = side === 'SELL' ? ':S' : '';
  return `${symbol}:${setupType}:${timeframe}:${levelPrice.toPrecision(6)}${suffix}`;
}
