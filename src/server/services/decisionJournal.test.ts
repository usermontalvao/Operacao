import assert from 'node:assert/strict';
import test from 'node:test';
import type { Trade, TradeSetup } from '../../core/types.ts';
import { buildDecision } from './decisionJournal.ts';

test('a autópsia usa o id do trade para aceitar reconciliação repetida', () => {
  const trade = {
    id: '11111111-1111-4111-8111-111111111111',
    status: 'CLOSED',
    closedAt: '2026-08-26T01:00:00.000Z',
    openedAt: '2026-08-26T00:00:00.000Z',
    setupId: 'setup-1',
    symbol: 'TESTUSDT',
    mode: 'LIVE',
    market: 'SPOT',
    side: 'BUY',
    setupType: 'MOMENTUM_BURST',
    timeframe: '1h',
    automatic: false,
    score: 95,
    averageFillPrice: 100,
    entryPrice: 100,
    stopLoss: 95,
    target1: 110,
    protectiveStop: null,
    outcome: 'MANUAL',
    realizedPnl: 2,
    realizedPnlPercent: 2,
    maxFavorablePercent: 4,
    maxAdversePercent: -1,
  } as Trade;
  const setup = {
    id: 'setup-1',
    setupType: 'MOMENTUM_BURST',
    timeframe: '1h',
    anchorTimeframe: '4h',
    score: 95,
    classification: 'SETUP_FORTE',
    riskReward: 2,
    scoreBreakdown: { components: [], penalties: [], total: 95 },
    reasons: [],
    evidence: null,
    btcContext: 'BTC_NEUTRAL',
    extended: false,
  } as unknown as TradeSetup;

  assert.equal(buildDecision(trade, setup).id, trade.id);
  assert.equal(buildDecision(trade, setup).id, trade.id);
});
