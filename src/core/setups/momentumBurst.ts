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
 *
 * ---------------------------------------------------------------------------
 * REMEDIDO EM 27/08/2026 sobre TODO o histórico da Binance: 28 pares,
 * 2017-10 a 2026-08 (3.237 dias), 5 janelas de tempo e as duas metades do
 * universo (src/lab/diagnostico.ts).
 *
 *   gatilho 1h    piso 95 .. +0,027R  PF 1,03   0,08 sinais/dia (28 pares)
 *                 piso 90 .. +0,082R  PF 1,11   0,19
 *                 piso 85 .. +0,087R  PF 1,11   0,29   <- melhor dos dois lados
 *                 piso 80 .. +0,052R  PF 1,07   0,40
 *                 sem piso . +0,048R  PF 1,06   0,55
 *
 *   gatilho 4h    piso 90 .. +0,285R  PF 1,42   0,04
 *                 piso 85 .. +0,306R  PF 1,45   0,06   <- o melhor de todos
 *                 sem piso . +0,251R  PF 1,36   0,13
 *
 * O piso 85 é o único que fica positivo nas DUAS metades do universo em 1h
 * (+0,104 e +0,075); o 90 tem uma metade em -0,009. Em 4h os dois passam, e o
 * 85 rende mais. Daí o padrão ter deixado de ser 90.
 *
 * ATENÇÃO ao tamanho da vantagem: +0,09R por operação em 1h é fino. Quatro em
 * cinco janelas são positivas, mas a pior delas é -0,12R. Isto não é uma
 * máquina de ganhar — é uma vantagem pequena que só existe somada em muitas
 * operações e só enquanto o regime de alta durar.
 *
 * E o que a medição diz sobre CHEGAR CEDO: a barra que gera o sinal anda, na
 * mediana, 3,78%, e a operação inteira oferece 3,77% depois dela. Metade do
 * movimento fica para trás — por construção, porque a tese É a barra grande.
 * Os detectores que entram cedo (pullback, reteste, reversão) têm razão de
 * 2,4 a 4,1 no mesmo teste e expectativa NEGATIVA em todos os pisos de score.
 * Entrar antes, aqui, não é um ajuste: é outra estratégia, ainda não medida.
 * ---------------------------------------------------------------------------
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
/**
 * Teto absoluto do atraso, valha o que valer a cadência da varredura.
 *
 * A tolerância pode crescer para acompanhar o tempo real de uma volta no
 * universo (ver `toleranciaDeAtraso`), mas não além disto. O desastre que
 * originou a regra — setup nascendo 173 minutos depois da barra — continua
 * impossível por construção, e não por sorte de configuração.
 */
export const TETO_ABSOLUTO_DE_ATRASO_MS = 25 * 60_000;

/**
 * Quanto atraso ainda é a mesma tese.
 *
 * O número fixo de 15% da barra tem um problema que não aparece em teste
 * nenhum: ele é uma promessa que a varredura não consegue cumprir. Uma barra
 * de 1h dá 9 minutos de validade, e o scanner leva de 12 a 14 minutos para
 * dar uma volta completa nos 455 pares — ou seja, boa parte das explosões
 * morre de velhice antes de o sistema chegar ao par. Medido em produção em
 * 27/08/2026: voltas de 761, 724 e 823 segundos.
 *
 * Com a cadência real em mãos, a tolerância passa a ser "uma volta inteira,
 * com folga" — limitada pelo teto absoluto. Quem protege contra a entrada
 * atrasada de verdade é a zona de entrada: se o preço saiu dela, o robô
 * recusa de qualquer jeito. Foi ela, e não esta regra, que salvou o TLMUSDT.
 */
export function toleranciaDeAtraso(barIntervalMs: number, cicloDeVarreduraMs?: number): number {
  const base = Math.min(barIntervalMs * MAX_STALE_FRACTION, MAX_STALE_MS);
  if (cicloDeVarreduraMs === undefined || !Number.isFinite(cicloDeVarreduraMs)) return base;
  /*
   * Dois tetos, e os dois precisam existir.
   *
   * O absoluto impede o desastre de horas. O relativo — metade da própria
   * barra — impede o oposto, que só aparece nos gatilhos curtos: uma volta de
   * 13 minutos autorizaria uma explosão de 5m com TRÊS barras de idade, que
   * já não é a mesma tese, é outro pedaço do gráfico.
   */
  const umaVolta = cicloDeVarreduraMs * 1.2; // o par pode ser o último do lote
  const teto = Math.min(TETO_ABSOLUTO_DE_ATRASO_MS, barIntervalMs * 0.5);
  return Math.min(Math.max(base, umaVolta), teto);
}

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

  /*
   * O regime do BTC — hoje um interruptor, e vale a pena saber por quê.
   *
   * A regra nasceu de uma medição que dizia "sem este filtro nenhuma variante
   * é positiva". Remedida em 27/08/2026 sobre 9 anos e já com o piso de score
   * 85, ela não se sustenta: o lado BLOQUEADO rende mais que o liberado
   * (+0,115R contra +0,087R em 1h; +0,482R contra +0,292R em 4h). A medição
   * antiga era de outra variante, mais fraca, e de uma janela curta.
   *
   * Continua LIGADO por padrão mesmo assim, e a razão é honesta: os pares
   * medidos são os sobreviventes de hoje, e as moedas que explodiram em
   * mercado de baixa e depois morreram não estão na amostra. Esse viés
   * favorece justamente o lado bloqueado. Quem desliga precisa saber que está
   * apostando que o viés explica menos do que a diferença medida.
   *
   * "Não saber o regime" continua não autorizando quando o filtro está ligado.
   */
  if (input.exigirRegimeDoBtc !== false && context?.btcAboveDailyMean !== !short) return null;

  const bar = candles[candles.length - 1] as Candle;

  // a explosão vale enquanto ela é notícia de agora
  const observedAt = Date.parse(input.analysis.updatedAt);
  if (Number.isFinite(observedAt)) {
    const barInterval = bar.closeTime - bar.openTime + 1;
    const tolerance = toleranciaDeAtraso(barInterval, input.scanCycleMs);
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
