import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle } from '../types.ts';
import { atr, bollinger, ema, macd, rsi, sma, volumeProfile } from './index.ts';

const WILDER_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
  46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35,
  44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
];

test('SMA fica nula antes do período e depois acompanha a média', () => {
  const values = [1, 2, 3, 4, 5];
  const result = sma(values, 3);
  assert.equal(result[0], null);
  assert.equal(result[1], null);
  assert.equal(result[2], 2);
  assert.equal(result[4], 4);
});

test('EMA é semeada pela SMA do primeiro bloco', () => {
  const values = Array.from({ length: 10 }, (_, i) => i + 1);
  const result = ema(values, 10);
  assert.equal(result[8], null);
  assert.equal(result[9], 5.5);
});

test('RSI reproduz o exemplo clássico de Wilder', () => {
  const result = rsi(WILDER_CLOSES, 14);
  assert.equal(result[13], null, 'não existe RSI antes de 14 variações');
  const first = result[14] as number;
  assert.ok(Math.abs(first - 70.46) < 0.2, `esperado ~70.46, veio ${first}`);
  const last = result[result.length - 1] as number;
  assert.ok(Math.abs(last - 37.77) < 0.3, `esperado ~37.77, veio ${last}`);
});

test('RSI vai a 100 em série só de altas e a 0 em série só de quedas', () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const down = Array.from({ length: 40 }, (_, i) => 100 - i);
  assert.equal(rsi(up, 14)[39], 100);
  assert.equal(rsi(down, 14)[39], 0);
});

test('MACD zera em série constante e o histograma é a diferença das linhas', () => {
  const flat = new Array(80).fill(50);
  const flatResult = macd(flat);
  const lastFlat = flatResult[79];
  assert.ok(lastFlat);
  assert.equal(Math.round(lastFlat.macd * 1e6) / 1e6, 0);

  const trending = Array.from({ length: 120 }, (_, i) => 100 + i * 0.7);
  const point = macd(trending)[119];
  assert.ok(point);
  assert.ok(point.macd > 0, 'MACD positivo em tendência de alta');
  assert.equal(Math.round((point.histogram - (point.macd - point.signal)) * 1e9) / 1e9, 0);
});

test('ATR do primeiro ponto é a média simples dos true ranges', () => {
  const candles: Candle[] = Array.from({ length: 20 }, (_, i) => candle(100 + i, 2));
  const result = atr(candles, 14);
  assert.equal(result[12], null);
  const first = result[13] as number;
  assert.ok(first > 0);
  assert.ok(Math.abs(first - 2) < 0.35, `ATR deveria ficar perto da amplitude fixa, veio ${first}`);
});

test('Bollinger colapsa em série constante', () => {
  const flat = new Array(30).fill(10);
  const point = bollinger(flat, 20, 2)[29];
  assert.ok(point);
  assert.equal(point.upper, 10);
  assert.equal(point.lower, 10);
  assert.equal(point.width, 0);
});

test('volume relativo compara com as barras anteriores', () => {
  const candles: Candle[] = Array.from({ length: 25 }, () => candle(100, 1, 1000));
  candles.push(candle(100, 1, 3000));
  const profile = volumeProfile(candles, 20);
  const relative = profile.relative[profile.relative.length - 1] as number;
  assert.ok(Math.abs(relative - 3) < 0.001, `esperado 3x, veio ${relative}`);
});

function candle(close: number, range: number, volume = 100): Candle {
  return {
    openTime: 0,
    open: close - range / 4,
    high: close + range / 2,
    low: close - range / 2,
    close,
    volume,
    quoteVolume: volume * close,
    closeTime: 0,
    closed: true,
  };
}
