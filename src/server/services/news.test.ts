import assert from 'node:assert/strict';
import test from 'node:test';
import type { SymbolFilters } from '../../core/types.ts';
import { NewsService } from './newsService.ts';

const NOW = new Date('2026-08-25T12:00:00.000Z');

function pair(symbol: string, overrides: Partial<SymbolFilters> = {}): SymbolFilters {
  return {
    symbol,
    baseAsset: symbol.replace('USDT', ''),
    quoteAsset: 'USDT',
    status: 'TRADING',
    tickSize: 0.01,
    stepSize: 0.001,
    minQty: 0.001,
    maxQty: 100000,
    minNotional: 5,
    applyMinToMarket: true,
    baseAssetPrecision: 8,
    quotePrecision: 8,
    isSpotTradingAllowed: true,
    ocoAllowed: true,
    market: 'SPOT',
    ...overrides,
  };
}

/** Cada chamada devolve a próxima lista da fila; a última se repete. */
function fetcherOf(...leituras: SymbolFilters[][]) {
  let index = 0;
  return async () => {
    const current = leituras[Math.min(index, leituras.length - 1)] ?? [];
    index += 1;
    return current;
  };
}

test('par suspenso na corretora bloqueia — e o bloqueio some sozinho quando ele volta', async () => {
  const news = new NewsService(
    fetcherOf([pair('SOLUSDT'), pair('XRPUSDT', { status: 'BREAK' })], [pair('SOLUSDT'), pair('XRPUSDT')]),
  );

  await news.refresh(NOW);
  assert.equal(news.verdict('XRPUSDT', NOW).blocked, true);
  assert.equal(news.verdict('SOLUSDT', NOW).blocked, false);

  await news.refresh(NOW);
  assert.equal(
    news.verdict('XRPUSDT', NOW).blocked,
    false,
    'estado é recalculado do zero: ninguém precisa retirar o bloqueio',
  );
});

test('par que sai da lista continua bloqueado nas leituras seguintes', async () => {
  const news = new NewsService(
    fetcherOf([pair('SOLUSDT'), pair('XRPUSDT')], [pair('SOLUSDT')], [pair('SOLUSDT')]),
  );

  await news.refresh(NOW);
  assert.equal(news.verdict('XRPUSDT', NOW).blocked, false, 'a primeira leitura não tem com o que comparar');

  await news.refresh(NOW);
  assert.equal(news.verdict('XRPUSDT', NOW).blocked, true);

  await news.refresh(NOW);
  assert.equal(
    news.verdict('XRPUSDT', NOW).blocked,
    true,
    'a deslistagem é notícia: ela não está visível em leitura nenhuma depois',
  );
});

test('falha de leitura não libera o que já estava bloqueado', async () => {
  let leitura = 0;
  const news = new NewsService(async () => {
    leitura += 1;
    if (leitura === 1) return [pair('SOLUSDT'), pair('XRPUSDT', { status: 'HALT' })];
    throw new Error('Binance indisponível');
  });

  await news.refresh(NOW);
  assert.equal(news.verdict('XRPUSDT', NOW).blocked, true);

  await news.refresh(NOW);
  assert.equal(news.verdict('XRPUSDT', NOW).blocked, true);
  assert.match(news.getStatus(NOW).lastError ?? '', /indisponível/);
});

test('lista vazia é falha de leitura, não mercado sem pares', async () => {
  const news = new NewsService(fetcherOf([pair('SOLUSDT'), pair('XRPUSDT')], [], []));
  await news.refresh(NOW);
  await news.refresh(NOW);
  await news.refresh(NOW);
  assert.equal(
    news.verdict('XRPUSDT', NOW).blocked,
    false,
    'a leitura vazia não pode virar uma deslistagem do mercado inteiro',
  );
});

test('trocar de ambiente esquece a lista anterior', async () => {
  const news = new NewsService(fetcherOf([pair('SOLUSDT'), pair('XRPUSDT')], [pair('SOLUSDT')]));
  await news.refresh(NOW);
  news.reset();
  await news.refresh(NOW);
  assert.equal(
    news.verdict('XRPUSDT', NOW).blocked,
    false,
    'o testnet tem outra lista: comparar as duas inventaria deslistagens',
  );
});

test('o painel mostra os bloqueados e quando a leitura foi feita', async () => {
  const news = new NewsService(fetcherOf([pair('SOLUSDT'), pair('XRPUSDT', { status: 'BREAK' })]));
  await news.refresh(NOW);
  const status = news.getStatus(NOW);
  assert.deepEqual(status.blockedSymbols, ['XRPUSDT']);
  assert.equal(status.lastRefreshAt, NOW.toISOString());
  assert.equal(status.lastError, null);
  assert.equal(status.events.length, 1);
});
