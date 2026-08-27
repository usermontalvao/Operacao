import type { Candle } from '../core/types.ts';
import { adx } from '../core/indicators/adx.ts';
import { atr } from '../core/indicators/atr.ts';
import { bollinger } from '../core/indicators/bollinger.ts';
import { ema, sma, standardDeviation } from '../core/indicators/ema.ts';
import { macd } from '../core/indicators/macd.ts';
import { rsi } from '../core/indicators/rsi.ts';
import { rollingVwap } from '../core/indicators/vwap.ts';

/**
 * BANCO DE ESTRATÉGIAS CANDIDATAS — o laboratório, não a produção.
 *
 * Nada aqui move dinheiro. São hipóteses escritas para serem MEDIDAS, e a
 * maioria vai morrer: é para isso que servem. O valor deste arquivo não está
 * em nenhuma estratégia em particular, está em elas passarem todas pelo mesmo
 * simulador, com os mesmos custos e a mesma regra de "na barra i só existe o
 * que aconteceu até i".
 *
 * O RISCO DESTE ARQUIVO, escrito aqui porque é o que mais engana:
 * testar centenas de combinações GARANTE encontrar vencedoras por sorte. Com
 * 200 testes, umas dez vão parecer ótimas sem ter vantagem nenhuma. Por isso
 * o corte não é "qual teve o melhor número" — é "qual continua positiva em
 * treino E teste, nas cinco janelas de tempo E nas duas metades do universo".
 * Quem escolhe pelo máximo da tabela está escolhendo o melhor sorteio.
 */

/** Uma entrada proposta: onde entrar, onde morre a tese, e o alvo em múltiplos do risco. */
export interface Candidata {
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
}

/** Tudo o que os detectores precisam, calculado uma vez por série. */
export interface Contexto {
  candles: Candle[];
  close: number[];
  atr14: (number | null)[];
  ema9: (number | null)[];
  ema21: (number | null)[];
  ema50: (number | null)[];
  ema200: (number | null)[];
  sma20: (number | null)[];
  rsi2: (number | null)[];
  rsi14: (number | null)[];
  bb20: ReturnType<typeof bollinger>;
  macdLinha: ReturnType<typeof macd>;
  adx14: ReturnType<typeof adx>;
  vwap60: (number | null)[];
  desvio20: (number | null)[];
  volMedia20: number[];
  /** largura da banda de Bollinger em % da média — mede compressão */
  larguraBB: (number | null)[];
}

export function montarContexto(candles: Candle[]): Contexto {
  const close = candles.map((c) => c.close);
  const bb20 = bollinger(close, 20, 2);
  const sma20 = sma(close, 20);
  const volMedia20: number[] = new Array(candles.length).fill(0);
  let soma = 0;
  for (let i = 0; i < candles.length; i += 1) {
    soma += (candles[i] as Candle).volume;
    if (i >= 20) soma -= (candles[i - 20] as Candle).volume;
    volMedia20[i] = i >= 19 ? soma / 20 : 0;
  }
  const larguraBB = bb20.map((p) =>
    p && p.middle > 0 ? ((p.upper - p.lower) / p.middle) * 100 : null,
  );
  return {
    candles,
    close,
    atr14: atr(candles, 14),
    ema9: ema(close, 9),
    ema21: ema(close, 21),
    ema50: ema(close, 50),
    ema200: ema(close, 200),
    sma20,
    rsi2: rsi(close, 2),
    rsi14: rsi(close, 14),
    bb20,
    macdLinha: macd(close),
    adx14: adx(candles, 14),
    vwap60: rollingVwap(candles, 60),
    desvio20: standardDeviation(close, 20),
    volMedia20,
    larguraBB,
  };
}

export interface Estrategia {
  nome: string;
  familia: 'TENDÊNCIA' | 'ROMPIMENTO' | 'REVERSÃO' | 'COMPRESSÃO' | 'MOMENTO' | 'PADRÃO';
  /** ideia em uma linha — para o relatório dizer o que foi testado */
  ideia: string;
  detectar(ctx: Contexto, i: number): Candidata | null;
}

