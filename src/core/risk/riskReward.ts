import { type Side, gainPerUnit } from '../direction.ts';

/** Preço de referência da zona de entrada. */
export function averageEntry(entryLow: number, entryHigh: number): number {
  return (entryLow + entryHigh) / 2;
}

/**
 * R/R = ganho até o alvo ÷ perda até o stop, os dois medidos a favor do lado.
 * Zero quando o risco é inválido — inclusive quando o stop está do lado errado
 * da entrada, que é o erro típico de um setup vendido escrito às pressas.
 */
export function computeRiskReward(
  entry: number,
  stopLoss: number,
  target: number,
  side: Side = 'BUY',
): number {
  const risk = -gainPerUnit(side, entry, stopLoss);
  const reward = gainPerUnit(side, entry, target);
  if (risk <= 0 || reward <= 0) return 0;
  return round(reward / risk, 2);
}

export function riskPercent(entry: number, stopLoss: number, side: Side = 'BUY'): number {
  if (entry <= 0) return 0;
  return round((-gainPerUnit(side, entry, stopLoss) / entry) * 100, 2);
}

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Rejeita o setup quando a assimetria não compensa o risco. */
export function passesRiskReward(riskReward: number, minimum: number): boolean {
  return riskReward >= minimum;
}
