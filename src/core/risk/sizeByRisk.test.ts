import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_COSTS } from './costs.ts';
import { sizeByRisk } from './sizeByRisk.ts';

const BASE = {
  equity: 10_000,
  available: 10_000,
  riskPerTradePercent: 1,
  maxPositionPercent: 100,
  maxNotional: 1_000_000,
  costs: DEFAULT_COSTS,
};

test('o risco no stop respeita o teto por operação — stop curto', () => {
  const resultado = sizeByRisk({ ...BASE, entryPrice: 100, stopLoss: 99 });
  assert.equal(resultado.blocked, false);
  assert.ok(
    resultado.riskAmount <= 100.01,
    `arriscou ${resultado.riskAmount} com orçamento de 100`,
  );
  assert.equal(resultado.boundBy, 'RISK_BUDGET');
});

test('stop largo devolve posição MENOR, não risco maior', () => {
  const curto = sizeByRisk({ ...BASE, entryPrice: 100, stopLoss: 99 });
  const largo = sizeByRisk({ ...BASE, entryPrice: 100, stopLoss: 80 });

  assert.ok(largo.quantity < curto.quantity, 'stop largo deveria comprar menos');
  // o que precisa ficar IGUAL é o prejuízo, não o tamanho
  assert.ok(Math.abs(largo.riskAmount - curto.riskAmount) < 0.5);
  assert.ok(largo.riskAmount <= 100.01);
});

test('MOMENTUM_BURST com stop largo: 1% de risco continua 1%', () => {
  // explosão típica: entrada esticada e stop na mínima do movimento, longe
  const resultado = sizeByRisk({
    ...BASE,
    entryPrice: 0.0010958,
    stopLoss: 0.00092,
    maxNotional: 50,
  });
  assert.equal(resultado.blocked, false);
  assert.ok(resultado.riskPercentOfEquity <= 1.01, `arriscou ${resultado.riskPercentOfEquity}%`);

  // e o teto por ordem é quem manda aqui, porque 1% de 10.000 compraria mais
  // do que 50 USDT permitem
  assert.equal(resultado.boundBy, 'MAX_NOTIONAL');
  assert.ok(resultado.notional <= 50.01);
});

test('taxa e escorregamento entram no risco — o bruto subestima', () => {
  const resultado = sizeByRisk({ ...BASE, entryPrice: 100, stopLoss: 95 });
  assert.ok(
    resultado.perUnitLoss > resultado.grossPerUnitLoss,
    'o prejuízo com custos tem de ser maior que entrada menos stop',
  );
  // stop em 95 com 0,15% de escorregamento preenche em ~94,86; some 0,1% de
  // taxa nas duas pontas
  assert.ok(resultado.stopFill < 95);
  assert.ok(resultado.grossRiskAmount < resultado.riskAmount);
});

test('sem custos no cálculo, a posição arriscaria acima do teto', () => {
  // prova do bug antigo: dimensionar por (entrada - stop) puro e depois
  // aplicar os custos reais estoura o orçamento
  const entryPrice = 100;
  const stopLoss = 99.5;
  const orcamento = BASE.equity * (BASE.riskPerTradePercent / 100);

  const quantidadeIngenua = orcamento / (entryPrice - stopLoss);
  const comCustos = sizeByRisk({ ...BASE, entryPrice, stopLoss });
  const prejuizoRealDaIngenua = quantidadeIngenua * comCustos.perUnitLoss;

  assert.ok(
    prejuizoRealDaIngenua > orcamento,
    'o cálculo sem custos deveria estourar o orçamento',
  );
  assert.ok(comCustos.riskAmount <= orcamento + 0.01);
});

test('stop acima da entrada é recusado, não dimensionado', () => {
  const resultado = sizeByRisk({ ...BASE, entryPrice: 100, stopLoss: 100.5 });
  assert.equal(resultado.blocked, true);
  assert.equal(resultado.quantity, 0);
});

