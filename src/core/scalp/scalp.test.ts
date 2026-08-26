import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle, LiquiditySnapshot } from '../types.ts';
import { TIMEFRAME_MINUTES, TIMEFRAMES, timeframeMinutes } from '../types.ts';
import { measureLiquidity, sweepCost, depthUsd } from './liquidity.ts';
import { scoreScalpability } from './scalpability.ts';
import { analyzeRangeRegime } from './rangeRegime.ts';
import { allInCostPercent, computeMicroEconomics, microOpportunityRejection } from './microEconomics.ts';
import { DEFAULT_MICRO_SCALP } from './config.ts';
import { adx } from '../indicators/adx.ts';
import { rollingVwap } from '../indicators/vwap.ts';

const AGORA = 1_700_000_000_000;

function livro(spread: number, tamanhoPorNivel: number, niveis = 50) {
  const meio = 100;
  const bids: Array<[number, number]> = [];
  const asks: Array<[number, number]> = [];
  for (let i = 0; i < niveis; i += 1) {
    bids.push([meio * (1 - spread / 200) - i * 0.01, tamanhoPorNivel / meio]);
    asks.push([meio * (1 + spread / 200) + i * 0.01, tamanhoPorNivel / meio]);
  }
  return { bids, asks };
}

function liquidez(over: Partial<LiquiditySnapshot> = {}): LiquiditySnapshot {
  return {
    symbol: 'TESTUSDT',
    bid: 99.99,
    ask: 100.01,
    spreadPercent: 0.02,
    slippagePercent: 0.01,
    bidDepthUsd: 50_000,
    askDepthUsd: 50_000,
    quoteVolume24h: 200_000_000,
    recentQuoteVolume: 900_000,
    measuredAt: AGORA,
    ...over,
  };
}

/** Faixa lateral limpa: oscila entre 99 e 101 sem sair. */
function faixa(barras = 120, baixo = 99, alto = 101): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < barras; i += 1) {
    const meio = (baixo + alto) / 2;
    const amplitude = (alto - baixo) / 2;
    const fase = Math.sin((i / 7) * Math.PI);
    const close = meio + amplitude * fase * 0.92;
    const open = meio + amplitude * Math.sin(((i - 1) / 7) * Math.PI) * 0.92;
    out.push({
      openTime: AGORA + i * 60_000,
      open,
      high: Math.max(open, close) + amplitude * 0.06,
      low: Math.min(open, close) - amplitude * 0.06,
      close,
      volume: 100,
      quoteVolume: 100 * close,
      closeTime: AGORA + i * 60_000 + 59_999,
      closed: true,
    });
  }
  return out;
}

