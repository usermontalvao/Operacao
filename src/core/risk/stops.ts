/**
 * Proteção da posição depois que ela abre.
 *
 * As duas operações abertas hoje contam a história: ZAMA subiu 6,19% de 7,29%
 * até o alvo e devolveu tudo; BOME subiu 4,95% de 6,23% e devolveu tudo. Com
 * alvo fixo e stop fixo, ganho que não encosta no alvo vira zero — ou vira
 * perda. Este módulo é o que trava o lucro no meio do caminho.
 */

import { type Side, bestOf, directionOf, gainPerUnit, isFavorable, stopBreached } from '../direction.ts';
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
  /**
   * Preço mais favorável visto desde a entrada: o topo de quem está comprado,
   * o fundo de quem está vendido. O nome ficou do tempo em que só havia compra.
   */
  highWaterPrice: number;
  currentPrice: number;
  /** o alvo 1 já preencheu */
  target1Filled: boolean;
  /** lado da posição; ausente = comprado, como era antes dos futuros */
  side?: Side;
}

/**
 * Novo stop, ou null quando nada muda. Duas invariantes, agora escritas nos
 * dois sentidos:
 *  1. stop só anda a favor — proteger é caminho de mão única (sobe no
 *     comprado, desce no vendido);
 *  2. stop nunca é colocado onde o preço de agora já o teria acionado, senão
 *     a proteção viraria uma saída imediata a mercado.
 */
export function nextProtectiveStop(context: StopContext, policy: StopPolicy): number | null {
  const { entryPrice, currentStop, highWaterPrice, currentPrice, target1Filled } = context;
  const side = context.side ?? 'BUY';
  if (entryPrice <= 0 || currentPrice <= 0) return null;

  let candidate = currentStop;

  if (policy.breakevenAfterTarget1 && target1Filled) {
    // o empate real fica além da entrada: as duas taxas precisam caber
    candidate = bestOf(side, candidate, breakevenPrice(entryPrice, policy.feePercent, side));
  }

  if (policy.trailingStopPercent > 0 && isFavorable(side, highWaterPrice, entryPrice)) {
    const trailing =
      highWaterPrice * (1 - directionOf(side) * (policy.trailingStopPercent / 100));
    // só arrasta depois que o trailing passou da entrada — antes disso ele
    // apenas apertaria o stop original sem ter lucro nenhum para proteger
    if (isFavorable(side, trailing, entryPrice)) candidate = bestOf(side, candidate, trailing);
  }

  if (!isFavorable(side, candidate, currentStop)) return null;
  if (stopBreached(side, currentPrice, candidate)) return null;
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
  side?: Side;
}): { target1: number; target2: number | null; target3: number | null; dropped: string[] } {
  const { entryPrice, target1, maxTargetPercent } = input;
  const side = input.side ?? 'BUY';
  const dropped: string[] = [];
  if (entryPrice <= 0 || maxTargetPercent <= 0) {
    return { target1, target2: input.target2, target3: input.target3, dropped };
  }

  // o teto é distância percorrida a favor, não preço: no vendido ele fica
  // ABAIXO da entrada, e comparar com "maior que" deixaria passar tudo
  const maxMove = entryPrice * (maxTargetPercent / 100);
  const keep = (target: number | null, label: string): number | null => {
    if (target === null) return null;
    // o chão vem antes do teto: preço negativo não é alvo longe demais, é
    // alvo que não existe. Só acontece no vendido, onde o ganho por unidade
    // é limitado pelo próprio preço de entrada
    if (!Number.isFinite(target) || target <= 0) {
      dropped.push(`${label} abaixo de zero — preço não existe ali`);
      return null;
    }
    const move = gainPerUnit(side, entryPrice, target);
    if (move <= maxMove) return target;
    dropped.push(`${label} a ${((move / entryPrice) * 100).toFixed(0)}% da entrada`);
    return null;
  };

  return {
    target1,
    target2: keep(input.target2, 'alvo 2'),
    target3: keep(input.target3, 'alvo 3'),
    dropped,
  };
}
