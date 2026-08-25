import { formatTable, groupBy, scoreBucket, summarize } from '../core/backtest/metrics.ts';
import type { Outcome } from '../core/backtest/types.ts';
import { BASE_POLICY, buildBtcContexts, collectSignals, labSettings, loadDataset, simulateAll } from './engine.ts';
import { topUsdtSymbols } from './klineCache.ts';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] ?? fallback : fallback;
}

async function main(): Promise<void> {
  const count = Number(arg('symbols', '30'));
  const days = Number(arg('days', '540'));
  const minScore = Number(arg('minScore', '80'));
  const minRR = Number(arg('minRR', '2.5'));

  console.log(`Universo: top ${count} pares USDT por volume | ${days} dias | gatilho 1h`);
  const universe = await topUsdtSymbols(count, 3_000_000);
  console.log(`Baixando ${universe.length} pares (cache em data/cache/klines)...`);

  const dataset = await loadDataset(universe.map((item) => item.symbol), days);
  console.log(`${dataset.length} pares com histórico suficiente.`);

  const contextAt = await buildBtcContexts(days);
  const settings = labSettings();

  console.time('replay');
  const signals = collectSignals(dataset, { trigger: '1h', settings, contextAt });
  console.timeEnd('replay');
  console.log(`${signals.length} sinais brutos (score >= ${settings.risk.minimumScoreToShow}).`);

  const outcomes = simulateAll(signals, dataset, '1h', BASE_POLICY, settings);
  report('TODOS OS SINAIS (score >= 60)', outcomes);

  const eligible = outcomes.filter(
    (item) => item.score >= minScore && item.riskReward >= minRR,
  );
  report(`FILTRO DO ROBÔ (score >= ${minScore} e R/R >= ${minRR})`, eligible);
}

function report(title: string, outcomes: Outcome[]): void {
  console.log(`\n=== ${title} ===`);
  const rows = [summarize('TOTAL', outcomes)];
  for (const [type, list] of [...groupBy(outcomes, (item) => item.setupType)].sort()) {
    rows.push(summarize(type, list));
  }
  const buckets = [...groupBy(outcomes, (item) => scoreBucket(item.score))].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [bucket, list] of buckets) rows.push(summarize(`score ${bucket}`, list));
  console.log(formatTable(rows));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
