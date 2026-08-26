import type { DetectorInput } from '../analysis.ts';
import { type Side, directionOf } from '../direction.ts';
import type { Candle, SetupCandidate } from '../types.ts';
import { normalizeEntryZone } from './shared.ts';

/**
 * EXPLOSÃO DE FORÇA (o "sniper" / scalper)
 *
 * As outras três teses esperam o preço voltar. Esta faz o contrário: compra a
 * força no instante em que ela aparece. Ela existe porque o laboratório disse
 * que ela existe — e só com estes números.
 *
 * O que foi medido (37 pares, 900 dias, treino até out/2025 e teste depois,
 * entrada na ABERTURA da barra seguinte, stop antes de alvo dentro da barra,
 * custos nas duas pontas):
 *
 *   corpo 1,0 ATR · volume 2x .................. -0,18R treino / -0,28R teste
 *   corpo 1,5 ATR · volume 3x .................. -0,10R treino / -0,25R teste
 *   corpo 2,0 ATR · volume 3x · máx. 40 barras . -0,04R treino / -0,10R teste
 *   ...as mesmas 2,0 ATR SÓ com BTC acima da
 *      média de 200 dias ....................... +0,06R treino / +0,26R teste
 *   ...com alvo em 3R ......................... +0,12R treino / +0,25R teste
 *
 * Duas leituras importam mais que os números: o resultado MELHORA de forma
 * monótona conforme a explosão fica mais extrema (não é uma célula sortuda de
 * uma tabela), e sem o filtro de regime nenhuma variante é positiva. Por isso
 * o regime não é configuração — é condição de existência do setup.
 */

/** Corpo mínimo do candle, em ATRs. Abaixo disto a medição vira negativa. */
export const MIN_BODY_ATR = 2;
/** Volume mínimo, em múltiplos da média de 20 barras. */
export const MIN_VOLUME_MULTIPLE = 3;
/** O fechamento precisa romper a máxima destas últimas barras. */
export const BREAKOUT_LOOKBACK = 40;
/** Fechamento no terço superior da própria barra: quem comprou está no lucro. */
export const MIN_CLOSE_POSITION = 0.7;
/** Alvo único, em múltiplos do risco. */
export const TARGET_R = 3;
/**
 * Atraso máximo entre o fechamento da barra de explosão e o nascimento do
 * setup, como fração da própria barra — com teto absoluto.
 *
 * A medição entra na ABERTURA da barra seguinte. Sem esta trava a produção
 * fazia outra coisa: o TLMUSDT de 25/08/2026 explodiu numa barra de 4h que
 * fechou às 15:59 e o setup nasceu às 18:52, quase três horas depois, com o
 * preço já 8% abaixo. O robô recusou por estar fora da zona — e foi ele que
 * salvou a operação, não esta regra, que não existia. Entrada atrasada não é
 * a estratégia medida: é uma aposta diferente, sem número nenhum por trás.
 */
export const MAX_STALE_FRACTION = 0.15;
export const MAX_STALE_MS = 20 * 60_000;

export function detectMomentumBurst(input: DetectorInput): SetupCandidate | null {
  return detectBurst(input, 'BUY');
}

/**
 * DESABAMENTO DE FORÇA — o espelho vendido, só disponível em futuros.
 *
 * ATENÇÃO, e isto não é formalidade: os números do cabeçalho acima são da
 * COMPRA. O lado vendido nunca foi medido no laboratório. Ele existe aqui
 * porque a mecânica é a mesma e porque quem opera futuros precisa dela na
 * mão — não porque haja expectativa comprovada. Por isso o robô continua
 * recusando teses vendidas na automação (ver automationPolicy): enquanto não
 * houver treino e teste deste lado, ele é uma entrada manual.
 *
 * O regime também espelha: em vez de exigir o BTC acima da média de 200 dias,
 * exige o BTC ABAIXO dela. "Não saber" segue não autorizando.
 */
export function detectCollapseBurst(input: DetectorInput): SetupCandidate | null {
  return detectBurst(input, 'SELL');
}

