/**
 * REGRAS CANDIDATAS — a tabela de faixas não decide nada sozinha.
 *
 * A auditoria mostrou um pico bonito no corpo entre 3,0 e 3,5 ATR (+0,56 e
 * +0,61R). Escolher a regra por ali seria repetir o erro contra o qual este
 * laboratório inteiro foi construído: com onze faixas, alguma vai parecer
 * ótima por sorte, e a mais extrema é justamente a candidata a sorteio.
 *
 * Então cada regra candidata passa pelas MESMAS quatro provas das outras:
 * treino e teste, as duas metades do universo, e as cinco janelas de tempo.
 *
 *   node --experimental-strip-types src/lab/regras.ts --list=... --tf=4h
 */
import type { Outcome } from '../core/backtest/types.ts';
import type { Timeframe } from '../core/types.ts';
import { summarize } from '../core/backtest/metrics.ts';
import { BASE_POLICY, buildBtcContexts, collectSignals, labSettings, loadDataset, simulateAll } from './engine.ts';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? (hit.split('=')[1] ?? fallback) : fallback;
}

interface Regra {
  nome: string;
  aceita(score: number, corpo: number): boolean;
}

const REGRAS: Regra[] = [
  // as três que o pedido manda comparar, em dados idênticos
  { nome: 'ANTES: corpo>=2,5 + score>=85', aceita: (s, c) => c >= 2.5 && s >= 85 },
  { nome: 'NOVA: corpo>=2,0, sem score', aceita: (_s, c) => c >= 2.0 },
  { nome: 'NOVA/NORMAL: 2,0 a 3,0', aceita: (_s, c) => c >= 2.0 && c < 3.0 },
  { nome: 'NOVA/STRONG: corpo>=3,0', aceita: (_s, c) => c >= 3.0 },
  // referências, para enxergar o entorno sem garimpar
  { nome: 'ref: corpo>=2,5, sem score', aceita: (_s, c) => c >= 2.5 },
  { nome: 'ref: score>=85, sem corpo', aceita: (s) => s >= 85 },
];

function prova(outcomes: Outcome[]): {
  ok: boolean;
  treino: number;
  teste: number;
  a: number;
  b: number;
  janelas: number;
} {
  const ord = [...outcomes].sort((x, y) => x.openTime - y.openTime);
  const corte = Math.floor(ord.length * 0.7);
  const treino = summarize('T', ord.slice(0, corte)).expectancyR;
  const teste = summarize('t', ord.slice(corte)).expectancyR;
  const pares = [...new Set(ord.map((o) => o.symbol))].sort();
  const metadeA = new Set(pares.filter((_, i) => i % 2 === 0));
  const a = summarize('A', ord.filter((o) => metadeA.has(o.symbol))).expectancyR;
  const b = summarize('B', ord.filter((o) => !metadeA.has(o.symbol))).expectancyR;
  let janelas = 0;
  const passo = Math.max(1, Math.ceil(ord.length / 5));
  for (let f = 0; f < 5; f += 1) {
    const fatia = ord.slice(f * passo, (f + 1) * passo);
    if (fatia.length > 0 && summarize('j', fatia).expectancyR > 0) janelas += 1;
  }
  return {
    ok: ord.length >= 150 && treino > 0 && teste > 0 && a > 0 && b > 0 && janelas >= 4,
    treino,
    teste,
    a,
    b,
    janelas,
  };
}

async function main(): Promise<void> {
  const symbols = arg('list', '').split(',').filter(Boolean);
  const days = Number(arg('days', '3400'));
  const gatilhos = arg('tf', '4h').split(',') as Timeframe[];

  const base = labSettings();
  const cfg = labSettings({
    risk: { ...base.risk, minimumRiskReward: 0.3, minimumScoreToShow: 20, minimumScoreToAlert: 30 },
    scanner: { ...base.scanner, burstRequireBtcRegime: false },
  });
  const contextAt = await buildBtcContexts(days);

  for (const trigger of gatilhos) {
    const dataset = await loadDataset(symbols, days, [trigger, '4h', '1d']);
    const sinais = collectSignals(dataset, { trigger, settings: cfg, contextAt, pisoDoCorpoAtr: 1 });
    const outcomes = simulateAll(sinais, dataset, trigger, { ...BASE_POLICY, scaleOut: [1, 0, 0], breakevenAfterTarget1: false }, cfg);

    const registros: Array<{ o: Outcome; score: number; corpo: number }> = [];
    let t0 = Number.POSITIVE_INFINITY;
    let t1 = 0;
    for (const [i, s] of sinais.entries()) {
      const o = outcomes[i];
      const corpo = s.setup.evidence?.burstBodyAtr;
      if (!o || !o.filled || s.setup.setupType !== 'MOMENTUM_BURST' || corpo === null || corpo === undefined) continue;
      registros.push({ o, score: s.setup.score, corpo });
      t0 = Math.min(t0, o.openTime);
      t1 = Math.max(t1, o.openTime);
    }
    const dias = Math.max(1, (t1 - t0) / 86_400_000);

    console.log(`\n${'='.repeat(96)}`);
    console.log(`GATILHO ${trigger} · ${dataset.length} pares · ${registros.length} explosões medidas · ${Math.round(dias)} dias`);
    console.log('='.repeat(96));
    console.log(
      `\n${'regra'.padEnd(32)}${'oper.'.padStart(7)}${'/dia'.padStart(7)}${'exp.R'.padStart(9)}` +
        `${'PF'.padStart(6)}${'soma R'.padStart(8)}${'treino'.padStart(8)}${'teste'.padStart(8)}` +
        `${'A'.padStart(7)}${'B'.padStart(7)}${'jan'.padStart(5)}${'passa?'.padStart(8)}`,
    );
    console.log('-'.repeat(96));
    for (const regra of REGRAS) {
      const lista = registros.filter((r) => regra.aceita(r.score, r.corpo)).map((r) => r.o);
      if (lista.length === 0) continue;
      const st = summarize('x', lista);
      const p = prova(lista);
      console.log(
        `${regra.nome.padEnd(32)}${String(lista.length).padStart(7)}${(lista.length / dias).toFixed(2).padStart(7)}` +
          `${((st.expectancyR >= 0 ? '+' : '') + st.expectancyR.toFixed(3)).padStart(9)}` +
          `${(Number.isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : '—').padStart(6)}` +
          `${st.totalR.toFixed(0).padStart(8)}` +
          `${((p.treino >= 0 ? '+' : '') + p.treino.toFixed(2)).padStart(8)}` +
          `${((p.teste >= 0 ? '+' : '') + p.teste.toFixed(2)).padStart(8)}` +
          `${((p.a >= 0 ? '+' : '') + p.a.toFixed(2)).padStart(7)}` +
          `${((p.b >= 0 ? '+' : '') + p.b.toFixed(2)).padStart(7)}` +
          `${(p.janelas + '/5').padStart(5)}${(p.ok ? 'SIM' : 'não').padStart(8)}`,
      );
    }
  }
}

main().catch((error) => {
  console.error('Falhou:', error);
  process.exit(1);
});
