import { formatTable, summarize } from '../core/backtest/metrics.ts';
import type { ExitPolicy } from '../core/backtest/types.ts';
import { BASE_POLICY, simulateAll } from './engine.ts';
import { byWindow, prepare, robotFilter } from './study.ts';

function policy(name: string, overrides: Partial<ExitPolicy>): ExitPolicy {
  return { ...BASE_POLICY, name, ...overrides };
}

/**
 * As saídas que o item 4 da auditoria manda comparar, mais as variações que
 * fazem sentido diante do que os dados mostraram: alvo 1 é alcançado em ~26%
 * das operações, mas 37% chegam a +2% de lucro aberto. Se isso for verdade,
 * realizar antes do alvo 1 muda o resultado.
 */
const POLICIES: ExitPolicy[] = [
  BASE_POLICY,
  policy('sem proteção nenhuma', { breakevenAfterTarget1: false }),
  policy('empate a partir de 1R', { breakevenAtR: 1 }),
  policy('empate a partir de 1,5R', { breakevenAtR: 1.5 }),
  policy('parcial 50% em 1R', { partialAtR: 1, partialShare: 0.5 }),
  policy('parcial 50% em 1R + empate', { partialAtR: 1, partialShare: 0.5, breakevenAtR: 1 }),
  policy('parcial 50% em 2R', { partialAtR: 2, partialShare: 0.5 }),
  policy('trailing 3%', { trailingStopPercent: 3 }),
  policy('trailing 5%', { trailingStopPercent: 5 }),
  policy('trailing por 2 ATR', { atrTrailMultiple: 2 }),
  policy('trailing por 3 ATR', { atrTrailMultiple: 3 }),
  policy('parcial 1R + trailing 2 ATR', { partialAtR: 1, partialShare: 0.5, atrTrailMultiple: 2 }),
  policy('devolve no máx. 30% do pico (arma em 1R)', { giveBackFraction: 0.3 }),
  policy('devolve no máx. 40% do pico (arma em 1R)', { giveBackFraction: 0.4 }),
  policy('devolve no máx. 50% do pico (arma em 1R)', { giveBackFraction: 0.5 }),
  policy('devolve no máx. 40% do pico (arma em 1,5R)', { giveBackFraction: 0.4, giveBackArmAtR: 1.5 }),
  policy('devolve no máx. 50% do pico (arma em 2R)', { giveBackFraction: 0.5, giveBackArmAtR: 2 }),
  policy('devolve 40% + parcial 50% em 1R', { giveBackFraction: 0.4, partialAtR: 1, partialShare: 0.5 }),
  policy('devolve no máx. 60% do pico (arma em 2R)', { giveBackFraction: 0.6, giveBackArmAtR: 2 }),
  policy('devolve no máx. 60% do pico (arma em 3R)', { giveBackFraction: 0.6, giveBackArmAtR: 3 }),
  policy('devolve no máx. 70% do pico (arma em 3R)', { giveBackFraction: 0.7, giveBackArmAtR: 3 }),
  policy('devolve no máx. 50% do pico (arma em 3R)', { giveBackFraction: 0.5, giveBackArmAtR: 3 }),
  policy('tudo no alvo 1 (sem 50/30/20)', { scaleOut: [1, 0, 0] }),
  policy('alvo único em 0,75R', { partialAtR: 0.75, partialShare: 1 }),
  policy('alvo único em 1R', { partialAtR: 1, partialShare: 1 }),
  policy('alvo único em 1,5R', { partialAtR: 1.5, partialShare: 1 }),
  policy('alvo único em 2R', { partialAtR: 2, partialShare: 1 }),
  policy('alvo único em 1,5R + empate em 0,75R', { partialAtR: 1.5, partialShare: 1, breakevenAtR: 0.75 }),
  policy('saída temporal em 24h', { timeStopBars: 24 }),
  policy('saída temporal em 48h', { timeStopBars: 48 }),
  policy('parcial 1R + temporal 48h', { partialAtR: 1, partialShare: 0.5, timeStopBars: 48 }),
];

async function main(): Promise<void> {
  const { dataset, signals, settings, splitAt } = await prepare();

  console.log('\n########## POLÍTICAS DE SAÍDA — TODOS OS SINAIS ##########');
  console.log('TREINO decide; TESTE confirma. Política que só funciona no treino é ajuste de curva.\n');

  const rows = [];
  for (const item of POLICIES) {
    const outcomes = simulateAll(signals, dataset, '1h', item, settings);
    const windows = byWindow(outcomes, splitAt);
    rows.push(summarize(`T ${item.name}`, windows.train));
    rows.push(summarize(`t ${item.name}`, windows.test));
  }
  console.log(formatTable(rows));

  console.log('\n########## AS MESMAS POLÍTICAS, SÓ NO FILTRO DO ROBÔ ##########\n');
  const robotRows = [];
  for (const item of POLICIES) {
    const outcomes = robotFilter(simulateAll(signals, dataset, '1h', item, settings));
    const windows = byWindow(outcomes, splitAt);
    robotRows.push(summarize(`T ${item.name}`, windows.train));
    robotRows.push(summarize(`t ${item.name}`, windows.test));
  }
  console.log(formatTable(robotRows));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
