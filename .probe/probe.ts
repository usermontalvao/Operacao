import { analysisFrom, candlesFromPath, uptrendWithPullback, breakoutWithRetest, defaultTestSettings } from '../src/core/testing/fixtures.ts';
import { generateSetups } from '../src/core/engines/setupEngine.ts';
import { detectPullback, detectBreakoutRetest } from '../src/core/setups/index.ts';

for (const [name, path] of [['pullback', uptrendWithPullback()], ['breakout', breakoutWithRetest()]] as [string, number[]][]) {
  const candles = candlesFromPath(path);
  const analysis = analysisFrom('TESTUSDT', candles, ['1h', '4h', '1d']);
  const tf = analysis.timeframes['1h']!;
  const anchor = analysis.timeframes['4h']!;
  console.log('===', name, 'close', tf.indicators.close.toFixed(2), 'rsi', tf.indicators.rsi14?.toFixed(1), 'atr', tf.indicators.atr14?.toFixed(3), 'trend', tf.structure.trend, anchor.structure.trend, 'struct', tf.structure.structure, 'pull%', tf.structure.pullbackPercent?.toFixed(2));
  console.log('  supports', tf.structure.supports.slice(0,3).map(s=>s.price.toFixed(2)+`(q${s.quality.toFixed(2)},t${s.touches})`).join(' '));
  console.log('  resist', tf.structure.resistances.slice(0,3).map(s=>s.price.toFixed(2)+`(q${s.quality.toFixed(2)},t${s.touches})`).join(' '));
  console.log('  breakout', tf.structure.breakout ? `${tf.structure.breakout.level.price.toFixed(2)} retested=${tf.structure.breakout.retested} failed=${tf.structure.breakout.failed} bars=${tf.structure.breakout.barsSinceBreakout}` : 'none');
  console.log('  detectPullback', JSON.stringify(detectPullback({analysis, trigger: tf, anchor, context: null})?.reasons ?? null));
  console.log('  detectBreakout', JSON.stringify(detectBreakoutRetest({analysis, trigger: tf, anchor, context: null})?.reasons ?? null));
  const setups = generateSetups({ analysis, context: null, settings: defaultTestSettings(), now: new Date(), makeId: () => 'id' });
  console.log('  setups', setups.map(s => `${s.setupType} score=${s.score} rr=${s.riskReward} entry=${s.entryLow.toFixed(2)}-${s.entryHigh.toFixed(2)} stop=${s.stopLoss.toFixed(2)} t1=${s.target1.toFixed(2)}`));
}
