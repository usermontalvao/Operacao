import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { LegacySettings } from '../../core/types.ts';
import { JsonStore } from '../store/jsonStore.ts';
import {
  SettingsService,
  defaultStoredSettings,
  normalizeStoredSettings,
  rejeicaoDeVarreduraVazia,
  settingsUpdateSchema,
} from './settingsService.ts';
import { DEFAULT_MICRO_SCALP } from '../../core/scalp/config.ts';

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

    await settings.update({ autoTrade: { liveArmedIndefinitely: true } });
    assert.equal(settings.get().autoTrade.liveArmedIndefinitely, true);
    assert.equal(settings.get().autoTrade.liveArmedUntil, null);

    await settings.update({ autoTrade: { enabled: false } });
    assert.equal(settings.get().autoTrade.liveArmedUntil, null);
    assert.equal(settings.get().autoTrade.liveArmedIndefinitely, false);
  } finally {
    await cleanup();
  }
});

test('futuros nasce barrado e o interruptor é quem libera a modalidade', async () => {
  const { settings, cleanup } = await servico();
  try {
    assert.equal(settings.get().futuresEnabled, false);
    assert.equal(settings.get().market, 'SPOT');

    // pedir a modalidade com o interruptor desligado não muda nada: o painel
    // não pode ficar em futuros enquanto futuros está barrado
    const barrado = await settings.update({ market: 'FUTURES' });
    assert.equal(barrado.market, 'SPOT');

    const liberado = await settings.update({ futuresEnabled: true, market: 'FUTURES' });
    assert.equal(liberado.market, 'FUTURES');
    assert.equal(liberado.futuresEnabled, true);
  } finally {
    await cleanup();
  }
});

test('barrar futuros com a tela em futuros devolve o painel para spot', async () => {
  const { settings, repository, cleanup } = await servico();
  try {
    await settings.update({ futuresEnabled: true, market: 'FUTURES' });
    const depois = await settings.update({ futuresEnabled: false });
    assert.equal(depois.market, 'SPOT');

    // e o disco não guarda o estado impossível: reiniciar não volta a futuros
    const gravado = await repository.loadSettings();
    assert.equal((gravado as { market?: string }).market, 'SPOT');
  } finally {
    await cleanup();
  }
});

test('quem já operava futuros não é barrado por uma atualização', () => {
  // o arquivo da versão anterior: já tem os baldes por modalidade, ainda não
  // tem o interruptor. Barrar quem estava em futuros seria a modalidade sumir
  // sozinha depois de uma atualização
  const anterior = { ...defaultStoredSettings(), market: 'FUTURES' as const };
  delete (anterior as { futuresEnabled?: boolean }).futuresEnabled;

  const antigo = normalizeStoredSettings(anterior);
  assert.equal(antigo.futuresEnabled, true);
  assert.equal(antigo.market, 'FUTURES');

  // e quem estava em spot continua barrado — atualizar não liga nada sozinho
  const emSpot = { ...defaultStoredSettings(), market: 'SPOT' as const };
  delete (emSpot as { futuresEnabled?: boolean }).futuresEnabled;
  assert.equal(normalizeStoredSettings(emSpot).futuresEnabled, false);
});

