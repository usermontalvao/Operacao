import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analysisFrom,
  breakoutWithRetest,
  breakoutWithWeakRetest,
  candlesFromPath,
  defaultTestSettings,
  downtrendWithRally,
  uptrendWithPullback,
} from '../testing/fixtures.ts';
import { evaluateMarketContext } from './marketContextEngine.ts';
import { applyPriceUpdate, generateSetups, resolveVisualState } from './setupEngine.ts';
import type { TradeSetup } from '../types.ts';

const NOW = new Date('2026-08-25T12:00:00.000Z');
let counter = 0;
const makeId = () => `setup-${(counter += 1)}`;

function pullbackAnalysis() {
  const candles = candlesFromPath(uptrendWithPullback());
  return analysisFrom('XRPUSDT', candles, ['15m', '1h', '4h', '1d']);
}

function breakoutAnalysis() {
  const candles = candlesFromPath(breakoutWithRetest());
  return analysisFrom('OPUSDT', candles, ['15m', '1h', '4h', '1d']);
}

test('detecta pullback em tendência com R/R e motivos explicados', () => {
  const setups = generateSetups({
    analysis: pullbackAnalysis(),
    context: null,
    settings: defaultTestSettings(),
    now: NOW,
    makeId,
  });
  const pullback = setups.find((s) => s.setupType === 'PULLBACK');
  assert.ok(pullback, 'esperava um setup de pullback');
  assert.ok(pullback.riskReward >= 1.8, `R/R deveria passar do mínimo, veio ${pullback.riskReward}`);
  assert.ok(pullback.stopLoss < pullback.entryLow, 'stop precisa ficar abaixo da entrada');
  assert.ok(pullback.target1 > pullback.entryHigh, 'alvo 1 precisa ficar acima da entrada');
  assert.ok(pullback.reasons.length >= 3, 'todo setup precisa explicar por que existe');
  assert.equal(pullback.side, 'BUY');
});

test('detecta breakout com reteste e não compra o rompimento puro', () => {
  const setups = generateSetups({
    analysis: breakoutAnalysis(),
    context: null,
    settings: defaultTestSettings(),
    now: NOW,
    makeId,
  });
  const breakout = setups.find((s) => s.setupType === 'BREAKOUT_RETEST');
  assert.ok(breakout, 'esperava um setup de breakout + reteste');
  assert.ok(
    breakout.reasons.some((reason) => reason.toLowerCase().includes('reteste')),
    'o reteste precisa aparecer entre os motivos',
  );
  assert.ok(breakout.stopLoss < breakout.entryLow);
});

test('score soma exatamente os componentes menos as penalidades', () => {
  const setups = generateSetups({
    analysis: pullbackAnalysis(),
    context: null,
    settings: defaultTestSettings(),
    now: NOW,
    makeId,
  });
  const setup = setups[0] as TradeSetup;
  const sum =
    setup.scoreBreakdown.components.reduce((acc, item) => acc + item.points, 0) +
    setup.scoreBreakdown.penalties.reduce((acc, item) => acc + item.points, 0);
  assert.equal(setup.score, Math.max(0, Math.min(100, Math.round(sum))));
  assert.ok(setup.scoreBreakdown.components.length >= 6, 'score precisa ser detalhado');
  assert.ok(setup.score >= 60 && setup.score <= 100);
});

test('R/R mínimo alto derruba os setups', () => {
  const settings = defaultTestSettings();
  settings.risk.minimumRiskReward = 99;
  const setups = generateSetups({
    analysis: pullbackAnalysis(),
    context: null,
    settings,
    now: NOW,
    makeId,
  });
  assert.equal(setups.length, 0);
});

test('contexto do BTC muda o score da altcoin', () => {
  const analysis = pullbackAnalysis();
  const settings = defaultTestSettings();
  const neutral = generateSetups({ analysis, context: null, settings, now: NOW, makeId })[0];
  const bearish = generateSetups({
    analysis,
    context: {
      state: 'BTC_BEARISH',
      scoreModifier: -20,
      reasons: ['BTC rompeu suporte'],
      btcPrice: 60000,
      btcChangePercent24h: -7,
      btcTrend4h: 'DOWN',
      btcTrend1d: 'DOWN',
      highVolatility: true,
    btcAboveDailyMean: false,
      updatedAt: NOW.toISOString(),
    },
    settings,
    now: NOW,
    makeId,
  })[0];
  assert.ok(neutral && bearish);
  assert.ok(bearish.score < neutral.score, 'BTC em queda tem de derrubar o score');
});

test('BTC sem dados devolve contexto neutro em vez de inventar', () => {
  const context = evaluateMarketContext(null, NOW.toISOString());
  assert.equal(context.state, 'BTC_NEUTRAL');
  assert.equal(context.scoreModifier, 0);
  assert.equal(context.btcPrice, null);
});

