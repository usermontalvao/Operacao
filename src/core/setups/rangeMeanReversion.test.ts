import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle, RangeRegimeReport } from '../types.ts';
import { MICRO_TIMEFRAME } from '../types.ts';
import { detectRangeFadeLong, detectRangeFadeShort } from './rangeMeanReversion.ts';
import { computeIndicators } from '../engines/indicatorEngine.ts';
import { computeStructure } from '../engines/structureEngine.ts';
import type { SymbolAnalysis, TimeframeAnalysis } from '../analysis.ts';

const AGORA = 1_700_000_000_000;

/**
 * Uma faixa entre 99 e 101 com o preço voltando do fundo na última barra —
 * a situação que o detector existe para encontrar.
 */
function serieNoFundo(): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 120; i += 1) {
    const close = 100 + Math.sin((i / 9) * Math.PI) * 0.9;
    const open = 100 + Math.sin(((i - 1) / 9) * Math.PI) * 0.9;
    out.push(barra(i, open, close, Math.max(open, close) + 0.05, Math.min(open, close) - 0.05, 100));
  }
  // as duas últimas: uma queda até o fundo e uma rejeição com pavio longo
  out.push(barra(120, 99.6, 99.15, 99.65, 99.1, 140));
  out.push(barra(121, 99.15, 99.55, 99.6, 99.02, 90));
  return out;
}

function barra(i: number, open: number, close: number, high: number, low: number, volume: number): Candle {
  return {
    openTime: AGORA + i * 60_000,
    open, high, low, close, volume,
    quoteVolume: volume * close,
    closeTime: AGORA + i * 60_000 + 59_999,
    closed: true,
  };
}

function regime(over: Partial<RangeRegimeReport> = {}): RangeRegimeReport {
  return {
    verdict: 'RANGE',
    confidence: 0.8,
    support: 99,
    resistance: 101,
    amplitudePercent: 2,
    position: 0.1,
    adx: 15,
    emaSlopePercent: 0.001,
    bollingerWidthPercent: 1.2,
    vwap: 100.2,
    supportTouches: 4,
    resistanceTouches: 4,
    reasons: [],
    ...over,
  };
}

function entrada(candles: Candle[], trend: 'UP' | 'DOWN' | 'SIDEWAYS' = 'SIDEWAYS') {
  const indicators = computeIndicators(candles, MICRO_TIMEFRAME);
  const trigger: TimeframeAnalysis = {
    timeframe: MICRO_TIMEFRAME,
    candles,
    indicators,
    structure: computeStructure(candles, indicators),
  };
  const anchor: TimeframeAnalysis = {
    ...trigger,
    timeframe: '15m',
    structure: { ...trigger.structure, trend },
  };
  const analysis: SymbolAnalysis = {
    symbol: 'TESTUSDT',
    price: indicators.close,
    changePercent24h: null,
    timeframes: { [MICRO_TIMEFRAME]: trigger, '15m': anchor },
    updatedAt: new Date(AGORA).toISOString(),
  };
  return { analysis, trigger, anchor, context: null, entryZonePercent: 25 };
}

test('compra a borda de baixo quando há faixa e rejeição', () => {
  const c = detectRangeFadeLong({ ...entrada(serieNoFundo()), regime: regime() });
  assert.ok(c, 'esperava um candidato');
  assert.equal(c.setupType, 'RANGE_FADE');
  assert.equal(c.side, 'BUY');
});

test('o ALVO fica acima da entrada numa compra', () => {
  /*
   * Este teste existe por causa de um bug real e mudo. `isFavorable(side, a, b)`
   * pergunta se A está no lado bom em relação a B — o alvo vem primeiro. Com os
   * argumentos trocados, a checagem exigia alvo ABAIXO da entrada numa compra e
   * recusava 100% dos sinais. O detector não quebrava, não avisava e não gerava
   * nada: em 102 janelas com faixa confirmada, zero setups. Só o backtest
   * separado revelou.
   */
  const c = detectRangeFadeLong({ ...entrada(serieNoFundo()), regime: regime() });
  assert.ok(c);
  const entryPrice = (c.entryLow + c.entryHigh) / 2;
  assert.ok(c.target1 > entryPrice, `alvo ${c.target1} não está acima da entrada ${entryPrice}`);
  assert.ok(c.stopLoss < entryPrice, `stop ${c.stopLoss} não está abaixo da entrada ${entryPrice}`);
  assert.ok(c.target1 < 101.01, 'o alvo não pode passar da borda oposta da faixa');
});

test('o alvo para AQUÉM da borda oposta, não nela', () => {
  // quem mira a extremidade exata quase nunca preenche: é ali que o outro lado
  // do book espera. Numa operação medida em décimos de %, não preencher é o
  // pior resultado possível
  const c = detectRangeFadeLong({ ...entrada(serieNoFundo()), regime: regime() });
  assert.ok(c);
  assert.ok(c.target1 < 101, `alvo ${c.target1} tocou a resistência`);
});

test('sem faixa não há tese, por mais bonita que esteja a barra', () => {
  for (const verdict of ['TENDENCIA', 'EXPANSAO', 'INDEFINIDO'] as const) {
    const c = detectRangeFadeLong({ ...entrada(serieNoFundo()), regime: regime({ verdict }) });
    assert.equal(c, null, `${verdict} não podia gerar setup`);
  }
});

test('no meio da faixa não opera — não há borda perto nem alvo longe', () => {
  const c = detectRangeFadeLong({ ...entrada(serieNoFundo()), regime: regime({ position: 0.5 }) });
  assert.equal(c, null);
});

test('âncora de 15m em queda veta a compra do fundo', () => {
  // a faixa é real, mas é o repouso entre duas quedas: a borda de baixo cede
  const c = detectRangeFadeLong({
    ...entrada(serieNoFundo(), 'DOWN'),
    regime: regime(),
  });
  assert.equal(c, null);
});

test('o lado vendido é o espelho e exige a borda de cima', () => {
  // no fundo da faixa não existe tese vendida, por mais que o mercado permita
  const c = detectRangeFadeShort({ ...entrada(serieNoFundo()), regime: regime() });
  assert.equal(c, null);
});

test('tocar o suporte sem rejeição NÃO é motivo para comprar', () => {
  /*
   * A regra que separa este detector de uma armadilha: toda faixa termina, e
   * ela termina exatamente com um toque que não voltou. Uma barra que fecha na
   * mínima é o rompimento começando, não a defesa acontecendo.
   */
  const caindo = serieNoFundo().slice(0, -2);
  caindo.push(barra(120, 99.9, 99.05, 99.92, 99.0, 300));
  caindo.push(barra(121, 99.05, 98.62, 99.06, 98.6, 420));
  const c = detectRangeFadeLong({ ...entrada(caindo), regime: regime({ position: 0.05 }) });
  assert.equal(c, null, 'fechou na mínima com volume crescente: é rompimento, não defesa');
});
