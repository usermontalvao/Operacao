import type { Candle } from '../types.ts';
import { wilderSmooth } from './ema.ts';
import { trueRange } from './atr.ts';

export interface AdxPoint {
  adx: number;
  plusDi: number;
  minusDi: number;
}

/**
 * ADX de Wilder — a única pergunta que ele responde é "existe tendência?",
 * e não "para onde".
 *
 * É o indicador que faltava no projeto porque nenhum setup até aqui precisava
 * dele: pullback, rompimento e explosão querem tendência e a leem pela
 * estrutura. O micro scalp quer o CONTRÁRIO — só opera quando não há
 * tendência —, e "não há tendência" precisa de uma medida, não de um
 * palpite. ADX abaixo de ~20 é a definição clássica de mercado sem direção.
 *
 * Alinhado ao array de candles: as primeiras 2*period-1 posições são null
 * porque o ADX é uma suavização de uma suavização e não existe antes disso.
 */
export function adx(candles: Candle[], period = 14): (AdxPoint | null)[] {
  const out: (AdxPoint | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period * 2) return out;

  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    if (i === 0) {
      plusDm.push(0);
      minusDm.push(0);
      continue;
    }
    const current = candles[i] as Candle;
    const previous = candles[i - 1] as Candle;
    const up = current.high - previous.high;
    const down = previous.low - current.low;
    // o movimento só conta para um lado: o maior dos dois, e só se for positivo
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }

  const smoothTr = wilderSmooth(trueRange(candles), period);
  const smoothPlus = wilderSmooth(plusDm, period);
  const smoothMinus = wilderSmooth(minusDm, period);

  const dx: number[] = new Array(candles.length).fill(0);
  const diPlus: (number | null)[] = new Array(candles.length).fill(null);
  const diMinus: (number | null)[] = new Array(candles.length).fill(null);

  for (let i = 0; i < candles.length; i += 1) {
    const tr = smoothTr[i];
    const plus = smoothPlus[i];
    const minus = smoothMinus[i];
    if (tr === null || tr === undefined || tr <= 0) continue;
    if (plus === null || plus === undefined) continue;
    if (minus === null || minus === undefined) continue;
    const pdi = (plus / tr) * 100;
    const mdi = (minus / tr) * 100;
    diPlus[i] = pdi;
    diMinus[i] = mdi;
    const sum = pdi + mdi;
    dx[i] = sum > 0 ? (Math.abs(pdi - mdi) / sum) * 100 : 0;
  }

  // o ADX é a média de Wilder do DX, e o DX só existe a partir de period-1
  const first = period - 1;
  const dxTail = dx.slice(first);
  const adxTail = wilderSmooth(dxTail, period);

  for (let i = 0; i < adxTail.length; i += 1) {
    const value = adxTail[i];
    if (value === null || value === undefined) continue;
    const index = first + i;
    const pdi = diPlus[index];
    const mdi = diMinus[index];
    if (pdi === null || pdi === undefined || mdi === null || mdi === undefined) continue;
    out[index] = { adx: value, plusDi: pdi, minusDi: mdi };
  }

  return out;
}