test('setup é invalidado quando o preço perde o stop antes da entrada', () => {
  const setup = generateSetups({
    analysis: pullbackAnalysis(),
    context: null,
    settings: defaultTestSettings(),
    now: NOW,
    makeId,
  })[0] as TradeSetup;

  const invalidated = applyPriceUpdate(setup, setup.stopLoss - 0.01, NOW);
  assert.equal(invalidated.status, 'INVALIDATED');
  assert.equal(invalidated.visualState, 'INVALIDADO');
  assert.ok(invalidated.invalidationNote);

  const triggered = applyPriceUpdate(setup, (setup.entryLow + setup.entryHigh) / 2, NOW);
  assert.equal(triggered.status, 'TRIGGERED');
  assert.equal(triggered.visualState, 'COMPRAVEL');

  const missed = applyPriceUpdate(setup, setup.target1 + 0.01, NOW);
  assert.equal(missed.status, 'EXPIRED');

  const later = new Date(new Date(setup.expiresAt).getTime() + 60_000);
  const expired = applyPriceUpdate(setup, setup.entryLow * 0.999, later);
  assert.equal(expired.status, 'EXPIRED');
});

test('moeda esticada é marcada e não é oferecida como compra', () => {
  const setup = generateSetups({
    analysis: pullbackAnalysis(),
    context: null,
    settings: defaultTestSettings(),
    now: NOW,
    makeId,
  })[0] as TradeSetup;
  const extended: TradeSetup = { ...setup, extended: true };
  assert.equal(resolveVisualState(extended, (setup.entryLow + setup.entryHigh) / 2), 'ESTICADO');
});

test('encostar no nível não é reteste: sem defesa depois do toque, não há setup', () => {
  const analysis = analysisFrom(
    'OPUSDT',
    candlesFromPath(breakoutWithWeakRetest()),
    ['15m', '1h', '4h', '1d'],
  );
  const breakout = analysis.timeframes['1h']?.structure.breakout;

  assert.ok(breakout, 'o rompimento continua sendo reconhecido');
  assert.equal(breakout.retested, true, 'o preço encostou no nível — era só isto que se exigia antes');
  assert.equal(breakout.confirmed, false, 'mas ninguém defendeu o nível depois do toque');

  const setups = generateSetups({
    analysis,
    context: null,
    settings: defaultTestSettings(),
    now: NOW,
    makeId,
  });
  assert.equal(
    setups.filter((setup) => setup.setupType === 'BREAKOUT_RETEST').length,
    0,
    'toque sem confirmação não pode virar oferta de compra',
  );
});

test('a confirmação do reteste é declarada nos motivos do setup', () => {
  const setups = generateSetups({
    analysis: breakoutAnalysis(),
    context: null,
    settings: defaultTestSettings(),
    now: NOW,
    makeId,
  });
  const setup = setups.find((item) => item.setupType === 'BREAKOUT_RETEST');
  assert.ok(setup);
  assert.ok(
    setup.reasons.some((reason) => reason.includes('Fechamento de volta acima')),
    `os motivos precisam dizer o que confirmou: ${setup.reasons.join(' | ')}`,
  );
});

test('em futuros com venda liberada, a mesma figura invertida vira um setup VENDIDO', () => {
  const candles = candlesFromPath(downtrendWithRally());
  const analysis = analysisFrom('XRPUSDT', candles, ['15m', '1h', '4h', '1d']);
  const futuros = defaultTestSettings({
    market: 'FUTURES',
    futures: {
      leverage: 3,
      maxLeverage: 10,
      marginMode: 'ISOLATED',
      allowShort: true,
      minLiquidationBufferPercent: 1.5,
    },
  });

  const setups = generateSetups({ analysis, context: null, settings: futuros, now: NOW, makeId });
  const vendido = setups.find((item) => item.side === 'SELL');

  assert.ok(vendido, 'esperava pelo menos uma tese vendida na tendência de baixa');
  assert.equal(vendido.market, 'FUTURES');
  assert.ok(vendido.stopLoss > vendido.entryHigh, 'vendido: o stop fica ACIMA da entrada');
  assert.ok(vendido.target1 < vendido.entryLow, 'vendido: o alvo fica ABAIXO da entrada');
  assert.ok(vendido.riskReward >= 1.8, `R/R veio ${vendido.riskReward}`);
  assert.ok(vendido.reasons.length >= 3, 'todo setup precisa explicar por que existe');
});

test('a mesma tendência de baixa NÃO gera tese vendida em spot', () => {
  const candles = candlesFromPath(downtrendWithRally());
  const analysis = analysisFrom('XRPUSDT', candles, ['15m', '1h', '4h', '1d']);

  // spot: não existe posição vendida, e mostrar no radar o que não dá para
  // executar dali é convite a tentar executar por fora
  const setups = generateSetups({
    analysis,
    context: null,
    settings: defaultTestSettings(),
    now: NOW,
    makeId,
  });
  assert.equal(setups.filter((item) => item.side === 'SELL').length, 0);
});

test('o radar de futuros com venda desligada volta a ser só de compra', () => {
  const candles = candlesFromPath(downtrendWithRally());
  const analysis = analysisFrom('XRPUSDT', candles, ['15m', '1h', '4h', '1d']);
  const setups = generateSetups({
    analysis,
    context: null,
    settings: defaultTestSettings({
      market: 'FUTURES',
      futures: {
        leverage: 3,
        maxLeverage: 10,
        marginMode: 'ISOLATED',
        allowShort: false,
        minLiquidationBufferPercent: 1.5,
      },
    }),
    now: NOW,
    makeId,
  });
  assert.equal(setups.filter((item) => item.side === 'SELL').length, 0);
});
