import assert from 'node:assert/strict';
import test from 'node:test';
import { strategyConfidenceSizeFactor } from './automationPolicy.ts';
import type { AutoTradeSettings } from '../types.ts';

const ajustes = { minimumScore: 85 } as AutoTradeSettings;

/*
 * O teste anterior travava a graduação de tamanho por força do sinal. Ela foi
 * REMOVIDA porque a medição não a sustenta em nenhuma das duas versões (por
 * score e por corpo). O que este arquivo trava agora é o oposto: que nenhuma
 * característica do sinal aumente a aposta sem evidência.
 */
test('nem score alto nem explosão gigante aumentam a aposta', () => {
  const fraco = strategyConfidenceSizeFactor(
    { setupType: 'MOMENTUM_BURST', score: 70, burstBodyAtr: 2 },
    ajustes,
  );
  const forte = strategyConfidenceSizeFactor(
    { setupType: 'MOMENTUM_BURST', score: 100, burstBodyAtr: 9 },
    ajustes,
  );
  assert.equal(fraco, 1);
  assert.equal(forte, 1, 'a explosão de 9 ATR não pode valer mais capital que a de 2');
  assert.equal(fraco, forte, 'quem dimensiona é o risco e a exposição, não o grau do sinal');
});

test('estratégia sem vantagem medida continua com meio tamanho', () => {
  for (const tipo of ['PULLBACK', 'BREAKOUT_RETEST', 'SUPPORT_REVERSAL', 'RANGE_FADE'] as const) {
    assert.equal(
      strategyConfidenceSizeFactor({ setupType: tipo, score: 100 }, ajustes),
      0.5,
      `${tipo} nunca foi validada e não pode operar em tamanho cheio`,
    );
  }
});
