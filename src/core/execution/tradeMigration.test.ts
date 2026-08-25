import assert from 'node:assert/strict';
import test from 'node:test';
import type { Trade } from '../types.ts';
import { migrateTrade } from './tradeMigration.ts';

/** Operação como ela foi gravada antes dos campos de taxa, topo e proteção. */
function antiga(): Trade {
  return {
    id: 'trade-antigo',
    setupId: 'setup-1',
    symbol: 'XRPUSDT',
    mode: 'PAPER',
    side: 'BUY',
    setupType: 'PULLBACK',
    timeframe: '1h',
    score: 82,
    status: 'OPEN',
    outcome: 'OPEN',
    requestedQuantity: 100,
    filledQuantity: 100,
    entryPrice: 1,
    stopLoss: 0.95,
    target1: 1.1,
    target2: null,
    target3: null,
    openedAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Trade;
}

test('campo ausente vira número, não NaN', () => {
  const trade = migrateTrade(antiga());

  assert.equal(trade.feesPaid, 0);
  assert.equal(trade.realizedPnl, 0);
  assert.equal(trade.maxFavorablePercent, 0);
  assert.equal(trade.remainingQuantity, 100, 'nada saiu ainda: a posição inteira continua na mão');
  assert.deepEqual(trade.fills, []);
  assert.deepEqual(trade.protectionListIds, []);
});

test('a aritmética da operação migrada não produz NaN', () => {
  const trade = migrateTrade(antiga());
  const soma = trade.realizedPnl + trade.feesPaid + trade.remainingQuantity * 2;
  assert.ok(Number.isFinite(soma), `conta virou ${soma}`);

  // sem migração, este é o resultado que atravessava o sistema em silêncio
  const cru = antiga();
  assert.ok(Number.isNaN((cru.realizedPnl as number) + (cru.feesPaid as number)));
});

test('posição aberta ganha topo conhecido — nunca zero, que falsearia o trailing', () => {
  const trade = migrateTrade(antiga());
  assert.equal(trade.highWaterPrice, 1, 'o topo conhecido é a própria entrada');
  assert.equal(trade.averageFillPrice, 1);
  assert.equal(trade.protectiveStop, null);
});

test('quantidade restante sai dos preenchimentos quando não foi gravada', () => {
  const base = antiga() as Trade & Record<string, unknown>;
  base.fills = [
    { kind: 'ENTRY', price: 1, quantity: 100, time: '' },
    { kind: 'TARGET1', price: 1.1, quantity: 50, time: '' },
  ];
  const trade = migrateTrade(base as Trade);
  assert.equal(trade.remainingQuantity, 50);
});

test('operação antiga é lida como saída única — era o que a conta real fazia', () => {
  assert.equal(migrateTrade(antiga()).exitPlanKind, 'SINGLE');
});
