/**
 * A configuração QUE VAI RODAR, medida inteira.
 *
 * Medir peça por peça responde "este filtro ajuda?". Não responde a única
 * pergunta que importa antes de ligar: com tudo junto, do jeito que está
 * gravado, o que esperar? Este estudo roda exatamente a régua em produção —
 * explosão, piso 85, gatilhos 1h e 4h, sem exigir regime do BTC — e mostra
 * também o que dói: a maior sequência de perdas acumulada.
 *
 *   node --experimental-strip-types src/lab/configuracaoAtual.ts --list=... --days=3400
 */
import type { ExitPolicy, Outcome, Signal } from '../core/backtest/types.ts';
import type { Timeframe } from '../core/types.ts';
import { summarize } from '../core/backtest/metrics.ts';
import type { Dataset } from './engine.ts';
import {
  BASE_POLICY,
  buildBtcContexts,
  collectSignals,
  labSettings,
  loadDataset,
  simulateAll,
} from './engine.ts';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? (hit.split('=')[1] ?? fallback) : fallback;
}

const PISO = Number(arg('piso', '85'));
const EXIGE_REGIME = arg('regime', 'nao') === 'sim';
const UNIVERSO_PRODUCAO = 455;

/**
 * O que a conta faz HOJE com uma posição aberta: alvo único em 3R, stop no pé
 * da explosão, e nada entre os dois. `liveScaleOut` está desligado, então não
 * há saída parcial; e como a saída é inteira no alvo 1, o "empate depois do
 * alvo 1" nunca chega a acontecer — quando ele poderia armar, a operação já
 * acabou. Na prática: o stop NÃO sobe.
 */
const POLITICA_ATUAL: ExitPolicy = {
  ...BASE_POLICY,
  name: 'atual (tudo no alvo 3R, stop parado)',
  scaleOut: [1, 0, 0],
};

/** As formas de proteger o lucro de uma alta forte, para comparar com a atual. */
const ALTERNATIVAS: ExitPolicy[] = [
  POLITICA_ATUAL,
  { ...POLITICA_ATUAL, name: 'empate a partir de 1R', breakevenAtR: 1 },
  { ...POLITICA_ATUAL, name: 'empate a partir de 1,5R', breakevenAtR: 1.5 },
  { ...POLITICA_ATUAL, name: 'trailing por 2 ATR', atrTrailMultiple: 2 },
  { ...POLITICA_ATUAL, name: 'trailing por 3 ATR', atrTrailMultiple: 3 },
  { ...POLITICA_ATUAL, name: 'trailing 5%', trailingStopPercent: 5 },
  { ...POLITICA_ATUAL, name: 'devolve no máx 40% (arma 1R)', giveBackFraction: 0.4 },
  { ...POLITICA_ATUAL, name: 'devolve no máx 50% (arma 2R)', giveBackFraction: 0.5, giveBackArmAtR: 2 },
  { ...POLITICA_ATUAL, name: 'devolve no máx 30% (arma 1R)', giveBackFraction: 0.3 },
  { ...POLITICA_ATUAL, name: 'parcial 50% em 1,5R', partialAtR: 1.5, partialShare: 0.5 },
  {
    ...POLITICA_ATUAL,
    name: 'parcial 50% em 1,5R + trail 2ATR',
    partialAtR: 1.5,
    partialShare: 0.5,
    atrTrailMultiple: 2,
  },
];

