import assert from 'node:assert/strict';
import test from 'node:test';
import { selectUniverseSymbols } from './universeService.ts';

test('universo inclui todo par negociável, mesmo sem volume recente', () => {
  const selected = selectUniverseSymbols(
    ['BTCUSDT', 'NEWUSDT', 'MIDUSDT', 'NEWUSDT'],
    new Set(['BTCUSDT']),
    new Map([
      ['BTCUSDT', 1_000_000_000],
      ['MIDUSDT', 2_000_000],
      ['NEWUSDT', 0],
    ]),
  );

  assert.deepEqual(selected, ['MIDUSDT', 'NEWUSDT']);
});
