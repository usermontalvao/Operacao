import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExitPlan, NO_FILTERS, type ExitPlanFilters } from './exitPlan.ts';

const SHARES = [0.5, 0.3, 0.2] as const;
const BINANCE: ExitPlanFilters = { stepSize: 0.1, minQty: 0.1, minNotional: 5 };

test('sem filtros o plano é exatamente 50/30/20', () => {
  const plan = buildExitPlan({
    quantity: 100,
    target1: 1.1,
    target2: 1.2,
    target3: 1.3,
    shares: SHARES,
    filters: NO_FILTERS,
  });

  assert.equal(plan.kind, 'SCALE_OUT');
  assert.deepEqual(
    plan.tranches.map((item) => item.quantity),
    [50, 30, 20],
  );
});

test('a soma das parcelas fecha com a posição, sem sobra presa', () => {
  const plan = buildExitPlan({
    quantity: 7.3,
    target1: 12,
    target2: 14,
    target3: 17,
    shares: SHARES,
    filters: BINANCE,
  });

  const total = plan.tranches.reduce((sum, item) => sum + item.quantity, 0);
  assert.ok(Math.abs(total - 7.3) < 1e-9, `sobrou ${7.3 - total} sem plano`);
});

test('alvo que não paga o mínimo da corretora sai e devolve a fatia', () => {
  // 20% de 30 unidades a 1 USDT = 6 USDT no alvo 3... e 5 no mínimo:
  // com posição menor, o alvo 3 deixa de caber
  const plan = buildExitPlan({
    quantity: 20,
    target1: 1,
    target2: 1.1,
    target3: 1.2,
    shares: SHARES,
    filters: { stepSize: 0.1, minQty: 0.1, minNotional: 8 },
  });

  assert.ok(plan.tranches.length < 3, 'o alvo que não cabe precisa sair do plano');
  assert.ok(
    plan.notes.some((note) => note.includes('mínimo')),
    'a razão precisa ficar registrada',
  );
  const total = plan.tranches.reduce((sum, item) => sum + item.quantity, 0);
  assert.ok(Math.abs(total - 20) < 1e-9, 'a posição inteira continua tendo plano');
});

test('posição pequena demais vira saída única no alvo 1 — como a conta real fazia', () => {
  const plan = buildExitPlan({
    quantity: 6,
    target1: 1,
    target2: 1.1,
    target3: 1.2,
    shares: SHARES,
    filters: { stepSize: 0.1, minQty: 0.1, minNotional: 5 },
  });

  assert.equal(plan.kind, 'SINGLE');
  assert.equal(plan.tranches.length, 1);
  assert.equal(plan.tranches[0]?.quantity, 6);
});

test('alvo distante já removido não deixa buraco: as fatias são renormalizadas', () => {
  const plan = buildExitPlan({
    quantity: 100,
    target1: 1.1,
    target2: 1.2,
    target3: null,
    shares: SHARES,
    filters: NO_FILTERS,
  });

  assert.equal(plan.tranches.length, 2);
  const total = plan.tranches.reduce((sum, item) => sum + item.quantity, 0);
  assert.equal(total, 100);
  // 50 e 30 renormalizados sobre 0,8 => 62,5% e 37,5%
  assert.equal(plan.tranches[0]?.quantity, 62.5);
});

test('quantidade sempre desce ao passo do lote, nunca sobe', () => {
  const plan = buildExitPlan({
    quantity: 3.77,
    target1: 100,
    target2: 120,
    target3: 140,
    shares: SHARES,
    filters: { stepSize: 0.01, minQty: 0.01, minNotional: 5 },
  });

  for (const tranche of plan.tranches) {
    const steps = tranche.quantity / 0.01;
    assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, `${tranche.quantity} não é múltiplo do passo`);
  }
  const total = plan.tranches.reduce((sum, item) => sum + item.quantity, 0);
  assert.ok(total <= 3.77 + 1e-9, 'o plano não pode vender mais do que existe');
});
