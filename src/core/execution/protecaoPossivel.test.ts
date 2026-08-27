import assert from 'node:assert/strict';
import test from 'node:test';
import { saidaImediataNecessaria } from './protecaoPossivel.ts';

const comprado = { stop: 90, alvo: 110, side: 'BUY' as const };

test('preço dentro da faixa deixa o OCO ser enviado', () => {
  assert.equal(saidaImediataNecessaria({ ...comprado, preco: 100 }), null);
});

test('preço no alvo pede saída a mercado — o alvo não cabe como ordem maker', () => {
  assert.equal(saidaImediataNecessaria({ ...comprado, preco: 110 }), 'ALVO_ALCANCADO');
  assert.equal(saidaImediataNecessaria({ ...comprado, preco: 115 }), 'ALVO_ALCANCADO');
});

test('preço no stop pede saída a mercado — o gatilho dispararia na hora', () => {
  assert.equal(saidaImediataNecessaria({ ...comprado, preco: 90 }), 'STOP_ALCANCADO');
  assert.equal(saidaImediataNecessaria({ ...comprado, preco: 80 }), 'STOP_ALCANCADO');
});

test('posição vendida inverte os dois lados', () => {
  const vendido = { stop: 110, alvo: 90, side: 'SELL' as const };
  assert.equal(saidaImediataNecessaria({ ...vendido, preco: 100 }), null);
  assert.equal(saidaImediataNecessaria({ ...vendido, preco: 89 }), 'ALVO_ALCANCADO');
  assert.equal(saidaImediataNecessaria({ ...vendido, preco: 111 }), 'STOP_ALCANCADO');
});

test('sem preço não há veredito — feed piscando não vende posição saudável', () => {
  assert.equal(saidaImediataNecessaria({ ...comprado, preco: null }), null);
  assert.equal(saidaImediataNecessaria({ ...comprado, preco: 0 }), null);
  assert.equal(saidaImediataNecessaria({ ...comprado, preco: Number.NaN }), null);
});

test('alvo ausente não impede a proteção; o stop continua valendo', () => {
  assert.equal(saidaImediataNecessaria({ ...comprado, alvo: 0, preco: 100 }), null);
  assert.equal(saidaImediataNecessaria({ ...comprado, alvo: 0, preco: 89 }), 'STOP_ALCANCADO');
});
