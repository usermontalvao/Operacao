import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTradePlan } from './tradePlan.ts';

test('aceita plano comprado e stop já em lucro, desde que abaixo do preço vivo', () => {
  assert.deepEqual(
    validateTradePlan(
      { stopLoss: 105, target1: 112, target2: 118, target3: 125 },
      'BUY',
      110,
    ),
    [],
  );
});

test('inverte stop, alvos e ordenação para posição vendida', () => {
  assert.deepEqual(
    validateTradePlan(
      { stopLoss: 105, target1: 95, target2: 90, target3: 85 },
      'SELL',
      100,
    ),
    [],
  );
});

test('recusa stop já acionado e alvos fora de ordem', () => {
  const errors = validateTradePlan(
    { stopLoss: 101, target1: 110, target2: 108, target3: 115 },
    'BUY',
    100,
  );
  assert.ok(errors.includes('O stop precisa ficar abaixo do preço atual'));
  assert.ok(errors.includes('O alvo 2 precisa ficar depois do alvo 1'));
});

test('não permite alvo 3 sem alvo 2', () => {
  assert.deepEqual(
    validateTradePlan({ stopLoss: 95, target1: 110, target2: null, target3: 130 }, 'BUY', 100),
    ['O alvo 3 exige um alvo 2'],
  );
});

test('stop a mais de 30% do preço é recusado — comprado e vendido', () => {
  const comprado = validateTradePlan(
    { stopLoss: 65, target1: 120, target2: null, target3: null },
    'BUY',
    100,
  );
  assert.ok(
    comprado.some((item) => /acima do teto de 30%/.test(item)),
    `esperava a recusa do stop largo, veio: ${comprado.join(' | ')}`,
  );

  const vendido = validateTradePlan(
    { stopLoss: 140, target1: 80, target2: null, target3: null },
    'SELL',
    100,
  );
  assert.ok(vendido.some((item) => /acima do teto de 30%/.test(item)));
});

test('30% cravados passam — o teto é o limite, não a proibição', () => {
  assert.deepEqual(
    validateTradePlan({ stopLoss: 70, target1: 120, target2: null, target3: null }, 'BUY', 100),
    [],
  );
});

test('plano sem stop é recusado antes de qualquer outra conta', () => {
  const semStop = validateTradePlan(
    { stopLoss: null as unknown as number, target1: 110, target2: null, target3: null },
    'BUY',
    100,
  );
  assert.ok(
    semStop.some((item) => /Ordem sem stop/.test(item)),
    `esperava a recusa por falta de stop, veio: ${semStop.join(' | ')}`,
  );

  const stopZerado = validateTradePlan(
    { stopLoss: 0, target1: 110, target2: null, target3: null },
    'BUY',
    100,
  );
  assert.ok(stopZerado.length > 0, 'stop zerado não pode passar');
});
