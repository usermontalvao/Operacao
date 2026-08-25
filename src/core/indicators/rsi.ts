import { wilderSmooth } from './ema.ts';

/** RSI de Wilder. Retorna array alinhado à entrada, com null antes do período. */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const diff = (values[i] as number) - (values[i - 1] as number);
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  const avgGain = wilderSmooth(gains, period);
  const avgLoss = wilderSmooth(losses, period);

  for (let i = 0; i < gains.length; i += 1) {
    const g = avgGain[i];
    const l = avgLoss[i];
    if (g === null || l === null || g === undefined || l === undefined) continue;
    // índice i em gains corresponde ao índice i+1 em values
    out[i + 1] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
