/**
 * AUDITORIA DO DESCARTE — o que os filtros estão jogando fora?
 *
 * Todo estudo anterior media o que PASSA pelos filtros. Isso responde "a
 * estratégia funciona?" e não responde a pergunta que mais importa depois de
 * meses operando pouco: "o filtro está me protegendo ou está me custando
 * dinheiro?". Elas parecem a mesma pergunta e não são — medir só o que passou
 * é conversar com a amostra que o próprio filtro escolheu.
 *
 * Aqui os pisos são derrubados de propósito (corpo a partir de 1 ATR, score a
 * partir de 30) e o resultado é medido FAIXA A FAIXA. Se a expectativa for
 * boa numa faixa hoje descartada, o filtro está custando; se for ruim, ele
 * está pagando o próprio preço.
 *
 * O corpo da explosão vem de `setup.evidence.burstBodyAtr` — o campo real.
 * A versão anterior deste estudo lia o número de dentro de uma FRASE
 * (`reasons[0].match(/([\d.]+) ATR/)`), o que é frágil de um jeito perigoso:
 * mudar a ordem das frases faria o valor virar zero e a operação sumir da
 * amostra em silêncio, sem erro nenhum.
 *
 *   node --experimental-strip-types src/lab/auditoria.ts --list=... --tf=4h
 */
import type { Outcome } from '../core/backtest/types.ts';
import type { Timeframe } from '../core/types.ts';
import { summarize } from '../core/backtest/metrics.ts';
import { BASE_POLICY, buildBtcContexts, collectSignals, labSettings, loadDataset, simulateAll } from './engine.ts';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? (hit.split('=')[1] ?? fallback) : fallback;
}

const POLITICA = { ...BASE_POLICY, scaleOut: [1, 0, 0] as [number, number, number], breakevenAfterTarget1: false };

interface Registro {
  outcome: Outcome;
  score: number;
  corpo: number | null;
  /** o valor que a extração frágil antiga teria produzido, para comparar */
  corpoPelaFrase: number | null;
}

function faixa(valor: number, bordas: number[]): string {
  for (let i = 0; i < bordas.length - 1; i += 1) {
    if (valor >= (bordas[i] as number) && valor < (bordas[i + 1] as number)) {
      return `${(bordas[i] as number).toFixed(2)} a ${(bordas[i + 1] as number).toFixed(2)}`;
    }
  }
  return `${(bordas[bordas.length - 1] as number).toFixed(2)} ou mais`;
}

function tabela(titulo: string, grupos: Map<string, Registro[]>, ordem: string[], dias: number): void {
  console.log(`\n${titulo}\n`);
  console.log(
    `${'faixa'.padEnd(18)}${'oper.'.padStart(7)}${'/dia'.padStart(7)}${'acerto'.padStart(8)}` +
      `${'exp.R'.padStart(9)}${'PF'.padStart(7)}${'soma R'.padStart(9)}`,
  );
  console.log('-'.repeat(65));
  for (const chave of ordem) {
    const lista = grupos.get(chave);
    if (!lista || lista.length === 0) continue;
    const st = summarize('x', lista.map((r) => r.outcome));
    console.log(
      `${chave.padEnd(18)}${String(st.filled).padStart(7)}${(st.filled / dias).toFixed(2).padStart(7)}` +
        `${((st.winRate * 100).toFixed(0) + '%').padStart(8)}` +
        `${((st.expectancyR >= 0 ? '+' : '') + st.expectancyR.toFixed(3)).padStart(9)}` +
        `${(Number.isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : '—').padStart(7)}` +
        `${st.totalR.toFixed(0).padStart(9)}`,
    );
  }
}

