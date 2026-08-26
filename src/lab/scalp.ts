/**
 * A pergunta: MUITAS operações curtas rendem mais que POUCAS longas — nesta
 * conta, com estes custos?
 *
 * Não é uma questão de gosto, é de aritmética, e a aritmética tem dois termos
 * que a intuição costuma esquecer:
 *
 *  1. CUSTO FIXO POR VIAGEM. Cada operação paga 0,1% na compra e 0,1% na
 *     venda, mais o escorregamento da saída. São ~0,3% que não dependem do
 *     tamanho do alvo. Num alvo de 6% isso é um décimo do lucro; num alvo de
 *     0,5%, é mais da metade. Dobrar o número de operações dobra esse custo.
 *  2. TAXA DE ACERTO NECESSÁRIA. Com alvo e stop iguais, o custo empurra o
 *     ponto de empate muito acima de 50% — e quanto mais curto o alvo, mais
 *     alto ele fica. Um sistema que acerta 60% ganha dinheiro com alvo de 2% e
 *     PERDE dinheiro com alvo de 0,5%, sem ter piorado em nada.
 *
 * Este estudo mede as duas coisas com o histórico real, comparando o gatilho
 * de 1h (o que roda hoje) com o de 15m (a ideia do scalp), pelos MESMOS
 * setups e com os MESMOS custos. Rode com:
 *
 *   node --env-file-if-exists=.env src/lab/scalp.ts --symbols=25 --days=120
 */

import type { Outcome } from '../core/backtest/types.ts';
import type { AppSettings, Timeframe } from '../core/types.ts';
import { DEFAULT_COSTS } from '../core/risk/costs.ts';
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
  return hit ? hit.split('=')[1] ?? fallback : fallback;
}

/** O tamanho de posição que esta conta consegue de fato usar. */
const CAPITAL_USDT = Number(arg('capital', '24.4'));
/** Mínimo da Binance por ordem no spot. Abaixo disto a corretora recusa. */
const MINIMO_POR_ORDEM = 5;

interface Resumo {
  nome: string;
  sinais: number;
  entrou: number;
  ganhos: number;
  perdas: number;
  acerto: number;
  medioLiquido: number;
  somaLiquida: number;
  empatePrecisaDe: number;
  barrasMedias: number;
  alvoMedio: number;
}

function resumir(nome: string, outcomes: Outcome[]): Resumo {
  const entrou = outcomes.filter((item) => item.filled);
  const ganhos = entrou.filter((item) => item.netReturnPercent > 0);
  const perdas = entrou.filter((item) => item.netReturnPercent <= 0);
  const soma = entrou.reduce((total, item) => total + item.netReturnPercent, 0);

  const mediaGanho =
    ganhos.length > 0 ? ganhos.reduce((t, i) => t + i.netReturnPercent, 0) / ganhos.length : 0;
  const mediaPerda =
    perdas.length > 0
      ? Math.abs(perdas.reduce((t, i) => t + i.netReturnPercent, 0) / perdas.length)
      : 0;

  return {
    nome,
    sinais: outcomes.length,
    entrou: entrou.length,
    ganhos: ganhos.length,
    perdas: perdas.length,
    acerto: entrou.length > 0 ? (ganhos.length / entrou.length) * 100 : 0,
    medioLiquido: entrou.length > 0 ? soma / entrou.length : 0,
    somaLiquida: soma,
    // taxa de acerto que faria a soma dar exatamente zero, com estes tamanhos
    empatePrecisaDe:
      mediaGanho + mediaPerda > 0 ? (mediaPerda / (mediaGanho + mediaPerda)) * 100 : 0,
    barrasMedias:
      entrou.length > 0 ? entrou.reduce((t, i) => t + i.barsHeld, 0) / entrou.length : 0,
    alvoMedio: mediaGanho,
  };
}

function linha(resumo: Resumo, minutosPorBarra: number): string {
  const horas = (resumo.barrasMedias * minutosPorBarra) / 60;
  return [
    resumo.nome.padEnd(22),
    String(resumo.entrou).padStart(6),
    `${resumo.acerto.toFixed(1)}%`.padStart(8),
    `${resumo.empatePrecisaDe.toFixed(1)}%`.padStart(9),
    `${resumo.medioLiquido >= 0 ? '+' : ''}${resumo.medioLiquido.toFixed(3)}%`.padStart(9),
    `${resumo.somaLiquida >= 0 ? '+' : ''}${resumo.somaLiquida.toFixed(1)}%`.padStart(10),
    `${horas.toFixed(1)}h`.padStart(8),
  ].join(' ');
}

function emDinheiro(resumo: Resumo, posicao: number): string {
  const total = (resumo.somaLiquida / 100) * posicao;
  const porOperacao = (resumo.medioLiquido / 100) * posicao;
  return (
    `  ${resumo.nome}: ${resumo.entrou} operações × US$ ${posicao.toFixed(2)} → ` +
    `${total >= 0 ? '+' : ''}US$ ${total.toFixed(2)} no período ` +
    `(${porOperacao >= 0 ? '+' : ''}US$ ${porOperacao.toFixed(4)} por operação)`
  );
}

