import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { getKlines } from './rest.ts';

const originalFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = originalFetch;
});

test('chamadas concorrentes à Binance saem uma por vez, sem formar rajada', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return new Response('[]', { status: 200 });
  };

  await Promise.all([
    getKlines('BTCUSDT', '15m', 10),
    getKlines('ETHUSDT', '15m', 10),
    getKlines('SOLUSDT', '15m', 10),
    getKlines('XRPUSDT', '15m', 10),
  ]);

  assert.equal(calls, 4);
  assert.equal(maxActive, 1);
});
