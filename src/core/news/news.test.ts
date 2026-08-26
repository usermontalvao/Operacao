import assert from 'node:assert/strict';
import test from 'node:test';
import type { BtcContextState, SymbolFilters } from '../types.ts';
import { DEFAULT_GUARD, computeRiskSnapshot, evaluateEntryGate } from '../risk/governor.ts';
import { stateEventsFrom, transitionEventsFrom } from './exchangeState.ts';
import { MIN_ACTIONABLE_CONFIDENCE, REDUCE_FACTOR, mergeEvents, verdictFor } from './rules.ts';
import type { MarketEvent } from './types.ts';

const NOW = new Date('2026-08-25T12:00:00.000Z');

function makeEvent(overrides: Partial<MarketEvent> = {}): MarketEvent {
  return {
    id: 'evento-1',
    source: 'teste',
    kind: 'MAINTENANCE',
    symbols: ['SOLUSDT'],
    severity: 'REDUCE',
    confidence: 1,
    title: 'manutenção de rede anunciada',
    detail: '',
    observedAt: NOW.toISOString(),
    expiresAt: null,
    ...overrides,
  };
}

function makeFilters(overrides: Partial<SymbolFilters> = {}): SymbolFilters {
  return {
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    status: 'TRADING',
    tickSize: 0.01,
    stepSize: 0.001,
    minQty: 0.001,
    maxQty: 100000,
    minNotional: 5,
    applyMinToMarket: true,
    baseAssetPrecision: 8,
    quotePrecision: 8,
    isSpotTradingAllowed: true,
    ocoAllowed: true,
    market: 'SPOT',
    ...overrides,
  };
}

test('evento de bloqueio zera o tamanho; evento médio apenas encolhe', () => {
  const bloqueio = verdictFor('SOLUSDT', [makeEvent({ severity: 'BLOCK' })], NOW);
  assert.equal(bloqueio.blocked, true);
  assert.equal(bloqueio.sizeFactor, 0);

  const reducao = verdictFor('SOLUSDT', [makeEvent({ severity: 'REDUCE' })], NOW);
  assert.equal(reducao.blocked, false);
  assert.equal(reducao.sizeFactor, REDUCE_FACTOR);
});

test('dois motivos independentes para desconfiar encolhem mais que um', () => {
  const verdict = verdictFor(
    'SOLUSDT',
    [makeEvent({ id: 'a' }), makeEvent({ id: 'b', title: 'incidente na ponte' })],
    NOW,
  );
  assert.equal(verdict.sizeFactor, REDUCE_FACTOR * REDUCE_FACTOR);
  assert.equal(verdict.reasons.length, 2);
});

test('boato não mexe no tamanho: abaixo da confiança mínima o evento só informa', () => {
  const verdict = verdictFor(
    'SOLUSDT',
    [makeEvent({ confidence: MIN_ACTIONABLE_CONFIDENCE - 0.01, severity: 'BLOCK' })],
    NOW,
  );
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.sizeFactor, 1);
  assert.equal(verdict.events.length, 0, 'o evento não pode ser creditado como aplicado');
});

test('manutenção que já terminou não bloqueia mais nada', () => {
  const encerrado = makeEvent({
    severity: 'BLOCK',
    expiresAt: new Date(NOW.getTime() - 60_000).toISOString(),
  });
  assert.equal(verdictFor('SOLUSDT', [encerrado], NOW).blocked, false);
  const vigente = makeEvent({
    severity: 'BLOCK',
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  });
  assert.equal(verdictFor('SOLUSDT', [vigente], NOW).blocked, true);
});

test('o veredito é de um ativo só: evento de outro par não contamina', () => {
  const verdict = verdictFor('SOLUSDT', [makeEvent({ symbols: ['PEPEUSDT'], severity: 'BLOCK' })], NOW);
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.sizeFactor, 1);
});

test('fontes que discordam: a severidade sobe e a janela mais longa manda', () => {
  const brando = makeEvent({ id: 'mesmo', severity: 'REDUCE', confidence: 0.7, expiresAt: '2026-08-25T13:00:00.000Z' });
  const grave = makeEvent({ id: 'mesmo', severity: 'BLOCK', confidence: 0.9, expiresAt: '2026-08-25T18:00:00.000Z' });
  const merged = mergeEvents([brando], [grave]);
  assert.equal(merged.length, 1, 'a mesma notícia por duas fontes é uma só');
  assert.equal(merged[0]?.severity, 'BLOCK');
  assert.equal(merged[0]?.confidence, 0.9);
  assert.equal(merged[0]?.expiresAt, '2026-08-25T18:00:00.000Z');
});