/** O scalp precisa das travas soltas: as de hoje recusam alvo curto por construção. */
function ajustesDeScalp(): AppSettings {
  const base = labSettings();
  return labSettings({
    risk: {
      ...base.risk,
      // R/R de 2 exige que o alvo valha o dobro do stop. Num alvo curto isso
      // quase nunca acontece, e o estudo mediria zero operação em vez de medir
      // a ideia. Aqui o filtro afrouxa DE PROPÓSITO, para a ideia poder falhar
      // pelos próprios méritos e não por uma trava herdada
      minimumRiskReward: 1,
      minimumScoreToShow: 50,
      minimumScoreToAlert: 60,
    },
    scanner: {
      ...base.scanner,
      triggerTimeframes: ['15m'],
      anchorTimeframe: '4h',
      // o setup de 15m que não aciona em 3 horas não é mais o mesmo mercado
      setupTtlMinutes: 180,
      cooldownMinutes: 60,
    },
  });
}

async function main(): Promise<void> {
  const quantos = Number(arg('symbols', '25'));
  const dias = Number(arg('days', '120'));

  console.log(`\nBaixando ${quantos} pares, ${dias} dias (15m, 1h, 4h, 1d)…`);
  const universo = await topUsdtSymbols(quantos, 3_000_000);
  const simbolos = universo.map((item) => item.symbol);

  const timeframes: Timeframe[] = ['15m', '1h', '4h', '1d'];
  const dataset: Dataset[] = await loadDataset(simbolos, dias, timeframes);
  const contextAt = await buildBtcContexts(dias);
  console.log(`${dataset.length} pares com histórico suficiente.\n`);

  const atual = labSettings();
  const scalp = ajustesDeScalp();

  const sinaisLongos = collectSignals(dataset, { trigger: '1h', settings: atual, contextAt });
  const sinaisCurtos = collectSignals(dataset, { trigger: '15m', settings: scalp, contextAt });

  // a mesma convenção pessimista dos outros estudos: quando o candle tocou
  // alvo e stop, assume-se que o stop veio primeiro
  const longos = simulateAll(sinaisLongos, dataset, '1h', BASE_POLICY, atual, DEFAULT_COSTS, 'STOP_FIRST');
  const curtos = simulateAll(sinaisCurtos, dataset, '15m', BASE_POLICY, scalp, DEFAULT_COSTS, 'STOP_FIRST');

  const rLongos = resumir('1h (o de hoje)', longos);
  const rCurtos = resumir('15m (scalp)', curtos);

  console.log('########## OPERAÇÕES QUE ENTRARAM ##########');
  console.log(
    `${'gatilho'.padEnd(22)} ${'entrou'.padStart(6)} ${'acerto'.padStart(8)} ` +
      `${'p/ empatar'.padStart(9)} ${'médio'.padStart(9)} ${'soma'.padStart(10)} ${'duração'.padStart(8)}`,
  );
  console.log('-'.repeat(80));
  console.log(linha(rLongos, 60));
  console.log(linha(rCurtos, 15));

  console.log('\n########## O MESMO, EM DINHEIRO NESTA CONTA ##########');
  const posicao = Math.max(MINIMO_POR_ORDEM, CAPITAL_USDT * 0.25);
  console.log(
    `Capital US$ ${CAPITAL_USDT.toFixed(2)} · mínimo da Binance US$ ${MINIMO_POR_ORDEM} por ordem ` +
      `→ posição de US$ ${posicao.toFixed(2)}, no máximo ${Math.floor(CAPITAL_USDT / MINIMO_POR_ORDEM)} ao mesmo tempo\n`,
  );
  console.log(emDinheiro(rLongos, posicao));
  console.log(emDinheiro(rCurtos, posicao));

  console.log('\n########## O CUSTO POR VIAGEM ##########');
  const custo = DEFAULT_COSTS.feePercent * 2 + DEFAULT_COSTS.exitSlippagePercent;
  console.log(
    `Taxa ${DEFAULT_COSTS.feePercent}% na compra + ${DEFAULT_COSTS.feePercent}% na venda + ` +
      `${DEFAULT_COSTS.exitSlippagePercent}% de escorregamento = ${custo.toFixed(2)}% por operação.`,
  );
  console.log(
    `Em ${rCurtos.entrou} operações de 15m isso é ${((rCurtos.entrou * custo) / 100 * posicao).toFixed(2)} USDT só de custo; ` +
      `em ${rLongos.entrou} operações de 1h, ${((rLongos.entrou * custo) / 100 * posicao).toFixed(2)} USDT.`,
  );
  console.log(
    `\nGanho médio das vencedoras: 1h ${rLongos.alvoMedio.toFixed(2)}% · 15m ${rCurtos.alvoMedio.toFixed(2)}%. ` +
      `Quanto menor o ganho, maior a fatia que ${custo.toFixed(2)}% consome.`,
  );
}

main().catch((error) => {
  console.error('Estudo falhou:', error);
  process.exit(1);
});
