import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_COSTS } from './costs.ts';
import { sizeByRisk } from './sizeByRisk.ts';

/**
 * O beco sem saída da conta pequena.
 *
 * Caso real de 26/08/2026: US$ 24,36 de patrimônio, orçamento de 1% de risco,
 * stop a 6,1% da entrada. A conta dá uma posição de US$ 3,70 — e a Binance não
 * aceita ordem abaixo de US$ 5. O painel dizia "Operação bloqueada" mostrando
 * o mínimo da corretora, que é intransponível, quando o que estava apertando
 * era o teto de risco, que é regra nossa e negociável.
 */
const BASE = {
  entryPrice: 0.09255,
  stopLoss: 0.086892,
  equity: 24.36,
  available: 24.36,
  riskPerTradePercent: 1,
  maxPositionPercent: 25,
  maxNotional: Number.POSITIVE_INFINITY,
  costs: DEFAULT_COSTS,
  stepSize: 0.1,
};

test('sem o piso, o orçamento de risco deixa a ordem abaixo do mínimo da Binance', () => {
  const sem = sizeByRisk(BASE);
  assert.equal(sem.boundBy, 'RISK_BUDGET');
  assert.ok(sem.notional < 5, `a posição saiu em ${sem.notional}, e a Binance recusa abaixo de 5`);
});

test('com o piso, a ordem sobe até o mínimo negociável', () => {
  const com = sizeByRisk({ ...BASE, minNotional: 5 });
  assert.equal(com.boundBy, 'EXCHANGE_MINIMUM');
  assert.ok(com.notional >= 5, `a posição precisa alcançar 5, veio ${com.notional}`);
});

test('o risco extra fica VISÍVEL — é ele que a confirmação vai liberar', () => {
  const com = sizeByRisk({ ...BASE, minNotional: 5 });
  // o painel transforma isto num bloqueio negociável ("acima do teto"), que a
  // confirmação desarma; esconder o número seria o erro
  assert.ok(
    com.riskPercentOfEquity > BASE.riskPerTradePercent,
    `o piso arrisca ${com.riskPercentOfEquity}%, acima do teto de ${BASE.riskPerTradePercent}%`,
  );
});

test('o piso arredonda para CIMA no passo de lote', () => {
  // arredondar para baixo cairia de novo abaixo do mínimo, que é o erro que o
  // piso existe justamente para evitar
  const com = sizeByRisk({ ...BASE, minNotional: 5 });
  const passos = com.quantity / BASE.stepSize;
  assert.ok(Math.abs(passos - Math.round(passos)) < 1e-6, 'a quantidade tem de casar com o passo');
  assert.ok(com.quantity * BASE.entryPrice >= 5);
});

test('saldo insuficiente continua sendo intransponível', () => {
  // o piso não inventa dinheiro: com US$ 3 na conta, nem o mínimo cabe
  const pobre = sizeByRisk({ ...BASE, equity: 3, available: 3, minNotional: 5 });
  assert.notEqual(pobre.boundBy, 'EXCHANGE_MINIMUM');
  assert.ok(pobre.notional < 5);
});

test('quando o orçamento já alcança o mínimo, o piso não muda nada', () => {
  const folgado = { ...BASE, equity: 500, available: 500 };
  const sem = sizeByRisk(folgado);
  const com = sizeByRisk({ ...folgado, minNotional: 5 });
  assert.equal(com.quantity, sem.quantity);
  assert.equal(com.boundBy, sem.boundBy);
});
