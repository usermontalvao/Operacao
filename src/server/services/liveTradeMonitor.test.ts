import assert from 'node:assert/strict';
import test from 'node:test';
import type { Trade } from '../../core/types.ts';
import { exitKindForOrder, updateTradeExcursions } from './liveTradeMonitor.ts';

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'trade-1',
    setupId: 'setup-1',
    symbol: 'TESTUSDT',
    mode: 'LIVE',
    market: 'SPOT',
    side: 'BUY',
    setupType: 'MOMENTUM_BURST',
    timeframe: '1h',
    score: 95,
    status: 'OPEN',
    outcome: 'OPEN',
    requestedQuantity: 1,
    filledQuantity: 1,
    entryPrice: 100,
    averageFillPrice: 100,
    stopLoss: 95,
    target1: 110,
    target2: null,
    target3: null,
    notional: 100,
    riskAmount: 5,
    realizedPnl: 0,
    realizedPnlPercent: 0,
    maxFavorablePercent: 0,
    maxAdversePercent: 0,
    remainingQuantity: 1,
    feesPaid: 0,
    highWaterPrice: 100,
    protectiveStop: null,
    leverage: 1,
    initialMargin: 100,
    liquidationPrice: null,
    closeReason: null,
    fills: [],
    exchangeOrderIds: [],
    clientOrderId: 'cshmanualrace',
    openedAt: '2026-08-26T00:00:00.000Z',
    closedAt: null,
    updatedAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

test('mede MFE e MAE da posição real sem apagar os extremos anteriores', () => {
  const current = trade();
  assert.equal(updateTradeExcursions(current, 104), true);
  assert.equal(updateTradeExcursions(current, 97), true);
  assert.equal(updateTradeExcursions(current, 102), false);
  assert.equal(current.maxFavorablePercent, 4);
  assert.equal(current.maxAdversePercent, -3);
});

test('mede excursões no sentido correto para posição vendida', () => {
  const current = trade({ side: 'SELL' });
  updateTradeExcursions(current, 94);
  updateTradeExcursions(current, 102);
  assert.equal(current.maxFavorablePercent, 6);
  assert.equal(current.maxAdversePercent, -2);
});

test('a ordem MARKET do botão de encerrar é manual, não TARGET1', () => {
  assert.equal(exitKindForOrder('MARKET', 'cshmanualracex', 'cshmanualrace'), 'MANUAL');
  assert.equal(exitKindForOrder('LIMIT_MAKER', 'alvo-1', 'cshmanualrace'), undefined);
  assert.equal(exitKindForOrder('STOP_LOSS_LIMIT', 'stop-1', 'cshmanualrace'), 'STOP');
});
