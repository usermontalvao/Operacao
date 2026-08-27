/**
 * PESQUISA — mede o catálogo inteiro de estratégias no mesmo simulador.
 *
 * O problema central deste programa não é medir; é NÃO SE ENGANAR ao medir.
 * Testando 111 combinações contra o mesmo histórico, algumas vão parecer
 * excelentes por sorte pura — com 111 sorteios, o melhor resultado é quase
 * sempre um sorteio bom, não uma vantagem real. Por isso nada aqui é ordenado
 * pelo maior número. O que decide é sobreviver a quatro perguntas
 * independentes ao mesmo tempo:
 *
 *   1. amostra suficiente (>= 150 operações)
 *   2. positiva no TREINO e no TESTE (corte temporal 70/30)
 *   3. positiva nas DUAS metades do universo (é do mercado, não de 3 moedas)
 *   4. positiva em pelo menos 4 das 5 janelas de tempo
 *
 * Uma estratégia sem vantagem tem chance pequena de passar nas quatro. Não
 * zero — por isso o relatório também mostra quantas passariam por acaso.
 *
 *   node --experimental-strip-types src/lab/pesquisa.ts --list=... --tf=1h
 */
import type { Candle, SetupType, Timeframe, TradeSetup } from '../core/types.ts';
import type { ExitPolicy, Outcome, Signal } from '../core/backtest/types.ts';
import { DEFAULT_COSTS } from '../core/risk/costs.ts';
import { summarize } from '../core/backtest/metrics.ts';
import { simulateSignal } from '../core/backtest/simulate.ts';
import { ALVOS_TESTADOS, catalogo, montarContexto, type Estrategia } from './candidatas.ts';
import { loadDataset } from './engine.ts';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? (hit.split('=')[1] ?? fallback) : fallback;
}

/** Saída única no alvo, stop fixo — a condução que a medição já elegeu. */
const POLITICA: ExitPolicy = {
  name: 'alvo único, stop fixo',
  scaleOut: [1, 0, 0],
  breakevenAfterTarget1: false,
  trailingStopPercent: 0,
  partialAtR: null,
  partialShare: 0,
  breakevenAtR: null,
  atrTrailMultiple: null,
  timeStopBars: null,
  giveBackFraction: null,
  giveBackArmAtR: 1,
};

/** Barras de aquecimento: sem isto a EMA200 e o percentil de 100 barras mentem. */
const AQUECIMENTO = 260;
/** Prazo da ordem limite, em barras. */
const PRAZO_BARRAS = 12;
const MINIMO_DE_OPERACOES = 150;

/**
 * O `simulateSignal` pede um TradeSetup inteiro, mas lê só nove campos. Um
 * objeto mínimo com um `as` explícito é honesto aqui: inventar os outros
 * quarenta campos daria a impressão de que eles significam alguma coisa nesta
 * medição, e não significam.
 */
function comoSetup(
  simbolo: string,
  c: { entryLow: number; entryHigh: number; stopLoss: number },
  alvoR: number,
): TradeSetup {
  const entrada = (c.entryLow + c.entryHigh) / 2;
  const risco = entrada - c.stopLoss;
  return {
    symbol: simbolo,
    side: 'BUY',
    setupType: 'MOMENTUM_BURST' as SetupType,
    entryLow: c.entryLow,
    entryHigh: c.entryHigh,
    stopLoss: c.stopLoss,
    target1: entrada + risco * alvoR,
    target2: null,
    target3: null,
    score: 100,
    riskReward: alvoR,
  } as unknown as TradeSetup;
}

interface Resultado {
  nome: string;
  familia: string;
  alvo: number;
  operacoes: number;
  porDia: number;
  acerto: number;
  expR: number;
  pf: number;
  somaR: number;
  quedaR: number;
  expTreino: number;
  expTeste: number;
  expParesA: number;
  expParesB: number;
  janelasPositivas: number;
  sobrevive: boolean;
}

