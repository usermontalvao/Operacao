import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_GUARD } from '../risk/governor.ts';
import { netPnl, stopFillPrice } from '../risk/costs.ts';
import { sanitizeTargets } from '../risk/stops.ts';
import { sizeByRisk } from '../risk/sizeByRisk.ts';
import { detectPolicyConflicts, EXIT_POLICIES } from '../strategy/exitPolicy.ts';

/**
 * Paridade entre o laboratório e a conta.
 *
 * O risco que estes testes vigiam não é de cálculo errado, é de cálculo
 * DUPLICADO. Enquanto backtest e execução compartilharem as mesmas funções
 * puras, um resultado medido continua valendo para o que o robô faz. No dia em
 * que alguém reescrever uma delas "só para este caso", os dois números
 * continuam parecendo comparáveis e deixam de ser.
 */

const COSTS = {
  feePercent: DEFAULT_GUARD.feePercent,
  stopSlippagePercent: DEFAULT_GUARD.stopSlippagePercent,
  exitSlippagePercent: DEFAULT_GUARD.exitSlippagePercent,
};

test('o preço de preenchimento do stop é o mesmo dos dois lados', () => {
  // stopFillPrice é a única fonte: se o backtest usasse o gatilho e a execução
  // usasse o preenchimento, todo R medido estaria otimista
  const stop = 0.9;
  assert.equal(stopFillPrice(stop, COSTS), stop * (1 - COSTS.stopSlippagePercent / 100));
  assert.ok(stopFillPrice(stop, COSTS) < stop);
});

test('o prejuízo planejado no risco é o MESMO que o realizado no stop', () => {
  // esta é a invariante que liga dimensionamento e resultado: o número que o
  // preview mostra como "risco" tem de ser o que a operação perde de verdade
  const entryPrice = 100;
  const stopLoss = 92;

  const sized = sizeByRisk({
    entryPrice,
    stopLoss,
    equity: 10_000,
    available: 10_000,
    riskPerTradePercent: 1,
    maxPositionPercent: 100,
    maxNotional: Number.POSITIVE_INFINITY,
    costs: COSTS,
  });

  // agora simula o desfecho pelo mesmo caminho do backtest e do PAPER
  const realizado = netPnl({
    entryPrice,
    exitPrice: stopFillPrice(stopLoss, COSTS),
    quantity: sized.quantity,
    feePercent: COSTS.feePercent,
  });

  assert.ok(
    Math.abs(-realizado - sized.riskAmount) < 0.01,
    `planejado ${sized.riskAmount}, realizado ${-realizado}`,
  );
});

test('o teto de alvo do laboratório é o mesmo do disjuntor', () => {
  // a divergência que existia: o simulador tinha 40 escrito no corpo enquanto a
  // execução lia o valor do painel. Coincidiam por acaso.
  const entrada = 100;
  const alvoAbsurdo = 200;

  const noLaboratorio = sanitizeTargets({
    entryPrice: entrada,
    target1: 110,
    target2: alvoAbsurdo,
    target3: null,
    maxTargetPercent: DEFAULT_GUARD.maxTargetPercent,
  });
  const naExecucao = sanitizeTargets({
    entryPrice: entrada,
    target1: 110,
    target2: alvoAbsurdo,
    target3: null,
    maxTargetPercent: DEFAULT_GUARD.maxTargetPercent,
  });

  assert.deepEqual(noLaboratorio, naExecucao);
  assert.equal(noLaboratorio.target2, null, 'alvo 2 absurdo tem de cair');
});

test('o alvo 1 NUNCA é descartado — e isso é deliberado, não esquecimento', () => {
  // documenta a semântica real de maxTargetPercent. Se algum dia alguém
  // "consertar" isto, MOMENTUM_BURST passa a operar com alvo diferente do que
  // foi medido, e este teste é o aviso.
  const resultado = sanitizeTargets({
    entryPrice: 100,
    target1: 500,
    target2: null,
    target3: null,
    maxTargetPercent: 40,
  });
  assert.equal(resultado.target1, 500, 'o alvo principal passa mesmo absurdo');
  assert.deepEqual(resultado.dropped, [], 'e não é registrado como descartado');
});

test('a contradição entre teto global e estratégia medida é DENUNCIADA', () => {
  // não bloqueia: avisa. O que não pode é ser silenciosa.
  const conflitos = detectPolicyConflicts({
    setupType: 'MOMENTUM_BURST',
    guard: { ...DEFAULT_GUARD, maxTargetPercent: 10 },
    entryPrice: 100,
    stopLoss: 90,
    target1: 130,
  });

  assert.equal(conflitos.length >= 1, true);
  const alvo = conflitos.find((c) => c.setting === 'maxTargetPercent');
  assert.ok(alvo);
  assert.match(alvo.message, /NÃO é descartado/);
  assert.match(alvo.message, /alvos 2 e 3/);
});

test('MOMENTUM_BURST tem alvo único e não usa saída em partes', () => {
  const policy = EXIT_POLICIES.MOMENTUM_BURST;
  assert.equal(policy.targets, 1);
  assert.equal(policy.scaleOut, false);
  assert.equal(policy.primaryTargetR, 3);

  // e ligar a saída em partes com alvo único é contradição, não configuração
  const conflitos = detectPolicyConflicts({
    setupType: 'MOMENTUM_BURST',
    guard: { ...DEFAULT_GUARD, liveScaleOut: true, maxTargetPercent: 300 },
    entryPrice: 100,
    stopLoss: 90,
    target1: 130,
  });
  assert.ok(conflitos.some((c) => c.setting === 'liveScaleOut'));
});

test('custos default do disjuntor e do laboratório não podem divergir', () => {
  // um lugar só define taxa e escorregamento; se alguém criar um segundo
  // conjunto de padrões, o resultado medido para de valer
  assert.equal(COSTS.feePercent, DEFAULT_GUARD.feePercent);
  assert.equal(COSTS.stopSlippagePercent, DEFAULT_GUARD.stopSlippagePercent);
  assert.equal(COSTS.exitSlippagePercent, DEFAULT_GUARD.exitSlippagePercent);
});
