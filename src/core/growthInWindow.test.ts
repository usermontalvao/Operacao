import assert from 'node:assert/strict';
import { test } from 'node:test';
import { growthInWindow } from './analytics.ts';
import type { EquityPoint } from './types.ts';

const ponto = (time: string, equity: number): EquityPoint => ({
  time,
  equity,
  realizedPnl: 0,
  tradeId: null,
});

/** Três dias de carteira: começa em 100, ganha 10 anteontem, perde 5 ontem. */
const CURVA: EquityPoint[] = [
  ponto('2026-08-20T00:00:00.000Z', 100),
  ponto('2026-08-24T12:00:00.000Z', 110),
  ponto('2026-08-25T12:00:00.000Z', 105),
];

const ms = (iso: string): number => Date.parse(iso);

test('sem recorte, o número é o de sempre: desde o início', () => {
  const r = growthInWindow({
    points: CURVA,
    startingCapital: 100,
    currentEquity: 105,
    from: null,
    to: null,
  });
  assert.equal(r.percent, 5);
});

test('a base da janela é o patrimônio ANTES dela, não o primeiro ponto de dentro', () => {
  // se a base fosse o primeiro ponto de dentro (110), a perda de ontem
  // sumiria — e é justamente a operação que abriu o período
  const ontem = growthInWindow({
    points: CURVA,
    startingCapital: 100,
    currentEquity: 105,
    from: ms('2026-08-25T00:00:00.000Z'),
    to: ms('2026-08-26T00:00:00.000Z'),
  });
  assert.equal(ontem.base, 110);
  assert.equal(ontem.end, 105);
  assert.ok(Math.abs(ontem.percent - -4.5454) < 0.01, `veio ${ontem.percent}`);
});

test('janela fechada não deixa o resultado de hoje vazar para ontem', () => {
  // currentEquity é 130 (hoje subiu muito); "ontem" tem de ignorar isso
  const ontem = growthInWindow({
    points: CURVA,
    startingCapital: 100,
    currentEquity: 130,
    from: ms('2026-08-25T00:00:00.000Z'),
    to: ms('2026-08-26T00:00:00.000Z'),
  });
  assert.equal(ontem.end, 105, 'o fim de uma janela fechada sai da curva');
});

test('janela que vai até agora usa o patrimônio de agora, com resultado em aberto', () => {
  const hoje = growthInWindow({
    points: CURVA,
    startingCapital: 100,
    currentEquity: 126,
    from: ms('2026-08-26T00:00:00.000Z'),
    to: null,
  });
  assert.equal(hoje.base, 105, 'começou o dia com 105');
  assert.equal(hoje.end, 126);
  assert.equal(hoje.percent, 20);
});

test('período sem operação nenhuma marca zero e avisa que está vazio', () => {
  const vazio = growthInWindow({
    points: CURVA,
    startingCapital: 100,
    currentEquity: 105,
    from: ms('2026-08-21T00:00:00.000Z'),
    to: ms('2026-08-22T00:00:00.000Z'),
  });
  assert.equal(vazio.percent, 0);
  assert.equal(vazio.hasData, false);
});

test('posição aberta que subiu conta como movimento, mesmo sem nada encerrado', () => {
  // a curva só registra encerramento; o patrimônio de agora já traz o
  // resultado em aberto, e negar isso contradiria o número logo acima na tela
  const hoje = growthInWindow({
    points: CURVA,
    startingCapital: 100,
    currentEquity: 108,
    from: ms('2026-08-26T00:00:00.000Z'),
    to: null,
  });
  assert.equal(hoje.hasData, true);
  assert.ok(hoje.percent > 0);
});

test('carteira sem histórico não divide por zero', () => {
  const r = growthInWindow({
    points: [],
    startingCapital: 0,
    currentEquity: 0,
    from: ms('2026-08-26T00:00:00.000Z'),
    to: null,
  });
  assert.equal(r.percent, 0);
});

test('o prejuízo aparece com sinal negativo, que é o ponto do filtro', () => {
  const semana = growthInWindow({
    points: CURVA,
    startingCapital: 100,
    currentEquity: 95,
    from: ms('2026-08-24T00:00:00.000Z'),
    to: null,
  });
  assert.equal(semana.base, 100);
  assert.equal(semana.percent, -5);
});
