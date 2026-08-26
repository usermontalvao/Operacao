import assert from 'node:assert/strict';
import test from 'node:test';
import { environmentFor, environmentForPath, setActiveEnvironment } from './rest.ts';

/**
 * A regra que impedia spot e futuros de coexistirem.
 *
 * Havia UM ambiente ativo, e toda chamada assinada ia para ele. Com o painel
 * em futuros, reconciliar uma posição de spot mandava `/api/v3/order` para
 * `fapi.binance.com`: erro, e a operação parada no tempo sem ninguém saber.
 */

test('o caminho decide a corretora — spot continua indo para spot com futuros na tela', () => {
  setActiveEnvironment('futures-production');

  assert.equal(environmentForPath('/api/v3/order').market, 'SPOT');
  assert.equal(environmentForPath('/api/v3/orderList').market, 'SPOT');
  assert.equal(environmentForPath('/fapi/v1/order').market, 'FUTURES');
  assert.equal(environmentForPath('/fapi/v2/balance').market, 'FUTURES');

  // e o endereço é mesmo outro: é isso que a assinatura errada não mostrava
  assert.notEqual(
    environmentForPath('/api/v3/order').tradeRestBase,
    environmentForPath('/fapi/v1/order').tradeRestBase,
  );
});

test('trocar de modalidade NUNCA troca de rede: testnet não vira produção', () => {
  setActiveEnvironment('futures-testnet');

  // o irmão de spot do testnet de futuros é o testnet de spot — jamais a
  // produção. Conferir ordem de dinheiro real numa conta de brincadeira (ou o
  // contrário) seria o erro mais caro que este módulo pode cometer
  assert.equal(environmentFor('SPOT').network, 'testnet');
  assert.equal(environmentFor('FUTURES').network, 'testnet');
  assert.equal(environmentForPath('/api/v3/order').network, 'testnet');

  setActiveEnvironment('production');
  assert.equal(environmentFor('SPOT').network, 'production');
  assert.equal(environmentFor('FUTURES').network, 'production');
  assert.equal(environmentFor('FUTURES').market, 'FUTURES');
});
