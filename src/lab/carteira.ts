/**
 * SIMULAÇÃO DE CARTEIRA — o que o Monte Carlo ingênuo escondia.
 *
 * A versão anterior sorteava operações soltas e as aplicava uma após a outra
 * sobre a conta inteira. Isso erra em duas direções, e as duas para o lado
 * otimista:
 *
 *  1. DESTRÓI O TEMPO. Cripto anda em regimes: numa semana de alta várias
 *     moedas explodem juntas e ganham juntas; numa quebra, todas devolvem
 *     juntas. Sorteando operações isoladas, essas sequências ruins somem — e
 *     com elas a pior parte da curva. O conserto é sortear BLOCOS de dias
 *     inteiros, preservando o que aconteceu junto.
 *
 *  2. IGNORA O CAIXA. Três sinais fortes simultâneos pediriam 210% da banca.
 *     Aqui existe caixa: uma operação só entra se houver dinheiro livre, e
 *     ela prende esse dinheiro até fechar. Sinal que chega com a conta cheia
 *     é PERDIDO, como na vida real.
 *
 * A saída é a distribuição de resultados finais — não uma média, que numa
 * estratégia de 30% de acerto engana mais do que informa.
 *
 *   node --experimental-strip-types src/lab/carteira.ts --list=... --regra=corpo3
 */
import type { Outcome } from '../core/backtest/types.ts';
import type { Timeframe } from '../core/types.ts';
import { BASE_POLICY, buildBtcContexts, collectSignals, labSettings, loadDataset, simulateAll } from './engine.ts';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? (hit.split('=')[1] ?? fallback) : fallback;
}

/** Uma operação como a carteira a vê: quando abre, quanto dura, quanto rende. */
interface Op {
  abre: number;
  fecha: number;
  r: number;
  corpo: number;
}

const DIA = 86_400_000;

/**
 * Bootstrap por BLOCOS. Sorteia trechos contíguos de `blocoDias` do histórico
 * e os cola em sequência. O que acontecia junto continua junto.
 */
function sortearBlocos(ops: Op[], t0: number, t1: number, dias: number, blocoDias: number): Op[] {
  const escolhidas: Op[] = [];
  const totalBlocos = Math.max(1, Math.floor((t1 - t0) / (blocoDias * DIA)));
  const quantos = Math.ceil(dias / blocoDias);
  let relogio = 0;
  for (let b = 0; b < quantos; b += 1) {
    const inicio = t0 + Math.floor(Math.random() * totalBlocos) * blocoDias * DIA;
    const fim = inicio + blocoDias * DIA;
    for (const o of ops) {
      if (o.abre >= inicio && o.abre < fim) {
        escolhidas.push({ ...o, abre: relogio + (o.abre - inicio), fecha: relogio + (o.fecha - inicio) });
      }
    }
    relogio += blocoDias * DIA;
  }
  return escolhidas.sort((a, b) => a.abre - b.abre);
}

/** Roda a carteira com caixa de verdade: sem dinheiro livre, o sinal é perdido. */
function rodarCarteira(
  ops: Op[],
  fracaoMedia: number,
  fracaoForte: number,
  fronteiraForte: number,
  stopTipico: number,
): { final: number; entrou: number; perdidos: number } {
  let conta = 100;
  let preso = 0;
  const abertas: Array<{ fecha: number; valor: number; r: number }> = [];
  let entrou = 0;
  let perdidos = 0;

  for (const op of ops) {
    // primeiro liquida o que venceu antes deste sinal
    for (let i = abertas.length - 1; i >= 0; i -= 1) {
      const a = abertas[i] as { fecha: number; valor: number; r: number };
      if (a.fecha <= op.abre) {
        conta += a.valor * a.r * stopTipico;
        preso -= a.valor;
        abertas.splice(i, 1);
      }
    }
    const fracao = op.corpo >= fronteiraForte ? fracaoForte : fracaoMedia;
    const desejado = conta * fracao;
    const livre = conta - preso;
    if (desejado > livre || livre <= conta * 0.02) {
      perdidos += 1;
      continue;
    }
    abertas.push({ fecha: op.fecha, valor: desejado, r: op.r });
    preso += desejado;
    entrou += 1;
  }
  for (const a of abertas) conta += a.valor * a.r * stopTipico;
  return { final: conta, entrou, perdidos };
}

