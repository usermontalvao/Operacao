import { analysisFrom } from '../src/core/testing/fixtures.ts';
import { generateSetups, applyPriceUpdate } from '../src/core/engines/setupEngine.ts';
import { evaluateMarketContext } from '../src/core/engines/marketContextEngine.ts';
import type { Candle, Timeframe, AppSettings } from '../src/core/types.ts';

const settings: AppSettings = await (await fetch('http://127.0.0.1:3010/api/settings')).json();
const tfs: Timeframe[] = ['15m', '1h', '4h', '1d'];

async function klines(symbol: string, tf: string): Promise<Candle[]> {
  const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=320`);
  const raw = (await res.json()) as unknown[][];
  return raw.slice(0, -1).map((k) => ({
    openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]),
    close: Number(k[4]), volume: Number(k[5]), quoteVolume: Number(k[7]), closeTime: Number(k[6]), closed: true,
  }));
}
async function build(symbol: string) {
  const price = Number((await (await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`)).json()).price);
  const map: Record<string, unknown> = {};
  for (const tf of tfs) map[tf] = analysisFrom(symbol, await klines(symbol, tf), [tf]).timeframes[tf];
  return { symbol, price, changePercent24h: 0, updatedAt: '', timeframes: map } as ReturnType<typeof analysisFrom>;
}

const btc = await build('BTCUSDT');
const ctx = evaluateMarketContext(btc, new Date().toISOString());
console.log('contexto', ctx.state, ctx.scoreModifier);
for (const symbol of settings.scanner.watchlist) {
  const analysis = symbol === 'BTCUSDT' ? btc : await build(symbol);
  const setups = generateSetups({ analysis, context: ctx, settings, now: new Date(), makeId: () => 'id' });
  for (const s of setups) {
    const after = applyPriceUpdate(s, analysis.price, new Date());
    console.log(`${symbol} ${s.setupType} ${s.timeframe} score=${s.score} rr=${s.riskReward} entry=${s.entryLow.toFixed(4)}-${s.entryHigh.toFixed(4)} stop=${s.stopLoss.toFixed(4)} t1=${s.target1.toFixed(4)} preço=${analysis.price} => ${after.status} ${after.visualState} ${after.invalidationNote ?? ''}`);
  }
  if (setups.length === 0) console.log(`${symbol}: nenhum candidato`);
}
