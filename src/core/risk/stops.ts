/**
 * Proteção da posição depois que ela abre.
 *
 * As duas operações abertas hoje contam a história: ZAMA subiu 6,19% de 7,29%
 * até o alvo e devolveu tudo; BOME subiu 4,95% de 6,23% e devolveu tudo. Com
 * alvo fixo e stop fixo, ganho que não encosta no alvo vira zero — ou vira
 * perda. Este módulo é o que trava o lucro no meio do caminho.
 */

import { breakevenPrice } from './costs.ts';

export interface StopPolicy {
  /** leva o stop para o empate assim que o alvo 1 preenche */
  breakevenAfterTarget1: boolean;
  /** stop que segue o preço, em % abaixo do topo alcançado (0 = desligado) */
  trailingStopPercent: number;
  feePercent: number;
}

export interface StopContext {
  entryPrice: number;
  currentStop: number;
  /** maior preço visto desde a entrada */
  highWaterPrice: number;
  currentPrice: number;
  /** o alvo 1 já preencheu */
  target1Filled: boolean;
}

/**
 * Novo stop, ou null quando nada muda. Duas invariantes:
 *  1. stop nunca desce — proteger é caminho de mão única;
 *  2. stop nunca é colocado acima do preço atual, senão a proteção viraria
 *     uma venda imediata a mercado.
 */
export function nextProtectiveStop(context: StopContext, policy: StopPolicy): number | null {
  const { entryPrice, currentStop, highWaterPrice, currentPrice, target1Filled } = context;
  if (entryPrice <= 0 || currentPrice <= 0) return null;

  let candidate = currentStop;

  if (policy.breakevenAfterTarget1 && target1Filled) {
    // o empate real fica acima da entrada: as duas taxas precisam caber
    candidate = Math.max(candidate, breakevenPrice(entryPrice, policy.feePercent));
  }

  if (policy.trailingStopPercent > 0 && highWaterPrice > entryPrice) {
    const trailing = highWaterPrice * (1 - policy.trailingStopPercent / 100);
    // só arrasta depois que o trailing passou da entrada — antes disso ele
    // apenas apertaria o stop original sem ter lucro nenhum para proteger
    if (trailing > entryPrice) candidate = Math.max(candidate, trailing);
  }

  if (candidate <= currentStop) return null;
  if (candidate >= currentPrice) return null;
  return candidate;
}

/**
 * Alvo que o mercado não vai entregar é o mesmo que não ter alvo.
 *
 * O detector chegou a produzir alvo 2 a +94% e alvo 3 a +105% sobre a entrada
 * (ONGUSDT). Metade da posição sairia no alvo 1 e a outra metade ficaria
 * pendurada para sempre, sem plano. Alvo além do teto vira null: dali em
 * diante quem manda é o stop que sobe.
 */
export function sanitizeTargets(input: {
  entryPrice: number;
  target1: number;
  target2: number | null;
  target3: number | null;
  maxTargetPercent: number;
}): { target1: number; target2: number | null; target3: number | null; dropped: string[] } {
  const { entryPrice, target1, maxTargetPercent } = input;
  const dropped: string[] = [];
  if (entryPrice <= 0 || maxTargetPercent <= 0) {
    return { target1, target2: input.target2, target3: input.target3, dropped };
  }

  const ceiling = entryPrice * (1 + maxTargetPercent / 100);
  const keep = (target: number | null, label: string): number | null => {
    if (target === null) return null;
    if (target <= ceiling) return target;
    dropped.push(`${label} a ${(((target - entryPrice) / entryPrice) * 100).toFixed(0)}% da entrada`);
    return null;
  };

  return {
    target1,
    target2: keep(input.target2, 'alvo 2'),
    target3: keep(input.target3, 'alvo 3'),
    dropped,
  };
}
