/** Média móvel simples alinhada ao índice do array de entrada. */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i] as number;
    if (i >= period) sum -= values[i - period] as number;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Média móvel exponencial semeada pela SMA do primeiro bloco — é assim que
 * TradingView e a maioria das corretoras calculam, então os valores batem.
 */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i] as number;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = (values[i] as number) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Suavização de Wilder (RMA), usada por RSI e ATR. */
export function wilderSmooth(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i] as number;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = (prev * (period - 1) + (values[i] as number)) / period;
    out[i] = prev;
  }
  return out;
}

export function standardDeviation(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += values[j] as number;
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const diff = (values[j] as number) - mean;
      variance += diff * diff;
    }
    out[i] = Math.sqrt(variance / period);
  }
  return out;
}
