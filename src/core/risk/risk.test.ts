import assert from 'node:assert/strict';
import test from 'node:test';
import type { SymbolFilters, TradeSetup } from '../types.ts';
import { computeRiskReward, passesRiskReward, riskPercent } from './riskReward.ts';
import { decimalsFromStep, roundDownToStep, roundToTick, validateOrder } from './filters.ts';
import { computeSizing, suggestedQuoteAmount } from './position.ts';

const FILTERS: SymbolFilters = {
  symbol: 'XRPUSDT',
  baseAsset: 'XRP',
  quoteAsset: 'USDT',
  status: 'TRADING',
  tickSize: 0.0001,
  stepSize: 0.1,
  minQty: 0.1,
  maxQty: 9222449,
  minNotional: 5,
  applyMinToMarket: true,
  baseAssetPrecision: 8,
  quotePrecision: 8,
  isSpotTradingAllowed: true,
  ocoAllowed: true,
  market: 'SPOT',
};

const SETUP: TradeSetup = {
  id: 'setup-1',
  symbol: 'XRPUSDT',
  side: 'BUY',
  market: 'SPOT',
  timeframe: '4h',
  anchorTimeframe: '1d',
  setupType: 'PULLBACK',
  currentPrice: 1.43,
  entryLow: 1.41,
  entryHigh: 1.44,
  stopLoss: 1.37,
  target1: 1.52,
  target2: 1.61,
  target3: 1.7,
  riskReward: 2.5,
  score: 84,
  classification: 'SETUP_FORTE',
  scoreBreakdown: { total: 84, classification: 'SETUP_FORTE', components: [], penalties: [] },
  reasons: [],
  btcContext: 'BTC_NEUTRAL',
  status: 'ACTIVE',
  visualState: 'COMPRAVEL',
  extended: false,
  extensionReasons: [],
  evidence: {
    rsi14: 45,
    atrPercent: 1.8,
    relativeVolume: 1.3,
    macdHistogram: 0.002,
    distanceToEma20InAtr: -0.4,
    triggerTrend: 'UP',
    anchorTrend: 'UP',
    anchorStructure: 'HH_HL',
    levelQuality: 0.8,
    volumeConfirmation: true,
    momentumTurning: true,
    btcScoreModifier: 5,
  },
  fingerprint: 'XRPUSDT:PULLBACK:4h:1.41',
  invalidationNote: null,
  createdAt: '2026-08-25T12:00:00.000Z',
  updatedAt: '2026-08-25T12:00:00.000Z',
  expiresAt: '2026-08-25T16:00:00.000Z',
  ignoredAt: null,
};

test('R/R usa a distância até o stop como unidade de risco', () => {
  assert.equal(computeRiskReward(1.42, 1.37, 1.52), 2);
  assert.equal(computeRiskReward(1.42, 1.42, 1.52), 0, 'risco zero é R/R inválido');
  assert.equal(computeRiskReward(1.42, 1.37, 1.4), 0, 'alvo abaixo da entrada é inválido');
  assert.equal(riskPercent(1.42, 1.37), 3.52);
  assert.equal(passesRiskReward(2, 2), true);
  assert.equal(passesRiskReward(1.9, 2), false);
});

test('casas decimais saem do passo informado pela Binance', () => {
  assert.equal(decimalsFromStep(0.001), 3);
  assert.equal(decimalsFromStep(1), 0);
  assert.equal(decimalsFromStep(0.00000100), 6);
});

test('quantidade sempre arredonda para baixo e o preço para o tick', () => {
  assert.equal(roundDownToStep(12.37, 0.1), 12.3);
  assert.equal(roundDownToStep(0.05, 0.1), 0);
  assert.equal(roundToTick(1.42357, 0.0001), 1.4236);
});

test('validação bloqueia ordem abaixo do mínimo nocional', () => {
  const small = validateOrder(FILTERS, 1, 1.42);
  assert.equal(small.valid, false);
  assert.ok(small.errors.some((error) => error.includes('abaixo do mínimo da Binance')));

  const good = validateOrder(FILTERS, 100, 1.42357);
  assert.equal(good.valid, true);
  assert.equal(good.price, 1.4236);
  assert.equal(good.quantity, 100);
});

test('validação recusa par fora de negociação', () => {
  const halted = validateOrder({ ...FILTERS, status: 'BREAK' }, 100, 1.42);
  assert.equal(halted.valid, false);
});

test('dimensionamento converte valor em quantidade, risco e lucro potencial', () => {
  const result = computeSizing(
    { setup: SETUP, quoteAmount: 213, entryPrice: 1.42, capital: 1000 },
    {
      paperCapital: 1000,
      paperCapitalCurrency: 'USDT',
      maxPositionPercent: 25,
      riskPerTradePercent: 1,
      maxOpenTrades: 3,
      dailyLossLimitPercent: 5,
      minimumRiskReward: 1.8,
      minimumScoreToAlert: 75,
      minimumScoreToShow: 60,
    },
  );
  assert.equal(result.quantity, 150);
  assert.equal(result.notional, 213);
  assert.equal(result.riskAmount, 7.5);
  assert.equal(result.potentialProfitTarget1, 15);
  assert.equal(result.riskReward, 2);
  assert.equal(result.blocked, false);
  assert.equal(result.warnings.length, 0, 'risco de 7,50 está dentro do teto de 1% do capital');
});

test('dimensionamento avisa quando o risco passa do teto por trade', () => {
  const result = computeSizing(
    { setup: SETUP, quoteAmount: 249, entryPrice: 1.42, capital: 1000 },
    {
      paperCapital: 1000,
      paperCapitalCurrency: 'USDT',
      maxPositionPercent: 25,
      riskPerTradePercent: 0.5,
      maxOpenTrades: 3,
      dailyLossLimitPercent: 5,
      minimumRiskReward: 1.8,
      minimumScoreToAlert: 75,
      minimumScoreToShow: 60,
    },
  );
  assert.equal(result.blocked, false);
  assert.ok(result.warnings.some((warning) => warning.includes('acima do teto')));
});

test('dimensionamento bloqueia posição acima do teto por operação', () => {
  const result = computeSizing(
    { setup: SETUP, quoteAmount: 900, entryPrice: 1.42, capital: 1000 },
    {
      paperCapital: 1000,
      paperCapitalCurrency: 'USDT',
      maxPositionPercent: 25,
      riskPerTradePercent: 1,
      maxOpenTrades: 3,
      dailyLossLimitPercent: 5,
      minimumRiskReward: 1.8,
      minimumScoreToAlert: 75,
      minimumScoreToShow: 60,
    },
  );
  assert.equal(result.blocked, true);
  assert.ok(result.blockReasons[0]?.includes('limite'));
});

test('valor sugerido respeita o risco por trade', () => {
  const amount = suggestedQuoteAmount(1000, 1.42, 1.37, {
    paperCapital: 1000,
    paperCapitalCurrency: 'USDT',
    maxPositionPercent: 25,
    riskPerTradePercent: 1,
    maxOpenTrades: 3,
    dailyLossLimitPercent: 5,
    minimumRiskReward: 1.8,
    minimumScoreToAlert: 75,
    minimumScoreToShow: 60,
  });
  // arriscar 10 USDT com stop a 0,05 de distância daria ~284 USDT de posição,
  // mas o teto de 25% do capital corta em 250
  assert.equal(amount, 250);
});
