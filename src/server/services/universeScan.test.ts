import assert from 'node:assert/strict';
import test from 'node:test';
import type { RawKline } from '../binance/rest.ts';
import { analyzeSymbol, analyzeSymbols } from './universeService.ts';

/** Uma linha de candle no formato cru da Binance. */
function row(openTime: number, close: number): RawKline {
  const high = close * 1.004;
  const low = close * 0.996;
  return {
    0: openTime,
    1: String(close * 0.999),
    2: String(high),
    3: String(low),
    4: String(close),
    5: '1000',
    6: openTime + 3_600_000,
    7: '100000',
    8: 500,
    9: '500',
    10: '50000',
    11: '0',
  };
}

/**
 * Série com 200 candles fechados mais o candle em formação no fim — é assim
 * que a Binance responde, e é o último que carrega o preço de agora.
 */
function series(closedAround: number, formingClose: number): RawKline[] {
  const candles: RawKline[] = [];
  for (let i = 0; i < 200; i += 1) {
    candles.push(row(Date.UTC(2026, 0, 1) + i * 3_600_000, closedAround + Math.sin(i / 3) * 2));
  }
  candles.push(row(Date.UTC(2026, 0, 1) + 200 * 3_600_000, formingClose));
  return candles;
}

const TIMEFRAMES = ['1h', '4h', '1d'] as const;

test('preço da varredura é o de agora, não o fechamento do diário', async () => {
  const fetched: string[] = [];
  const analysis = await analyzeSymbol('SPCXBUSDT', [...TIMEFRAMES], async (_symbol, interval) => {
    fetched.push(interval);
    // o diário fechou ontem em 135; o preço negociado agora é 101,5
    return interval === '1d' ? series(135, 101.5) : series(100, 101.5);
  });

  assert.ok(analysis, 'a análise precisa sair');
  assert.deepEqual(fetched, ['1h', '4h', '1d'], 'o diário é o último timeframe da volta');
  assert.equal(analysis.price, 101.5, 'preço atual vem do candle em formação');
  assert.notEqual(analysis.price, 135, 'fechamento do diário anterior não é preço atual');
});

test('sem candle em formação o preço cai no gatilho, nunca no diário', async () => {
  const analysis = await analyzeSymbol('SPCXBUSDT', [...TIMEFRAMES], async (_symbol, interval) => {
    const raw = interval === '1d' ? series(135, 135) : series(100, 100);
    // corretora devolveu o último candle sem negócio: preço zerado
    (raw[raw.length - 1] as RawKline)[4] = '0';
    return raw;
  });

  assert.ok(analysis);
  const trigger = analysis.timeframes['1h'];
  assert.ok(trigger);
  assert.equal(analysis.price, trigger.indicators.close, 'reserva é o fechamento do 1h');
  assert.ok(analysis.price < 110, `preço ${analysis.price} não pode vir do diário`);
});

test('candle em formação não entra nos indicadores', async () => {
  const analysis = await analyzeSymbol('SPCXBUSDT', ['1h'], async () => series(100, 101.5));
  assert.ok(analysis);
  const trigger = analysis.timeframes['1h'];
  assert.ok(trigger);
  assert.equal(trigger.candles.length, 200, 'só os candles fechados são analisados');
  assert.ok(trigger.candles.every((candle) => candle.closed));
});

test('um lote começa a buscar vários pares sem esperar o anterior terminar', async () => {
  let started = 0;
  let release!: () => void;
  let bothStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { bothStarted = resolve; });

  const pending = analyzeSymbols(['AAAUSDT', 'BBBUSDT'], ['1h'], async () => {
    started += 1;
    if (started === 2) bothStarted();
    await gate;
    return series(100, 101.5);
  });

  await ready;
  assert.equal(started, 2, 'o segundo par começou antes de o primeiro terminar');
  release();

  const analyses = await pending;
  assert.equal(analyses.length, 2);
  assert.ok(analyses.every(Boolean));
});
