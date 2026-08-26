/**
 * Até onde dá para operar MAIS sem a conta virar contra?
 *
 * O estudo do scalp respondeu a pergunta grossa: encurtar o alvo destrói o
 * resultado, mesmo acertando mais vezes, porque o custo por viagem é fixo.
 * Sobra a pergunta útil — dentro do formato que PAGA, quanto dá para afrouxar
 * os filtros antes de o dinheiro sumir?
 *
 * O método evita a armadilha de recolher sinal a cada combinação: os sinais
 * são colhidos UMA vez com o filtro mais frouxo possível e depois recortados
 * por score e por R/R. É o mesmo conjunto de operações visto por peneiras
 * diferentes — que é exatamente o que os filtros do painel fazem.
 *
 *   node --env-file-if-exists=.env src/lab/frequencia.ts --symbols=25 --days=120
 */

import type { Outcome } from '../core/backtest/types.ts';
import type { Timeframe } from '../core/types.ts';
import { DEFAULT_COSTS } from '../core/risk/costs.ts';
import {
  BASE_POLICY,
  buildBtcContexts,
  collectSignals,
  labSettings,
  loadDataset,
  simulateAll,
} from './engine.ts';
import { topUsdtSymbols } from './klineCache.ts';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] ?? fallback : fallback;
}

const CAPITAL = Number(arg('capital', '24.4'));
const POSICAO = Math.max(5, CAPITAL * 0.25);

interface Linha {
  rotulo: string;
  operacoes: number;
  porDia: number;
  acerto: number;
  medio: number;
  soma: number;
  dinheiro: number;
}

function medir(rotulo: string, outcomes: Outcome[], dias: number): Linha {
  const entrou = outcomes.filter((item) => item.filled);
  const ganhos = entrou.filter((item) => item.netReturnPercent > 0);
  const soma = entrou.reduce((total, item) => total + item.netReturnPercent, 0);
  return {
    rotulo,
    operacoes: entrou.length,
    porDia: entrou.length / dias,
    acerto: entrou.length > 0 ? (ganhos.length / entrou.length) * 100 : 0,
    medio: entrou.length > 0 ? soma / entrou.length : 0,
    soma,
    dinheiro: (soma / 100) * POSICAO,
  };
}

function imprimir(linhas: Linha[]): void {
  console.log(
    `${'filtro'.padEnd(26)} ${'oper.'.padStart(6)} ${'por dia'.padStart(8)} ` +
      `${'acerto'.padStart(7)} ${'médio'.padStart(9)} ${'US$ no período'.padStart(15)}`,
  );
  console.log('-'.repeat(78));
  for (const l of linhas) {
    console.log(
      `${l.rotulo.padEnd(26)} ${String(l.operacoes).padStart(6)} ${l.porDia.toFixed(1).padStart(8)} ` +
        `${(l.acerto.toFixed(1) + '%').padStart(7)} ` +
        `${((l.medio >= 0 ? '+' : '') + l.medio.toFixed(3) + '%').padStart(9)} ` +
        `${((l.dinheiro >= 0 ? '+' : '') + l.dinheiro.toFixed(2)).padStart(15)}`,
    );
  }
}

async function main(): Promise<void> {
  const quantos = Number(arg('symbols', '25'));
  const dias = Number(arg('days', '120'));

  const universo = await topUsdtSymbols(quantos, 3_000_000);
  const timeframes: Timeframe[] = ['15m', '1h', '4h', '1d'];
  const dataset = await loadDataset(universo.map((i) => i.symbol), dias, timeframes);
  const contextAt = await buildBtcContexts(dias);
  console.log(`\n${dataset.length} pares · ${dias} dias · posição de US$ ${POSICAO.toFixed(2)}\n`);

  // peneira mínima: tudo o que os setups conseguem gerar
  const frouxo = labSettings({
    risk: {
      ...labSettings().risk,
      minimumRiskReward: 0.5,
      minimumScoreToShow: 30,
      minimumScoreToAlert: 40,
    },
  });

  const resultados: Record<Timeframe, Outcome[]> = {} as Record<Timeframe, Outcome[]>;
  for (const gatilho of ['1h', '4h'] as Timeframe[]) {
    const sinais = collectSignals(dataset, { trigger: gatilho, settings: frouxo, contextAt });
    resultados[gatilho] = simulateAll(
      sinais,
      dataset,
      gatilho,
      BASE_POLICY,
      frouxo,
      DEFAULT_COSTS,
      'STOP_FIRST',
    );
  }

  console.log('########## 1. AFROUXANDO O R/R NO GATILHO DE 1H ##########');
  console.log('O filtro que recusou a operação de hoje (R/R líquido 1,46 < 1,8).\n');
  imprimir(
    [2.5, 2.0, 1.8, 1.5, 1.2, 1.0].map((rr) =>
      medir(
        `R/R >= ${rr.toFixed(1)}`,
        (resultados['1h'] ?? []).filter((o) => o.riskReward >= rr && o.score >= 60),
        dias,
      ),
    ),
  );

  console.log('\n########## 2. AFROUXANDO O SCORE (com R/R >= 1,5) ##########\n');
  imprimir(
    [90, 80, 70, 60, 50, 40].map((score) =>
      medir(
        `score >= ${score}`,
        (resultados['1h'] ?? []).filter((o) => o.score >= score && o.riskReward >= 1.5),
        dias,
      ),
    ),
  );

  console.log('\n########## 3. SOMAR O GATILHO DE 4H AO DE 1H ##########\n');
  const so1h = (resultados['1h'] ?? []).filter((o) => o.score >= 60 && o.riskReward >= 1.5);
  const so4h = (resultados['4h'] ?? []).filter((o) => o.score >= 60 && o.riskReward >= 1.5);
  imprimir([
    medir('só 1h', so1h, dias),
    medir('só 4h', so4h, dias),
    medir('1h + 4h', [...so1h, ...so4h], dias),
  ]);

  console.log(
    `\nLembrete de tamanho: com US$ ${CAPITAL.toFixed(2)} e mínimo de US$ 5 por ordem, ` +
      `cabem ${Math.floor(CAPITAL / 5)} posições ao mesmo tempo. ` +
      `Mais sinais por dia do que isso viram fila, não lucro.`,
  );
}

main().catch((error) => {
  console.error('Estudo falhou:', error);
  process.exit(1);
});