// --------------------------------------------------------------------------
// utilidades comuns
// --------------------------------------------------------------------------

const num = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : v;

/** Menor mínima das últimas `n` barras, inclusive a atual. */
function minimaDe(candles: Candle[], i: number, n: number): number {
  let menor = Number.POSITIVE_INFINITY;
  for (let k = Math.max(0, i - n + 1); k <= i; k += 1) menor = Math.min(menor, (candles[k] as Candle).low);
  return menor;
}

function maximaDe(candles: Candle[], i: number, n: number): number {
  let maior = 0;
  for (let k = Math.max(0, i - n + 1); k <= i; k += 1) maior = Math.max(maior, (candles[k] as Candle).high);
  return maior;
}

/** Entrada colada no fechamento — para teses que compram agora. */
function zonaAgora(close: number, atrValue: number): [number, number] {
  return [close - atrValue * 0.25, close + atrValue * 0.15];
}

/** Entrada esperando o preço voltar — para teses de correção. */
function zonaAbaixo(close: number, atrValue: number, fundura: number): [number, number] {
  return [close - atrValue * (fundura + 0.4), close - atrValue * fundura];
}

/** Monta a candidata garantindo risco positivo e stop com folga mínima. */
function montar(
  entrada: [number, number],
  stopLoss: number,
  atrValue: number,
): Candidata | null {
  const [entryLow, entryHigh] = entrada;
  if (!(entryLow > 0) || !(entryHigh > 0) || entryHigh < entryLow) return null;
  const entryPrice = (entryLow + entryHigh) / 2;
  const risco = entryPrice - stopLoss;
  // stop colado demais infla o R/R e vira estopada no primeiro ruído — a mesma
  // regra que o setupEngine aplica na produção
  if (risco <= 0 || risco < atrValue * 0.45) return null;
  return { entryLow, entryHigh, stopLoss };
}

// --------------------------------------------------------------------------
// TENDÊNCIA — comprar a favor do movimento maior
// --------------------------------------------------------------------------

function cruzamentoEma(rapida: number, lenta: number): Estrategia {
  const campoRapida = rapida === 9 ? 'ema9' : 'ema21';
  const campoLenta = lenta === 21 ? 'ema21' : lenta === 50 ? 'ema50' : 'ema200';
  return {
    nome: `EMA ${rapida}x${lenta} cruza para cima`,
    familia: 'TENDÊNCIA',
    ideia: 'a média curta cruza a longa para cima; entra no fechamento da barra do cruzamento',
    detectar(ctx, i) {
      const r = num(ctx[campoRapida as 'ema9'][i]);
      const l = num(ctx[campoLenta as 'ema50'][i]);
      const rAnt = num(ctx[campoRapida as 'ema9'][i - 1]);
      const lAnt = num(ctx[campoLenta as 'ema50'][i - 1]);
      const a = num(ctx.atr14[i]);
      if (r === null || l === null || rAnt === null || lAnt === null || a === null || a <= 0) return null;
      if (!(rAnt <= lAnt && r > l)) return null;
      const bar = ctx.candles[i] as Candle;
      return montar(zonaAgora(bar.close, a), minimaDe(ctx.candles, i, 5) - a * 0.2, a);
    },
  };
}

function macdCruza(comFiltro: boolean): Estrategia {
  return {
    nome: `MACD cruza a linha de sinal${comFiltro ? ' (só acima da EMA200)' : ''}`,
    familia: 'TENDÊNCIA',
    ideia: 'histograma vira positivo; a versão filtrada só aceita em tendência de alta',
    detectar(ctx, i) {
      const m = ctx.macdLinha[i];
      const mAnt = ctx.macdLinha[i - 1];
      const a = num(ctx.atr14[i]);
      if (!m || !mAnt || a === null || a <= 0) return null;
      if (!(mAnt.histogram <= 0 && m.histogram > 0)) return null;
      const bar = ctx.candles[i] as Candle;
      if (comFiltro) {
        const e200 = num(ctx.ema200[i]);
        if (e200 === null || bar.close <= e200) return null;
      }
      return montar(zonaAgora(bar.close, a), minimaDe(ctx.candles, i, 7) - a * 0.2, a);
    },
  };
}

