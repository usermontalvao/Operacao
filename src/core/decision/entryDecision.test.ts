import assert from 'node:assert/strict';
import test from 'node:test';
import type { AutoTradeSettings, TradeSetup } from '../types.ts';
import { evaluateFreshness, TICK_THRESHOLDS } from '../health/freshness.ts';
import { evaluateEntryDecision, type EntryDecisionInput } from './entryDecision.ts';
import { distanceToEntryPercent } from './types.ts';

const AGORA = new Date('2026-08-25T12:00:00.000Z');

const AUTO: AutoTradeSettings = {
  enabled: true,
  minimumScore: 90,
  minimumRiskReward: 2.5,
  percentOfCapital: 10,
  maxConcurrentTrades: 1,
  cooldownMinutes: 180,
  requireInsideEntryZone: true,
  allowLive: false,
  liveArmedUntil: null,
  liveArmedIndefinitely: false,
  maxNotionalPerTrade: 50,
  strategies: {
    PULLBACK: { enabled: false, minimumScore: 75, minimumRiskReward: 2 },
    BREAKOUT_RETEST: { enabled: false, minimumScore: 78, minimumRiskReward: 2 },
    SUPPORT_REVERSAL: { enabled: false, minimumScore: 80, minimumRiskReward: 2.2 },
    MOMENTUM_BURST: { enabled: true, minimumScore: 90, minimumRiskReward: 2.5 },
    RANGE_FADE: { enabled: false, minimumScore: 75, minimumRiskReward: 1.8 },
  },
};

function setup(overrides: Partial<TradeSetup> = {}): TradeSetup {
  return {
    id: 'setup-1',
    symbol: 'BMTUSDT',
    side: 'BUY',
    market: 'SPOT',
    timeframe: '1h',
    anchorTimeframe: '1d',
    setupType: 'MOMENTUM_BURST',
    currentPrice: 1.0,
    entryLow: 0.98,
    entryHigh: 1.02,
    stopLoss: 0.9,
    target1: 1.3,
    target2: null,
    target3: null,
    riskReward: 3,
    score: 95,
    classification: 'SETUP_FORTE',
    scoreBreakdown: { total: 95, classification: 'SETUP_FORTE', components: [], penalties: [] },
    reasons: [],
    btcContext: 'BTC_NEUTRAL',
    status: 'ACTIVE',
    visualState: 'COMPRAVEL',
    extended: false,
    extensionReasons: [],
    evidence: {} as TradeSetup['evidence'],
    fingerprint: 'fp',
    invalidationNote: null,
    createdAt: '2026-08-25T11:30:00.000Z',
    updatedAt: '2026-08-25T11:59:00.000Z',
    expiresAt: '2026-08-25T20:00:00.000Z',
    ignoredAt: null,
    ...overrides,
  };
}

function input(overrides: Partial<EntryDecisionInput> = {}): EntryDecisionInput {
  return {
    setup: setup(),
    now: AGORA,
    currentPrice: 1.0,
    priceFreshness: evaluateFreshness(AGORA.getTime() - 1_000, TICK_THRESHOLDS, AGORA.getTime()),
    robotEnabled: true,
    liveDenial: null,
    persistenceAvailable: true,
    timeframeEnabled: true,
    autoTrade: AUTO,
    openAutomatic: [],
    symbolCooldownUntil: null,
    ...overrides,
  };
}

/** Códigos dos bloqueios, para asserção legível. */
function codigos(decision: ReturnType<typeof evaluateEntryDecision>): string[] {
  return decision.blockers.map((b) => b.code);
}

test('o caminho feliz: MOMENTUM_BURST score 95 dentro da zona é autorizado', () => {
  const decision = evaluateEntryDecision(input());
  assert.equal(decision.allowed, true, codigos(decision).join(', '));
  assert.equal(decision.code, 'ALLOWED');
  assert.equal(decision.distanceToEntryPercent, 0);
});

test('robô desligado produz decisão gravável, não um silêncio', () => {
  const decision = evaluateEntryDecision(input({ robotEnabled: false }));
  assert.equal(decision.allowed, false);
  assert.ok(codigos(decision).includes('ROBOT_DISABLED'));
  // o essencial: existe uma decisão com motivo, e não um `return null`
  assert.ok(decision.blockers[0]?.message.length ?? 0 > 0);
});

test('timeframe desligado não pode gerar entrada automática', () => {
  const decision = evaluateEntryDecision(input({ timeframeEnabled: false }));

  assert.equal(decision.allowed, false);
  assert.ok(codigos(decision).includes('TIMEFRAME_DISABLED'));
  assert.match(
    decision.blockers.find((item) => item.code === 'TIMEFRAME_DISABLED')?.message ?? '',
    /gatilho de 1h está desligado/,
  );
});

