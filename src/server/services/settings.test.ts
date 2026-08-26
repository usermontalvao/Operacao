import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { LegacySettings } from '../../core/types.ts';
import { JsonStore } from '../store/jsonStore.ts';
import { SettingsService, normalizeStoredSettings } from './settingsService.ts';

async function servico() {
  const directory = await mkdtemp(join(tmpdir(), 'hunter-settings-'));
  const repository = new JsonStore(directory);
  await repository.init();
  const settings = new SettingsService(repository);
  await settings.load();
  return { settings, repository, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('o robô ligado no demo NÃO chega ligado na conta real', async () => {
  const { settings, cleanup } = await servico();
  try {
    await settings.update({ mode: 'PAPER', autoTrade: { enabled: true } });
    assert.equal(settings.get().autoTrade.enabled, true);

    await settings.update({ mode: 'LIVE' });
    assert.equal(settings.get().mode, 'LIVE');
    assert.equal(
      settings.get().autoTrade.enabled,
      false,
      'a conta real herdou o interruptor do demo',
    );

    // e a volta também: o demo continua como estava
    await settings.update({ mode: 'PAPER' });
    assert.equal(settings.get().autoTrade.enabled, true);
  } finally {
    await cleanup();
  }
});

test('capital e disjuntor são de cada conta; a watchlist é das três', async () => {
  const { settings, cleanup } = await servico();
  try {
    await settings.update({
      mode: 'PAPER',
      risk: { paperCapital: 5000 },
      guard: { maxDailyTrades: 20 },
      scanner: { watchlist: ['BTCUSDT', 'ETHUSDT'] },
    });
    await settings.update({ mode: 'TESTNET', risk: { paperCapital: 200 }, guard: { maxDailyTrades: 3 } });

    assert.equal(settings.get().risk.paperCapital, 200);
    assert.equal(settings.get().guard.maxDailyTrades, 3);
    assert.deepEqual(settings.get().scanner.watchlist, ['BTCUSDT', 'ETHUSDT']);

    await settings.update({ mode: 'PAPER' });
    assert.equal(settings.get().risk.paperCapital, 5000);
    assert.equal(settings.get().guard.maxDailyTrades, 20);
    assert.deepEqual(settings.get().scanner.watchlist, ['BTCUSDT', 'ETHUSDT']);
  } finally {
    await cleanup();
  }
});

test('parar o disjuntor de um modo não silencia o do outro', async () => {
  const { settings, cleanup } = await servico();
  const ate = new Date(Date.now() + 3_600_000).toISOString();
  try {
    await settings.update({ mode: 'PAPER', guard: { mutedUntil: ate } });
    await settings.update({ mode: 'TESTNET' });
    assert.equal(settings.get().guard.mutedUntil, null);
    await settings.update({ mode: 'PAPER' });
    assert.equal(settings.get().guard.mutedUntil, ate);
  } finally {
    await cleanup();
  }
});

test('a separação sobrevive ao reinício do servidor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hunter-settings-'));
  try {
    const primeiro = new JsonStore(directory);
    await primeiro.init();
    const antes = new SettingsService(primeiro);
    await antes.load();
    await antes.update({ mode: 'TESTNET', risk: { paperCapital: 777 } });
    await antes.update({ mode: 'PAPER', risk: { paperCapital: 111 } });
    await primeiro.flush();

    const segundo = new JsonStore(directory);
    await segundo.init();
    const depois = new SettingsService(segundo);
    await depois.load();
    assert.equal(depois.get().risk.paperCapital, 111);
    assert.equal(depois.forMode('TESTNET').risk.paperCapital, 777);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('o ajuste do formato antigo volta para o modo que estava na tela', () => {
  const antigo: LegacySettings = {
    mode: 'TESTNET',
    risk: { paperCapital: 4242 } as LegacySettings['risk'],
    scanner: { watchlist: ['SOLUSDT'] } as LegacySettings['scanner'],
    autoTrade: { enabled: true, minimumScore: 97 } as LegacySettings['autoTrade'],
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  const convertido = normalizeStoredSettings(antigo);

  assert.equal(convertido.mode, 'TESTNET');
  // arquivo daquela época é de antes dos futuros: o que ele guarda é spot
  assert.equal(convertido.market, 'SPOT');
  assert.equal(convertido.byMarket.SPOT.TESTNET.risk.paperCapital, 4242);
  assert.equal(convertido.byMarket.SPOT.TESTNET.autoTrade.minimumScore, 97);
  assert.deepEqual(convertido.scanner.watchlist, ['SOLUSDT']);

  // os outros modos começam do padrão: números pensados para a conta de teste
  // não podem virar, sozinhos, os números da conta real
  assert.notEqual(convertido.byMarket.SPOT.LIVE.risk.paperCapital, 4242);
  assert.equal(convertido.byMarket.SPOT.LIVE.autoTrade.enabled, false);

  // e futuros não herda nada: o capital do spot não vira capital alavancado
  assert.notEqual(convertido.byMarket.FUTURES.TESTNET.risk.paperCapital, 4242);
});

test('desligar o robô desarma a conta real só do modo mexido', async () => {
  const { settings, cleanup } = await servico();
  const ate = new Date(Date.now() + 600_000).toISOString();
  try {
    await settings.update({ mode: 'LIVE', autoTrade: { allowLive: true, enabled: true } });
    await settings.update({ autoTrade: { liveArmedUntil: ate } });
    assert.equal(settings.get().autoTrade.liveArmedUntil, ate);

    await settings.update({ autoTrade: { enabled: false } });
    assert.equal(settings.get().autoTrade.liveArmedUntil, null);
  } finally {
    await cleanup();
  }
});
