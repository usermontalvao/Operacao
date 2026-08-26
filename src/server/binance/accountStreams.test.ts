import assert from 'node:assert/strict';
import { test } from 'node:test';
import { marketsWithAccount } from './accountStreams.ts';
import { listenKeyPath, listenKeySource } from './rest.ts';

test('a chave do fluxo tem endereço próprio em cada modalidade', () => {
  // era daqui que vinha o silêncio: a chave de futuros era pedida no endpoint
  // de spot, e a execução de uma posição alavancada nunca chegava
  assert.equal(listenKeyPath('SPOT'), '/api/v3/userDataStream');
  assert.equal(listenKeyPath('FUTURES'), '/fapi/v1/listenKey');
});

test('spot pede a chave pela WebSocket API; futuros continua no REST', () => {
  // `POST /api/v3/userDataStream` responde 410 Gone: enquanto o pedido saía
  // por ali, o painel ficava sem nenhum aviso de execução em tempo real
  assert.equal(listenKeySource('SPOT', 'wss://ws-api.binance.com:443/ws-api/v3'), 'WS_API');
  assert.equal(listenKeySource('FUTURES', 'wss://ws-api.binance.com:443/ws-api/v3'), 'REST');
});

test('sem WebSocket API configurada, spot cai no REST em vez de ficar sem chave', () => {
  assert.equal(listenKeySource('SPOT', ''), 'REST');
});

test('a modalidade em exibição sempre precisa de fluxo', () => {
  assert.deepEqual(marketsWithAccount('SPOT', []), ['SPOT']);
  assert.deepEqual(marketsWithAccount('FUTURES', []), ['FUTURES']);
});

test('posição viva na outra modalidade mantém o fluxo dela aberto', () => {
  // olhar para spot não faz a posição de futuros deixar de existir — e é
  // enquanto ninguém está olhando que o preenchimento precisa ser ouvido
  const mercados = marketsWithAccount('SPOT', [{ mode: 'LIVE', market: 'FUTURES' }]);
  assert.deepEqual([...mercados].sort(), ['FUTURES', 'SPOT']);
});

test('operação de papel não abre fluxo: não há ordem na corretora', () => {
  assert.deepEqual(marketsWithAccount('SPOT', [{ mode: 'PAPER', market: 'FUTURES' }]), ['SPOT']);
});

test('operação antiga, gravada sem modalidade, conta como spot', () => {
  assert.deepEqual(marketsWithAccount('SPOT', [{ mode: 'LIVE' }]), ['SPOT']);
});
