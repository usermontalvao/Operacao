import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_GUARD } from './governor.ts';

/**
 * O descanso pós-perda, isolado da máquina de risco inteira.
 *
 * A regra que interessa é uma só e cabe aqui: quantas perdas seguidas o
 * descanso exige para armar, e quanto tempo falta. Reproduzir a decisão neste
 * teste vale mais que montar um `RiskSnapshot` inteiro — o que se quer provar
 * é que perder UMA vez deixou de parar a operação.
 */
function descanso(input: {
  consecutiveLosses: number;
  lastLossAt: string | null;
  agora: string;
  cooldownMinutes?: number;
  minimo?: number;
}): string | null {
  const guard = {
    lossCooldownMinutes: input.cooldownMinutes ?? DEFAULT_GUARD.lossCooldownMinutes,
    minLossesForCooldown: input.minimo ?? DEFAULT_GUARD.minLossesForCooldown,
  };
  const minimoParaDescanso = Math.max(guard.minLossesForCooldown ?? 1, 1);
  if (
    guard.lossCooldownMinutes <= 0 ||
    input.lastLossAt === null ||
    input.consecutiveLosses < minimoParaDescanso
  ) {
    return null;
  }
  const elapsed = Date.parse(input.agora) - Date.parse(input.lastLossAt);
  const window = guard.lossCooldownMinutes * 60_000;
  if (elapsed < 0 || elapsed >= window) return null;
  return `faltam ${Math.ceil((window - elapsed) / 60_000)} min`;
}

test('o padrão exige mais de uma perda: perder uma vez não para a operação', () => {
  assert.equal(DEFAULT_GUARD.minLossesForCooldown, 2);
  const uma = descanso({
    consecutiveLosses: 1,
    lastLossAt: '2026-08-26T14:53:00.000Z',
    agora: '2026-08-26T15:15:00.000Z',
  });
  assert.equal(uma, null, 'uma perda isolada é o resultado esperado, não uma maré ruim');
});

test('duas perdas seguidas armam o descanso', () => {
  const duas = descanso({
    consecutiveLosses: 2,
    lastLossAt: '2026-08-26T14:53:00.000Z',
    agora: '2026-08-26T15:15:00.000Z',
  });
  assert.equal(duas, 'faltam 38 min');
});

test('o contador anda de verdade — não fica preso no mesmo número', () => {
  const base = { consecutiveLosses: 3, lastLossAt: '2026-08-26T14:00:00.000Z' };
  assert.equal(descanso({ ...base, agora: '2026-08-26T14:10:00.000Z' }), 'faltam 50 min');
  assert.equal(descanso({ ...base, agora: '2026-08-26T14:40:00.000Z' }), 'faltam 20 min');
  assert.equal(descanso({ ...base, agora: '2026-08-26T14:59:00.000Z' }), 'faltam 1 min');
});

test('passada a janela, o descanso sai sozinho', () => {
  const depois = descanso({
    consecutiveLosses: 3,
    lastLossAt: '2026-08-26T14:00:00.000Z',
    agora: '2026-08-26T15:00:00.000Z',
  });
  assert.equal(depois, null);
});

test('exigir 1 perda restaura o comportamento antigo, para quem quiser', () => {
  const uma = descanso({
    consecutiveLosses: 1,
    lastLossAt: '2026-08-26T14:53:00.000Z',
    agora: '2026-08-26T15:15:00.000Z',
    minimo: 1,
  });
  assert.equal(uma, 'faltam 38 min');
});

test('descanso zerado desliga a trava por completo', () => {
  const sem = descanso({
    consecutiveLosses: 5,
    lastLossAt: '2026-08-26T14:53:00.000Z',
    agora: '2026-08-26T15:15:00.000Z',
    cooldownMinutes: 0,
  });
  assert.equal(sem, null);
});