test('stop muito curto vira posição grande, contida pelo teto de posição', () => {
  // a corretagem nunca anula a distância até o stop — ela soma ao prejuízo.
  // O perigo do stop curto não é risco negativo, é tamanho: quem segura é o
  // maxPositionPercent, e o risco continua dentro do orçamento.
  const resultado = sizeByRisk({
    ...BASE,
    entryPrice: 100,
    stopLoss: 99.9,
    maxPositionPercent: 25,
  });
  assert.equal(resultado.blocked, false);
  assert.ok(resultado.perUnitLoss > resultado.grossPerUnitLoss);
  assert.equal(resultado.boundBy, 'MAX_POSITION_PERCENT');
  assert.ok(resultado.riskAmount <= 100.01);
});

test('o escorregamento AFASTA o preenchimento do stop, aumentando o prejuízo', () => {
  const semEscorregamento = sizeByRisk({
    ...BASE,
    entryPrice: 100,
    stopLoss: 95,
    costs: { feePercent: 0.1, stopSlippagePercent: 0, exitSlippagePercent: 0 },
  });
  const comEscorregamento = sizeByRisk({ ...BASE, entryPrice: 100, stopLoss: 95 });

  assert.ok(comEscorregamento.stopFill < semEscorregamento.stopFill);
  assert.ok(comEscorregamento.perUnitLoss > semEscorregamento.perUnitLoss);
  // e por isso compra MENOS para manter o mesmo prejuízo aceito
  assert.ok(comEscorregamento.quantity < semEscorregamento.quantity);
});

test('o stepSize arredonda para baixo e nunca aumenta o risco', () => {
  const sem = sizeByRisk({ ...BASE, entryPrice: 100, stopLoss: 90 });
  const com = sizeByRisk({ ...BASE, entryPrice: 100, stopLoss: 90, stepSize: 1 });

  assert.ok(com.quantity <= sem.quantity);
  assert.ok(com.riskAmount <= sem.riskAmount);
  assert.equal(com.quantity, Math.floor(sem.quantity));
});

test('saldo insuficiente limita a quantidade e diz que foi o saldo', () => {
  const resultado = sizeByRisk({ ...BASE, entryPrice: 100, stopLoss: 90, available: 30 });
  assert.equal(resultado.boundBy, 'AVAILABLE_BALANCE');
  assert.ok(resultado.notional <= 30.01);
});

test('maxPositionPercent limita quando o stop é muito curto', () => {
  // stop a 0,2% deixaria o risco comprar uma posição gigante
  const resultado = sizeByRisk({
    ...BASE,
    entryPrice: 100,
    stopLoss: 99.8,
    maxPositionPercent: 25,
  });
  assert.equal(resultado.boundBy, 'MAX_POSITION_PERCENT');
  assert.ok(resultado.notional <= 2_500.01);
  assert.ok(resultado.riskAmount <= 100.01);
});

test('sem saldo não há posição', () => {
  const resultado = sizeByRisk({ ...BASE, entryPrice: 100, stopLoss: 90, available: 0 });
  assert.equal(resultado.blocked, true);
  assert.equal(resultado.quantity, 0);
});

test('regime nervoso encolhe a posição e o risco junto', () => {
  const cheio = sizeByRisk({ ...BASE, entryPrice: 100, stopLoss: 90 });
  const meio = sizeByRisk({ ...BASE, entryPrice: 100, stopLoss: 90, sizeFactor: 0.5 });

  assert.ok(Math.abs(meio.quantity - cheio.quantity / 2) < 1e-6);
  assert.ok(meio.riskAmount < cheio.riskAmount);
});

test('o valor pedido pelo usuário nunca supera o orçamento de risco', () => {
  const resultado = sizeByRisk({
    ...BASE,
    entryPrice: 100,
    stopLoss: 90,
    requestedQuote: 9_000,
  });
  assert.equal(resultado.boundBy, 'RISK_BUDGET');
  assert.ok(resultado.riskAmount <= 100.01);
  assert.ok(resultado.notional < 9_000);
});

test('pedido pequeno manda quando cabe dentro do risco', () => {
  const resultado = sizeByRisk({
    ...BASE,
    entryPrice: 100,
    stopLoss: 90,
    requestedQuote: 200,
  });
  assert.equal(resultado.boundBy, 'REQUESTED');
  assert.ok(resultado.notional <= 200.01);
});