function tendenciaComAdx(minAdx: number): Estrategia {
  return {
    nome: `EMA9>EMA21 com ADX >= ${minAdx}`,
    familia: 'TENDÊNCIA',
    ideia: 'só compra tendência quando o ADX diz que existe tendência de verdade',
    detectar(ctx, i) {
      const e9 = num(ctx.ema9[i]);
      const e21 = num(ctx.ema21[i]);
      const a = num(ctx.atr14[i]);
      const ad = ctx.adx14[i];
      if (e9 === null || e21 === null || a === null || a <= 0 || !ad) return null;
      if (!(e9 > e21 && ad.adx >= minAdx && ad.plusDi > ad.minusDi)) return null;
      // só na barra em que a condição NASCE, senão vira sinal todo dia
      const adAnt = ctx.adx14[i - 1];
      if (adAnt && adAnt.adx >= minAdx && adAnt.plusDi > adAnt.minusDi) return null;
      const bar = ctx.candles[i] as Candle;
      return montar(zonaAgora(bar.close, a), minimaDe(ctx.candles, i, 5) - a * 0.2, a);
    },
  };
}

// --------------------------------------------------------------------------
// ROMPIMENTO — comprar quando o preço vence um extremo
// --------------------------------------------------------------------------

function donchian(lookback: number): Estrategia {
  return {
    nome: `Rompe a máxima de ${lookback} barras`,
    familia: 'ROMPIMENTO',
    ideia: 'canal de Donchian clássico: fecha acima do teto do período',
    detectar(ctx, i) {
      const a = num(ctx.atr14[i]);
      if (a === null || a <= 0 || i < lookback + 2) return null;
      const bar = ctx.candles[i] as Candle;
      const tetoAnterior = maximaDe(ctx.candles, i - 1, lookback);
      if (bar.close <= tetoAnterior) return null;
      // e não pode já ter rompido na barra anterior: queremos o momento
      const anterior = ctx.candles[i - 1] as Candle;
      if (anterior.close > maximaDe(ctx.candles, i - 2, lookback)) return null;
      return montar(
        zonaAgora(bar.close, a),
        Math.min(minimaDe(ctx.candles, i, Math.max(5, Math.round(lookback / 2))), tetoAnterior) - a * 0.2,
        a,
      );
    },
  };
}

function keltner(multiplo: number): Estrategia {
  return {
    nome: `Fecha acima da EMA20 + ${multiplo} ATR`,
    familia: 'ROMPIMENTO',
    ideia: 'canal de Keltner: expansão medida em ATR em vez de desvio padrão',
    detectar(ctx, i) {
      const a = num(ctx.atr14[i]);
      const media = num(ctx.sma20[i]);
      if (a === null || a <= 0 || media === null) return null;
      const bar = ctx.candles[i] as Candle;
      const anterior = ctx.candles[i - 1] as Candle;
      const mediaAnt = num(ctx.sma20[i - 1]);
      const aAnt = num(ctx.atr14[i - 1]);
      if (!anterior || mediaAnt === null || aAnt === null) return null;
      if (!(bar.close > media + multiplo * a && anterior.close <= mediaAnt + multiplo * aAnt)) return null;
      return montar(zonaAgora(bar.close, a), media - a * 0.5, a);
    },
  };
}

function barraInterna(): Estrategia {
  return {
    nome: `Rompe a barra que engoliu a anterior`,
    familia: 'ROMPIMENTO',
    ideia: 'barra interna (inside bar) é pausa; o rompimento dela costuma continuar',
    detectar(ctx, i) {
      const a = num(ctx.atr14[i]);
      if (a === null || a <= 0 || i < 3) return null;
      const mae = ctx.candles[i - 2] as Candle;
      const interna = ctx.candles[i - 1] as Candle;
      const bar = ctx.candles[i] as Candle;
      if (!(interna.high <= mae.high && interna.low >= mae.low)) return null;
      if (bar.close <= interna.high) return null;
      return montar(zonaAgora(bar.close, a), interna.low - a * 0.1, a);
    },
  };
}

