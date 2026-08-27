import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeLiveEquity } from './equity.ts';
import type { AccountBalanceResponse } from './api.ts';
import type { Trade } from './types.ts';

const balance = (patch: Partial<AccountBalanceResponse> = {}): AccountBalanceResponse => ({
  capital: 24.76,
  available: 24.76,
  holdingsValue: 0.2265,
  source: 'BINANCE',
  currency: 'USDT',
  brlRate: 5.16,
  mode: 'LIVE',
  ...patch,
});

const nvdab = (patch: Partial<Trade> = {}): Trade => ({
  id: 'nvdab',
  symbol: 'NVDABUSDT',
  market: 'SPOT',
  mode: 'LIVE',
  status: 'OPEN',
  entryPrice: 218.19,
  averageFillPrice: 218.19,
  remainingQuantity: 0.109,
  notional: 23.78,
  ...patch,
} as Trade);

test('patrimônio real inclui caixa e moedas mesmo sem posição aberta', () => {
  const result = computeLiveEquity({
    balance: balance(),
    trades: [],
    prices: {},
    mode: 'LIVE',
    market: 'SPOT',
  });
  assert.equal(result.equity, 24.99);
});

test('evento de saldo após venda não duplica uma posição ainda velha na tela', () => {
  const result = computeLiveEquity({
    balance: balance(),
    trades: [nvdab()],
    prices: { NVDABUSDT: 219.58 },
    mode: 'LIVE',
    market: 'SPOT',
    serverPositions: [{ symbol: 'NVDABUSDT', currentPrice: 219.58 }],
  });
  assert.equal(result.equity, 24.99, 'não pode somar os 23,93 USDT da posição duas vezes');
});

test('patrimônio spot anda somente pela variação desde o retrato do servidor', () => {
  const result = computeLiveEquity({
    balance: balance({ capital: 1.07, available: 1.07, holdingsValue: 23.87 }),
    trades: [nvdab()],
    prices: { NVDABUSDT: 220.58 },
    mode: 'LIVE',
    market: 'SPOT',
    serverPositions: [{ symbol: 'NVDABUSDT', currentPrice: 219.58 }],
  });
  assert.equal(result.equity, 25.05);
});
