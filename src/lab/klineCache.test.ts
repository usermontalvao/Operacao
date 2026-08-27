import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle } from '../core/types.ts';
import { klineCacheIsFresh } from './klineCache.ts';

function candle(closeTime: number): Candle {
  return {
    openTime: closeTime - 3_599_999,
    closeTime,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    quoteVolume: 1,
    closed: true,
  };
}

test('cache só é fresco quando alcança o último candle completamente encerrado', () => {
  const now = Date.parse('2026-08-27T02:30:00.000Z');
  assert.equal(klineCacheIsFresh([candle(Date.parse('2026-08-27T01:59:59.999Z'))], '1h', now), true);
  assert.equal(klineCacheIsFresh([candle(Date.parse('2026-08-27T00:59:59.999Z'))], '1h', now), false);
  assert.equal(klineCacheIsFresh([], '1h', now), false);
});
