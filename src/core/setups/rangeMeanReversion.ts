import type { DetectorInput } from '../analysis.ts';
import { type Side, directionOf, isFavorable } from '../direction.ts';
import type { Candle, RangeRegimeReport, SetupCandidate } from '../types.ts';
import { isBearishRejection, isBullishRejection } from '../structure/index.ts';
import { previousRsi } from '../engines/indicatorEngine.ts';
import { normalizeEntryZone } from './shared.ts';

/**
 * MICRO SCALP — REVERSÃO À MÉDIA DENTRO DA FAIXA (1 minuto)
 *
 * O único detector do projeto que não é direcional. Os outros quatro
 * perguntam "para onde o preço vai?"; este pergunta "onde está a borda?" e
 * aposta na volta ao meio. Só faz sentido dentro de um regime lateral já
 * confirmado — quem confirma é `analyzeRangeRegime`, e sem RANGE este arquivo
 * nem é chamado.
 *
 *   RESISTÊNCIA ─────────────────────  ← vende aqui (só futuros)
 *                  /\    /\
 *                 /  \  /  \
 *                /    \/    \
 *   SUPORTE   ─────────────────────    ← compra aqui
 *
 * A regra que este módulo NÃO quebra: tocar a borda não é motivo para operar.
 * Toda faixa acaba, e ela acaba exatamente com um toque que não voltou. O que
 * autoriza a entrada é a REJEIÇÃO — o preço foi até lá e voltou, com quem
 * estava do outro lado aparecendo. Sem isso, o detector estaria comprando
 * justamente o rompimento que encerra a faixa que ele acabou de medir.
 */

const REQUIRED_CONFIRMATIONS = 2;

export interface RangeFadeInput extends DetectorInput {
  regime: RangeRegimeReport;
  /** onde o preço precisa estar dentro da faixa, em % da amplitude */
  entryZonePercent: number;
}

export function detectRangeFadeLong(input: RangeFadeInput): SetupCandidate | null {
  return detectRangeFade(input, 'BUY');
}

/** O espelho vendido. Em spot não nasce: não existe posição vendida à vista. */
export function detectRangeFadeShort(input: RangeFadeInput): SetupCandidate | null {
  return detectRangeFade(input, 'SELL');
}

