import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  moedaBaseDoPar,
  quantidadeQueEntrou,
  quantidadeVendavel,
  restoEhPo,
} from './posicaoReal.ts';

const JASMY = { stepSize: 0.1, minQty: 0.1, minNotional: 5 };

test('a taxa cobrada na moeda comprada sai da posição em mãos', () => {
  // o caso real de 26/08/2026: comprou 1158,1 JASMY, entraram 1156,94 —
  // e pedir 1158,1 de volta fez a corretora recusar TODA ordem de venda
  const emMaos = quantidadeQueEntrou({
    preenchida: 1158.1,
    comissao: 1.1581,
    moedaDaComissao: 'JASMY',
    moedaBase: 'JASMY',
  });
  assert.equal(Number(emMaos.toFixed(4)), 1156.9419);
});

test('taxa paga em BNB ou em USDT não encolhe a posição', () => {
  // sai de outro bolso: descontar aqui inventaria uma perda que não houve
  const comBnb = quantidadeQueEntrou({
    preenchida: 1158.1,
    comissao: 0.002,
    moedaDaComissao: 'BNB',
    moedaBase: 'JASMY',
  });
  assert.equal(comBnb, 1158.1);
  const comUsdt = quantidadeQueEntrou({
    preenchida: 1158.1,
    comissao: 0.0055,
    moedaDaComissao: 'USDT',
    moedaBase: 'JASMY',
  });
  assert.equal(comUsdt, 1158.1);
});

test('sem informação de taxa, a posição é a preenchida', () => {
  const semTaxa = quantidadeQueEntrou({
    preenchida: 500,
    comissao: 0,
    moedaDaComissao: null,
    moedaBase: 'ARB',
  });
  assert.equal(semTaxa, 500);
});

test('a moeda comprada sai do nome do par', () => {
  assert.equal(moedaBaseDoPar('JASMYUSDT'), 'JASMY');
  assert.equal(moedaBaseDoPar('BTCUSDT'), 'BTC');
  assert.equal(moedaBaseDoPar('ETHBTC'), 'ETH');
  // sufixo desconhecido não vira palpite: string vazia significa "não desconte"
  assert.equal(moedaBaseDoPar('ALGOXYZ'), '');
});

test('a venda nunca pede mais do que a carteira tem', () => {
  // pedir a mais não devolve uma venda menor: devolve recusa — e recusa aqui
  // é posição sem stop na conta real
  assert.equal(quantidadeVendavel(1158.1, 1156.9419, 0.1), 1156.9);
  assert.equal(quantidadeVendavel(100, 500, 0.1), 100);
  assert.equal(quantidadeVendavel(100, 0, 0.1), 0);
});

test('o resto abaixo do mínimo da corretora é pó, e pó encerra a operação', () => {
  // 1,2 JASMY a 0,00476 valem meio centavo: nenhuma ordem aceita isso
  assert.equal(restoEhPo(1.2, 0.00476, JASMY), true);
  assert.equal(restoEhPo(0.05, 0.00476, JASMY), true, 'abaixo do mínimo de lote');
  assert.equal(restoEhPo(0, 0.00476, JASMY), true);
});

test('posição de verdade não é confundida com pó', () => {
  assert.equal(restoEhPo(1156.9, 0.00476, JASMY), false);
});
