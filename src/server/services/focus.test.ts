import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_FOCUS_SYMBOLS, prioritizedFocus } from './focus.ts';

test('ordens e posições ficam no stream antes da watchlist cheia', () => {
  const watchlist = Array.from({ length: 40 }, (_, index) => `WATCH${index}USDT`);
  const focus = prioritizedFocus(['ARUSDT', 'MORPHOUSDT'], watchlist);

  assert.equal(focus.length, MAX_FOCUS_SYMBOLS);
  assert.deepEqual(focus.slice(0, 3), ['BTCUSDT', 'ARUSDT', 'MORPHOUSDT']);
  assert.equal(focus.includes('WATCH39USDT'), false);
});

test('o BTC conta dentro do teto e não aparece duplicado', () => {
  const focus = prioritizedFocus(['BTCUSDT'], ['ETHUSDT', 'SOLUSDT']);

  assert.deepEqual(focus, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
});