/** Tendência de alta firme: cada barra fecha acima da anterior. */
function tendencia(barras = 120): Candle[] {
  const out: Candle[] = [];
  let preco = 100;
  for (let i = 0; i < barras; i += 1) {
    const open = preco;
    preco *= 1.004;
    out.push({
      openTime: AGORA + i * 60_000,
      open,
      high: preco * 1.001,
      low: open * 0.999,
      close: preco,
      volume: 100,
      quoteVolume: 100 * preco,
      closeTime: AGORA + i * 60_000 + 59_999,
      closed: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// A armadilha que originou o item 9 do pedido
// ---------------------------------------------------------------------------

test('todo timeframe tem duração declarada — nenhum cai em fallback de 60 min', () => {
  // o `minutesOf` antigo terminava em `return 60`: qualquer timeframe novo
  // herdava calado a duração de uma hora, e um setup de 1m viveria 60x demais
  assert.equal(timeframeMinutes('1m'), 1);
  assert.equal(timeframeMinutes('15m'), 15);
  assert.equal(timeframeMinutes('1h'), 60);
  assert.equal(timeframeMinutes('4h'), 240);
  assert.equal(timeframeMinutes('1d'), 1440);
});

test('o 1m NÃO entra na varredura padrão', () => {
  // se entrasse, todo par do universo abriria stream de 1m no boot — ligado ou
  // desligado o micro scalp. É esta linha que faz o módulo ser mesmo opt-in
  assert.equal(TIMEFRAMES.includes('1m'), false);
  assert.equal(Object.keys(TIMEFRAME_MINUTES).length, 5);
});

test('o micro scalp nasce desligado', () => {
  assert.equal(DEFAULT_MICRO_SCALP.enabled, false);
});

// ---------------------------------------------------------------------------
// Liquidez medida no livro
// ---------------------------------------------------------------------------

test('varrer o book cobra mais caro quanto maior a ordem', () => {
  const { asks } = livro(0.02, 100);
  const pequena = sweepCost(asks, 100, 50, 'BUY');
  const grande = sweepCost(asks, 100, 3000, 'BUY');
  assert.ok(pequena !== null && grande !== null);
  assert.ok((grande as number) > (pequena as number));
});

test('book raso demais devolve null, não um número otimista', () => {
  // "não dá para executar" e "escorrega 0,3%" não podem virar o mesmo número:
  // o primeiro é impedimento, o segundo é custo
  const { asks } = livro(0.02, 1, 3);
  assert.equal(sweepCost(asks, 100, 50_000, 'BUY'), null);
});

test('o escorregamento é o PIOR dos dois lados, não a média', () => {
  const { bids, asks } = livro(0.02, 100);
  // book fundo dos dois lados: a medição existe e é pequena
  const simetrico = measureLiquidity({
    symbol: 'X',
    bids,
    asks,
    quoteVolume24h: 1,
    recentQuoteVolume: 1,
    probeOrderUsd: 500,
    measuredAt: AGORA,
  });
  assert.ok(simetrico?.slippagePercent !== null);

  /*
   * Agora a venda fica rasa: dá para ENTRAR barato e não dá para SAIR. A média
   * dos dois lados esconderia isso num número aceitável — e sair é a metade da
   * operação que não é opcional. O contrato é devolver null: "não dá para
   * executar" não pode virar um custo estimado.
   */
  const saidaRasa = measureLiquidity({
    symbol: 'X',
    bids: bids.slice(0, 2),
    asks,
    quoteVolume24h: 1,
    recentQuoteVolume: 1,
    probeOrderUsd: 500,
    measuredAt: AGORA,
  });
  assert.equal(saidaRasa?.slippagePercent, null);
});

test('profundidade soma o valor em dólar dos primeiros níveis', () => {
  const { bids } = livro(0.02, 100);
  assert.ok(depthUsd(bids, 10) > 900);
});

// ---------------------------------------------------------------------------
// Scalpability — cada filtro sozinho tem poder de veto
// ---------------------------------------------------------------------------

const BASE_SCORE = {
  filters: DEFAULT_MICRO_SCALP.filters,
  weights: DEFAULT_MICRO_SCALP.weights,
  feePercent: 0.1,
  fallbackSlippagePercent: 0.1,
  minCostMultiple: DEFAULT_MICRO_SCALP.regime.minCostMultiple,
  enforce: true,
};

test('par líquido e com amplitude passa', () => {
  const r = scoreScalpability({ ...BASE_SCORE, liquidity: liquidez(), microAtrPercent: 0.3 });
  assert.deepEqual(r.blockers, []);
  assert.ok(r.score >= 70, `esperava nota alta, veio ${r.score}`);
  assert.notEqual(r.grade, 'BLOQUEADO');
});

test('a nota não pune duas vezes o mesmo fato', () => {
  /*
   * O desconto de custo já mediu a razão custo/amplitude — que é exatamente o
   * que a parcela de "amplitude aproveitável" mede ao contrário. O par
   * apanhava nos dois lugares pela mesma característica e um par excelente
   * saía com 62. O desconto agora mede outra coisa: o atrito ALÉM da taxa.
   */
  const r = scoreScalpability({ ...BASE_SCORE, liquidity: liquidez(), microAtrPercent: 0.3 });
  const custo = r.components.find((c) => c.key === 'cost');
  assert.ok(custo);
  // taxa 0,1% x2 = 0,2 de 0,24 total: só 1/6 do custo é atrito evitável
  assert.ok(Math.abs(custo.points) < 6, `desconto de custo exagerado: ${custo.points}`);
});

test('book raso e caro é punido de verdade', () => {
  const ruim = scoreScalpability({
    ...BASE_SCORE,
    liquidity: liquidez({ spreadPercent: 0.055, slippagePercent: 0.045, bidDepthUsd: 5_500, askDepthUsd: 5_500 }),
    microAtrPercent: 0.3,
  });
  const bom = scoreScalpability({ ...BASE_SCORE, liquidity: liquidez(), microAtrPercent: 0.3 });
  assert.ok(ruim.score < bom.score - 25, `${ruim.score} vs ${bom.score}`);
});

test('spread alto reprova mesmo com volume excelente', () => {
  // é o caso que o ranking por volume deixaria passar: 200M em 24h e um book
  // que cobra mais para atravessar do que a barra costuma andar
  const r = scoreScalpability({
    ...BASE_SCORE,
    liquidity: liquidez({ spreadPercent: 0.5, quoteVolume24h: 900_000_000 }),
    microAtrPercent: 0.3,
  });
  assert.equal(r.grade, 'BLOQUEADO');
  assert.ok(r.blockers.some((b) => b.includes('spread')), r.blockers.join(' | '));
});

test('amplitude insuficiente reprova — é a aritmética do módulo', () => {
  // ATR de 1m do BTC: 0,056%. Alvo de 2 ATR não paga 0,2% de taxa
  const r = scoreScalpability({ ...BASE_SCORE, liquidity: liquidez(), microAtrPercent: 0.056 });
  assert.equal(r.grade, 'BLOQUEADO');
  assert.ok(
    r.blockers.some((b) => b.includes('amplitude insuficiente')),
    r.blockers.join(' | '),
  );
});

test('volatilidade anormal também reprova — não é oscilação, é notícia', () => {
  const r = scoreScalpability({ ...BASE_SCORE, liquidity: liquidez(), microAtrPercent: 3 });
  assert.equal(r.grade, 'BLOQUEADO');
  assert.ok(r.blockers.some((b) => b.includes('anormal')), r.blockers.join(' | '));
});

test('par parado agora reprova mesmo tendo girado muito em 24h', () => {
  const r = scoreScalpability({
    ...BASE_SCORE,
    liquidity: liquidez({ recentQuoteVolume: 500 }),
    microAtrPercent: 0.3,
  });
  assert.equal(r.grade, 'BLOQUEADO');
  assert.ok(r.blockers.some((b) => b.includes('parado')), r.blockers.join(' | '));
});

test('reprovado nunca sai com nota de aprovado', () => {
  const r = scoreScalpability({
    ...BASE_SCORE,
    liquidity: liquidez({ spreadPercent: 0.4 }),
    microAtrPercent: 0.5,
  });
  assert.ok(r.score < DEFAULT_MICRO_SCALP.filters.minScore);
});

// ---------------------------------------------------------------------------
// Regime
// ---------------------------------------------------------------------------

test('canal inclinado não é faixa, mesmo com ADX baixo', () => {
  // o eixo sobe devagar: cada borda de baixo está acima da anterior, e comprar
  // a de agora é comprar um degrau de uma escada em movimento
  const inclinada = faixa(120).map((c, i) => {
    const deriva = 1 + i * 0.0004;
    return { ...c, open: c.open * deriva, high: c.high * deriva, low: c.low * deriva, close: c.close * deriva };
  });
  const r = analyzeRangeRegime({
    candles: inclinada,
    settings: DEFAULT_MICRO_SCALP.regime,
    allInCostPercent: 0.22,
  });
  assert.notEqual(r.verdict, 'RANGE', r.reasons.join(' | '));
});

test('faixa lateral é reconhecida como RANGE', () => {
  const r = analyzeRangeRegime({
    candles: faixa(),
    settings: DEFAULT_MICRO_SCALP.regime,
    allInCostPercent: 0.22,
  });
  assert.equal(r.verdict, 'RANGE', r.reasons.join(' | '));
  assert.ok(r.confidence > 0);
  assert.ok(r.supportTouches >= 2 && r.resistanceTouches >= 2);
});

test('tendência firme NÃO é operada pelo micro scalp', () => {
  const r = analyzeRangeRegime({
    candles: tendencia(),
    settings: DEFAULT_MICRO_SCALP.regime,
    allInCostPercent: 0.22,
  });
  assert.notEqual(r.verdict, 'RANGE');
  assert.equal(r.confidence, 0);
});

test('faixa estreita demais para o custo é recusada — o caso do BTC em 1m', () => {
  // lateralidade perfeita e visível, e cada ida e volta rende menos que a taxa
  const r = analyzeRangeRegime({
    candles: faixa(120, 99.97, 100.03),
    settings: DEFAULT_MICRO_SCALP.regime,
    allInCostPercent: 0.22,
  });
  assert.notEqual(r.verdict, 'RANGE');
  assert.ok(
    r.reasons.some((motivo) => motivo.includes('não cobre')),
    r.reasons.join(' | '),
  );
});

test('histórico curto devolve INDEFINIDO em vez de chutar', () => {
  const r = analyzeRangeRegime({
    candles: faixa(20),
    settings: DEFAULT_MICRO_SCALP.regime,
    allInCostPercent: 0.22,
  });
  assert.equal(r.verdict, 'INDEFINIDO');
});

// ---------------------------------------------------------------------------
// A conta que decide tudo
// ---------------------------------------------------------------------------

test('o custo total soma as duas taxas, o spread e as duas pontas de escorregamento', () => {
  const custo = allInCostPercent({
    feePercent: 0.1,
    liquidity: liquidez({ spreadPercent: 0.02, slippagePercent: 0.01 }),
    fallbackSlippagePercent: 0.1,
  });
  // 0,1*2 + (0,02/2)*2 + 0,01*2
  assert.ok(Math.abs(custo - 0.24) < 1e-9, `veio ${custo}`);
});

test('futuros custa menos que spot no MESMO par', () => {
  const entrada = { liquidity: liquidez(), fallbackSlippagePercent: 0.1 };
  const spot = allInCostPercent({ ...entrada, feePercent: 0.1 });
  const futuros = allInCostPercent({ ...entrada, feePercent: 0.05 });
  assert.ok(futuros < spot);
  assert.ok(Math.abs(spot - futuros - 0.1) < 1e-9, 'a diferença é exatamente as duas taxas');
});

test('alvo que não paga o custo é recusado mesmo acertando', () => {
  const eco = computeMicroEconomics({
    side: 'BUY',
    entryPrice: 100,
    stopLoss: 99.9,
    target: 100.1, // 0,1% bruto contra 0,24% de custo
    feePercent: 0.1,
    liquidity: liquidez(),
    costs: { feePercent: 0.1, stopSlippagePercent: 0.15, exitSlippagePercent: 0.1 },
  });
  assert.ok(eco.netExpectedProfitPercent < 0);
  const recusa = microOpportunityRejection(eco, 2, 1.8);
  assert.ok(recusa !== null);
  assert.ok(recusa.includes('prejuízo'), recusa);
});

test('alvo com folga sobre o custo passa', () => {
  const eco = computeMicroEconomics({
    side: 'BUY',
    entryPrice: 100,
    // stop de 0,4% e alvo de 1,6%: R/R bruto 4, que é o que sobra ~2 depois
    // dos custos. É o tamanho que o módulo de fato exige — e mostrar isso no
    // teste é mostrar quanto o custo come mesmo numa operação boa
    stopLoss: 99.6,
    target: 101.6,
    feePercent: 0.1,
    liquidity: liquidez(),
    costs: { feePercent: 0.1, stopSlippagePercent: 0.15, exitSlippagePercent: 0.1 },
  });
  assert.ok(eco.netExpectedProfitPercent > 0);
  assert.ok(eco.costMultiple > 2);
  assert.equal(microOpportunityRejection(eco, 2, 1.8), null);
});

test('custo zero não vira multiplicador infinito', () => {
  const eco = computeMicroEconomics({
    side: 'BUY',
    entryPrice: 100,
    stopLoss: 99,
    target: 102,
    feePercent: 0,
    liquidity: liquidez({ spreadPercent: 0, slippagePercent: 0 }),
    costs: { feePercent: 0, stopSlippagePercent: 0, exitSlippagePercent: 0 },
  });
  assert.ok(Number.isFinite(eco.costMultiple));
});

// ---------------------------------------------------------------------------
// Indicadores novos
// ---------------------------------------------------------------------------

test('ADX separa tendência de lateralidade', () => {
  const emFaixa = adx(faixa(200), 14).at(-1);
  const emTendencia = adx(tendencia(200), 14).at(-1);
  assert.ok(emFaixa && emTendencia);
  assert.ok(
    (emTendencia as { adx: number }).adx > (emFaixa as { adx: number }).adx,
    'tendência precisa marcar ADX maior que faixa',
  );
});

test('VWAP fica dentro da faixa de preços da janela', () => {
  const candles = faixa();
  const valor = rollingVwap(candles, 60).at(-1);
  assert.ok(valor !== null && valor !== undefined);
  assert.ok((valor as number) > 98.9 && (valor as number) < 101.1, `veio ${valor}`);
});

test('VWAP não inventa preço quando não houve volume', () => {
  const semVolume = faixa(80).map((c) => ({ ...c, volume: 0, quoteVolume: 0 }));
  assert.equal(rollingVwap(semVolume, 60).at(-1), null);
});

// ---------------------------------------------------------------------------
// Modo permissivo: os filtros descrevem em vez de vetar
// ---------------------------------------------------------------------------

test('sem vetar, o par entra com o motivo anexado em vez de barrado', () => {
  const entrada = { ...BASE_SCORE, liquidity: liquidez(), microAtrPercent: 0.02 };
  const vetando = scoreScalpability({ ...entrada, enforce: true });
  const avisando = scoreScalpability({ ...entrada, enforce: false });

  assert.equal(vetando.blocked, true);
  assert.equal(avisando.blocked, false);
  // o diagnóstico é o MESMO nos dois: muda o que se faz com ele, não o fato
  assert.deepEqual(avisando.blockers, vetando.blockers);
  assert.ok(avisando.blockers.length > 0);
});

test('a nota não é rebaixada por ter impedimento', () => {
  /*
   * A versão anterior achatava a nota de quem tinha algum impedimento, para
   * ninguém ler "68" e achar que faltava pouco. Com os filtros apenas
   * avisando isso passaria a mentir: dois pares muito diferentes sairiam com
   * a mesma nota inventada, e o ranking que escolhe quem entra no universo
   * deixaria de ordenar qualquer coisa.
   */
  const ruim = scoreScalpability({
    ...BASE_SCORE,
    liquidity: liquidez({ spreadPercent: 0.5 }),
    microAtrPercent: 0.3,
    enforce: false,
  });
  const pessimo = scoreScalpability({
    ...BASE_SCORE,
    liquidity: liquidez({ spreadPercent: 0.5, quoteVolume24h: 100, recentQuoteVolume: 10 }),
    microAtrPercent: 0.005,
    enforce: false,
  });
  assert.ok(ruim.score > pessimo.score, `${ruim.score} deveria ser maior que ${pessimo.score}`);
});

test('permissivo NÃO maquia a conta — o custo continua o real', () => {
  const r = scoreScalpability({
    ...BASE_SCORE,
    liquidity: liquidez(),
    microAtrPercent: 0.02,
    enforce: false,
  });
  // é este número que a tese vai usar para calcular o líquido; afrouxar o
  // veto não pode torná-lo otimista
  assert.ok(Math.abs(r.allInCostPercent - 0.24) < 1e-9, `veio ${r.allInCostPercent}`);
});
