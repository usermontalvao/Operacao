import assert from 'node:assert/strict';
import test from 'node:test';
import { activeSessionModes, isSessionActive } from './sessions.ts';

test('olhar a conta real não desliga o robô do demo', () => {
  const sessoes = activeSessionModes('LIVE');
  assert.ok(sessoes.includes('PAPER'), 'o demo tem de continuar operando');
  assert.ok(sessoes.includes('LIVE'));
});

test('olhar o demo não desliga o robô da conta real', () => {
  const sessoes = activeSessionModes('PAPER');
  assert.ok(sessoes.includes('LIVE'));
  assert.ok(sessoes.includes('PAPER'));
});

test('PAPER e LIVE convivem porque leem os mesmos endpoints', () => {
  assert.deepEqual(activeSessionModes('PAPER'), activeSessionModes('LIVE'));
});

test('TESTNET é exclusivo: outra fonte de preço não convive com produção', () => {
  const sessoes = activeSessionModes('TESTNET');
  assert.deepEqual(sessoes, ['TESTNET']);
  assert.equal(isSessionActive('TESTNET', 'PAPER'), false);
  assert.equal(isSessionActive('TESTNET', 'LIVE'), false);
});

test('entrar no testnet suspende as outras sessões, e sair as devolve', () => {
  assert.equal(isSessionActive('PAPER', 'LIVE'), true);
  assert.equal(isSessionActive('TESTNET', 'LIVE'), false);
  assert.equal(isSessionActive('LIVE', 'PAPER'), true);
});
