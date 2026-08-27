/**
 * DIAGNÓSTICO DO ROBÔ — três perguntas, uma medição só.
 *
 *   1. Quantas entradas por dia cada estratégia realmente oferece?
 *   2. O que custa afrouxar os filtros até chegar à meta de entradas/dia?
 *   3. O sinal chega ANTES ou DEPOIS do movimento?
 *
 * A terceira é a que ninguém tinha medido, e é a mais importante. Um sinal que
 * só nasce depois de uma barra de 2 ATR está, por construção, comprando o que
 * já andou. A pergunta objetiva é: do movimento total, quanto sobrou para
 * quem entrou no sinal? Se a barra que gera o sinal anda mais do que tudo o
 * que a operação oferece depois dela, o sistema não está prevendo — está
 * registrando.
 *
 *   node --experimental-strip-types src/lab/diagnostico.ts --symbols=30 --days=3400 --tf=1h
 */

import type { Candle, SetupType, Timeframe } from '../core/types.ts';
import type { Outcome, Signal } from '../core/backtest/types.ts';
import { summarize } from '../core/backtest/metrics.ts';
import {
  BASE_POLICY,
  buildBtcContexts,
  collectSignals,
  labSettings,
  loadDataset,
  simulateAll,
  type Dataset,
} from './engine.ts';
import { topUsdtSymbols } from './klineCache.ts';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? (hit.split('=')[1] ?? fallback) : fallback;
}

const DIAS_POR_MS = 86_400_000;

function intervaloEmMinutos(timeframe: Timeframe): number {
  if (timeframe === '5m') return 5;
  if (timeframe === '15m') return 15;
  if (timeframe === '4h') return 240;
  if (timeframe === '1d') return 1440;
  return 60;
}

/**
 * O quanto o sinal chegou atrasado, em números.
 *
 * `movimentoDoSinal` é o corpo da barra que ACIONOU a tese, em % — o pedaço
 * que já aconteceu quando o sistema resolveu comprar. `sobrouDepois` é a maior
 * alta que a operação chegou a mostrar depois de entrar. A razão entre os dois
 * é a resposta: acima de 1, ainda havia mais movimento adiante do que o já
 * andado; abaixo de 1, a maior parte do movimento ficou para trás.
 */
export interface Atraso {
  movimentoDoSinal: number;
  sobrouDepois: number;
  razao: number;
}

export function medirAtraso(signal: Signal, candles: Candle[], outcome: Outcome): Atraso | null {
  const bar = candles[signal.barIndex];
  if (!bar || bar.open <= 0 || !outcome.filled) return null;
  const movimentoDoSinal = Math.abs((bar.close - bar.open) / bar.open) * 100;
  const sobrouDepois = outcome.maxFavorablePercent;
  if (movimentoDoSinal <= 0) return null;
  return { movimentoDoSinal, sobrouDepois, razao: sobrouDepois / movimentoDoSinal };
}

function mediana(valores: number[]): number {
  if (valores.length === 0) return 0;
  const ordenado = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenado.length / 2);
  return ordenado.length % 2 === 0
    ? ((ordenado[meio - 1] as number) + (ordenado[meio] as number)) / 2
    : (ordenado[meio] as number);
}

interface Linha {
  rotulo: string;
  sinais: number;
  porDia: number;
  preencheu: string;
  fugiu: string;
  acerto: string;
  expR: string;
  pf: string;
}

function linha(rotulo: string, outcomes: Outcome[], dias: number): Linha {
  const stats = summarize(rotulo, outcomes);
  const fugiu = outcomes.filter((item) => item.reason === 'MISSED_TARGET_BEFORE_ENTRY').length;
  return {
    rotulo,
    sinais: outcomes.length,
    porDia: outcomes.length / dias,
    preencheu: `${(stats.fillRate * 100).toFixed(0)}%`,
    fugiu: `${outcomes.length > 0 ? ((fugiu / outcomes.length) * 100).toFixed(0) : '0'}%`,
    acerto: `${(stats.winRate * 100).toFixed(0)}%`,
    expR: (stats.expectancyR >= 0 ? '+' : '') + stats.expectancyR.toFixed(3),
    pf: Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '—',
  };
}