function detectBurst(input: DetectorInput, side: Side): SetupCandidate | null {
  const { trigger, anchor, context } = input;
  const short = side === 'SELL';
  const direction = directionOf(side);
  const candles = trigger.candles;
  const atrValue = trigger.indicators.atr14;
  if (atrValue === null || atrValue <= 0 || candles.length < BREAKOUT_LOOKBACK + 5) return null;

  // regime: sem BTC acima da média de 200 dias esta entrada é perdedora em
  // todas as variantes medidas. Não saber também não autoriza. No espelho
  // vendido a exigência inverte: BTC abaixo da própria média diária.
  if (context?.btcAboveDailyMean !== !short) return null;

  const bar = candles[candles.length - 1] as Candle;

  // a explosão vale enquanto ela é notícia de agora
  const observedAt = Date.parse(input.analysis.updatedAt);
  if (Number.isFinite(observedAt)) {
    const barInterval = bar.closeTime - bar.openTime + 1;
    const tolerance = Math.min(barInterval * MAX_STALE_FRACTION, MAX_STALE_MS);
    if (observedAt - bar.closeTime > tolerance) return null;
  }

  const range = bar.high - bar.low;
  const body = (bar.close - bar.open) * direction;
  if (range <= 0 || body <= 0) return null;

  const bodyAtr = body / atrValue;
  if (bodyAtr < MIN_BODY_ATR) return null;

  // fechamento no extremo da própria barra: no topo dela na explosão de alta,
  // no fundo dela no desabamento
  const closePosition = short ? (bar.high - bar.close) / range : (bar.close - bar.low) / range;
  if (closePosition < MIN_CLOSE_POSITION) return null;

  const average = averageVolume(candles, 20);
  if (average <= 0) return null;
  const volumeMultiple = bar.volume / average;
  if (volumeMultiple < MIN_VOLUME_MULTIPLE) return null;

  // o fechamento tem de vencer o extremo das últimas barras: a máxima na
  // explosão, a mínima no desabamento
  let extreme = short ? Number.POSITIVE_INFINITY : 0;
  for (let i = candles.length - 1 - BREAKOUT_LOOKBACK; i < candles.length - 1; i += 1) {
    const previous = candles[i];
    if (!previous) continue;
    extreme = short ? Math.min(extreme, previous.low) : Math.max(extreme, previous.high);
  }
  if (!Number.isFinite(extreme) || extreme <= 0) return null;
  if (short ? bar.close > extreme : bar.close < extreme) return null;

  // a entrada é agora, não numa zona lá embaixo: quem espera repique de
  // explosão fica de fora justamente das que não repicam
  const [entryLow, entryHigh] = normalizeEntryZone(
    bar.close - direction * atrValue * 0.25,
    bar.close + direction * atrValue * 0.15,
    bar.close,
  );
  const entryPrice = (entryLow + entryHigh) / 2;
  // o stop é o pé da explosão (o teto do desabamento): se o mercado devolver
  // a barra inteira, a tese morreu — não é preciso inventar distância nenhuma
  const stopLoss = short ? bar.high : bar.low;
  const risk = (entryPrice - stopLoss) * direction;
  if (risk <= 0) return null;

  const reasons = [
    `Candle de ${short ? 'baixa' : 'alta'} com corpo de ${bodyAtr.toFixed(1)} ATR no ${trigger.timeframe}`,
    `Volume ${volumeMultiple.toFixed(1)}x a média de 20 barras`,
    `Fechamento ${short ? 'abaixo da mínima' : 'acima da máxima'} das últimas ${BREAKOUT_LOOKBACK} barras`,
    `Fechou no ${short ? 'fundo' : 'topo'} da própria barra (${Math.round(closePosition * 100)}% do range)`,
    short
      ? 'BTC abaixo da média de 200 dias — o regime espelhado (este lado não foi medido)'
      : 'BTC acima da média de 200 dias — o regime que a medição exige',
  ];
  if (anchor.structure.trend === (short ? 'DOWN' : 'UP')) {
    reasons.push(`Tendência de ${short ? 'baixa' : 'alta'} no ${anchor.timeframe}`);
  }

  return {
    symbol: input.analysis.symbol,
    side,
    timeframe: trigger.timeframe,
    anchorTimeframe: anchor.timeframe,
    setupType: 'MOMENTUM_BURST',
    entryLow,
    entryHigh,
    stopLoss,
    // alvo único: o laboratório mediu saída INTEIRA em 3R, não 50/30/20
    target1: entryPrice + direction * risk * TARGET_R,
    target2: null,
    target3: null,
    reasons,
    levelPrice: extreme,
    qualityHints: {
      levelQuality: 0,
      volumeConfirmation: true,
      momentumTurning: true,
      trendAligned: anchor.structure.trend !== (short ? 'UP' : 'DOWN'),
      burst: { bodyAtr, volumeMultiple, lookback: BREAKOUT_LOOKBACK, closePosition },
    },
  };
}

function averageVolume(candles: Candle[], length: number): number {
  if (candles.length < length + 1) return 0;
  let total = 0;
  for (let i = candles.length - 1 - length; i < candles.length - 1; i += 1) {
    total += (candles[i] as Candle).volume;
  }
  return total / length;
}
