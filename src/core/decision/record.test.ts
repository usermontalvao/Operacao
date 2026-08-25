import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_GUARD } from '../risk/governor.ts';
import { capturePolicySnapshot, describePolicy } from '../policy/snapshot.ts';
import type { EntryDecision } from './types.ts';
import {
  DECISION_DEDUP_WINDOW_MS,
  buildDecisionRecord,
  decisionFingerprint,
  mergeRepeatedDecision,
} from './record.ts';

function decision(overrides: Partial<EntryDecision> = {}): EntryDecision {
  return {
    allowed: false,
    code: 'PRICE_OUTSIDE_ENTRY_ZONE',
    blockers: [
      {
        code: 'PRICE_OUTSIDE_ENTRY_ZONE',
        rule: 'autoTrader',
        message: 'Preço 3,14% acima da zona máxima.',
      },
    ],
    warnings: [],
    sizeFactor: 1,
    stage: 'SCORE_SUFICIENTE',
    evaluatedAt: '2026-08-25T12:00:00.000Z',
    setupId: 'setup-1',
    symbol: 'BMTUSDT',
    currentPrice: 1.05,
    entryLow: 0.98,
    entryHigh: 1.02,
    distanceToEntryPercent: 3.14,
    ...overrides,
  };
}

function record(d: EntryDecision, id = 'r1') {
  return buildDecisionRecord({
    decision: d,
    setupType: 'MOMENTUM_BURST',
    timeframe: '1h',
    mode: 'PAPER',
    score: 95,
    policy: null,
    id,
  });
}

test('a mesma situação repetida NÃO gera linha nova', () => {
  const primeira = record(decision());
  const repetida = record(
    decision({ evaluatedAt: '2026-08-25T12:05:00.000Z', currentPrice: 1.0505 }),
    'r2',
  );

  const resultado = mergeRepeatedDecision(primeira, repetida, DECISION_DEDUP_WINDOW_MS);
  assert.equal(resultado, null, 'dentro da janela, nada volta ao disco');
});

test('passada a janela, a repetição atualiza a linha e conta a ocorrência', () => {
  const primeira = record(decision());
  const depois = record(decision({ evaluatedAt: '2026-08-25T12:20:00.000Z' }), 'r2');

  const resultado = mergeRepeatedDecision(primeira, depois, DECISION_DEDUP_WINDOW_MS);
  assert.ok(resultado);
  assert.equal(resultado.id, primeira.id, 'continua sendo a MESMA linha');
  assert.equal(resultado.occurrences, 2);
  assert.equal(resultado.lastSeenAt, '2026-08-25T12:20:00.000Z');
  assert.equal(resultado.firstSeenAt, '2026-08-25T12:00:00.000Z');
});

test('mudar o motivo cria linha nova, mesmo dentro da janela', () => {
  const primeira = record(decision());
  const outra = record(
    decision({
      evaluatedAt: '2026-08-25T12:01:00.000Z',
      code: 'SYMBOL_COOLDOWN',
      blockers: [{ code: 'SYMBOL_COOLDOWN', rule: 'autoTrader', message: 'Descanso' }],
    }),
    'r2',
  );

  const resultado = mergeRepeatedDecision(primeira, outra, DECISION_DEDUP_WINDOW_MS);
  assert.ok(resultado);
  assert.equal(resultado.id, 'r2', 'motivo diferente é situação diferente');
});

test('o preço atravessar a faixa de meio por cento cria linha nova', () => {
  // sem faixa, cada centavo criaria uma linha; com faixa grande demais, o preço
  // cruzaria a zona inteira sem registro
  const perto = decisionFingerprint(decision({ distanceToEntryPercent: 3.1 }), 95);
  const igual = decisionFingerprint(decision({ distanceToEntryPercent: 3.2 }), 95);
  const longe = decisionFingerprint(decision({ distanceToEntryPercent: 5.0 }), 95);

  assert.equal(perto, igual, 'oscilação pequena continua sendo a mesma situação');
  assert.notEqual(perto, longe, 'meio por cento adiante já é outra situação');
});

test('score diferente é situação diferente', () => {
  assert.notEqual(
    decisionFingerprint(decision(), 95),
    decisionFingerprint(decision(), 91),
  );
});

test('o retrato da política congela os números, não a referência', () => {
  const risk = { riskPerTradePercent: 1 } as never;
  const autoTrade = { minimumScore: 90 } as never;
  const guard = { ...DEFAULT_GUARD };

  const snapshot = capturePolicySnapshot({
    mode: 'PAPER',
    autoTrade,
    risk,
    guard,
    btcContext: 'BTC_NEUTRAL',
  });

  // muda a configuração viva DEPOIS de capturar
  guard.feePercent = 0.9;

  assert.equal(snapshot.guard.feePercent, DEFAULT_GUARD.feePercent, 'o retrato não pode mudar junto');
  assert.equal(snapshot.costs.feePercent, DEFAULT_GUARD.feePercent);
  assert.equal(snapshot.strategyVersion, 'momentum-burst-only@1');
});

test('operação antiga sem retrato é declarada sem retrato, não preenchida com o de hoje', () => {
  assert.match(describePolicy(null), /não registrada/i);
  const snapshot = capturePolicySnapshot({
    mode: 'PAPER',
    autoTrade: {} as never,
    risk: {} as never,
    guard: DEFAULT_GUARD,
    btcContext: null,
  });
  assert.match(describePolicy(snapshot), /momentum-burst-only@1/);
});
