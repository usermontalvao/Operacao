import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticStrategyRejectionReason } from './automationPolicy.ts';

test('somente a estratégia validada pode operar automaticamente', () => {
  assert.equal(automaticStrategyRejectionReason({ setupType: 'MOMENTUM_BURST', score: 90 }), null);
  assert.match(
    automaticStrategyRejectionReason({ setupType: 'MOMENTUM_BURST', score: 89 }) ?? '',
    /piso validado de 90/i,
  );
  assert.match(automaticStrategyRejectionReason({ setupType: 'PULLBACK', score: 99 }) ?? '', /observação/i);
  assert.match(automaticStrategyRejectionReason({ setupType: 'BREAKOUT_RETEST', score: 99 }) ?? '', /observação/i);
  assert.match(automaticStrategyRejectionReason({ setupType: 'SUPPORT_REVERSAL', score: 99 }) ?? '', /observação/i);
});
