import { formatTable, summarize } from '../core/backtest/metrics.ts';
import type { Outcome, Signal } from '../core/backtest/types.ts';
import { BASE_POLICY, simulateAll } from './engine.ts';
import { prepare, robotFilter } from './study.ts';

interface Pair { signal: Signal; outcome: Outcome }

/**
 * As únicas fatias ruins em TREINO e TESTE ao mesmo tempo. Se remover as três
 * não deixa o resto positivo, calibrar o score é ajustar peso de ruído.
 */
const EXCLUSIONS: Array<{ name: string; drop: (pair: Pair) => boolean }> = [
  { name: 'RSI < 45', drop: ({ signal }) => (signal.setup.evidence.rsi14 ?? 100) < 45 },
  {
    name: 'stop a menos de 0,8 ATR',
    drop: ({ signal }) => {
      const risk = (signal.setup.entryLow + signal.setup.entryHigh) / 2 - signal.setup.stopLoss;
      return signal.atr > 0 && risk / signal.atr < 0.8;
    },
  },
  { name: 'âncora lateral', drop: ({ signal }) => signal.setup.evidence.anchorTrend === 'SIDEWAYS' },
  { name: 'BTC vendedor', drop: ({ signal }) => signal.setup.btcContext === 'BTC_BEARISH' },
];

async function main(): Promise<void> {
  const { dataset, signals, settings, splitAt } = await prepare();
  const outcomes = simulateAll(signals, dataset, '1h', BASE_POLICY, settings);
  const pairs: Pair[] = signals.map((signal, index) => ({ signal, outcome: outcomes[index] as Outcome }));

  const windows = (list: Pair[]) => ({
    train: list.filter((item) => item.outcome.openTime < splitAt).map((item) => item.outcome),
    test: list.filter((item) => item.outcome.openTime >= splitAt).map((item) => item.outcome),
  });

  const rows = [];
  const base = windows(pairs);
  rows.push(summarize('T sem filtro nenhum', base.train));
  rows.push(summarize('t sem filtro nenhum', base.test));

  let kept = pairs;
  for (const exclusion of EXCLUSIONS) {
    kept = kept.filter((pair) => !exclusion.drop(pair));
    const split = windows(kept);
    rows.push(summarize(`T + sem ${exclusion.name}`, split.train));
    rows.push(summarize(`t + sem ${exclusion.name}`, split.test));
  }

  console.log('\n########## MELHOR CASO DA CALIBRAÇÃO: TIRAR TUDO QUE É RUIM NAS DUAS JANELAS ##########\n');
  console.log(formatTable(rows));

  console.log('\n########## O MESMO, SOMADO AO FILTRO DO ROBÔ (score>=80, R/R>=2.5) ##########\n');
  const robotRows = [];
  const robotBase = windows(pairs.filter((p) => robotFilter([p.outcome]).length > 0));
  robotRows.push(summarize('T robô puro', robotBase.train));
  robotRows.push(summarize('t robô puro', robotBase.test));
  const robotKept = kept.filter((p) => robotFilter([p.outcome]).length > 0);
  const robotSplit = windows(robotKept);
  robotRows.push(summarize('T robô + 4 filtros', robotSplit.train));
  robotRows.push(summarize('t robô + 4 filtros', robotSplit.test));
  console.log(formatTable(robotRows));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
