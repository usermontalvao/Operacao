/**
 * Qual estratégia pode operar sozinha?
 *
 * Hoje só MOMENTUM_BURST pode, e a regra que decide isso é dura de propósito:
 * expectativa positiva no TREINO **e** no TESTE. Uma estratégia que só ganha
 * no treino é ajuste de curva; uma que só ganha no teste é sorte de janela.
 * Exigir as duas é o que impede ligar o robô em cima de ruído.
 *
 * Este estudo refaz a pergunta com o histórico de hoje, estratégia por
 * estratégia, e mostra o veredito com o número que o produziu — inclusive o
 * tamanho da amostra, porque expectativa medida em cinco operações não é
 * expectativa, é anedota.
 *
 *   node --env-file-if-exists=.env src/lab/estrategias.ts --symbols=25 --days=540
 */

import { summarize, type Stats } from '../core/backtest/metrics.ts';
import type { Outcome } from '../core/backtest/types.ts';
import type { SetupType } from '../core/types.ts';
import {
  MIN_VALIDATED_AUTOMATIC_SCORE,
  VALIDATED_AUTOMATIC_SETUP_TYPES,
} from '../core/strategy/automationPolicy.ts';
import { BASE_POLICY, simulateAll } from './engine.ts';
import { byWindow, prepare } from './study.ts';

/** Abaixo disto o número não sustenta uma decisão sobre dinheiro de verdade. */
const AMOSTRA_MINIMA = 30;

const TIPOS: SetupType[] = ['MOMENTUM_BURST', 'PULLBACK', 'BREAKOUT_RETEST', 'SUPPORT_REVERSAL'];

function linha(rotulo: string, stats: Stats): string {
  return [
    rotulo.padEnd(30),
    String(stats.filled).padStart(6),
    `${(stats.winRate * 100).toFixed(1)}%`.padStart(8),
    `${stats.expectancyR >= 0 ? '+' : ''}${stats.expectancyR.toFixed(3)}`.padStart(9),
    stats.profitFactor.toFixed(2).padStart(7),
    `${stats.totalR >= 0 ? '+' : ''}${stats.totalR.toFixed(1)}`.padStart(9),
  ].join(' ');
}

function cabecalho(): void {
  console.log(
    `${'estratégia'.padEnd(30)} ${'oper.'.padStart(6)} ${'acerto'.padStart(8)} ` +
      `${'expec.R'.padStart(9)} ${'PF'.padStart(7)} ${'totalR'.padStart(9)}`,
  );
  console.log('-'.repeat(76));
}

interface Veredito {
  tipo: SetupType;
  treino: Stats;
  teste: Stats;
  aprovada: boolean;
  motivo: string;
}

export function julgar(tipo: SetupType, treino: Stats, teste: Stats): Veredito {
  /*
   * Trinta no total não basta. Antes, 28 operações no treino e apenas 5 no
   * teste somavam 33 e o relatório escrevia "PODE" — justamente o tipo de
   * falsa confiança que a separação treino/teste deveria impedir. Cada
   * janela precisa sustentar a própria conclusão.
   */
  if (treino.filled < AMOSTRA_MINIMA || teste.filled < AMOSTRA_MINIMA) {
    return {
      tipo,
      treino,
      teste,
      aprovada: false,
      motivo:
        `amostra insuficiente por janela: ${treino.filled} no treino e ${teste.filled} no teste ` +
        `(mínimo ${AMOSTRA_MINIMA} em cada)`,
    };
  }
  if (treino.expectancyR <= 0) {
    return { tipo, treino, teste, aprovada: false, motivo: 'expectativa negativa no treino' };
  }
  if (teste.expectancyR <= 0) {
    return {
      tipo,
      treino,
      teste,
      aprovada: false,
      motivo: 'ganha no treino e perde no teste — é ajuste de curva',
    };
  }
  return {
    tipo,
    treino,
    teste,
    aprovada: true,
    motivo: `positiva nas duas janelas (${treino.filled} treino + ${teste.filled} teste)`,
  };
}

async function main(): Promise<void> {
  const { dataset, signals, settings, splitAt } = await prepare();
  const todos = simulateAll(signals, dataset, '1h', BASE_POLICY, settings);

  for (const piso of [0, MIN_VALIDATED_AUTOMATIC_SCORE]) {
    console.log(
      `\n########## ${piso === 0 ? 'TODAS AS TESES (sem piso de score)' : `SÓ COM SCORE >= ${piso} — o piso que o robô usa`} ##########\n`,
    );
    cabecalho();

    const vereditos: Veredito[] = [];
    for (const tipo of TIPOS) {
      const daEstrategia = todos.filter(
        (item: Outcome) => item.setupType === tipo && item.score >= piso,
      );
      const janelas = byWindow(daEstrategia, splitAt);
      const treino = summarize(`${tipo} treino`, janelas.train);
      const teste = summarize(`${tipo} teste`, janelas.test);
      console.log(linha(`${tipo} · treino`, treino));
      console.log(linha(`${tipo} · teste`, teste));
      vereditos.push(julgar(tipo, treino, teste));
    }

    if (piso === MIN_VALIDATED_AUTOMATIC_SCORE) {
      console.log('\n---------- VEREDITO ----------');
      for (const v of vereditos) {
        const jaLiberada = (VALIDATED_AUTOMATIC_SETUP_TYPES as readonly string[]).includes(v.tipo);
        const marca = v.aprovada ? 'PODE' : 'NÃO PODE';
        const mudanca =
          v.aprovada && !jaLiberada
            ? '  <<< LIBERAR'
            : !v.aprovada && jaLiberada
              ? '  <<< REVOGAR'
              : '';
        console.log(`${marca.padEnd(9)} ${v.tipo.padEnd(18)} ${v.motivo}${mudanca}`);
      }
      console.log(
        `\nHoje o robô opera: ${VALIDATED_AUTOMATIC_SETUP_TYPES.join(', ')}.` +
          '\nRegra: só entra quem for positiva NAS DUAS janelas e tiver amostra suficiente.',
      );
    }
  }
}

if (process.argv[1]?.endsWith('estrategias.ts')) {
  main().catch((error) => {
    console.error('Estudo falhou:', error);
    process.exit(1);
  });
}