// --------------------------------------------------------------------------
// COMPRESSÃO — a família que tenta chegar ANTES da explosão
// --------------------------------------------------------------------------

function apertoDeBollinger(percentil: number): Estrategia {
  return {
    nome: `Aperto de Bollinger (${percentil}% mais estreito) e rompe`,
    familia: 'COMPRESSÃO',
    ideia:
      'volatilidade comprimida antecede expansão; entra quando a banda estava estreita e o preço rompe',
    detectar(ctx, i) {
      const a = num(ctx.atr14[i]);
      const larg = num(ctx.larguraBB[i - 1]);
      const banda = ctx.bb20[i];
      if (a === null || a <= 0 || larg === null || !banda || i < 120) return null;
      // a largura de ontem estava entre as mais estreitas das últimas 100?
      const janela: number[] = [];
      for (let k = i - 100; k < i; k += 1) {
        const v = num(ctx.larguraBB[k]);
        if (v !== null) janela.push(v);
      }
      if (janela.length < 60) return null;
      janela.sort((x, y) => x - y);
      const corte = janela[Math.floor(janela.length * (percentil / 100))] as number;
      if (larg > corte) return null;
      const bar = ctx.candles[i] as Candle;
      if (bar.close <= banda.upper) return null;
      return montar(zonaAgora(bar.close, a), banda.lower, a);
    },
  };
}

function contracaoDeRange(barras: number): Estrategia {
  return {
    nome: `Menor amplitude em ${barras} barras e rompe`,
    familia: 'COMPRESSÃO',
    ideia: 'NR7 e parentes: a barra mais estreita do período costuma preceder movimento',
    detectar(ctx, i) {
      const a = num(ctx.atr14[i]);
      if (a === null || a <= 0 || i < barras + 2) return null;
      const estreita = ctx.candles[i - 1] as Candle;
      const amplitude = estreita.high - estreita.low;
      for (let k = i - barras; k < i - 1; k += 1) {
        const c = ctx.candles[k] as Candle;
        if (c.high - c.low <= amplitude) return null;
      }
      const bar = ctx.candles[i] as Candle;
      if (bar.close <= estreita.high) return null;
      return montar(zonaAgora(bar.close, a), estreita.low - a * 0.1, a);
    },
  };
}

// --------------------------------------------------------------------------
// REVERSÃO — comprar o exagero para baixo
// --------------------------------------------------------------------------

function rsiSobrevendido(periodo: 2 | 14, corte: number, comTendencia: boolean): Estrategia {
  const campo = periodo === 2 ? 'rsi2' : 'rsi14';
  return {
    nome: `RSI(${periodo}) < ${corte}${comTendencia ? ' acima da EMA200' : ''}`,
    familia: 'REVERSÃO',
    ideia: 'exagero de curto prazo dentro (ou fora) de uma tendência maior de alta',
    detectar(ctx, i) {
      const r = num(ctx[campo][i]);
      const a = num(ctx.atr14[i]);
      if (r === null || a === null || a <= 0 || r >= corte) return null;
      const rAnt = num(ctx[campo][i - 1]);
      if (rAnt !== null && rAnt < corte) return null; // só quando entra na zona
      const bar = ctx.candles[i] as Candle;
      if (comTendencia) {
        const e200 = num(ctx.ema200[i]);
        if (e200 === null || bar.close <= e200) return null;
      }
      return montar(zonaAgora(bar.close, a), minimaDe(ctx.candles, i, 3) - a * 0.3, a);
    },
  };
}