function imprimir(linhas: Linha[]): void {
  console.log(
    `${'                    '.slice(0, 22)}${'sinais'.padStart(7)}${'/dia'.padStart(7)}` +
      `${'entrou'.padStart(8)}${'fugiu'.padStart(7)}${'acerto'.padStart(8)}${'exp.R'.padStart(8)}${'PF'.padStart(7)}`,
  );
  console.log('-'.repeat(74));
  for (const l of linhas) {
    console.log(
      `${l.rotulo.slice(0, 21).padEnd(22)}${String(l.sinais).padStart(7)}${l.porDia.toFixed(2).padStart(7)}` +
        `${l.preencheu.padStart(8)}${l.fugiu.padStart(7)}${l.acerto.padStart(8)}${l.expR.padStart(8)}${l.pf.padStart(7)}`,
    );
  }
}

interface Medicao {
  trigger: Timeframe;
  dataset: Dataset[];
  signals: Signal[];
  outcomes: Outcome[];
  /** os mesmos sinais com o prazo de entrada que a produção realmente aplica */
  outcomesCurto: Outcome[];
  dias: number;
  corteTreino: number;
}

async function medir(trigger: Timeframe, symbols: string[], days: number): Promise<Medicao> {
  const timeframes: Timeframe[] = [...new Set<Timeframe>([trigger, '4h', '1d'])];
  const dataset = await loadDataset(symbols, days, timeframes);
  const contextAt = await buildBtcContexts(days);
  // peneira mínima: quer-se ver TUDO o que os detectores produzem, e depois
  // recortar. Colher já filtrado impede de medir o custo de cada filtro.
  const frouxo = labSettings({
    risk: {
      ...labSettings().risk,
      minimumRiskReward: 0.5,
      minimumScoreToShow: 30,
      minimumScoreToAlert: 40,
    },
  });
  const signals = collectSignals(dataset, { trigger, settings: frouxo, contextAt });
  const outcomes = simulateAll(signals, dataset, trigger, BASE_POLICY, frouxo);
  /*
   * A MESMA carteira de sinais, com o prazo de entrada que a produção usa.
   *
   * O laboratório deixa a ordem limite esperando `setupTtlMinutes` (12 horas =
   * 12 barras de 1h). A produção não faz isso com a explosão: o setup de
   * MOMENTUM_BURST expira em UMA barra (setupEngine corta o TTL pelo tamanho
   * do candle). Medir com 12 barras e operar com 1 é medir outra coisa.
   */
  const curto = labSettings({
    ...frouxo,
    scanner: { ...frouxo.scanner, setupTtlMinutes: Math.round(intervaloEmMinutos(trigger)) },
  });
  const outcomesCurto = simulateAll(signals, dataset, trigger, BASE_POLICY, curto);

  const primeiro = signals[0]?.openTime ?? 0;
  const ultimo = signals[signals.length - 1]?.openTime ?? 0;
  const dias = Math.max(1, (ultimo - primeiro) / DIAS_POR_MS);
  return {
    trigger,
    dataset,
    signals,
    outcomes,
    outcomesCurto,
    dias,
    corteTreino: primeiro + (ultimo - primeiro) * 0.7,
  };
}