async function main(): Promise<void> {
  const symbols = arg('list', '').split(',').filter(Boolean);
  const days = Number(arg('days', '3400'));

  const base = labSettings();
  const settings = labSettings({
    risk: { ...base.risk, minimumRiskReward: 0.5, minimumScoreToShow: 30, minimumScoreToAlert: 40 },
    scanner: { ...base.scanner, burstRequireBtcRegime: EXIGE_REGIME },
  });
  const contextAt = await buildBtcContexts(days);

  const todos: Outcome[] = [];
  const porGatilho = new Map<Timeframe, Outcome[]>();
  // guardados para reexecutar os MESMOS sinais com outras políticas de saída
  const material: Array<{ trigger: Timeframe; dataset: Dataset[]; sinais: Signal[] }> = [];
  let pares = 0;
  let primeiro = Number.POSITIVE_INFINITY;
  let ultimo = 0;

  for (const trigger of ['1h', '4h'] as Timeframe[]) {
    const dataset = await loadDataset(symbols, days, [trigger, '4h', '1d']);
    pares = Math.max(pares, dataset.length);
    const todosOsSinais = collectSignals(dataset, { trigger, settings, contextAt });
    const sinais = todosOsSinais.filter(
      (s) => s.setup.setupType === 'MOMENTUM_BURST' && s.setup.score >= PISO,
    );
    material.push({ trigger, dataset, sinais });
    const meus = simulateAll(sinais, dataset, trigger, POLITICA_ATUAL, settings);
    for (const o of meus) {
      primeiro = Math.min(primeiro, o.openTime);
      ultimo = Math.max(ultimo, o.openTime);
    }
    porGatilho.set(trigger, meus);
    todos.push(...meus);
  }

  const dias = Math.max(1, (ultimo - primeiro) / 86_400_000);
  const escala = UNIVERSO_PRODUCAO / pares;

  console.log('\n' + '='.repeat(70));
  console.log('CONFIGURAÇÃO GRAVADA — explosão, piso ' + PISO + ', gatilhos 1h e 4h');
  console.log(`exige BTC acima da média de 200 dias: ${EXIGE_REGIME ? 'SIM' : 'NÃO'}`);
  console.log(
    `${pares} pares · ${new Date(primeiro).toISOString().slice(0, 10)} a ` +
      `${new Date(ultimo).toISOString().slice(0, 10)} (${Math.round(dias)} dias)`,
  );
  console.log('='.repeat(70));

  const linha = (rot: string, lista: Outcome[]): void => {
    const s = summarize(rot, lista);
    console.log(
      `${rot.padEnd(16)}${String(lista.length).padStart(7)}` +
        `${((lista.length / dias) * escala).toFixed(2).padStart(9)}` +
        `${((s.winRate * 100).toFixed(0) + '%').padStart(8)}` +
        `${((s.expectancyR >= 0 ? '+' : '') + s.expectancyR.toFixed(3)).padStart(9)}` +
        `${(Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '—').padStart(7)}` +
        `${s.totalR.toFixed(0).padStart(9)}` +
        `${('-' + s.maxDrawdownR.toFixed(1)).padStart(9)}`,
    );
  };

  console.log(
    `\n${''.padEnd(16)}${'oper.'.padStart(7)}${'/dia(455)'.padStart(9)}${'acerto'.padStart(8)}` +
      `${'exp.R'.padStart(9)}${'PF'.padStart(7)}${'soma R'.padStart(9)}${'pior queda'.padStart(9)}`,
  );
  console.log('-'.repeat(70));
  linha('1h', porGatilho.get('1h') ?? []);
  linha('4h', porGatilho.get('4h') ?? []);
  linha('OS DOIS', todos);

  console.log('\n--- ANO A ANO (a prova que a média esconde) ---\n');
  const porAno = new Map<string, Outcome[]>();
  for (const o of todos) {
    const ano = new Date(o.openTime).getUTCFullYear().toString();
    porAno.set(ano, [...(porAno.get(ano) ?? []), o]);
  }
  console.log(
    `${''.padEnd(16)}${'oper.'.padStart(7)}${'/dia(455)'.padStart(9)}${'acerto'.padStart(8)}` +
      `${'exp.R'.padStart(9)}${'PF'.padStart(7)}${'soma R'.padStart(9)}${'pior queda'.padStart(9)}`,
  );
  console.log('-'.repeat(70));
  for (const ano of [...porAno.keys()].sort()) linha(ano, porAno.get(ano) as Outcome[]);

  console.log('\n--- E SE O STOP SUBISSE? (mesmos sinais, outra condução) ---\n');
  console.log(
    `${''.padEnd(32)}${'acerto'.padStart(8)}${'exp.R'.padStart(9)}${'PF'.padStart(7)}` +
      `${'soma R'.padStart(9)}${'pior queda'.padStart(11)}`,
  );
  console.log('-'.repeat(76));
  for (const politica of ALTERNATIVAS) {
    const resultado: Outcome[] = [];
    for (const m of material) {
      resultado.push(...simulateAll(m.sinais, m.dataset, m.trigger, politica, settings));
    }
    const r = summarize(politica.name, resultado);
    console.log(
      `${politica.name.slice(0, 31).padEnd(32)}` +
        `${((r.winRate * 100).toFixed(0) + '%').padStart(8)}` +
        `${((r.expectancyR >= 0 ? '+' : '') + r.expectancyR.toFixed(3)).padStart(9)}` +
        `${(Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '—').padStart(7)}` +
        `${r.totalR.toFixed(0).padStart(9)}` +
        `${('-' + r.maxDrawdownR.toFixed(1)).padStart(11)}`,
    );
  }

  const s = summarize('total', todos);
  console.log('\n--- O QUE ISSO SIGNIFICA EM DINHEIRO ---\n');
  const capital = Number(arg('capital', '24'));
  const risco = capital * 0.01;
  console.log(`  com ${capital} USDT e 1% de risco por operação (${risco.toFixed(2)} USDT por trade):`);
  console.log(`  ganho esperado por operação ..... ${(s.expectancyR * risco).toFixed(3)} USDT`);
  console.log(
    `  por dia (${((todos.length / dias) * escala).toFixed(1)} operações) ......... ` +
      `${(s.expectancyR * risco * (todos.length / dias) * escala).toFixed(2)} USDT`,
  );
  console.log(`  pior sequência de perdas ........ ${(s.maxDrawdownR * risco).toFixed(2)} USDT`);
  /*
   * A distância até o stop é o corpo da explosão — 3,78% na mediana. Então 1%
   * de risco pede uma posição de ~6,3 USDT, que passa do mínimo de 5 da
   * Binance: a conta FECHA neste capital, ao contrário do que parecia.
   */
  console.log(
    `\n  a distância até o stop é o corpo da explosão (3,78% na mediana), então\n` +
      `  1% de risco pede uma posição de ~${((risco / 0.0378)).toFixed(1)} USDT — acima do mínimo de 5 da\n` +
      '  Binance. A conta fecha neste capital.\n' +
      '\n  O QUE NÃO FECHA é a pior queda: -' +
      `${s.maxDrawdownR.toFixed(0)}R a 1% por operação é perder perto de\n` +
      '  todo o capital no pior momento da série. Esse número é o motivo de\n' +
      '  esta estratégia pedir capital maior ou risco por operação menor.',
  );
}

main().catch((error) => {
  console.error('Falhou:', error);
  process.exit(1);
});