function bandaInferior(esperaRepique: boolean): Estrategia {
  return {
    nome: `Toca a banda inferior de Bollinger${esperaRepique ? ' (espera voltar)' : ''}`,
    familia: 'REVERSÃO',
    ideia: 'preço dois desvios abaixo da média volta para a média',
    detectar(ctx, i) {
      const banda = ctx.bb20[i];
      const a = num(ctx.atr14[i]);
      if (!banda || a === null || a <= 0) return null;
      const bar = ctx.candles[i] as Candle;
      if (bar.low > banda.lower) return null;
      if (bar.close < banda.lower) return null; // fechou de volta para dentro
      const zona = esperaRepique ? zonaAbaixo(bar.close, a, 0.3) : zonaAgora(bar.close, a);
      return montar(zona, Math.min(bar.low, banda.lower) - a * 0.3, a);
    },
  };
}

function desvioDaVwap(desvios: number): Estrategia {
  return {
    nome: `${desvios} desvios abaixo da VWAP de 60 barras`,
    familia: 'REVERSÃO',
    ideia: 'a VWAP é o preço médio ponderado por volume; distância dela costuma fechar',
    detectar(ctx, i) {
      const v = num(ctx.vwap60[i]);
      const d = num(ctx.desvio20[i]);
      const a = num(ctx.atr14[i]);
      if (v === null || d === null || d <= 0 || a === null || a <= 0) return null;
      const bar = ctx.candles[i] as Candle;
      const z = (bar.close - v) / d;
      if (z > -desvios) return null;
      const zAnt = (() => {
        const vA = num(ctx.vwap60[i - 1]);
        const dA = num(ctx.desvio20[i - 1]);
        const cA = ctx.candles[i - 1] as Candle;
        return vA !== null && dA !== null && dA > 0 ? (cA.close - vA) / dA : null;
      })();
      if (zAnt !== null && zAnt <= -desvios) return null;
      return montar(zonaAgora(bar.close, a), minimaDe(ctx.candles, i, 5) - a * 0.3, a);
    },
  };
}

// --------------------------------------------------------------------------
// MOMENTO — variações da explosão que já roda, para achar o limiar certo
// --------------------------------------------------------------------------

function explosao(corpoAtr: number, volume: number, exigeRompimento: boolean): Estrategia {
  return {
    nome: `Explosão ${corpoAtr} ATR · volume ${volume}x${exigeRompimento ? ' · rompe 40 barras' : ''}`,
    familia: 'MOMENTO',
    ideia: 'a família que já opera, com os limiares afrouxados e apertados em volta do atual',
    detectar(ctx, i) {
      const a = num(ctx.atr14[i]);
      if (a === null || a <= 0 || i < 45) return null;
      const bar = ctx.candles[i] as Candle;
      const corpo = bar.close - bar.open;
      const amplitude = bar.high - bar.low;
      if (corpo <= 0 || amplitude <= 0) return null;
      if (corpo / a < corpoAtr) return null;
      if ((bar.close - bar.low) / amplitude < 0.7) return null;
      const media = ctx.volMedia20[i] ?? 0;
      if (media <= 0 || bar.volume / media < volume) return null;
      if (exigeRompimento && bar.close < maximaDe(ctx.candles, i - 1, 40)) return null;
      return montar(zonaAgora(bar.close, a), bar.low, a);
    },
  };
}

function aceleracao(barras: number, minPercent: number): Estrategia {
  return {
    nome: `Sobe ${minPercent}% em ${barras} barras`,
    familia: 'MOMENTO',
    ideia: 'taxa de variação pura, sem olhar volume nem estrutura',
    detectar(ctx, i) {
      const a = num(ctx.atr14[i]);
      if (a === null || a <= 0 || i < barras + 2) return null;
      const antes = ctx.candles[i - barras] as Candle;
      const bar = ctx.candles[i] as Candle;
      if (antes.close <= 0) return null;
      const variacao = ((bar.close - antes.close) / antes.close) * 100;
      if (variacao < minPercent) return null;
      const antesAnt = ctx.candles[i - barras - 1] as Candle;
      const anterior = ctx.candles[i - 1] as Candle;
      if (antesAnt.close > 0 && ((anterior.close - antesAnt.close) / antesAnt.close) * 100 >= minPercent) {
        return null;
      }
      return montar(zonaAgora(bar.close, a), minimaDe(ctx.candles, i, barras) - a * 0.2, a);
    },
  };
}

