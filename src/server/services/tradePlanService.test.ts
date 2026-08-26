import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SymbolFilters, Trade, TradingMode } from '../../core/types.ts';
import { EventBus } from '../events.ts';
import { JsonStore } from '../store/jsonStore.ts';
import { AuditService } from './auditService.ts';
import type { MarketDataService } from './marketDataService.ts';
import { PaperTradingEngine } from './paperTradingEngine.ts';
import { SettingsService } from './settingsService.ts';
import { TradePlanService } from './tradePlanService.ts';

const FILTERS: SymbolFilters = {
  symbol: 'XRPUSDT',
  baseAsset: 'XRP',
  quoteAsset: 'USDT',
  status: 'TRADING',
  tickSize: 0.0001,
  stepSize: 0.1,
  minQty: 0.1,
  maxQty: 1_000_000,
  minNotional: 5,
  applyMinToMarket: true,
  baseAssetPrecision: 8,
  quotePrecision: 8,
  isSpotTradingAllowed: true,
  ocoAllowed: true,
  market: 'SPOT',
};

function openTrade(mode: TradingMode): Trade {
  const now = new Date().toISOString();
  return {
    id: `trade-${mode}`,
    setupId: 'setup-1',
    symbol: 'XRPUSDT',
    mode,
    market: 'SPOT',
    side: 'BUY',
    setupType: 'PULLBACK',
    timeframe: '15m',
    score: 80,
    status: 'OPEN',
    outcome: 'OPEN',
    requestedQuantity: 100,
    filledQuantity: 100,
    remainingQuantity: 100,
    entryPrice: 1,
    averageFillPrice: 1,
    stopLoss: 0.9,
    target1: 1.2,
    target2: 1.3,
    target3: 1.4,
    notional: 100,
    riskAmount: 10,
    realizedPnl: 0,
    realizedPnlPercent: 0,
    maxFavorablePercent: 10,
    maxAdversePercent: 0,
    feesPaid: 0,
    highWaterPrice: 1.1,
    protectiveStop: null,
    leverage: 1,
    initialMargin: 100,
    liquidationPrice: null,
    closeReason: null,
    fills: [{ kind: 'ENTRY', price: 1, quantity: 100, time: now }],
    exchangeOrderIds: ['1'],
    clientOrderId: 'client-1',
    protectionListIds: ['old-list'],
    openedAt: now,
    closedAt: null,
    updatedAt: now,
  };
}

async function harness(mode: TradingMode, armed: boolean[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'trade-plan-'));
  const repository = new JsonStore(directory);
  await repository.init();
  const settings = new SettingsService(repository);
  await settings.load();
  await settings.update({ mode });
  const bus = new EventBus();
  const audit = new AuditService(repository);
  const paper = new PaperTradingEngine(repository, bus, audit, settings);
  const trade = openTrade(mode);
  await repository.saveTrade(trade);
  paper.track(trade);
  const calls: Array<{ stop: number; target: number }> = [];
  let index = 0;
  const protection = {
    rearm: async (current: Trade, _filters: SymbolFilters, stop: number) => {
      calls.push({ stop, target: current.target1 });
      const ok = armed[index++] ?? true;
      current.protectionListIds = ok ? [`list-${index}`] : [];
      return { armed: ok, kind: ok ? ('SINGLE' as const) : ('NONE' as const), listIds: current.protectionListIds, notes: [] };
    },
    panicSell: async () => true,
  };
  const market = { getPrice: () => 1.1 } as unknown as MarketDataService;
  const service = new TradePlanService(
    repository,
    paper,
    market,
    settings,
    audit,
    bus,
    protection,
    { loadFilters: async () => FILTERS },
  );
  return { directory, repository, trade, calls, service };
}

test('atualiza stop e alvos de uma posição PAPER', async (t) => {
  const context = await harness('PAPER');
  t.after(() => rm(context.directory, { recursive: true, force: true }));

  const changed = await context.service.update(context.trade.id, {
    stopLoss: 1.05,
    target1: 1.25,
    target2: 1.35,
    target3: 1.45,
  });
  assert.equal(changed.stopLoss, 1.05);
  assert.equal(changed.target1, 1.25);
  assert.equal(context.calls.length, 0, 'simulação não envia ordens à corretora');
  const saved = (await context.repository.listTrades())[0] as Trade;
  assert.equal(saved.target3, 1.45);
});

test('só confirma plano TESTNET depois de rearmar a proteção', async (t) => {
  const context = await harness('TESTNET', [true]);
  t.after(() => rm(context.directory, { recursive: true, force: true }));

  const changed = await context.service.update(context.trade.id, {
    stopLoss: 1.04,
    target1: 1.24,
  });
  assert.deepEqual(context.calls, [{ stop: 1.04, target: 1.24 }]);
  assert.equal(changed.protectiveStop, 1.04);
});

test('restaura o plano anterior quando a nova proteção é recusada', async (t) => {
  const context = await harness('TESTNET', [false, true]);
  t.after(() => rm(context.directory, { recursive: true, force: true }));

  await assert.rejects(
    context.service.update(context.trade.id, { stopLoss: 1.03, target1: 1.23 }),
    /alvos anteriores foram restaurados/i,
  );
  assert.deepEqual(context.calls, [
    { stop: 1.03, target: 1.23 },
    { stop: 0.9, target: 1.2 },
  ]);
  assert.equal(context.trade.stopLoss, 0.9);
  assert.equal(context.trade.target1, 1.2);
});

test('recusa stop já atravessado antes de tocar na proteção', async (t) => {
  const context = await harness('TESTNET');
  t.after(() => rm(context.directory, { recursive: true, force: true }));

  await assert.rejects(
    context.service.update(context.trade.id, { stopLoss: 1.11 }),
    /abaixo do preço atual/i,
  );
  assert.equal(context.calls.length, 0);
});
