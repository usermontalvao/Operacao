import { gainPerUnit, type Side } from '../direction.ts';

/** Níveis que podem ser ajustados pelo usuário antes e depois da entrada. */
export interface EditableTradePlan {
  stopLoss: number;
  target1: number;
  target2: number | null;
  target3: number | null;
}

/**
 * Confere um plano contra o preço em que ele passará a valer.
 *
 * Para uma ordem nova, `referencePrice` é a entrada aprovada. Para uma
 * posição aberta, é o preço vivo: assim um stop arrastado para além do preço
 * atual não vira uma saída instantânea e um alvo já ultrapassado não nasce
 * executado.
 */
export function validateTradePlan(
  plan: EditableTradePlan,
  side: Side,
  referencePrice: number,
): string[] {
  const errors: string[] = [];
  const named: Array<[string, number | null]> = [
    ['Stop', plan.stopLoss],
    ['Alvo 1', plan.target1],
    ['Alvo 2', plan.target2],
    ['Alvo 3', plan.target3],
  ];

  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return ['Preço de referência indisponível para validar stop e alvos'];
  }
  for (const [label, value] of named) {
    if (value !== null && (!Number.isFinite(value) || value <= 0)) {
      errors.push(`${label} precisa ser um preço positivo`);
    }
  }
  if (errors.length > 0) return errors;

  if (gainPerUnit(side, referencePrice, plan.stopLoss) >= 0) {
    errors.push(
      side === 'BUY'
        ? 'O stop precisa ficar abaixo do preço atual'
        : 'O stop precisa ficar acima do preço atual',
    );
  }
  if (gainPerUnit(side, referencePrice, plan.target1) <= 0) {
    errors.push(
      side === 'BUY'
        ? 'O alvo 1 precisa ficar acima do preço atual'
        : 'O alvo 1 precisa ficar abaixo do preço atual',
    );
  }

  if (plan.target2 !== null && gainPerUnit(side, plan.target1, plan.target2) <= 0) {
    errors.push('O alvo 2 precisa ficar depois do alvo 1');
  }
  if (plan.target3 !== null && plan.target2 === null) {
    errors.push('O alvo 3 exige um alvo 2');
  } else if (
    plan.target3 !== null &&
    plan.target2 !== null &&
    gainPerUnit(side, plan.target2, plan.target3) <= 0
  ) {
    errors.push('O alvo 3 precisa ficar depois do alvo 2');
  }

  return errors;
}