test('par fora de TRADING vira bloqueio de estado; par normal não gera evento', () => {
  const events = stateEventsFrom(
    [makeFilters(), makeFilters({ symbol: 'XRPUSDT', status: 'BREAK' })],
    NOW,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.symbols[0], 'XRPUSDT');
  assert.equal(events[0]?.severity, 'BLOCK');
  assert.equal(verdictFor('XRPUSDT', events, NOW).blocked, true);
  assert.equal(verdictFor('SOLUSDT', events, NOW).blocked, false);
});

test('par que some da lista foi deslistado — o estado sozinho não contaria isso', () => {
  const antes = [makeFilters(), makeFilters({ symbol: 'XRPUSDT' })];
  const depois = [makeFilters()];
  const events = transitionEventsFrom(antes, depois, NOW);
  const delisting = events.find((event) => event.kind === 'DELISTING');
  assert.ok(delisting, 'o par ausente precisa virar deslistagem');
  assert.equal(delisting.symbols[0], 'XRPUSDT');
  assert.equal(verdictFor('XRPUSDT', events, NOW).blocked, true);
});

test('primeira leitura não inventa transição: sem "antes" não há notícia', () => {
  assert.deepEqual(transitionEventsFrom(null, [makeFilters()], NOW), []);
  assert.deepEqual(transitionEventsFrom([], [makeFilters()], NOW), []);
});

test('par novo e mudança de filtros informam, mas não bloqueiam nem encolhem', () => {
  const antes = [makeFilters()];
  const depois = [makeFilters({ minNotional: 10 }), makeFilters({ symbol: 'NOVOUSDT' })];
  const events = transitionEventsFrom(antes, depois, NOW);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.severity === 'INFORM'));
  assert.equal(verdictFor('NOVOUSDT', events, NOW).sizeFactor, 1);
  assert.equal(verdictFor('SOLUSDT', events, NOW).sizeFactor, 1);
});

function snapshot() {
  return computeRiskSnapshot({
    trades: [],
    mode: 'PAPER',
    capital: 1000,
    dailyLossLimitPercent: 5,
    guard: DEFAULT_GUARD,
    prices: {},
    now: NOW,
  });
}

function gateWith(
  newsVerdict: ReturnType<typeof verdictFor> | null,
  btcContext: BtcContextState = 'BTC_NEUTRAL',
) {
  return evaluateEntryGate({
    snapshot: snapshot(),
    guard: { ...DEFAULT_GUARD, lossCooldownMinutes: 0 },
    symbol: 'SOLUSDT',
    quoteAmount: 100,
    netRiskReward: 3,
    openTrades: [],
    btcContext,
    quoteVolume24h: 50_000_000,
    newsVerdict,
    now: NOW,
  });
}

test('o portão de entrada recusa a compra quando o ativo está bloqueado por evento', () => {
  const gate = gateWith(verdictFor('SOLUSDT', [makeEvent({ severity: 'BLOCK' })], NOW));
  assert.equal(gate.allowed, false);
  assert.equal(gate.sizeFactor, 0);
  assert.match(gate.blockers.join(' '), /evento de mercado/i);
});

test('evento médio não fecha o portão, encolhe a posição — e soma com a do BTC', () => {
  const so = gateWith(verdictFor('SOLUSDT', [makeEvent()], NOW));
  assert.equal(so.allowed, true);
  assert.equal(so.sizeFactor, REDUCE_FACTOR);

  const comBtc = gateWith(verdictFor('SOLUSDT', [makeEvent()], NOW), 'BTC_HIGH_VOLATILITY');
  assert.equal(
    comBtc.sizeFactor,
    DEFAULT_GUARD.highVolatilitySizeFactor * REDUCE_FACTOR,
    'as duas reduções são multiplicativas, não excludentes',
  );
});

test('não saber nada sobre o ativo nunca é motivo para bloquear', () => {
  const semMonitor = gateWith(null);
  assert.equal(semMonitor.allowed, true);
  assert.equal(semMonitor.sizeFactor, 1);
  const semEventos = gateWith(verdictFor('SOLUSDT', [], NOW));
  assert.equal(semEventos.allowed, true);
  assert.equal(semEventos.sizeFactor, 1);
});
