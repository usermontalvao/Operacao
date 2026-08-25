import type { Outcome } from './types.ts';

export interface Stats {
  label: string;
  /** sinais gerados, inclusive os que nunca preencheram */
  signals: number;
  /** sinais que viraram operação */
  filled: number;
  fillRate: number;
  wins: number;
  winRate: number;
  /** fração dos preenchidos que tocou o alvo 1 antes do stop */
  target1Rate: number;
  /** resultado médio por operação, em múltiplos do risco */
  expectancyR: number;
  /** resultado médio por operação, em % do valor investido */
  expectancyPercent: number;
  profitFactor: number;
  totalR: number;
  /** maior queda da curva acumulada, em R */
  maxDrawdownR: number;
  avgMfePercent: number;
  avgMaePercent: number;
}

export function summarize(label: string, outcomes: Outcome[]): Stats {
  const filled = outcomes.filter((item) => item.filled);
  const wins = filled.filter((item) => item.rMultiple > 0);
  const grossWin = wins.reduce((total, item) => total + item.rMultiple, 0);
  const grossLoss = filled
    .filter((item) => item.rMultiple < 0)
    .reduce((total, item) => total + Math.abs(item.rMultiple), 0);

  const ordered = [...filled].sort((a, b) => a.openTime - b.openTime);
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const item of ordered) {
    running += item.rMultiple;
    if (running > peak) peak = running;
    maxDrawdown = Math.max(maxDrawdown, peak - running);
  }

  const mean = (list: number[]): number =>
    list.length === 0 ? 0 : list.reduce((total, value) => total + value, 0) / list.length;

  return {
    label,
    signals: outcomes.length,
    filled: filled.length,
    fillRate: outcomes.length === 0 ? 0 : filled.length / outcomes.length,
    wins: wins.length,
    winRate: filled.length === 0 ? 0 : wins.length / filled.length,
    target1Rate:
      filled.length === 0 ? 0 : filled.filter((item) => item.reachedTarget1).length / filled.length,
    expectancyR: mean(filled.map((item) => item.rMultiple)),
    expectancyPercent: mean(filled.map((item) => item.netReturnPercent)),
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss,
    totalR: running,
    maxDrawdownR: maxDrawdown,
    avgMfePercent: mean(filled.map((item) => item.maxFavorablePercent)),
    avgMaePercent: mean(filled.map((item) => item.maxAdversePercent)),
  };
}

export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const bucket = key(item);
    const list = groups.get(bucket);
    if (list) list.push(item);
    else groups.set(bucket, [item]);
  }
  return groups;
}

export function scoreBucket(score: number): string {
  if (score >= 90) return '90+';
  if (score >= 85) return '85-89';
  if (score >= 80) return '80-84';
  if (score >= 75) return '75-79';
  if (score >= 70) return '70-74';
  return '<70';
}

/** Tabela de largura fixa: relatório de terminal que dá para ler sem rolar. */
export function formatTable(rows: Stats[]): string {
  const header = [
    'grupo'.padEnd(22),
    'sinais'.padStart(7),
    'oper.'.padStart(6),
    'alvo1'.padStart(7),
    'acerto'.padStart(7),
    'expec.R'.padStart(8),
    'expec.%'.padStart(8),
    'PF'.padStart(6),
    'totalR'.padStart(8),
    'DD_R'.padStart(7),
  ].join(' ');

  const body = rows.map((row) =>
    [
      row.label.slice(0, 22).padEnd(22),
      String(row.signals).padStart(7),
      String(row.filled).padStart(6),
      `${(row.target1Rate * 100).toFixed(1)}%`.padStart(7),
      `${(row.winRate * 100).toFixed(1)}%`.padStart(7),
      row.expectancyR.toFixed(3).padStart(8),
      row.expectancyPercent.toFixed(2).padStart(8),
      (row.profitFactor === Infinity ? '∞' : row.profitFactor.toFixed(2)).padStart(6),
      row.totalR.toFixed(1).padStart(8),
      row.maxDrawdownR.toFixed(1).padStart(7),
    ].join(' '),
  );

  return [header, '-'.repeat(header.length), ...body].join('\n');
}
