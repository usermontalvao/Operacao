import { formatTable, groupBy, scoreBucket, summarize, type Stats } from '../core/backtest/metrics.ts';
import type { Outcome, Signal } from '../core/backtest/types.ts';
import type { Timeframe } from '../core/types.ts';
import { automaticStrategyRejectionReason } from '../core/strategy/automationPolicy.ts';
import { BASE_POLICY, buildBtcContexts, collectSignals, labSettings, loadDataset, simulateAll, type Dataset } from './engine.ts';
import { topUsdtSymbols } from './klineCache.ts';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] ?? fallback : fallback;
}

export interface Study {
  dataset: Dataset[];
  signals: Signal[];
  settings: ReturnType<typeof labSettings>;
  splitAt: number;
  trigger: Timeframe;
}

/** Carrega dados, reproduz a varredura e devolve tudo pronto para as análises. */
export async function prepare(): Promise<Study> {
  const count = Number(arg('symbols', '40'));
  const days = Number(arg('days', '540'));
  const trainFraction = Number(arg('train', '0.65'));
  const trigger = arg('tf', '1h') as Timeframe;

  const universe = await topUsdtSymbols(count, 3_000_000);
  const dataset = await loadDataset(universe.map((item) => item.symbol), days);
  const contextAt = await buildBtcContexts(days);
  const settings = labSettings();
  const signals = collectSignals(dataset, { trigger, settings, contextAt });

  const first = signals[0]?.openTime ?? 0;
  const last = signals[signals.length - 1]?.openTime ?? 0;
  const splitAt = first + (last - first) * trainFraction;

  console.log(
    `${dataset.length} pares | gatilho ${trigger} | ${signals.length} sinais | ` +
      `treino até ${new Date(splitAt).toISOString().slice(0, 10)} | ` +
      `teste de ${new Date(splitAt).toISOString().slice(0, 10)} a ${new Date(last).toISOString().slice(0, 10)}`,
  );
  return { dataset, signals, settings, splitAt, trigger };
}

export function robotFilter(outcomes: Outcome[], minScore = 90, minRR = 2.5): Outcome[] {
  return outcomes.filter(
    (item) =>
      automaticStrategyRejectionReason(item) === null &&
      item.score >= minScore &&
      item.riskReward >= minRR,
  );
}

export function byWindow(outcomes: Outcome[], splitAt: number): { train: Outcome[]; test: Outcome[] } {
  return {
    train: outcomes.filter((item) => item.openTime < splitAt),
    test: outcomes.filter((item) => item.openTime >= splitAt),
  };
}

export function breakdown(label: string, outcomes: Outcome[]): Stats[] {
  const rows = [summarize(label, outcomes)];
  for (const [type, list] of [...groupBy(outcomes, (item) => item.setupType)].sort()) {
    rows.push(summarize(`  ${type}`, list));
  }
  for (const [bucket, list] of [...groupBy(outcomes, (item) => scoreBucket(item.score))].sort()) {
    rows.push(summarize(`  score ${bucket}`, list));
  }
  return rows;
}

async function main(): Promise<void> {
  const study = await prepare();
  const { dataset, signals, settings, splitAt, trigger } = study;

  console.log('\n########## 1. QUANTO A CONVENÇÃO DE INTRABARRA MUDA O RESULTADO ##########');
  console.log('Se a conclusão inverte entre as duas linhas, não há conclusão — só ruído.\n');
  const pessimistic = simulateAll(signals, dataset, trigger, BASE_POLICY, settings, undefined, 'STOP_FIRST');
  const optimistic = simulateAll(signals, dataset, trigger, BASE_POLICY, settings, undefined, 'TARGET_FIRST');
  console.log(
    formatTable([
      summarize('stop primeiro', pessimistic),
      summarize('alvo primeiro', optimistic),
      summarize('robô: stop 1º', robotFilter(pessimistic)),
      summarize('robô: alvo 1º', robotFilter(optimistic)),
    ]),
  );

  console.log('\n########## 2. LINHA DE BASE, SEPARADA EM TREINO E TESTE ##########\n');
  const windows = byWindow(pessimistic, splitAt);
  console.log(formatTable([...breakdown('TREINO', windows.train), ...breakdown('TESTE', windows.test)]));

  console.log('\n########## 3. O FILTRO DO ROBÔ (só MOMENTUM_BURST, score>=90, R/R>=2.5) ##########\n');
  const robot = byWindow(robotFilter(pessimistic), splitAt);
  console.log(formatTable([...breakdown('TREINO', robot.train), ...breakdown('TESTE', robot.test)]));
}

if (process.argv[1]?.endsWith('study.ts')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
