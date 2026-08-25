/** Preço de referência da zona de entrada. */
export function averageEntry(entryLow: number, entryHigh: number): number {
  return (entryLow + entryHigh) / 2;
}

/** R/R = (alvo − entrada) ÷ (entrada − stop). Zero quando o risco é inválido. */
export function computeRiskReward(entry: number, stopLoss: number, target: number): number {
  const risk = entry - stopLoss;
  const reward = target - entry;
  if (risk <= 0 || reward <= 0) return 0;
  return round(reward / risk, 2);
}

export function riskPercent(entry: number, stopLoss: number): number {
  if (entry <= 0) return 0;
  return round(((entry - stopLoss) / entry) * 100, 2);
}

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Rejeita o setup quando a assimetria não compensa o risco. */
export function passesRiskReward(riskReward: number, minimum: number): boolean {
  return riskReward >= minimum;
}