async function main(): Promise<void> {
  const quantos = Number(arg('symbols', '30'));
  const days = Number(arg('days', '3400'));
  const gatilhos = arg('tf', '1h,4h').split(',') as Timeframe[];

  // `--list=` fixa o universo. Serve para repetir exatamente o mesmo estudo
  // depois: o "top 30 por volume" muda de composição de uma semana para a
  // outra, e comparar duas rodadas com universos diferentes não compara nada.
  const lista = arg('list', '');
  const symbols =
    lista.length > 0
      ? lista.split(',').map((item) => item.trim().toUpperCase())
      : (await topUsdtSymbols(quantos, 3_000_000)).map((item) => item.symbol);

  for (const trigger of gatilhos) {
    const m = await medir(trigger, symbols, days);
    const desde = m.signals[0] ? new Date(m.signals[0].openTime).toISOString().slice(0, 10) : '-';
    const ate = m.signals[m.signals.length - 1]
      ? new Date((m.signals[m.signals.length - 1] as Signal).openTime).toISOString().slice(0, 10)
      : '-';

    console.log(`\n${'='.repeat(74)}`);
    console.log(
      `GATILHO ${trigger} · ${m.dataset.length} pares · ${desde} a ${ate} ` +
        `(${Math.round(m.dias)} dias) · ${m.signals.length} sinais`,
    );
    console.log('='.repeat(74));

    console.log('\n--- 1. O QUE CADA ESTRATÉGIA OFERECE (sem filtro de score) ---\n');
    const porTipo = new Map<SetupType, Outcome[]>();
    for (const outcome of m.outcomes) {
      const lista = porTipo.get(outcome.setupType) ?? [];
      lista.push(outcome);
      porTipo.set(outcome.setupType, lista);
    }
    imprimir([
      linha('TODAS', m.outcomes, m.dias),
      ...[...porTipo.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([tipo, lista]) => linha(tipo, lista, m.dias)),
    ]);

    console.log('\n--- 2. O PREÇO DA FREQUÊNCIA: cada piso de score ---\n');
    imprimir(
      [95, 90, 85, 80, 75, 70, 60, 50, 30].map((piso) =>
        linha(
          `score >= ${piso}`,
          m.outcomes.filter((item) => item.score >= piso),
          m.dias,
        ),
      ),
    );

    console.log('\n--- 3. FORA DA AMOSTRA (treino 70% / teste 30%) ---\n');
    for (const piso of [90, 80, 70, 60]) {
      const elegiveis = m.outcomes.filter((item) => item.score >= piso);
      imprimir([
        linha(
          `score>=${piso} treino`,
          elegiveis.filter((item) => item.openTime <= m.corteTreino),
          (m.dias * 7) / 10,
        ),
        linha(
          `score>=${piso} teste`,
          elegiveis.filter((item) => item.openTime > m.corteTreino),
          (m.dias * 3) / 10,
        ),
      ]);
      console.log('');
    }

    console.log('\n--- 4. A REGRA DO ROBÔ: só MOMENTUM_BURST ---\n');
    const burst = m.outcomes.filter((item) => item.setupType === 'MOMENTUM_BURST');
    imprimir([
      ...[95, 90, 85, 80, 75, 70, 60].map((piso) =>
        linha(
          `burst score>=${piso}`,
          burst.filter((item) => item.score >= piso),
          m.dias,
        ),
      ),
    ]);
    console.log('');
    imprimir(
      [3, 2.5, 2, 1.5, 1].map((rr) =>
        linha(
          `burst R/R>=${rr}`,
          burst.filter((item) => item.riskReward >= rr),
          m.dias,
        ),
      ),
    );
    /*
     * Um corte 70/30 no tempo não serve para ESTA estratégia.
     *
     * A explosão só nasce com o BTC acima da média de 200 dias, então os
     * sinais se concentram nos regimes de alta. Um terço final em baixa devolve
     * três operações no "teste" — número do qual não se conclui nada, nem a
     * favor nem contra. Duas provas independentes substituem esse corte:
     *
     *  - CINCO JANELAS de tempo iguais em número de sinais. Se a régua é real,
     *    ela aparece na maioria das janelas, não em uma sortuda.
     *  - METADE DOS PARES contra a outra metade. Isso pergunta outra coisa: a
     *    régua é do mercado ou de um punhado de moedas?
     */
    console.log('\n  ROBUSTEZ — 5 janelas de tempo, mesmo número de sinais em cada:\n');
    for (const piso of [90, 85, 70]) {
      const elegiveis = burst
        .filter((item) => item.score >= piso)
        .sort((a, b) => a.openTime - b.openTime);
      const porJanela = Math.max(1, Math.ceil(elegiveis.length / 5));
      const linhas: Linha[] = [];
      for (let f = 0; f < 5; f += 1) {
        const fatia = elegiveis.slice(f * porJanela, (f + 1) * porJanela);
        if (fatia.length === 0) continue;
        const de = new Date((fatia[0] as Outcome).openTime).toISOString().slice(2, 7);
        linhas.push(linha(`score>=${piso} ${de}`, fatia, m.dias / 5));
      }
      imprimir(linhas);
      console.log('');
    }

    console.log('  ROBUSTEZ — metade dos pares contra a outra metade:\n');
    const pares = [...new Set(burst.map((item) => item.symbol))].sort();
    const metadeA = new Set(pares.filter((_, i) => i % 2 === 0));
    for (const piso of [90, 85, 70]) {
      const elegiveis = burst.filter((item) => item.score >= piso);
      imprimir([
        linha(`score>=${piso} pares A`, elegiveis.filter((i) => metadeA.has(i.symbol)), m.dias),
        linha(`score>=${piso} pares B`, elegiveis.filter((i) => !metadeA.has(i.symbol)), m.dias),
      ]);
      console.log('');
    }

    console.log('  a regra em produção hoje = score>=90 E R/R>=2.5, juntas:');
    imprimir([
      linha(
        'REGRA ATUAL',
        burst.filter((item) => item.score >= 90 && item.riskReward >= 2.5),
        m.dias,
      ),
    ]);
    const universoProducao = Number(arg('universoProducao', '455'));
    const atual = burst.filter((item) => item.score >= 90 && item.riskReward >= 2.5);
    console.log(
      `\n  medido em ${m.dataset.length} pares. O scanner varre ${universoProducao}: ` +
        `${((atual.length / m.dias / m.dataset.length) * universoProducao).toFixed(1)} sinais/dia\n` +
        '  (extrapolação linear — os pares de menor volume têm menos liquidez e\n' +
        '   custo maior, então o número real fica ABAIXO deste)',
    );

    console.log(
      '\n  PRAZO DE ENTRADA: o laboratório deixa a ordem esperando 12 barras;\n' +
        '  a produção mata a explosão em 1 barra. Os mesmos sinais, dos dois jeitos:\n',
    );
    const burstCurto = m.outcomesCurto.filter((item) => item.setupType === 'MOMENTUM_BURST');
    imprimir([
      linha('burst 12 barras', burst, m.dias),
      linha('burst 1 barra (real)', burstCurto, m.dias),
    ]);

    console.log('\n--- 5. O SINAL CHEGA ANTES OU DEPOIS DO MOVIMENTO? ---\n');
    const seriePorPar = new Map(m.dataset.map((d) => [d.symbol, d.series.get(trigger) ?? []]));
    const atrasoPorTipo = new Map<SetupType, Atraso[]>();
    for (const [i, signal] of m.signals.entries()) {
      const outcome = m.outcomes[i];
      if (!outcome) continue;
      const atraso = medirAtraso(signal, seriePorPar.get(signal.symbol) ?? [], outcome);
      if (!atraso) continue;
      const lista = atrasoPorTipo.get(signal.setup.setupType) ?? [];
      lista.push(atraso);
      atrasoPorTipo.set(signal.setup.setupType, lista);
    }
    console.log(
      `${'estratégia'.padEnd(22)}${'barra do sinal'.padStart(16)}${'sobrou depois'.padStart(15)}${'razão'.padStart(9)}`,
    );
    console.log('-'.repeat(62));
    for (const [tipo, lista] of [...atrasoPorTipo.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(
        `${tipo.padEnd(22)}${(mediana(lista.map((a) => a.movimentoDoSinal)).toFixed(2) + '%').padStart(16)}` +
          `${(mediana(lista.map((a) => a.sobrouDepois)).toFixed(2) + '%').padStart(15)}` +
          `${mediana(lista.map((a) => a.razao)).toFixed(2).padStart(9)}`,
      );
    }
    console.log(
      '\nrazão < 1 = a barra que gerou o sinal andou mais do que tudo o que a\n' +
        'operação ofereceu depois dela. O sinal é registro, não previsão.',
    );
  }
}

main().catch((error) => {
  console.error('Diagnóstico falhou:', error);
  process.exit(1);
});
