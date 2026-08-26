import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSpotHoldings } from './spotHoldings.ts';

test('a carteira não esconde moeda comprada nem saldo bloqueado', () => {
  const holdings = buildSpotHoldings(
    [
      { asset: 'JASMY', free: 0.0419 },
      { asset: 'SOL', free: 1, locked: 0.5 },
    ],
    new Map([
      ['JASMY', 'JASMYUSDT'],
      ['SOL', 'SOLUSDT'],
    ]),
    new Map([
      ['JASMYUSDT', 0.005],
      ['SOLUSDT', 100],
    ]),
  );

  assert.equal(holdings[0]?.asset, 'SOL');
  assert.equal(holdings[0]?.quantity, 1.5);
  assert.equal(holdings[0]?.value, 150);
  assert.equal(holdings[1]?.asset, 'JASMY');
  assert.equal(holdings[1]?.value, 0.0002095);
});

test('ativo sem par direto continua visível, sem inventar valor', () => {
  const holdings = buildSpotHoldings(
    [{ asset: 'BRL', free: 100 }],
    new Map(),
    new Map(),
  );

  assert.equal(holdings[0]?.quantity, 100);
  assert.equal(holdings[0]?.symbol, null);
  assert.equal(holdings[0]?.value, null);
});
