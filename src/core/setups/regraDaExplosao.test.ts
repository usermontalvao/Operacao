import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CORPO_DE_EXPLOSAO_FORTE,
  MIN_BODY_ATR,
  forcaDaExplosao,
  timeframeOperaExplosao,
} from './momentumBurst.ts';
import { automaticRejection, strategyConfidenceSizeFactor } from '../strategy/automationPolicy.ts';
import { sizeByRisk } from '../risk/sizeByRisk.ts';
import { DEFAULT_COSTS } from '../risk/costs.ts';
import type { AutoTradeSettings } from '../types.ts';

/**
 * A REGRA OPERACIONAL DA EXPLOSÃO, travada em teste.
 *
 * Cada uma destas asserções corresponde a uma conclusão do laboratório. Elas
 * existem para que a régua não volte sozinha ao que era numa refatoração
 * futura — especialmente as duas que parecem "faltando alguma coisa": score
 * baixo passa, e explosão gigante não vale mais dinheiro.
 */

const ajustes = {
  minimumScore: 85,
  minimumRiskReward: 2.5,
  strategies: {
    MOMENTUM_BURST: { enabled: true, minimumScore: 85, minimumRiskReward: 2.5 },
  },
} as unknown as AutoTradeSettings;

const burst = (over: Record<string, unknown> = {}) => ({
  setupType: 'MOMENTUM_BURST' as const,
  score: 95,
  timeframe: '4h',
  ...over,
});

test('o piso do corpo é 2,0 e a fronteira do forte é 3,0', () => {
  assert.equal(MIN_BODY_ATR, 2);
  assert.equal(CORPO_DE_EXPLOSAO_FORTE, 3);
});

test('1h não opera explosão; 4h opera', () => {
  assert.equal(timeframeOperaExplosao('4h'), true);
  for (const tf of ['1m', '5m', '15m', '1h', '1d']) {
    assert.equal(timeframeOperaExplosao(tf), false, `${tf} não pode operar explosão`);
  }
});

test('explosão de 1h é recusada mesmo com score máximo', () => {
  const r = automaticRejection(burst({ timeframe: '1h', score: 100 }), ajustes);
  assert.equal(r?.code, 'TIMEFRAME_NOT_ENABLED');
});

test('4h com score BAIXO é aceito — o score deixou de ser porteiro', () => {
  for (const score of [40, 70, 78, 84]) {
    assert.equal(
      automaticRejection(burst({ score }), ajustes),
      null,
      `score ${score} não pode barrar a explosão`,
    );
  }
});

test('a classificação de força tem exatamente dois níveis', () => {
  assert.equal(forcaDaExplosao(1.99), 'NORMAL');
  assert.equal(forcaDaExplosao(2), 'NORMAL');
  assert.equal(forcaDaExplosao(2.99), 'NORMAL');
  assert.equal(forcaDaExplosao(3), 'STRONG');
  assert.equal(forcaDaExplosao(3.42), 'STRONG');
  assert.equal(forcaDaExplosao(9), 'STRONG');
});

test('força NÃO multiplica capital: NORMAL e STRONG pedem o mesmo tamanho', () => {
  const normal = strategyConfidenceSizeFactor(burst({ burstBodyAtr: 2.1 }), ajustes);
  const forte = strategyConfidenceSizeFactor(burst({ burstBodyAtr: 8 }), ajustes);
  assert.equal(normal, forte);
  assert.equal(forte, 1);
});

/**
 * 25% é TETO DE EXPOSIÇÃO, não risco até o stop. Confundir os dois
 * multiplicaria o risco por 25 — é o erro mais caro possível aqui.
 */
test('25% de exposição com 1% de risco: o exemplo de 1.000 USDT', () => {
  const r = sizeByRisk({
    entryPrice: 100,
    stopLoss: 96, // 4% de distância
    equity: 1000,
    available: 1000,
    riskPerTradePercent: 1,
    maxPositionPercent: 25,
    maxNotional: 1_000_000,
    costs: { ...DEFAULT_COSTS, feePercent: 0, stopSlippagePercent: 0, exitSlippagePercent: 0 },
  });
  assert.equal(r.notional, 250, 'posição = 10 USDT de risco / 4% de stop = 250');
  assert.ok(Math.abs(r.riskAmount - 10) < 0.01, `risco tinha de ser 10 USDT, veio ${r.riskAmount}`);
  assert.equal(r.notional / 1000, 0.25, 'exposição de 25%');
  assert.ok(r.riskAmount / 1000 <= 0.0101, 'risco de 1%, NÃO de 25%');
});

test('stop mais largo encolhe a posição e mantém o risco em 1%', () => {
  const semCusto = { ...DEFAULT_COSTS, feePercent: 0, stopSlippagePercent: 0, exitSlippagePercent: 0 };
  for (const [stop, esperado] of [[96, 250], [90, 100], [80, 50]] as const) {
    const r = sizeByRisk({
      entryPrice: 100,
      stopLoss: stop,
      equity: 1000,
      available: 1000,
      riskPerTradePercent: 1,
      maxPositionPercent: 25,
      maxNotional: 1_000_000,
      costs: semCusto,
    });
    assert.equal(r.notional, esperado, `stop em ${stop} deveria dar posição de ${esperado}`);
    assert.ok(r.riskAmount <= 10.01, 'o risco nunca passa de 1% do patrimônio');
  }
});

test('o teto de exposição corta quando o stop é curto — e o risco cai junto', () => {
  const r = sizeByRisk({
    entryPrice: 100,
    stopLoss: 99.5, // 0,5%: pelo risco daria 2.000, muito acima do teto
    equity: 1000,
    available: 1000,
    riskPerTradePercent: 1,
    maxPositionPercent: 25,
    maxNotional: 1_000_000,
    costs: { ...DEFAULT_COSTS, feePercent: 0, stopSlippagePercent: 0, exitSlippagePercent: 0 },
  });
  assert.equal(r.notional, 250, 'quem manda passa a ser o teto de exposição');
  assert.equal(r.boundBy, 'MAX_POSITION_PERCENT');
  assert.ok(r.riskAmount < 10, 'com stop curto e teto de exposição, arrisca-se MENOS que 1%');
});

test('o saldo disponível continua limitando, e uma posição não sequestra a conta', () => {
  const r = sizeByRisk({
    entryPrice: 100,
    stopLoss: 96,
    equity: 1000,
    available: 80, // já há capital preso em outras posições
    riskPerTradePercent: 1,
    maxPositionPercent: 25,
    maxNotional: 1_000_000,
    costs: DEFAULT_COSTS,
  });
  assert.ok(r.notional <= 80, `a ordem não pode passar do saldo livre, veio ${r.notional}`);
  assert.equal(r.boundBy, 'AVAILABLE_BALANCE');
});

test('o teto absoluto por ordem continua valendo', () => {
  const r = sizeByRisk({
    entryPrice: 100,
    stopLoss: 96,
    equity: 100_000,
    available: 100_000,
    riskPerTradePercent: 1,
    maxPositionPercent: 25,
    maxNotional: 500,
    costs: DEFAULT_COSTS,
  });
  assert.ok(r.notional <= 500);
  assert.equal(r.boundBy, 'MAX_NOTIONAL');
});
