import { getTickers, listTradableSymbols } from '../binance/rest.ts';
import { logger } from '../logger.ts';

/** Stablecoins e tokens alavancados não servem para este tipo de setup. */
const EXCLUDED_BASES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'EUR', 'GBP', 'AEUR', 'USDP', 'PAX', 'USD1', 'XUSD',
  'RLUSD', 'USDE', 'USDF', 'USDS', 'EURI', 'PYUSD', 'LDUSDT',
  'BRL', 'TRY', 'ARS', 'JPY', 'PLN', 'RON', 'ZAR', 'MXN', 'COP', 'CZK', 'UAH',
]);

const LEVERAGED = /(UP|DOWN|BULL|BEAR)$/;

export interface CuratedOptions {
  limit?: number;
  minQuoteVolume24h?: number;
}

/**
 * Monta a watchlist com os pares que realmente dá para operar: spot em USDT,
 * negociando agora e com volume de verdade. Sem stablecoin contra stablecoin
 * e sem token alavancado.
 */
export async function buildCuratedWatchlist(options: CuratedOptions = {}): Promise<string[]> {
  const limit = options.limit ?? 30;
  const minVolume = options.minQuoteVolume24h ?? 20_000_000;

  const universe = await listTradableSymbols('USDT');
  const eligible = universe.filter(
    (item) => !EXCLUDED_BASES.has(item.baseAsset) && !LEVERAGED.test(item.baseAsset),
  );
  const tickers = await getTickers(eligible.map((item) => item.symbol));

  const ranked = tickers
    .map((ticker) => ({ symbol: ticker.symbol, volume: Number(ticker.quoteVolume) }))
    .filter((item) => item.volume >= minVolume)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, limit)
    .map((item) => item.symbol);

  const withBtc = ranked.includes('BTCUSDT') ? ranked : ['BTCUSDT', ...ranked].slice(0, limit);
  logger.info('Watchlist curada montada', { pares: withBtc.length, volumeMinimo: minVolume });
  return withBtc;
}