test('estratégia desligada na conta é bloqueada mesmo com score alto', () => {
  const decision = evaluateEntryDecision(input({ setup: setup({ setupType: 'PULLBACK', score: 99 }) }));
  assert.ok(codigos(decision).includes('STRATEGY_DISABLED'));
});

test('MOMENTUM_BURST com score 89 é recusado pelo piso validado', () => {
  const decision = evaluateEntryDecision(input({ setup: setup({ score: 89 }) }));
  assert.equal(decision.allowed, false);
  assert.ok(codigos(decision).includes('SCORE_BELOW_VALIDATED_FLOOR'));
});

test('MOMENTUM_BURST com score 90 passa no piso', () => {
  const decision = evaluateEntryDecision(input({ setup: setup({ score: 90 }) }));
  assert.equal(decision.allowed, true, codigos(decision).join(', '));
});

test('o caso BMTUSDT: preço acima da zona diz o quanto e por quê', () => {
  // o caso real que motivou tudo isto: score 95, R/R 3, e nenhuma explicação
  const decision = evaluateEntryDecision(
    input({ currentPrice: 1.052, setup: setup({ currentPrice: 1.052 }) }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'PRICE_OUTSIDE_ENTRY_ZONE');

  const bloqueio = decision.blockers.find((b) => b.code === 'PRICE_OUTSIDE_ENTRY_ZONE');
  assert.ok(bloqueio);
  assert.match(bloqueio.message, /acima da zona/i);
  assert.match(bloqueio.message, /perseguir o movimento/i);
  assert.equal(bloqueio.data?.lado, 'ACIMA');
  assert.ok(decision.distanceToEntryPercent > 3 && decision.distanceToEntryPercent < 3.2);
});

test('preço abaixo da zona é outro estado, não o mesmo bloqueio', () => {
  const decision = evaluateEntryDecision(input({ currentPrice: 0.95 }));
  const bloqueio = decision.blockers.find((b) => b.code === 'PRICE_OUTSIDE_ENTRY_ZONE');
  assert.equal(bloqueio?.data?.lado, 'ABAIXO');
  assert.ok(decision.distanceToEntryPercent < 0, 'abaixo da zona tem distância negativa');
  assert.match(bloqueio?.message ?? '', /ainda não acionou/i);
});

test('dentro da zona a distância é exatamente zero', () => {
  assert.equal(distanceToEntryPercent(1.0, 0.98, 1.02), 0);
  assert.equal(distanceToEntryPercent(0.98, 0.98, 1.02), 0);
  assert.equal(distanceToEntryPercent(1.02, 0.98, 1.02), 0);
});

test('setup expirado é bloqueado pela validade, não pelo status', () => {
  const decision = evaluateEntryDecision(
    input({ setup: setup({ expiresAt: '2026-08-25T11:00:00.000Z' }) }),
  );
  assert.ok(codigos(decision).includes('SETUP_EXPIRED'));
});

test('sinal antigo demais para MOMENTUM_BURST não é comprado', () => {
  // criado 5h antes: o card ainda vale, a explosão não
  const decision = evaluateEntryDecision(
    input({ setup: setup({ createdAt: '2026-08-25T07:00:00.000Z' }) }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(codigos(decision).includes('SETUP_STALE'));
  const bloqueio = decision.blockers.find((b) => b.code === 'SETUP_STALE');
  assert.equal(bloqueio?.data?.estrategia, 'MOMENTUM_BURST');
});

test('o mesmo sinal de 5h atrás continuaria válido para PULLBACK', () => {
  // prova que o frescor é POR estratégia, não um número global
  const decision = evaluateEntryDecision(
    input({ setup: setup({ setupType: 'PULLBACK', createdAt: '2026-08-25T07:00:00.000Z' }) }),
  );
  assert.ok(!codigos(decision).includes('SETUP_STALE'));
});

test('setup já comprado, invalidado ou dispensado não volta', () => {
  assert.ok(codigos(evaluateEntryDecision(input({ setup: setup({ status: 'BOUGHT' }) }))).includes('SETUP_ALREADY_BOUGHT'));
  assert.ok(codigos(evaluateEntryDecision(input({ setup: setup({ status: 'INVALIDATED' }) }))).includes('SETUP_INVALIDATED'));
  assert.ok(codigos(evaluateEntryDecision(input({ setup: setup({ ignoredAt: '2026-08-25T11:00:00.000Z' }) }))).includes('SETUP_IGNORED'));
});

test('uma posição automática por vez', () => {
  const decision = evaluateEntryDecision(
    input({ openAutomatic: [{ symbol: 'OUTRO', setupId: 'x' }] }),
  );
  assert.ok(codigos(decision).includes('MAX_CONCURRENT_TRADES'));
});

test('não empilha no mesmo ativo', () => {
  const decision = evaluateEntryDecision(
    input({ openAutomatic: [{ symbol: 'BMTUSDT', setupId: 'x' }] }),
  );
  assert.ok(codigos(decision).includes('SYMBOL_ALREADY_OPEN'));
});

test('cooldown do ativo bloqueia e diz a hora da liberação', () => {
  const liberaEm = AGORA.getTime() + 45 * 60_000;
  const decision = evaluateEntryDecision(input({ symbolCooldownUntil: liberaEm }));
  const bloqueio = decision.blockers.find((b) => b.code === 'SYMBOL_COOLDOWN');
  assert.ok(bloqueio);
  assert.equal(bloqueio.data?.faltamMinutos, 45);
  assert.equal(bloqueio.data?.liberaEm, new Date(liberaEm).toISOString());
});

test('preço atrasado bloqueia a compra', () => {
  const decision = evaluateEntryDecision(
    input({
      priceFreshness: evaluateFreshness(AGORA.getTime() - 60_000, TICK_THRESHOLDS, AGORA.getTime()),
    }),
  );
  assert.ok(codigos(decision).includes('MARKET_DATA_STALE'));
});

test('sem preço nenhum também bloqueia', () => {
  const decision = evaluateEntryDecision(
    input({ priceFreshness: evaluateFreshness(null, TICK_THRESHOLDS, AGORA.getTime()) }),
  );
  assert.ok(codigos(decision).includes('MARKET_DATA_STALE'));
});

test('persistência indisponível impede qualquer entrada', () => {
  const decision = evaluateEntryDecision(input({ persistenceAvailable: false }));
  assert.equal(decision.allowed, false);
  assert.ok(codigos(decision).includes('PERSISTENCE_UNAVAILABLE'));
});

test('conta real não armada bloqueia com o motivo por extenso', () => {
  const decision = evaluateEntryDecision(
    input({ liveDenial: 'ALLOW_LIVE_AUTOTRADE não está ligado no .env do servidor' }),
  );
  assert.ok(codigos(decision).includes('LIVE_NOT_ARMED'));
  assert.match(decision.blockers[0]?.message ?? '', /ALLOW_LIVE_AUTOTRADE/);
});

test('a decisão junta TODOS os bloqueios, não só o primeiro', () => {
  const decision = evaluateEntryDecision(
    input({
      robotEnabled: false,
      currentPrice: 1.5,
      setup: setup({ score: 50, setupType: 'PULLBACK' }),
    }),
  );
  const encontrados = codigos(decision);
  assert.ok(encontrados.includes('ROBOT_DISABLED'));
  assert.ok(encontrados.includes('STRATEGY_DISABLED'));
  assert.ok(encontrados.includes('PRICE_OUTSIDE_ENTRY_ZONE'));
  assert.ok(encontrados.length >= 3, 'saber que faltou UMA coisa é pouco quando faltavam três');
  // e o código que MANDA é o primeiro, para o painel ter um rótulo curto
  assert.equal(decision.code, encontrados[0]);
});

test('R/R abaixo do mínimo do robô bloqueia', () => {
  const decision = evaluateEntryDecision(input({ setup: setup({ riskReward: 2 }) }));
  assert.ok(codigos(decision).includes('RISK_REWARD_BELOW_MINIMUM'));
});

test('preço esticado é aviso, não bloqueio — encolher já é papel do regime', () => {
  const decision = evaluateEntryDecision(
    input({ setup: setup({ extended: true, extensionReasons: ['2 ATR acima do gatilho'] }) }),
  );
  assert.equal(decision.allowed, true);
  assert.ok(decision.warnings.some((w) => w.code === 'PRICE_EXTENDED'));
});

test('quando requireInsideEntryZone é falso, o preço fora não bloqueia', () => {
  const decision = evaluateEntryDecision(
    input({ currentPrice: 1.05, autoTrade: { ...AUTO, requireInsideEntryZone: false } }),
  );
  assert.ok(!codigos(decision).includes('PRICE_OUTSIDE_ENTRY_ZONE'));
});

test('bloqueios externos do disjuntor entram na mesma decisão', () => {
  const decision = evaluateEntryDecision(
    input({
      externalBlockers: [
        { code: 'DAILY_LOSS_LIMIT', rule: 'governor', message: 'Limite de perda diária atingido' },
      ],
    }),
  );
  assert.equal(decision.allowed, false);
  assert.ok(codigos(decision).includes('DAILY_LOSS_LIMIT'));
});
