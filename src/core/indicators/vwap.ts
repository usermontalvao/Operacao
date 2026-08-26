import type { Candle } from '../types.ts';

/**
 * VWAP de janela deslizante — o preço médio ponderado por volume das últimas
 * N barras.
 *
 * Deliberadamente NÃO é o VWAP de sessão. Cripto não tem pregão: a sessão
 * teria de ser o dia UTC, e às 00:05 o indicador reiniciaria com duas barras
 * de história, dando um "preço justo" que é só o último preço. Numa janela
 * deslizante ele significa a mesma coisa a qualquer hora — que é o que um
 * módulo que opera 24h precisa.
 *
 * No range, o VWAP é o eixo: preço muito abaixo dele com suporte por perto é
 * o lado barato da faixa; muito acima, o lado caro.
 */
export function rollingVwap(candles: Candle[], period = 60): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (period <= 0 || candles.length === 0) return out;

  let volumeSum = 0;
  let notionalSum = 0;

  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i] as Candle;
    const typical = (candle.high + candle.low + candle.close) / 3;
    volumeSum += candle.volume;
    notionalSum += typical * candle.volume;

    if (i >= period) {
      const old = candles[i - period] as Candle;
      const oldTypical = (old.high + old.low + old.close) / 3;
      volumeSum -= old.volume;
      notionalSum -= oldTypical * old.volume;
    }

    if (i >= period - 1) {
      // barra sem negócio nenhum na janela: o preço médio não existe, e
      // devolver o último preço fingiria uma referência que ninguém pagou
      out[i] = volumeSum > 0 ? notionalSum / volumeSum : null;
    }
  }

  return out;
}
