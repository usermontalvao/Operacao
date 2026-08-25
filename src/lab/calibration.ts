import { formatTable, summarize, type Stats } from '../core/backtest/metrics.ts';
import type { Outcome, Signal } from '../core/backtest/types.ts';
import { BASE_POLICY, simulateAll } from './engine.ts';
import { prepare } from './study.ts';

interface Pair {
  signal: Signal;
  outcome: Outcome;
}

type Slicer = { name: string; bucket: (pair: Pair) => string | null };

const SLICERS: Slicer[] = [
  {
    name: 'componente TENDÊNCIA',
    bucket: ({ signal }) => points(signal, 'trend') >= 18 ? 'máximo' : 'abaixo do máximo',
  },
  {
    name: 'componente ESTRUTURA',
    bucket: ({ signal }) => points(signal, 'structure') >= 14 ? 'máximo' : 'abaixo do máximo',
  },
  {
    name: 'componente MOMENTUM',
    bucket: ({ signal }) => bucketOf(points(signal, 'momentum'), [6, 10]),
  },
  {
    name: 'componente VOLUME',
    bucket: ({ signal }) => bucketOf(points(signal, 'volume'), [6, 10]),
  },
  {
    name: 'componente NÍVEL',
    bucket: ({ signal }) => bucketOf(points(signal, 'level'), [7, 11]),
  },
  {
    name: 'R/R declarado',
    bucket: ({ outcome }) => bucketOf(outcome.riskReward, [2.5, 3.5]),
  },
  {
    name: 'contexto do BTC',
    bucket: ({ signal }) => signal.setup.btcContext,
  },
  {
    name: 'tendência da âncora',
    bucket: ({ signal }) => signal.setup.evidence.anchorTrend,
  },
  {
    name: 'ATR% do gatilho',
    bucket: ({ signal }) => bucketOf(signal.setup.evidence.atrPercent ?? 0, [1.5, 3]),
  },
  {
    name: 'RSI do gatilho',
    bucket: ({ signal }) => bucketOf(signal.setup.evidence.rsi14 ?? 0, [45, 60]),
  },
  {
    name: 'volume relativo',
    bucket: ({ signal }) => bucketOf(signal.setup.evidence.relativeVolume ?? 0, [1, 1.5]),
  },
  {
    name: 'distância do stop (ATR)',
    bucket: ({ signal }) => {
      const risk = (signal.setup.entryLow + signal.setup.entryHigh) / 2 - signal.setup.stopLoss;
      return signal.atr > 0 ? bucketOf(risk / signal.atr, [0.8, 1.4]) : null;
    },
  },
];

function points(signal: Signal, key: string): number {
  return signal.setup.scoreBreakdown.components.find((item) => item.key === key)?.points ?? 0;
}

function bucketOf(value: number, cuts: [number, number]): string {
  if (value < cuts[0]) return `< ${cuts[0]}`;
  if (value < cuts[1]) return `${cuts[0]} a ${cuts[1]}`;
  return `>= ${cuts[1]}`;
}

async function main(): Promise<void> {
  const { dataset, signals, settings, splitAt } = await prepare();
  const outcomes = simulateAll(signals, dataset, '1h', BASE_POLICY, settings);
  const pairs: Pair[] = signals.map((signal, index) => ({
    signal,
    outcome: outcomes[index] as Outcome,
  }));

  console.log('\n########## O QUE PREVÊ O RESULTADO? ##########');
  console.log('T = treino, t = teste. Só interessa a fatia positiva NAS DUAS janelas e com amostra.\n');

  for (const slicer of SLICERS) {
    const groups = new Map<string, Pair[]>();
    for (const pair of pairs) {
      const key = slicer.bucket(pair);
      if (key === null) continue;
      const list = groups.get(key);
      if (list) list.push(pair);
      else groups.set(key, [pair]);
    }

    const rows: Stats[] = [];
    for (const [key, list] of [...groups].sort()) {
      const train = list.filter((item) => item.outcome.openTime < splitAt).map((item) => item.outcome);
      const test = list.filter((item) => item.outcome.openTime >= splitAt).map((item) => item.outcome);
      rows.push(summarize(`T ${key}`, train));
      rows.push(summarize(`t ${key}`, test));
    }
    console.log(`--- ${slicer.name} ---`);
    console.log(formatTable(rows));
    console.log('');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
