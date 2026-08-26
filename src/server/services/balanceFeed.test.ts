import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Trade } from '../../core/types.ts';
import { EventBus, type ServerEvent } from '../events.ts';
import { BalanceFeed } from './balanceFeed.ts';
import type { ExecutionService } from './executionService.ts';
import type { SettingsService } from './settingsService.ts';

function operacao(patch: Partial<Trade> = {}): Trade {
  return {
    id: 'op-1',
    status: 'OPEN',
    filledQuantity: 10,
    remainingQuantity: 10,
    realizedPnl: 0,
    feesPaid: 0.01,
    notional: 100,
    // o resto da operação não participa da decisão; o tipo é largo de propósito
    ...patch,
  } as Trade;
}

function bancada(capital = 250): {
  bus: EventBus;
  feed: BalanceFeed;
  eventos: ServerEvent[];
  leituras: () => number;
} {
  const bus = new EventBus();
  const eventos: ServerEvent[] = [];
  bus.observe((event) => eventos.push(event));
  let leituras = 0;
  const execution = {
    getCapital: async () => {
      leituras += 1;
      return { capital, available: capital, source: 'BINANCE', currency: 'USDT', brlRate: 5 };
    },
  } as unknown as ExecutionService;
  const settings = {
    get: () => ({ mode: 'LIVE', market: 'SPOT' }),
  } as unknown as SettingsService;
  return { bus, feed: new BalanceFeed(execution, settings, bus), eventos, leituras: () => leituras };
}

test('o saldo vai para a tela com o número que veio da conta', async () => {
  const { feed, eventos } = bancada(250);
  await feed.push();
  const saldo = eventos.find((event) => event.type === 'balance');
  assert.ok(saldo, 'nenhum evento de saldo foi ao ar');
  assert.equal(saldo.payload.capital, 250);
  assert.equal(saldo.payload.mode, 'LIVE');
  assert.equal(saldo.payload.market, 'SPOT');
});

test('operação repetida sem novidade financeira não pede saldo de novo', () => {
  // no DEMO o aviso de operação sai a cada tique que renova o topo do preço:
  // reagir a todos viraria uma leitura de conta várias vezes por segundo
  const { feed } = bancada();
  assert.equal(feed.mexeuNoDinheiro(operacao()), true, 'a primeira vez sempre conta');
  assert.equal(feed.mexeuNoDinheiro(operacao()), false);
  assert.equal(feed.mexeuNoDinheiro(operacao()), false);
});

test('preenchimento, resultado e encerramento contam como dinheiro novo', () => {
  const { feed } = bancada();
  feed.mexeuNoDinheiro(operacao({ status: 'PENDING', filledQuantity: 0, remainingQuantity: 0 }));
  assert.equal(feed.mexeuNoDinheiro(operacao({ status: 'OPEN' })), true, 'a ordem preencheu');
  assert.equal(feed.mexeuNoDinheiro(operacao({ realizedPnl: 3 })), true, 'saiu resultado');
  assert.equal(
    feed.mexeuNoDinheiro(operacao({ status: 'CLOSED', realizedPnl: 3, remainingQuantity: 0 })),
    true,
    'a posição encerrou',
  );
});

test('uma leitura por rajada: cinco avisos juntos não viram cinco consultas', async () => {
  const { feed, leituras } = bancada();
  feed.schedule();
  feed.schedule();
  feed.schedule();
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(leituras(), 1);
});