// --------------------------------------------------------------------------
// PADRÃO — formações de candle clássicas
// --------------------------------------------------------------------------

function engolfo(comTendencia: boolean): Estrategia {
  return {
    nome: `Engolfo de alta${comTendencia ? ' acima da EMA200' : ''}`,
    familia: 'PADRÃO',
    ideia: 'barra de alta que engole o corpo da barra de baixa anterior',
    detectar(ctx, i) {
      const a = num(ctx.atr14[i]);
      if (a === null || a <= 0 || i < 2) return null;
      const anterior = ctx.candles[i - 1] as Candle;
      const bar = ctx.candles[i] as Candle;
      if (!(anterior.close < anterior.open)) return null;
      if (!(bar.close > bar.open && bar.close > anterior.open && bar.open < anterior.close)) return null;
      if (comTendencia) {
        const e200 = num(ctx.ema200[i]);
        if (e200 === null || bar.close <= e200) return null;
      }
      return montar(zonaAgora(bar.close, a), Math.min(bar.low, anterior.low) - a * 0.1, a);
    },
  };
}

function martelo(): Estrategia {
  return {
    nome: `Martelo (pavio longo embaixo)`,
    familia: 'PADRÃO',
    ideia: 'rejeição de preço mais baixo: pavio inferior grande e fechamento no topo',
    detectar(ctx, i) {
      const a = num(ctx.atr14[i]);
      if (a === null || a <= 0) return null;
      const bar = ctx.candles[i] as Candle;
      const amplitude = bar.high - bar.low;
      if (amplitude <= 0) return null;
      const corpo = Math.abs(bar.close - bar.open);
      const pavio = Math.min(bar.open, bar.close) - bar.low;
      if (pavio < corpo * 2) return null;
      if ((bar.close - bar.low) / amplitude < 0.6) return null;
      if (amplitude < a * 0.8) return null;
      return montar(zonaAgora(bar.close, a), bar.low - a * 0.1, a);
    },
  };
}

// --------------------------------------------------------------------------
// O catálogo inteiro
// --------------------------------------------------------------------------

/**
 * O catálogo. O ALVO não entra aqui de propósito: ele é dimensão do teste, não
 * parte da tese. Detectar é a parte cara (varre milhões de barras); multiplicar
 * por três alvos depois custa quase nada. Misturar os dois fazia o laboratório
 * repetir a mesma detecção três vezes.
 */
export function catalogo(): Estrategia[] {
  return [
    cruzamentoEma(9, 21),
    cruzamentoEma(9, 50),
    cruzamentoEma(21, 50),
    macdCruza(false),
    macdCruza(true),
    tendenciaComAdx(25),
    tendenciaComAdx(35),

    donchian(20),
    donchian(40),
    donchian(55),
    keltner(1.5),
    keltner(2.5),
    barraInterna(),

    apertoDeBollinger(10),
    apertoDeBollinger(25),
    contracaoDeRange(7),
    contracaoDeRange(14),

    rsiSobrevendido(2, 5, true),
    rsiSobrevendido(2, 10, true),
    rsiSobrevendido(2, 5, false),
    rsiSobrevendido(14, 30, true),
    bandaInferior(false),
    bandaInferior(true),
    desvioDaVwap(2),
    desvioDaVwap(2.5),

    explosao(1, 2, false),
    explosao(1.5, 2, true),
    explosao(1.5, 3, true),
    explosao(2, 3, true),
    explosao(2.5, 3, true),
    explosao(2, 4, true),
    aceleracao(3, 5),
    aceleracao(6, 8),
    aceleracao(12, 12),

    engolfo(true),
    engolfo(false),
    martelo(),
  ];
}

/** Os alvos testados sobre CADA detector, em múltiplos do risco. */
export const ALVOS_TESTADOS = [1.5, 2, 3];
