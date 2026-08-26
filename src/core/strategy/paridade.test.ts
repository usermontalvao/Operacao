import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { VALIDATED_AUTOMATIC_SETUP_TYPES } from './automationPolicy.ts';
import type { SetupType } from '../types.ts';

/** Os quatro detectores que existem. Se nascer um quinto, este teste cobra. */
const TODOS: SetupType[] = ['PULLBACK', 'BREAKOUT_RETEST', 'SUPPORT_REVERSAL', 'MOMENTUM_BURST'];

/**
 * A tela de ordem marca as estratégias observacionais em vermelho a partir de
 * uma lista PRÓPRIA, no navegador — ela não pode importar do servidor. Duas
 * listas que precisam concordar sempre acabam discordando um dia, e o dia em
 * que discordarem a tela vai dizer "expectativa positiva" sobre uma
 * estratégia reprovada. Este teste é a costura entre as duas.
 */
test('a lista de observacionais da tela é o avesso exato da lista validada', async () => {
  const modal = await readFile(
    new URL('../../../web/src/components/BuyModal.tsx', import.meta.url),
    'utf8',
  );
  const bloco = /const OBSERVACIONAL = new Set<TradeSetup\['setupType'\]>\(\[([^\]]+)\]\)/.exec(modal);
  assert.ok(bloco, 'não encontrei a lista OBSERVACIONAL no BuyModal');

  const naTela = new Set(
    (bloco[1] as string)
      .split(',')
      .map((item) => item.trim().replace(/^'|'$/g, ''))
      .filter(Boolean),
  );

  const esperado = TODOS.filter((type) => !VALIDATED_AUTOMATIC_SETUP_TYPES.includes(type));

  assert.deepEqual([...naTela].sort(), [...esperado].sort());
});