async function main(): Promise<void> {
  const symbols = arg('list', '').split(',').filter(Boolean);
  const days = Number(arg('days', '3400'));
  const trigger = arg('tf', '4h') as Timeframe;
  const pisoCorpo = Number(arg('corpo', '3'));
  const pisoScore = Number(arg('score', '0'));
  const stopTipico = Number(arg('stop', '4.8')) / 100;

  const base = labSettings();
  const cfg = labSettings({
    risk: { ...base.risk, minimumRiskReward: 0.3, minimumScoreToShow: 20, minimumScoreToAlert: 30 },
    scanner: { ...base.scanner, burstRequireBtcRegime: false },
  });
  const contextAt = await buildBtcContexts(days);
  const dataset = await loadDataset(symbols, days, [trigger, '4h', '1d']);
  const sinais = collectSignals(dataset, { trigger, settings: cfg, contextAt, pisoDoCorpoAtr: 1 });
  const outcomes = simulateAll(dataset.length > 0 ? sinais : [], dataset, trigger, { ...BASE_POLICY, scaleOut: [1, 0, 0], breakevenAfterTarget1: false }, cfg);

  const barra = trigger === '4h' ? 4 * 3_600_000 : 3_600_000;
  const ops: Op[] = [];
  let t0 = Number.POSITIVE_INFINITY;
  let t1 = 0;
  for (const [i, s] of sinais.entries()) {
    const o: Outcome | undefined = outcomes[i];
    const corpo = s.setup.evidence?.burstBodyAtr;
    if (!o || !o.filled || s.setup.setupType !== 'MOMENTUM_BURST') continue;
    if (corpo === null || corpo === undefined || corpo < pisoCorpo) continue;
    if (s.setup.score < pisoScore) continue;
    ops.push({ abre: o.openTime, fecha: o.openTime + Math.max(1, o.barsHeld) * barra, r: o.rMultiple, corpo });
    t0 = Math.min(t0, o.openTime);
    t1 = Math.max(t1, o.openTime);
  }
  ops.sort((a, b) => a.abre - b.abre);

  console.log(`\n=== REGRA: corpo >= ${pisoCorpo} ATR${pisoScore > 0 ? ` e score >= ${pisoScore}` : ' (sem filtro de score)'} · gatilho ${trigger} ===`);
  console.log(`  ${ops.length} operações reais em ${Math.round((t1 - t0) / DIA)} dias · ${(ops.length / ((t1 - t0) / DIA)).toFixed(2)}/dia`);

  const CENARIOS = [
    ['30% médio / 70% forte (como está)', 0.3, 0.7],
    ['70% médio / 30% forte (o que os dados dizem)', 0.7, 0.3],
    ['50% fixo', 0.5, 0.5],
    ['25% fixo', 0.25, 0.25],
  ] as const;

  for (const prazo of [180, 365]) {
    console.log(`\n--- ${prazo} dias · bootstrap por BLOCOS de 30 dias · 5.000 futuros ---\n`);
    console.log(
      `${'tamanho da aposta'.padEnd(44)}${'entrou'.padStart(8)}${'perdeu'.padStart(8)}` +
        `${'lucro'.padStart(8)}${'pior 10%'.padStart(10)}${'típico'.padStart(8)}${'melhor 10%'.padStart(12)}${'metade'.padStart(8)}`,
    );
    console.log('-'.repeat(106));
    for (const [nome, fMedio, fForte] of CENARIOS) {
      const finais: number[] = [];
      let entrouTotal = 0;
      let perdidosTotal = 0;
      for (let s = 0; s < 5000; s += 1) {
        const amostra = sortearBlocos(ops, t0, t1, prazo, 30);
        const r = rodarCarteira(amostra, fMedio, fForte, 3.5, stopTipico);
        finais.push(r.final);
        entrouTotal += r.entrou;
        perdidosTotal += r.perdidos;
      }
      finais.sort((a, b) => a - b);
      const q = (p: number): number => finais[Math.floor(finais.length * p)] as number;
      console.log(
        `${nome.padEnd(44)}${(entrouTotal / 5000).toFixed(1).padStart(8)}` +
          `${(perdidosTotal / 5000).toFixed(1).padStart(8)}` +
          `${((finais.filter((f) => f > 100).length / finais.length) * 100).toFixed(0).padStart(7)}%` +
          `${q(0.1).toFixed(0).padStart(10)}${q(0.5).toFixed(0).padStart(8)}${q(0.9).toFixed(0).padStart(12)}` +
          `${((finais.filter((f) => f < 50).length / finais.length) * 100).toFixed(0).padStart(7)}%`,
      );
    }
  }
}

main().catch((error) => {
  console.error('Falhou:', error);
  process.exit(1);
});
