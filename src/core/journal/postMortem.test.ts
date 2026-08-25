import assert from 'node:assert/strict';
import test from 'node:test';
import { postMortemOf, type PostMortemInput } from './postMortem.ts';

/** A ZAMA de 25/08/2026 — a operação que motivou este módulo. */
function zama(overrides: Partial<PostMortemInput> = {}): PostMortemInput {
  return {
    entryPrice: 0.05635,
    stopLoss: 0.05535004,
    target1: 0.06046,
    maxFavorablePercent: 6.19,
    maxAdversePercent: -1.93,
    realizedPnlPercent: -2.12,
    outcome: 'STOP',
    durationMinutes: 184,
    ...overrides,
  };
}

test('a operação que subiu 6% e fechou no stop é diagnosticada como lucro devolvido', () => {
  const report = postMortemOf(zama());
  assert.equal(report.code, 'LUCRO_DEVOLVIDO');
  assert.match(report.headline, /6[.,]19%/);
  assert.match(report.facts.join(' '), /84% do caminho|85% do caminho/);
});

test('o contrafactual diz, em número, o que cada regra teria feito NESTA operação', () => {
  const report = postMortemOf(zama());
  const texto = report.couldHaveSaved.join(' ');
  assert.match(texto, /empate/, 'a regra do empate em 1R precisa aparecer');
  // pico de 6,19% devolvendo 40% => sairia por volta de +3,7%
  assert.match(texto, /\+3[.,]7\d%/);
  assert.match(texto, /nenhuma dessas regras melhorou a expectativa/, 'o aviso do laboratório é obrigatório');
});

test('operação que nunca andou não recebe contrafactual — não havia lucro para proteger', () => {
  const report = postMortemOf(
    zama({ maxFavorablePercent: 0.2, realizedPnlPercent: -1.9, durationMinutes: 45 }),
  );
  assert.equal(report.code, 'MORREU_NA_LARGADA');
  assert.deepEqual(report.couldHaveSaved, []);
});

test('quase no alvo é diferente de devolveu lucro: o alvo é que estava longe', () => {
  const report = postMortemOf({
    entryPrice: 100,
    stopLoss: 97,
    target1: 110,
    maxFavorablePercent: 7.4,
    maxAdversePercent: -3,
    realizedPnlPercent: -3.1,
    outcome: 'STOP',
    durationMinutes: 600,
  });
  assert.equal(report.code, 'LUCRO_DEVOLVIDO');
  assert.match(report.facts[1] ?? '', /74% do caminho/);
});

test('quem ganhou também é lido — o diário não é só de derrota', () => {
  const report = postMortemOf(zama({ realizedPnlPercent: 5.8, outcome: 'TARGET1' }));
  assert.equal(report.code, 'GANHOU');
  assert.deepEqual(report.couldHaveSaved, []);
});
