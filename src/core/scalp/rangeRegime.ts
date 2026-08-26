import type { Candle, RangeRegimeReport, RangeRegimeSettings, RangeVerdict } from '../types.ts';
import { adx, atr, bollinger, ema, rollingVwap } from '../indicators/index.ts';

/**
 * O laudo de LATERALIDADE — o porteiro do micro scalp.
 *
 * Os quatro detectores que já existiam no projeto compram força: pullback numa
 * alta, reteste de rompimento, defesa de suporte numa tendência, explosão de
 * volume. Todos perdem dinheiro justamente onde este módulo quer operar, e o
 * inverso também vale: comprar a borda de baixo de uma faixa é a pior coisa
 * possível quando a faixa está sendo rompida para baixo.
 *
 * Por isso o micro scalp não começa perguntando "onde está o preço?" e sim
 * "existe uma faixa?". Só depois de RANGE ele olha a borda. Um único
 * indicador não decide: ADX diz se há tendência, a inclinação da EMA diz para
 * onde o eixo aponta, a expansão do ATR denuncia a vela de notícia, e os
 * toques nas extremidades são o que separa uma faixa de verdade de duas
 * barras que por acaso ficaram próximas.
 */
export interface RangeRegimeInput {
  candles: Candle[];
  settings: RangeRegimeSettings;
  /** custo de ida e volta do par, em % — a faixa precisa valer múltiplos dele */
  allInCostPercent: number;
}

function lastOf<T>(series: (T | null)[]): T | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function vazio(verdict: RangeVerdict, reason: string): RangeRegimeReport {
  return {
    verdict,
    confidence: 0,
    support: 0,
    resistance: 0,
    amplitudePercent: 0,
    position: 0.5,
    adx: null,
    emaSlopePercent: null,
    bollingerWidthPercent: null,
    vwap: null,
    supportTouches: 0,
    resistanceTouches: 0,
    reasons: [reason],
  };
}

