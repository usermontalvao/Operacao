import { gainPerUnit, type Side } from '../direction.ts';

/** Níveis que podem ser ajustados pelo usuário antes e depois da entrada. */
export interface EditableTradePlan {
  stopLoss: number;
  target1: number;
  target2: number | null;
  target3: number | null;
}

/**
 * O prejuízo máximo que um stop pode desenhar, em % do preço de entrada.
 *
 * Não é preferência de risco — o tamanho da posição já cuida disso. É um teto
 * de sanidade: um stop a mais de 30% do preço não é proteção, é a ausência
 * dela com aparência de plano. Ele nasce de par ilíquido, de alvo digitado no
 * campo errado e de tese com invalidação absurda; em todos esses casos a
 * ordem certa é a que não sai.
 *
 * Vale para a ordem automática e para a manual, e a confirmação de "ordem
 * forçada" NÃO o desarma: forçar existe para atropelar régua própria (R/R
 * mínimo, teto de exposição), nunca para operar sem proteção.
 */
export const MAX_STOP_DISTANCE_PERCENT = 30;

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
  // Sem stop não há ordem. Um plano que chega aqui com stop nulo, zerado ou
  // não numérico não é "um plano sem stop": é um plano quebrado, e deixá-lo
  // passar criaria posição sem saída na conta real.
  if (plan.stopLoss === null || plan.stopLoss === undefined || !Number.isFinite(plan.stopLoss)) {
    errors.push('Ordem sem stop não é permitida — defina o preço de invalidação');
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

  const distanciaDoStop = (Math.abs(referencePrice - plan.stopLoss) / referencePrice) * 100;
  if (distanciaDoStop > MAX_STOP_DISTANCE_PERCENT) {
    errors.push(
      `Stop a ${distanciaDoStop.toFixed(1)}% do preço — acima do teto de ${MAX_STOP_DISTANCE_PERCENT}%. Um stop tão largo não protege a posição`,
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