function detectRangeFade(input: RangeFadeInput, side: Side): SetupCandidate | null {
  const { trigger, anchor, regime, entryZonePercent } = input;
  if (regime.verdict !== 'RANGE') return null;

  const short = side === 'SELL';
  const indicators = trigger.indicators;
  const candles = trigger.candles;
  const last = candles[candles.length - 1];
  const atrValue = indicators.atr14;
  const close = indicators.close;
  const direction = directionOf(side);

  if (!last || atrValue === null || atrValue <= 0 || close <= 0) return null;

  const amplitude = regime.resistance - regime.support;
  if (amplitude <= 0) return null;

  /*
   * O preço precisa estar na FAIXA DE ENTRADA da borda certa: nos 25% de
   * baixo para comprar, nos 25% de cima para vender. No meio da faixa não há
   * tese — não há borda perto para servir de stop nem borda oposta longe o
   * bastante para servir de alvo.
   */
  const zona = entryZonePercent / 100;
  const dentroDaZona = short ? regime.position >= 1 - zona : regime.position <= zona;
  if (!dentroDaZona) return null;

  const reasons: string[] = [];
  let confirmations = 0;

  // 1. rejeição na barra: o preço foi até a borda e não ficou lá
  if (short ? isBearishRejection(last) : isBullishRejection(last)) {
    confirmations += 1;
    reasons.push(`Candle de rejeição na ${short ? 'resistência' : 'suporte'} da faixa`);
  }

  // 2. o RSI virou vindo do extremo — o esgotamento do lado que empurrava
  const rsiValue = indicators.rsi14;
  const rsiPrevious = previousRsi(candles);
  const rsiExtreme = short ? 62 : 38;
  if (
    rsiValue !== null &&
    rsiPrevious !== null &&
    (short
      ? rsiPrevious > rsiExtreme && rsiValue < rsiPrevious
      : rsiPrevious < rsiExtreme && rsiValue > rsiPrevious)
  ) {
    confirmations += 1;
    reasons.push(`RSI virando em ${rsiPrevious.toFixed(0)} → ${rsiValue.toFixed(0)}`);
  }

  // 3. o preço perfurou a banda de Bollinger e voltou para dentro
  if (indicators.bollinger !== null) {
    const band = short ? indicators.bollinger.upper : indicators.bollinger.lower;
    const perfurou = short ? last.high >= band : last.low <= band;
    const voltou = short ? last.close < band : last.close > band;
    if (perfurou && voltou) {
      confirmations += 1;
      reasons.push(`Preço voltou da banda ${short ? 'superior' : 'inferior'}`);
    }
  }

  // 4. o VWAP concorda: a borda está longe do preço médio pago na janela
  if (regime.vwap !== null && regime.vwap > 0) {
    const distancia = ((close - regime.vwap) / regime.vwap) * 100;
    const favoravel = short ? distancia > 0 : distancia < 0;
    if (favoravel && Math.abs(distancia) >= (atrValue / close) * 100 * 0.5) {
      confirmations += 1;
      reasons.push(
        `Preço ${short ? 'acima' : 'abaixo'} do VWAP em ${Math.abs(distancia).toFixed(3)}%`,
      );
    }
  }

  // 5. quem empurrava para a borda perdeu força
  if (naoAceleraContra(candles, side)) {
    confirmations += 1;
    reasons.push(`Volume ${short ? 'comprador' : 'vendedor'} perdendo força na borda`);
  }

  if (confirmations < REQUIRED_CONFIRMATIONS) return null;

  /*
   * A âncora tem VOTO, não veto — e é um voto que só desempata contra.
   *
   * Comprar o fundo de uma faixa de 1 minuto enquanto o gráfico de 15m
   * despenca é comprar um degrau de uma escada descendo. A faixa é real, mas
   * ela é o repouso entre duas quedas, e a borda de baixo vai ceder.
   */
  const contraAAncora = anchor.structure.trend === (short ? 'UP' : 'DOWN');
  if (contraAAncora) return null;

  reasons.unshift(
    `Faixa de ${regime.amplitudePercent.toFixed(3)}% em 1m · preço a ${(regime.position * 100).toFixed(0)}% da amplitude`,
  );

  const borda = short ? regime.resistance : regime.support;
  const oposta = short ? regime.support : regime.resistance;

  /*
   * A entrada é uma zona estreita a partir da borda em direção ao meio: o
   * preço já está lá, e esperar mais um ATR seria esperar o movimento que se
   * quer capturar. O stop fica ALÉM da borda com folga de meio ATR — colado
   * demais vira estopada no primeiro tique, e o custo de estopar aqui é o
   * mesmo custo de qualquer outra operação.
   */
  const [entryLow, entryHigh] = normalizeEntryZone(
    borda,
    borda + direction * amplitude * 0.15,
    close,
  );
  const entryPrice = (entryLow + entryHigh) / 2;
  const stopLoss = borda - direction * atrValue * 0.5;

  const entryEdge = short ? entryHigh : entryLow;
  if (!isFavorable(side, entryEdge, stopLoss)) return null;

  /*
   * Alvo único a 80% do caminho até a borda oposta.
   *
   * Não é a borda: quem mira a extremidade exata quase nunca preenche, porque
   * é ali que o outro lado do book espera. Sair um pouco antes é trocar um
   * pedaço do alvo por probabilidade de preenchimento — e numa operação cujo
   * lucro é medido em décimos de por cento, não preencher é o pior resultado.
   */
  const target1 = entryPrice + direction * Math.abs(oposta - entryPrice) * 0.8;
  // `isFavorable(side, a, b)` pergunta se A está no lado BOM em relação a B —
  // então o ALVO vem primeiro. Invertido, isto exigia alvo abaixo da entrada
  // numa compra e recusava 100% dos sinais válidos, calado
  if (!isFavorable(side, target1, entryPrice)) return null;

  return {
    symbol: input.analysis.symbol,
    side,
    timeframe: trigger.timeframe,
    anchorTimeframe: anchor.timeframe,
    setupType: 'RANGE_FADE',
    entryLow,
    entryHigh,
    stopLoss,
    target1,
    // alvo único, por decisão de política: ver EXIT_POLICIES.RANGE_FADE
    target2: null,
    target3: null,
    reasons,
    levelPrice: borda,
    regime,
    qualityHints: {
      levelQuality: regime.confidence,
      volumeConfirmation: naoAceleraContra(candles, side),
      momentumTurning: true,
      // "alinhado" aqui significa que a âncora não contradiz — o micro scalp
      // não busca tendência, ele busca a ausência dela
      trendAligned: anchor.structure.trend === 'SIDEWAYS',
    },
  };
}

/**
 * O lado que empurrava para a borda está desacelerando?
 *
 * Compara o volume das duas últimas barras que foram CONTRA a tese. Volume
 * crescente contra é o sinal de que a borda vai ceder, não de que ela segura.
 */
function naoAceleraContra(candles: Candle[], side: Side): boolean {
  const ultimas = candles.slice(-3);
  if (ultimas.length < 3) return false;
  const contra = ultimas.filter((c) => (side === 'BUY' ? c.close < c.open : c.close > c.open));
  if (contra.length < 2) return true;
  const penultima = contra[contra.length - 2] as Candle;
  const ultima = contra[contra.length - 1] as Candle;
  return ultima.volume <= penultima.volume;
}
