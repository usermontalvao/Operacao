import assert from 'node:assert/strict';
import test from 'node:test';
import type { Stats } from '../core/backtest/metrics.ts';
import { julgar } from './estrategias.ts';

function stats(filled: number, expectancyR = 0.2): Stats {
  return {
    label: 'janela',
    signals: filled,
    filled,
    fillRate: 1,
    wins: Math.round(filled / 2),
    winRate: 0.5,
    target1Rate: 0.5,
    expectancyR,
    expectancyPercent: expectancyR,
    profitFactor: expectancyR > 0 ? 1.2 : 0.8,
    totalR: expectancyR * filled,
    maxDrawdownR: 3,
    avgMfePercent: 2,
    avgMaePercent: -1,
  };
}

test('uma estratégia não é aprovada somando uma amostra grande com um teste minúsculo', () => {
  const verdict = julgar('BREAKOUT_RETEST', stats(100), stats(5));

  assert.equal(verdict.aprovada, false);
  assert.match(verdict.motivo, /100 no treino e 5 no teste/);
});

test('cada janela com amostra e expectativa positiva pode avançar', () => {
  assert.equal(julgar('MOMENTUM_BURST', stats(30), stats(30)).aprovada, true);
});