test('cada modalidade tem o SEU robô: ligar um não liga o outro', async () => {
  const { settings, cleanup } = await servico();
  try {
    await settings.update({ futuresEnabled: true });
    // na demo o robô já nasce ligado nas duas; desligo os dois para partir de
    // um estado conhecido
    await settings.update({ autoTrade: { enabled: false } }, { targetMarket: 'SPOT' });
    await settings.update({ autoTrade: { enabled: false } }, { targetMarket: 'FUTURES' });

    // liga o robô de futuros sem trocar a tela, que segue em spot
    await settings.update({ autoTrade: { enabled: true } }, { targetMarket: 'FUTURES' });

    assert.equal(settings.get().market, 'SPOT', 'a janela não pode ter se mexido');
    assert.equal(settings.forMode('PAPER', 'FUTURES').autoTrade.enabled, true);
    assert.equal(
      settings.forMode('PAPER', 'SPOT').autoTrade.enabled,
      false,
      'o robô de spot não pode ter sido ligado junto',
    );

    // e desligar o de futuros não devolve o de spot para o ar
    await settings.update({ autoTrade: { enabled: false } }, { targetMarket: 'FUTURES' });
    assert.equal(settings.forMode('PAPER', 'FUTURES').autoTrade.enabled, false);
    assert.equal(settings.forMode('PAPER', 'SPOT').autoTrade.enabled, false);
  } finally {
    await cleanup();
  }
});

test('o radar varre as duas modalidades — e só uma quando futuros está barrado', async () => {
  const { settings, cleanup } = await servico();
  try {
    assert.deepEqual(settings.activeMarkets(), ['SPOT']);

    await settings.update({ futuresEnabled: true });
    assert.deepEqual(settings.activeMarkets(), ['SPOT', 'FUTURES']);

    // a visão por modalidade traz o balde certo sem trocar a tela
    await settings.update({ risk: { riskPerTradePercent: 2 } }, { targetMarket: 'FUTURES' });
    assert.equal(settings.viewFor('FUTURES').risk.riskPerTradePercent, 2);
    assert.notEqual(settings.viewFor('SPOT').risk.riskPerTradePercent, 2);
    assert.equal(settings.viewFor('FUTURES').market, 'FUTURES');
    assert.equal(settings.get().market, 'SPOT');
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Só 1 minuto: desligar todos os gatilhos de tendência
// ---------------------------------------------------------------------------

test('dá para desligar 4h e ficar só com o micro scalp', () => {
  const scanner = {
    ...defaultStoredSettings().scanner,
    triggerTimeframes: [],
    microScalp: { ...DEFAULT_MICRO_SCALP, enabled: true },
  };
  assert.equal(rejeicaoDeVarreduraVazia(scanner), null);
});

test('desligar TUDO é recusado — o radar pararia de procurar', () => {
  /*
   * Cada lado pode ser desligado sozinho. Os dois juntos deixam o painel de
   * pé, conectado, com preço atualizando e nenhum detector rodando: uma tela
   * que parece viva e não procura mais nada. É o único estado que a
   * combinação não pode alcançar em silêncio.
   */
  const scanner = {
    ...defaultStoredSettings().scanner,
    triggerTimeframes: [],
    microScalp: { ...DEFAULT_MICRO_SCALP, enabled: false },
  };
  const recusa = rejeicaoDeVarreduraVazia(scanner);
  assert.ok(recusa !== null);
  assert.ok(recusa.includes('micro scalp'), recusa);
});

test('só tendência, sem micro scalp, continua válido', () => {
  const scanner = {
    ...defaultStoredSettings().scanner,
    triggerTimeframes: ['1h' as const],
    microScalp: { ...DEFAULT_MICRO_SCALP, enabled: false },
  };
  assert.equal(rejeicaoDeVarreduraVazia(scanner), null);
});

test('o schema aceita lista de gatilhos vazia', () => {
  // era `.min(1)`, que fazia sentido antes de o 1m existir: sem gatilho não
  // havia o que varrer. Hoje "nenhum gatilho de tendência" é configuração
  const parsed = settingsUpdateSchema.safeParse({ scanner: { triggerTimeframes: [] } });
  assert.equal(parsed.success, true);
});

test('o 1m continua barrado como gatilho de tendência', () => {
  // ligar o micro scalp é outro campo; aceitar '1m' aqui rodaria pullback e
  // rompimento em candle de 1 minuto, que é a ideia que a medição reprovou
  const parsed = settingsUpdateSchema.safeParse({ scanner: { triggerTimeframes: ['1m'] } });
  assert.equal(parsed.success, false);
});