export function analyzeRangeRegime(input: RangeRegimeInput): RangeRegimeReport {
  const { candles, settings, allInCostPercent } = input;
  const { lookback } = settings;

  /*
   * ADX de 14 exige 28 barras só para existir. Pedir `lookback` barras não
   * basta — e devolver INDEFINIDO aqui é o comportamento certo: um par que
   * acabou de entrar no universo não tem história de 1m ainda, e chutar
   * "é lateral" seria operar às cegas no primeiro minuto.
   */
  if (candles.length < Math.max(lookback, 40)) {
    return vazio('INDEFINIDO', `histórico de 1m insuficiente (${candles.length} barras)`);
  }

  const janela = candles.slice(-lookback);
  const closes = janela.map((c) => c.close);
  const price = closes[closes.length - 1] as number;
  if (price <= 0) return vazio('INDEFINIDO', 'preço inválido');

  const resistance = Math.max(...janela.map((c) => c.high));
  const support = Math.min(...janela.map((c) => c.low));
  const amplitude = resistance - support;
  const amplitudePercent = (amplitude / price) * 100;

  const adxPoint = lastOf(adx(candles, 14));
  const adxValue = adxPoint?.adx ?? null;

  const emaSeries = ema(closes, 20);
  const emaNow = lastOf(emaSeries);
  const emaBefore = emaSeries[Math.max(0, emaSeries.length - 11)] ?? null;
  const emaSlopePercent =
    emaNow !== null && emaBefore !== null && emaBefore > 0
      ? ((emaNow - emaBefore) / emaBefore / 10) * 100
      : null;

  /*
   * A inclinação que importa é RELATIVA À FAIXA, não em porcento absoluto.
   *
   * Um limite absoluto não escala entre moedas, e o erro aparece nos dois
   * sentidos: 0,03% por barra é deriva irrelevante dentro de uma faixa de 2%
   * (o eixo anda um sexto da amplitude em dez barras) e é tendência forte
   * dentro de uma faixa de 0,1%. Com um número só para todos os pares, o
   * detector reprovaria altcoins laterais e aprovaria BTC em tendência.
   *
   * Normalizado pela amplitude, o limite passa a significar sempre a mesma
   * coisa: "o eixo da faixa andou mais do que X dela no último terço da
   * janela — então não é uma faixa, é um canal subindo".
   */
  const emaDrift =
    emaNow !== null && emaBefore !== null && amplitude > 0
      ? Math.abs(emaNow - emaBefore) / amplitude
      : null;

  /*
   * E a pergunta decisiva: o eixo ATRAVESSOU a faixa?
   *
   * A deriva de dez barras acima não basta, e a razão é sutil. Num canal que
   * sobe devagar, a própria amplitude medida INCHA — o topo da janela é o fim
   * da subida e o fundo é o começo dela, então "amplitude" deixa de ser a
   * oscilação e passa a ser o quanto o canal andou. Como o denominador cresce
   * junto com o movimento, a razão fica pequena e o canal passa por faixa.
   *
   * Comparar as duas pontas da janela desfaz o disfarce: numa faixa de
   * verdade o eixo começa e termina perto do meio; num canal ele sai de perto
   * do fundo e chega perto do topo. Percorrer a maior parte da amplitude é a
   * assinatura de que a "faixa" era uma viagem.
   */
  const emaInicio = emaSeries.find((v): v is number => v !== null && v !== undefined) ?? null;
  const emaTravel =
    emaNow !== null && emaInicio !== null && amplitude > 0
      ? Math.abs(emaNow - emaInicio) / amplitude
      : null;

  const bb = lastOf(bollinger(closes, 20, 2));
  const bollingerWidthPercent = bb ? (bb.width ?? 0) * 100 : null;
  const vwap = lastOf(rollingVwap(janela, Math.min(lookback, 60)));

  const atrSeries = atr(candles, 14);
  const atrNow = lastOf(atrSeries);
  const atrValues = atrSeries.filter((v): v is number => v !== null && v !== undefined);
  const atrMean =
    atrValues.length > 0 ? atrValues.slice(-lookback).reduce((t, v) => t + v, 0) / Math.min(atrValues.length, lookback) : null;
  const expansion = atrNow !== null && atrMean !== null && atrMean > 0 ? atrNow / atrMean : null;

  /*
   * Toque conta com tolerância de um ATR. Exigir a máxima exata seria exigir
   * que o preço encostasse no mesmo centavo duas vezes — e faixa real não é
   * uma linha, é uma região.
   */
  const tol = atrNow ?? amplitude * 0.1;
  const resistanceTouches = janela.filter((c) => c.high >= resistance - tol).length;
  const supportTouches = janela.filter((c) => c.low <= support + tol).length;

  const position = amplitude > 0 ? (price - support) / amplitude : 0.5;

  const reasons: string[] = [];
  let verdict: RangeVerdict = 'RANGE';

  if (expansion !== null && expansion > settings.maxVolatilityExpansion) {
    verdict = 'EXPANSAO';
    reasons.push(
      `volatilidade expandiu ${expansion.toFixed(1)}x a média — vela de notícia, não oscilação`,
    );
  } else if (adxValue !== null && adxValue > settings.maxAdx) {
    verdict = 'TENDENCIA';
    reasons.push(`ADX em ${adxValue.toFixed(0)} (acima de ${settings.maxAdx}): há tendência`);
  } else if (emaTravel !== null && emaTravel > settings.maxEmaTravelOfRange) {
    verdict = 'TENDENCIA';
    reasons.push(
      `o eixo atravessou ${(emaTravel * 100).toFixed(0)}% da faixa de ponta a ponta — é canal, não faixa`,
    );
  } else if (emaDrift !== null && emaDrift > settings.maxEmaDriftOfRange) {
    verdict = 'TENDENCIA';
    reasons.push(
      `eixo da faixa andou ${(emaDrift * 100).toFixed(0)}% da amplitude em 10 barras — inclinação forte`,
    );
  } else if (
    supportTouches < settings.minTouchesPerSide ||
    resistanceTouches < settings.minTouchesPerSide
  ) {
    verdict = 'INDEFINIDO';
    reasons.push(
      `faixa sem testes suficientes (${supportTouches} no suporte, ${resistanceTouches} na resistência)`,
    );
  } else if (amplitudePercent < allInCostPercent * settings.minAmplitudeCostMultiple) {
    /*
     * A faixa existe mas é estreita demais para valer a viagem. Esta é a
     * reprovação mais importante do módulo: é exatamente o caso do BTC em 1
     * minuto, onde a lateralidade é visível e perfeita — e cada ida e volta
     * dentro dela rende menos que a corretagem.
     */
    verdict = 'INDEFINIDO';
    reasons.push(
      `amplitude de ${amplitudePercent.toFixed(3)}% não cobre ${settings.minAmplitudeCostMultiple}x o custo de ${allInCostPercent.toFixed(3)}%`,
    );
  } else {
    reasons.push(
      `faixa de ${amplitudePercent.toFixed(3)}% com ${supportTouches} testes no suporte e ${resistanceTouches} na resistência`,
    );
    if (adxValue !== null) reasons.push(`ADX em ${adxValue.toFixed(0)}: sem tendência`);
  }

  /*
   * A confiança é o produto de quatro leituras independentes, não a média:
   * basta uma delas ser ruim para a faixa deixar de ser confiável, e a média
   * deixaria uma leitura excelente compensar uma péssima.
   */
  const confidence =
    verdict !== 'RANGE'
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            (adxValue === null ? 0.6 : Math.max(0, 1 - adxValue / settings.maxAdx)) *
              (emaTravel === null ? 0.6 : Math.max(0, 1 - emaTravel / settings.maxEmaTravelOfRange)) *
              Math.min(1, (supportTouches + resistanceTouches) / (settings.minTouchesPerSide * 4)) *
              Math.min(1, amplitudePercent / (allInCostPercent * settings.minAmplitudeCostMultiple)),
          ),
        );

  return {
    verdict,
    confidence,
    support,
    resistance,
    amplitudePercent,
    position,
    adx: adxValue,
    emaSlopePercent,
    bollingerWidthPercent,
    vwap,
    supportTouches,
    resistanceTouches,
    reasons,
  };
}