async function main(): Promise<void> {
  const symbols = arg('list', '').split(',').filter(Boolean);
  const days = Number(arg('days', '3400'));
  const gatilhos = arg('tf', '4h,1h').split(',') as Timeframe[];
  const pisoCorpo = Number(arg('piso', '1'));

  const base = labSettings();
  const cfg = labSettings({
    risk: { ...base.risk, minimumRiskReward: 0.3, minimumScoreToShow: 20, minimumScoreToAlert: 30 },
    scanner: { ...base.scanner, burstRequireBtcRegime: false },
  });
  const contextAt = await buildBtcContexts(days);

  for (const trigger of gatilhos) {
    const dataset = await loadDataset(symbols, days, [trigger, '4h', '1d']);
    const sinais = collectSignals(dataset, { trigger, settings: cfg, contextAt, pisoDoCorpoAtr: pisoCorpo });
    const outcomes = simulateAll(sinais, dataset, trigger, POLITICA, cfg);

    const registros: Registro[] = [];
    let t0 = Number.POSITIVE_INFINITY;
    let t1 = 0;
    for (const [i, s] of sinais.entries()) {
      const o = outcomes[i];
      if (!o || s.setup.setupType !== 'MOMENTUM_BURST') continue;
      const pelaFrase = Number(s.setup.reasons?.[0]?.match(/([\d.]+) ATR/)?.[1] ?? Number.NaN);
      registros.push({
        outcome: o,
        score: s.setup.score,
        corpo: s.setup.evidence?.burstBodyAtr ?? null,
        corpoPelaFrase: Number.isFinite(pelaFrase) ? pelaFrase : null,
      });
      t0 = Math.min(t0, o.openTime);
      t1 = Math.max(t1, o.openTime);
    }
    const dias = Math.max(1, (t1 - t0) / 86_400_000);
    const preenchidos = registros.filter((r) => r.outcome.filled);

    console.log(`\n${'='.repeat(78)}`);
    console.log(
      `GATILHO ${trigger} · ${dataset.length} pares · piso do corpo derrubado para ${pisoCorpo} ATR`,
    );
    console.log(`${registros.length} sinais · ${preenchidos.length} viraram operação · ${Math.round(dias)} dias`);
    console.log('='.repeat(78));

    // --- a extração frágil: quanto ela perdia? ---
    const semCampo = registros.filter((r) => r.corpo === null).length;
    const semFrase = registros.filter((r) => r.corpoPelaFrase === null).length;
    const divergem = registros.filter(
      (r) => r.corpo !== null && r.corpoPelaFrase !== null && Math.abs(r.corpo - r.corpoPelaFrase) > 0.051,
    ).length;
    console.log(`\n--- O CAMPO CONTRA A EXTRAÇÃO POR TEXTO ---`);
    console.log(`  sinais sem o campo burstBodyAtr ......... ${semCampo}`);
    console.log(`  sinais em que a frase não deu número .... ${semFrase}`);
    console.log(`  divergências acima de 0,05 ATR .......... ${divergem}`);

    // --- score, TODAS as faixas ---
    const porScore = new Map<string, Registro[]>();
    const bordasScore = [30, 60, 70, 75, 80, 85, 90, 95];
    for (const r of preenchidos) {
      const chave = faixa(r.score, bordasScore);
      porScore.set(chave, [...(porScore.get(chave) ?? []), r]);
    }
    tabela(
      '--- 1. SCORE: todas as faixas, inclusive as que a produção descarta ---',
      porScore,
      [...porScore.keys()].sort(),
      dias,
    );
    const abaixo = preenchidos.filter((r) => r.score < 85);
    const acima = preenchidos.filter((r) => r.score >= 85);
    const stA = summarize('a', abaixo.map((r) => r.outcome));
    const stB = summarize('b', acima.map((r) => r.outcome));
    console.log(
      `\n  DESCARTADO hoje (score < 85): ${stA.filled} operações · ` +
        `${(stA.expectancyR >= 0 ? '+' : '') + stA.expectancyR.toFixed(3)}R · soma ${stA.totalR.toFixed(0)}R`,
    );
    console.log(
      `  ACEITO hoje  (score >= 85): ${stB.filled} operações · ` +
        `${(stB.expectancyR >= 0 ? '+' : '') + stB.expectancyR.toFixed(3)}R · soma ${stB.totalR.toFixed(0)}R`,
    );

    // --- corpo, faixas finas ---
    const bordasCorpo = [1, 1.5, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 4, 5];
    const porCorpo = new Map<string, Registro[]>();
    for (const r of preenchidos) {
      if (r.corpo === null) continue;
      const chave = faixa(r.corpo, bordasCorpo);
      porCorpo.set(chave, [...(porCorpo.get(chave) ?? []), r]);
    }
    const ordemCorpo = [...porCorpo.keys()].sort(
      (a, b) => Number.parseFloat(a) - Number.parseFloat(b),
    );
    tabela('--- 2. CORPO DA EXPLOSÃO em faixas finas: onde está o ponto ótimo? ---', porCorpo, ordemCorpo, dias);

    // --- cruzamento score x corpo ---
    console.log(`\n--- 3. CRUZAMENTO score x corpo (expectativa em R; "·" = amostra < 40) ---\n`);
    const fCorpo = [
      ['1,0-2,5', (c: number) => c < 2.5],
      ['2,5-3,0', (c: number) => c >= 2.5 && c < 3],
      ['3,0-3,5', (c: number) => c >= 3 && c < 3.5],
      ['3,5-5,0', (c: number) => c >= 3.5 && c < 5],
      ['5,0+', (c: number) => c >= 5],
    ] as const;
    const fScore = [
      ['<70', (s: number) => s < 70],
      ['70-79', (s: number) => s >= 70 && s < 80],
      ['80-84', (s: number) => s >= 80 && s < 85],
      ['85-89', (s: number) => s >= 85 && s < 90],
      ['90+', (s: number) => s >= 90],
    ] as const;
    console.log(`${'corpo \\ score'.padEnd(14)}${fScore.map(([n]) => n.padStart(11)).join('')}`);
    console.log('-'.repeat(14 + fScore.length * 11));
    for (const [nomeC, testeC] of fCorpo) {
      const celulas = fScore.map(([, testeS]) => {
        const l = preenchidos.filter((r) => r.corpo !== null && testeC(r.corpo) && testeS(r.score));
        if (l.length < 40) return `·(${l.length})`.padStart(11);
        const st = summarize('c', l.map((r) => r.outcome));
        return `${(st.expectancyR >= 0 ? '+' : '') + st.expectancyR.toFixed(2)}(${l.length})`.padStart(11);
      });
      console.log(`${nomeC.padEnd(14)}${celulas.join('')}`);
    }
  }
}

main().catch((error) => {
  console.error('Auditoria falhou:', error);
  process.exit(1);
});
