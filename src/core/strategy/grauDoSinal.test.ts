import assert from 'node:assert/strict';
import test from 'node:test';
import { FRACAO_SINAL_MEDIO, strategyConfidenceSizeFactor } from './automationPolicy.ts';
import type { AutoTradeSettings } from '../types.ts';

const ajustes = { minimumScore: 85 } as AutoTradeSettings;

test('o grau vem do corpo da explosão, não do score', () => {
  // score máximo com corpo médio continua sendo aposta média: foi medido que
  // a faixa 95-100 rende MENOS que a 85-89
  assert.equal(
    strategyConfidenceSizeFactor(
      { setupType: 'MOMENTUM_BURST', score: 100, burstBodyAtr: 3 },
      ajustes,
    ),
    FRACAO_SINAL_MEDIO,
  );
  // score no piso com corpo grande é aposta cheia
  assert.equal(
    strategyConfidenceSizeFactor(
      { setupType: 'MOMENTUM_BURST', score: 85, burstBodyAtr: 4 },
      ajustes,
    ),
    1,
  );
});

test('sem a medida do corpo, o benefício da dúvida NUNCA aumenta a aposta', () => {
  for (const corpo of [null, undefined, Number.NaN]) {
    assert.equal(
      strategyConfidenceSizeFactor(
        { setupType: 'MOMENTUM_BURST', score: 100, burstBodyAtr: corpo },
        ajustes,
      ),
      FRACAO_SINAL_MEDIO,
      `corpo ${String(corpo)} tinha de cair no tamanho médio`,
    );
  }
});

test('estratégia sem grau medido opera no tamanho médio, nunca no cheio', () => {
  for (const tipo of ['PULLBACK', 'BREAKOUT_RETEST', 'SUPPORT_REVERSAL', 'RANGE_FADE'] as const) {
    assert.equal(
      strategyConfidenceSizeFactor({ setupType: tipo, score: 100, burstBodyAtr: 9 }, ajustes),
      FRACAO_SINAL_MEDIO,
      `${tipo} não tem grau medido e não pode chegar ao tamanho cheio`,
    );
  }
});

test('a fronteira é 3,5 ATR e ela é inclusiva', () => {
  const grau = (corpo: number): number =>
    strategyConfidenceSizeFactor({ setupType: 'MOMENTUM_BURST', score: 90, burstBodyAtr: corpo }, ajustes);
  assert.equal(grau(3.49), FRACAO_SINAL_MEDIO);
  assert.equal(grau(3.5), 1);
  assert.equal(grau(3.51), 1);
});
