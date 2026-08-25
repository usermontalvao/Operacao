import { analysisFrom } from '../src/core/testing/fixtures.ts';
import { detectPullback, detectBreakoutRetest, detectSupportReversal } from '../src/core/setups/index.ts';
import type { Candle, Timeframe } from '../src/core/types.ts';

const symbols = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'OPUSDT', 'ONDOUSDT'];
const tfs: Timeframe[] = ['15m', '1h', '4h', '1d'];

async function klines(symbol: string, tf: string): Promise<Candle[]> {
  const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=320`);
  const raw = (await res.json()) as unknown[][];
  return raw.slice(0, -1).map((k) => ({
    openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]),
    close: Number(k[4]), volume: Number(k[5]), quoteVolume: Number(k[7]), closeTime: Number(k[6]), closed: true,
  }));
}

for (const symbol of symbols) {
  const byTf: Record<string, Candle[]> = {};
  for (const tf of tfs) byTf[tf] = await klines(symbol, tf);
  const analysis = {
    symbol, price: byTf['1h']!.at(-1)!.close, changePercent24h: 0, updatedAt: '',
    timeframes: Object.fromEntries(tfs.map((tf) => [tf, analysisFrom(symbol, byTf[tf]!, [tf]).timeframes[tf]!])),
  } as ReturnType<typeof analysisFrom>;

  for (const tf of ['1h', '4h'] as Timeframe[]) {
    const trigger = analysis.timeframes[tf]!;
    const anchor = analysis.timeframes[tf === '1h' ? '4h' : '1d']!;
    const i = trigger.indicators, s = trigger.structure;
    const input = { analysis, trigger, anchor, context: null };
    const hits = [
      detectPullback(input) && 'PULLBACK',
      detectBreakoutRetest(input) && 'BREAKOUT',
      detectSupportReversal(input) && 'REVERSAL',
    ].filter(Boolean);
    console.log(
      `${symbol} ${tf}: trend=${s.trend}/${anchor.structure.trend} struct=${s.structure} rsi=${i.rsi14?.toFixed(0)} ` +
      `atr%=${i.atrPercent?.toFixed(2)} pull%=${s.pullbackPercent?.toFixed(1)} relVol=${i.relativeVolume?.toFixed(2)} ` +
      `sup=${s.nearestSupport ? s.nearestSupport.price.toPrecision(5)+'/q'+s.nearestSupport.quality.toFixed(2) : '-'} ` +
      `bo=${s.breakout ? 'y(r'+(s.breakout.retested?1:0)+'f'+(s.breakout.failed?1:0)+'b'+s.breakout.barsSinceBreakout+')' : '-'} ` +
      `=> ${hits.join(',') || 'nenhum'}`,
    );
  }
}

// segunda passada: mostra por que um candidato não vira setup
import { generateSetups } from '../src/core/engines/setupEngine.ts';
import { defaultTestSettings } from '../src/core/testing/fixtures.ts';
import { averageEntry, computeRiskReward } from '../src/core/risk/index.ts';
import { scoreSetup } from '../src/core/engines/scoreEngine.ts';
import { checkExtension } from '../src/core/setups/index.ts';

console.log('\n--- por que cada candidato passa ou cai ---');
for (const symbol of symbols) {
  const byTf: Record<string, Candle[]> = {};
  for (const tf of tfs) byTf[tf] = await klines(symbol, tf);
  const analysis = {
    symbol, price: byTf['1h']!.at(-1)!.close, changePercent24h: 0, updatedAt: '',
    timeframes: Object.fromEntries(tfs.map((tf) => [tf, analysisFrom(symbol, byTf[tf]!, [tf]).timeframes[tf]!])),
  } as ReturnType<typeof analysisFrom>;
  for (const tf of ['1h', '4h'] as Timeframe[]) {
    const trigger = analysis.timeframes[tf]!;
    const anchor = analysis.timeframes[tf === '1h' ? '4h' : '1d']!;
    const input = { analysis, trigger, anchor, context: null };
    for (const [name, det] of [['PULLBACK', detectPullback], ['BREAKOUT', detectBreakoutRetest], ['REVERSAL', detectSupportReversal]] as const) {
      const c = det(input);
      if (!c) continue;
      const entry = averageEntry(c.entryLow, c.entryHigh);
      const rr = computeRiskReward(entry, c.stopLoss, c.target1);
      const atr = trigger.indicators.atr14 ?? 0;
      const riskInAtr = (entry - c.stopLoss) / atr;
      const ext = checkExtension(trigger.indicators, trigger.candles);
      const score = scoreSetup({ candidate: c, trigger, anchor, context: null, riskReward: rr, extension: ext });
      console.log(`${symbol} ${tf} ${name}: rr=${rr} riscoEmATR=${riskInAtr.toFixed(2)} score=${score.total} ext=${ext.extended} -> ${rr < 2 ? 'CAI no R/R' : riskInAtr < 0.45 ? 'CAI no stop curto' : score.total < 60 ? 'CAI no score' : 'PASSA'}`);
    }
  }
  const setups = generateSetups({ analysis, context: null, settings: { ...defaultTestSettings(), risk: { ...defaultTestSettings().risk, minimumRiskReward: 2 } }, now: new Date(), makeId: () => 'x' });
  if (setups.length) console.log(`  >>> ${symbol}:`, setups.map((s) => `${s.setupType} ${s.timeframe} score=${s.score} rr=${s.riskReward}`).join(' | '));
}