function avaliar(
  estrategia: Estrategia,
  alvo: number,
  outcomes: Outcome[],
  dias: number,
): Resultado {
  const ordenado = [...outcomes].sort((a, b) => a.openTime - b.openTime);
  const total = summarize('t', ordenado);
  const corte = ordenado.length > 0 ? Math.floor(ordenado.length * 0.7) : 0;
  const treino = summarize('T', ordenado.slice(0, corte));
  const teste = summarize('t', ordenado.slice(corte));

  const pares = [...new Set(ordenado.map((o) => o.symbol))].sort();
  const metadeA = new Set(pares.filter((_, i) => i % 2 === 0));
  const paresA = summarize('A', ordenado.filter((o) => metadeA.has(o.symbol)));
  const paresB = summarize('B', ordenado.filter((o) => !metadeA.has(o.symbol)));

  let janelasPositivas = 0;
  const porJanela = Math.max(1, Math.ceil(ordenado.length / 5));
  for (let f = 0; f < 5; f += 1) {
    const fatia = ordenado.slice(f * porJanela, (f + 1) * porJanela);
    if (fatia.length === 0) continue;
    if (summarize('j', fatia).expectancyR > 0) janelasPositivas += 1;
  }

  const sobrevive =
    total.filled >= MINIMO_DE_OPERACOES &&
    treino.expectancyR > 0 &&
    teste.expectancyR > 0 &&
    paresA.expectancyR > 0 &&
    paresB.expectancyR > 0 &&
    janelasPositivas >= 4;

  return {
    nome: estrategia.nome,
    familia: estrategia.familia,
    alvo,
    operacoes: total.filled,
    porDia: total.filled / dias,
    acerto: total.winRate * 100,
    expR: total.expectancyR,
    pf: total.profitFactor,
    somaR: total.totalR,
    quedaR: total.maxDrawdownR,
    expTreino: treino.expectancyR,
    expTeste: teste.expectancyR,
    expParesA: paresA.expectancyR,
    expParesB: paresB.expectancyR,
    janelasPositivas,
    sobrevive,
  };
}

async function main(): Promise<void> {
  const symbols = arg('list', '').split(',').filter(Boolean);
  const days = Number(arg('days', '3400'));
  const gatilhos = arg('tf', '1h,4h').split(',') as Timeframe[];
  const estrategias = catalogo();

  console.log(
    `\n${estrategias.length} detectores x ${ALVOS_TESTADOS.length} alvos = ` +
      `${estrategias.length * ALVOS_TESTADOS.length} combinações por gatilho`,
  );

  for (const trigger of gatilhos) {
    const dataset = await loadDataset(symbols, days, [trigger]);
    console.log(`\n${'='.repeat(100)}`);
    console.log(`GATILHO ${trigger} · ${dataset.length} pares`);
    console.log('='.repeat(100));

    // contexto uma vez por par: é a parte cara
    const contextos = dataset.map((d) => ({
      symbol: d.symbol,
      candles: d.series.get(trigger) ?? [],
      ctx: montarContexto(d.series.get(trigger) ?? []),
    }));

    let primeiro = Number.POSITIVE_INFINITY;
    let ultimo = 0;
    for (const c of contextos) {
      const primeira = c.candles[AQUECIMENTO];
      const ultima = c.candles[c.candles.length - 1];
      if (primeira) primeiro = Math.min(primeiro, primeira.openTime);
      if (ultima) ultimo = Math.max(ultimo, ultima.openTime);
    }
    const dias = Math.max(1, (ultimo - primeiro) / 86_400_000);

    // busca por nome em vez de varrer a lista a cada sinal: com dezenas de
    // milhares de sinais por estratégia, o `find` dominava o tempo total
    const porSimbolo = new Map(contextos.map((c) => [c.symbol, c]));

    const resultados: Resultado[] = [];
    for (const estrategia of estrategias) {
      // detecta UMA vez; os três alvos reaproveitam a mesma detecção
      const achados: Array<{ symbol: string; i: number; candidata: NonNullable<ReturnType<Estrategia['detectar']>> }> = [];
      for (const { symbol, candles, ctx } of contextos) {
        for (let i = AQUECIMENTO; i < candles.length - 1; i += 1) {
          const candidata = estrategia.detectar(ctx, i);
          if (candidata) achados.push({ symbol, i, candidata });
        }
      }
      if (achados.length === 0) continue;

      for (const alvo of ALVOS_TESTADOS) {
        const outcomes: Outcome[] = [];
        for (const { symbol, i, candidata } of achados) {
          const entrada = porSimbolo.get(symbol);
          if (!entrada) continue;
          const bar = entrada.candles[i] as Candle;
          const signal: Signal = {
            symbol,
            setup: comoSetup(symbol, candidata, alvo),
            barIndex: i,
            openTime: bar.openTime,
            atr: 0,
          };
          outcomes.push(
            simulateSignal({
              signal,
              candles: entrada.candles.slice(i),
              policy: POLITICA,
              costs: DEFAULT_COSTS,
              entryTtlBars: PRAZO_BARRAS,
              intrabar: 'STOP_FIRST',
            }),
          );
        }
        resultados.push(avaliar(estrategia, alvo, outcomes, dias));
      }
    }

    imprimir(resultados, trigger);
  }
}

