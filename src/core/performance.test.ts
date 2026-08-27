import assert from 'node:assert/strict';
import test from 'node:test';
import type { Trade } from './types.ts';
import { computePerformance } from './performance.ts';

function closed(id: string, pnl: number, automatic: boolean): Trade {
  return {
    id,
    setupId: `setup-${id}`,
    automatic,
    symbol: 'TESTUSDT',
    mode: 'LIVE',
    market: 'SPOT',
    side: 'BUY',
    setupType: 'MOMENTUM_BURST',
    timeframe: '1h',
    score: 95,
    status: 'CLOSED',
    outcome: pnl > 0 ? 'TARGET1' : 'STOP',
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
    realizedPnl: pnl,
    realizedPnlPercent: pnl,
    maxFavorablePercent: Math.max(pnl, 0),
    maxAdversePercent: Math.min(pnl, 0),
    remainingQuantity: 0,
    feesPaid: 0,
    highWaterPrice: null,
    protectiveStop: null,
    leverage: 1,
    initialMargin: 100,
    liquidationPrice: null,
    closeReason: null,
    fills: [],
    exchangeOrderIds: [],
    clientOrderId: `csh-${id}`,
    openedAt: '2026-08-26T00:00:00.000Z',
    closedAt: '2026-08-26T01:00:00.000Z',
    updatedAt: '2026-08-26T01:00:00.000Z',
  };
}

test('desempenho separa operações do robô das manuais', () => {
  const stats = computePerformance(
    [closed('auto', -3, true), closed('manual-1', 5, false), closed('manual-2', 2, false)],
    [],
  );

  assert.deepEqual(stats.byOrigin, [
    { key: 'Manual', trades: 2, wins: 2, winRate: 100, pnl: 7 },
    { key: 'Robô', trades: 1, wins: 0, winRate: 0, pnl: -3 },
  ]);
});
