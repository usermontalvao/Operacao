import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analysisFrom, candlesFromPath, uptrendWithPullback } from '../../core/testing/fixtures.ts';
import { EventBus } from '../events.ts';
import { JsonStore } from '../store/jsonStore.ts';
import { AlertEngine } from './alertEngine.ts';
import { AuditService } from './auditService.ts';
import type { MarketDataService } from './marketDataService.ts';
import { PaperTradingEngine } from './paperTradingEngine.ts';
import { ScannerService } from './scannerService.ts';
import { SettingsService } from './settingsService.ts';

const CANDLES = candlesFromPath(uptrendWithPullback());

/** A mesma tese, sempre: é o que a varredura reencontra a cada volta. */
function analysis(price?: number) {
  return analysisFrom('XRPUSDT', CANDLES, ['15m', '1h', '4h', '1d'], price);
}

async function harness(cooldownMinutes = 120) {
  const directory = await mkdtemp(join(tmpdir(), 'hunter-scanner-'));
  const repository = new JsonStore(directory);
  await repository.init();
  const settings = new SettingsService(repository);
  await settings.load();
  await settings.update({ scanner: { watchlist: [], cooldownMinutes } });

  const bus = new EventBus();
  const audit = new AuditService(repository);
  const alerts = new AlertEngine(repository, bus);
  const paper = new PaperTradingEngine(repository, bus, audit, settings);
  const market = {
    getAnalysis: () => null,
    getSymbols: () => [],
    setSymbols: async () => {},
    getSnapshot: () => null,
    getPrice: () => null,
    isAvailable: () => true,
    on: () => {},
  } as unknown as MarketDataService;

  const build = () =>
    new ScannerService(market, repository, settings, bus, alerts, paper, audit);

  return {
    repository,
    build,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('setup dispensado não renasce na varredura seguinte', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  const scanner = context.build();
  t.after(() => scanner.stop());
  await scanner.start();

  await scanner.ingest(analysis());
  const born = scanner.getSetups();
  assert.ok(born.length > 0, 'a tese precisa nascer antes de morrer');
  const fingerprint = (born[0] as { fingerprint: string }).fingerprint;

  for (const setup of born) await scanner.ignoreSetup(setup.id);
  assert.equal(scanner.getSetups().length, 0);

  await scanner.ingest(analysis());
  assert.equal(scanner.getSetups().length, 0, 'a tese dispensada voltou à tela');

  const stored = await context.repository.listSetups();
  const copies = stored.filter((setup) => setup.fingerprint === fingerprint);
  assert.equal(copies.length, born.filter((s) => s.fingerprint === fingerprint).length,
    'a mesma tese foi gravada duas vezes em disco');
});

test('tese invalidada pelo preço não é recriada dentro do cooldown', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  const scanner = context.build();
  t.after(() => scanner.stop());
  await scanner.start();

  await scanner.ingest(analysis());
  const born = scanner.getSetups();
  assert.ok(born.length > 0);
  const stop = Math.min(...born.map((setup) => setup.stopLoss));

  // preço perde o stop: a tese morre
  await scanner.ingest(analysis(stop * 0.9));
  assert.equal(scanner.getSetups().length, 0, 'o setup precisa ser invalidado');

  const afterDeath = (await context.repository.listSetups()).length;
  await scanner.ingest(analysis());
  await scanner.ingest(analysis());
  await scanner.ingest(analysis());

  assert.equal(scanner.getSetups().length, 0, 'a tese invalidada renasceu');
  assert.equal(
    (await context.repository.listSetups()).length,
    afterDeath,
    'três varreduras depois, o disco não pode ter crescido',
  );
});

test('a lembrança sobrevive ao reinício do servidor', async (t) => {
  const context = await harness();
  t.after(context.cleanup);

  const first = context.build();
  await first.start();
  await first.ingest(analysis());
  const born = first.getSetups();
  assert.ok(born.length > 0);
  for (const setup of born) await first.ignoreSetup(setup.id);
  first.stop();

  // servidor reinicia: só o disco sobra
  const second = context.build();
  t.after(() => second.stop());
  await second.start();
  await second.ingest(analysis());

  assert.equal(second.getSetups().length, 0, 'o reinício ressuscitou a tese dispensada');
});

test('sem cooldown configurado a tese pode voltar — o filtro não é permanente', async (t) => {
  const context = await harness(0);
  t.after(context.cleanup);
  const scanner = context.build();
  t.after(() => scanner.stop());
  await scanner.start();

  await scanner.ingest(analysis());
  const born = scanner.getSetups();
  assert.ok(born.length > 0);
  for (const setup of born) await scanner.ignoreSetup(setup.id);

  await scanner.ingest(analysis());
  assert.ok(scanner.getSetups().length > 0, 'com cooldown zero a tese volta a ser oferecida');
});