function imprimir(resultados: Resultado[], trigger: Timeframe): void {
  const comAmostra = resultados.filter((r) => r.operacoes >= MINIMO_DE_OPERACOES);
  const sobreviventes = resultados.filter((r) => r.sobrevive);

  console.log(`\ncombinações medidas ......... ${resultados.length}`);
  console.log(`com amostra suficiente ...... ${comAmostra.length}`);
  console.log(`SOBREVIVERAM às 4 provas .... ${sobreviventes.length}`);
  /*
   * Quantas passariam por acaso? Uma estratégia sem vantagem nenhuma tem, em
   * cada prova, chance perto de 1/2 de dar positiva. Quatro provas quase
   * independentes: (1/2)^4 = 1/16 dos testes, mais a exigência de 4 de 5
   * janelas. O número abaixo é a expectativa de falsos positivos — se os
   * sobreviventes forem menos que isto, não há nada aqui.
   */
  const acaso = comAmostra.length * (1 / 16) * 0.19;
  console.log(`esperados por PURO ACASO .... ${acaso.toFixed(1)}`);

  const cab =
    `${'estratégia'.padEnd(52)}${'alvo'.padStart(5)}${'oper.'.padStart(7)}${'/dia'.padStart(7)}` +
    `${'acerto'.padStart(8)}${'exp.R'.padStart(9)}${'PF'.padStart(6)}${'treino'.padStart(8)}${'teste'.padStart(8)}` +
    `${'A'.padStart(8)}${'B'.padStart(8)}${'jan'.padStart(5)}`;
  const linha = (r: Resultado): string =>
    `${r.nome.slice(0, 51).padEnd(52)}${(r.alvo + 'R').padStart(5)}${String(r.operacoes).padStart(7)}` +
    `${r.porDia.toFixed(2).padStart(7)}${(r.acerto.toFixed(0) + '%').padStart(8)}` +
    `${((r.expR >= 0 ? '+' : '') + r.expR.toFixed(3)).padStart(9)}` +
    `${(Number.isFinite(r.pf) ? r.pf.toFixed(2) : '—').padStart(6)}` +
    `${((r.expTreino >= 0 ? '+' : '') + r.expTreino.toFixed(2)).padStart(8)}` +
    `${((r.expTeste >= 0 ? '+' : '') + r.expTeste.toFixed(2)).padStart(8)}` +
    `${((r.expParesA >= 0 ? '+' : '') + r.expParesA.toFixed(2)).padStart(8)}` +
    `${((r.expParesB >= 0 ? '+' : '') + r.expParesB.toFixed(2)).padStart(8)}` +
    `${(r.janelasPositivas + '/5').padStart(5)}`;

  console.log(`\n--- SOBREVIVENTES (${trigger}) — ordenadas por entradas por dia ---\n`);
  console.log(cab);
  console.log('-'.repeat(133));
  for (const r of [...sobreviventes].sort((a, b) => b.porDia - a.porDia)) console.log(linha(r));
  if (sobreviventes.length === 0) console.log('  (nenhuma)');

  console.log(`\n--- AS 15 DE MAIOR EXPECTATIVA, tenham sobrevivido ou não ---`);
  console.log('  (esta tabela é a armadilha: o topo dela é, em boa parte, sorte)\n');
  console.log(cab);
  console.log('-'.repeat(133));
  for (const r of [...comAmostra].sort((a, b) => b.expR - a.expR).slice(0, 15)) {
    console.log(`${linha(r)}${r.sobrevive ? '  <= sobreviveu' : ''}`);
  }

  console.log(`\n--- POR FAMÍLIA (média das combinações com amostra) ---\n`);
  const familias = new Map<string, Resultado[]>();
  for (const r of comAmostra) familias.set(r.familia, [...(familias.get(r.familia) ?? []), r]);
  for (const [familia, lista] of [...familias].sort()) {
    const media = lista.reduce((t, r) => t + r.expR, 0) / lista.length;
    const positivas = lista.filter((r) => r.expR > 0).length;
    console.log(
      `  ${familia.padEnd(13)} ${String(lista.length).padStart(3)} combinações · ` +
        `expectativa média ${(media >= 0 ? '+' : '') + media.toFixed(3)} · ` +
        `${positivas} positivas · ${lista.filter((r) => r.sobrevive).length} sobreviveram`,
    );
  }
}

main().catch((error) => {
  console.error('Pesquisa falhou:', error);
  process.exit(1);
});
