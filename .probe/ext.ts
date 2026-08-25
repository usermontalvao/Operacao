import { analysisFrom } from '../src/core/testing/fixtures.ts';
import { checkExtension } from '../src/core/setups/index.ts';
import type { Candle } from '../src/core/types.ts';

async function klines(symbol: string, tf: string): Promise<Candle[]> {
  const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=320`);
  const raw = (await res.json()) as unknown[][];
  return raw.slice(0, -1).map((k) => ({
    openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]),
    close: Number(k[4]), volume: Number(k[5]), quoteVolume: Number(k[7]), closeTime: Number(k[6]), closed: true,
  }));
}
for (const symbol of ['BTCUSDT', 'XRPUSDT', 'ONDOUSDT']) {
  for (const tf of ['4h', '1d'] as const) {
    const c = await klines(symbol, tf);
    const a = analysisFrom(symbol, c, [tf]).timeframes[tf]!;
    const e = checkExtension(a.indicators, a.candles);
    console.log(symbol, tf, 'extended=', e.extended, e.reasons);
  }
}
