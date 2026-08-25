import assert from 'node:assert/strict';
import test from 'node:test';
import type { Trade } from '../types.ts';
import { activeCooldowns, symbolCooldownUntil } from './cooldown.ts';

const AGORA = Date.parse('2026-08-25T12:00:00.000Z');

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 't1',
    setupId: 's1',
    automatic: true,
    symbol: 'BMTUSDT',
    mode: 'PAPER',
    side: 'BUY',
    setupType: 'MOMENTUM_BURST',
    timeframe: '1h',
    score: 95,
    status: 'CLOSED',
    outcome: 'STOP',
    requestedQuantity: 10,
    filledQuantity: 10,
    remainingQuantity: 0,
    entryPrice: 1,
    averageFillPrice: 1,
    stopLoss: 0.9,
    target1: 1.3,
    target2: null,
    target3: null,
    notional: 10,
    realizedPnl: -1,
    feesPaid: 0.02,
    openedAt: '2026-08-25T11:30:00.000Z',
    closedAt: '2026-08-25T11:45:00.000Z',
    ...overrides,
  } as Trade;
}

test('o descanso vem da operação gravada, então sobrevive ao reinício', () => {
  // este é o teste do reinício: nada aqui depende de estado em memória. O
  // "servidor novo" recebe as mesmas operações do disco e chega ao mesmo
  // descanso que o servidor antigo tinha.
  const trades = [trade()];
  const until = symbolCooldownUntil({
    trades,
    symbol: 'BMTUSDT',
    mode: 'PAPER',
    cooldownMinutes: 180,
  });
  assert.ok(until !== null);
  assert.equal(until, Date.parse('2026-08-25T14:30:00.000Z'));
  assert.ok(until > AGORA, 'ainda em descanso 30 min depois da abertura');
});

test('sem operação anterior não há descanso', () => {
  assert.equal(
    symbolCooldownUntil({ trades: [], symbol: 'BMTUSDT', mode: 'PAPER', cooldownMinutes: 180 }),
    null,
  );
});

test('o descanso é por sessão: o demo não prende a conta real', () => {
  const trades = [trade({ mode: 'PAPER' })];
  assert.ok(
    symbolCooldownUntil({ trades, symbol: 'BMTUSDT', mode: 'PAPER', cooldownMinutes: 180 }) !== null,
  );
  assert.equal(
    symbolCooldownUntil({ trades, symbol: 'BMTUSDT', mode: 'LIVE', cooldownMinutes: 180 }),
    null,
  );
});

test('compra manual não prende o robô', () => {
  const trades = [trade({ automatic: false })];
  assert.equal(
    symbolCooldownUntil({ trades, symbol: 'BMTUSDT', mode: 'PAPER', cooldownMinutes: 180 }),
    null,
  );
});

test('vale a operação MAIS RECENTE do ativo', () => {
  const trades = [
    trade({ id: 'antiga', openedAt: '2026-08-25T08:00:00.000Z' }),
    trade({ id: 'recente', openedAt: '2026-08-25T11:30:00.000Z' }),
  ];
  const until = symbolCooldownUntil({
    trades,
    symbol: 'BMTUSDT',
    mode: 'PAPER',
    cooldownMinutes: 60,
  });
  assert.equal(until, Date.parse('2026-08-25T12:30:00.000Z'));
});

test('cooldown zerado desliga a regra', () => {
  assert.equal(
    symbolCooldownUntil({ trades: [trade()], symbol: 'BMTUSDT', mode: 'PAPER', cooldownMinutes: 0 }),
    null,
  );
});

test('o painel consegue listar os descansos ativos com a hora da liberação', () => {
  const trades = [
    trade({ symbol: 'BMTUSDT', openedAt: '2026-08-25T11:30:00.000Z' }),
    trade({ id: 't2', symbol: 'ARBUSDT', openedAt: '2026-08-25T11:50:00.000Z' }),
    trade({ id: 't3', symbol: 'VELHOUSDT', openedAt: '2026-08-25T05:00:00.000Z' }),
  ];
  const ativos = activeCooldowns({ trades, mode: 'PAPER', cooldownMinutes: 60, now: AGORA });

  const simbolos = ativos.map((item) => item.symbol);
  assert.deepEqual(simbolos, ['BMTUSDT', 'ARBUSDT']);
  assert.ok(!simbolos.includes('VELHOUSDT'), 'descanso vencido não aparece');
  assert.equal(ativos[0]?.remainingMinutes, 30);
});
