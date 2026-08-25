import { roundDownToStep } from '../risk/filters.ts';

/** Saída em três etapas: 50% no alvo 1, 30% no alvo 2 e o resto no alvo 3. */
export const SCALE_OUT = [0.5, 0.3, 0.2] as const;

export type ExitKind = 'TARGET1' | 'TARGET2' | 'TARGET3';

export interface ExitTranche {
  kind: ExitKind;
  price: number;
  quantity: number;
}

export interface ExitPlanFilters {
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export interface ExitPlanInput {
  quantity: number;
  target1: number;
  target2: number | null;
  target3: number | null;
  /** fração da posição em cada alvo — a mesma para papel e para conta real */
  shares: readonly [number, number, number];
  filters: ExitPlanFilters;
}

export interface ExitPlan {
  /** SCALE_OUT = saída em partes; SINGLE = tudo no alvo 1 */
  kind: 'SCALE_OUT' | 'SINGLE';
  tranches: ExitTranche[];
  /** por que o plano ficou diferente do pedido — vai para a auditoria */
  notes: string[];
}

/** Sem filtros de corretora: é assim que o papel enxerga o mercado. */
export const NO_FILTERS: ExitPlanFilters = { stepSize: 0, minQty: 0, minNotional: 0 };

/**
 * Plano de saída de uma posição — a única fonte da verdade.
 *
 * Existe porque papel e conta real estavam executando estratégias diferentes:
 * o papel realizava 50/30/20 nos três alvos e a conta real mandava a posição
 * inteira para um único alvo. Desempenho medido no papel não dizia nada sobre
 * a conta real. Agora os dois derivam daqui; o que muda entre eles é só o que
 * a corretora impõe (lote mínimo e valor mínimo), e o que a corretora impôs
 * fica escrito em `notes`.
 */
export function buildExitPlan(input: ExitPlanInput): ExitPlan {
  const { quantity, filters } = input;
  const notes: string[] = [];
  if (quantity <= 0) return { kind: 'SINGLE', tranches: [], notes: ['Sem quantidade para vender'] };

  const all: Array<{ kind: ExitKind; price: number; share: number }> = [
    { kind: 'TARGET1', price: input.target1, share: input.shares[0] },
    { kind: 'TARGET2', price: input.target2 ?? 0, share: input.shares[1] },
    { kind: 'TARGET3', price: input.target3 ?? 0, share: input.shares[2] },
  ];
  const wanted = all.filter((item) => item.price > 0 && item.share > 0);

  if (wanted.length === 0) {
    return { kind: 'SINGLE', tranches: [], notes: ['Nenhum alvo válido'] };
  }
  if (input.target2 === null || input.target3 === null) {
    notes.push('Alvo distante removido antes do plano');
  }

  // tira o alvo que a corretora recusaria e devolve a fatia dele para os outros
  let candidates = [...wanted];
  for (let attempt = 0; attempt < wanted.length; attempt += 1) {
    const tranches = distribute(quantity, candidates, filters);
    const offender = tranches.findIndex(
      (item) =>
        item.quantity <= 0 ||
        item.quantity < filters.minQty ||
        (filters.minNotional > 0 && item.quantity * item.price < filters.minNotional),
    );
    if (offender < 0) {
      return {
        kind: tranches.length > 1 ? 'SCALE_OUT' : 'SINGLE',
        tranches,
        notes,
      };
    }
    if (candidates.length === 1) break;
    const dropped = candidates[candidates.length - 1] as { kind: ExitKind };
    notes.push(`${dropped.kind} não cabe no mínimo da corretora — fatia devolvida aos alvos restantes`);
    candidates = candidates.slice(0, -1);
  }

  // nem uma parcela passa: sai tudo no alvo 1, como antes
  const single = roundDownToStep(quantity, filters.stepSize) || quantity;
  notes.push('Posição pequena demais para sair em partes — saída única no alvo 1');
  return {
    kind: 'SINGLE',
    tranches: [{ kind: 'TARGET1', price: input.target1, quantity: single }],
    notes,
  };
}

/**
 * Reparte a quantidade entre os alvos que sobraram. A última parcela leva o
 * resto: assim a soma fecha exatamente com a posição, sem poeira presa.
 */
function distribute(
  quantity: number,
  candidates: Array<{ kind: ExitKind; price: number; share: number }>,
  filters: ExitPlanFilters,
): ExitTranche[] {
  const totalShare = candidates.reduce((total, item) => total + item.share, 0);
  if (totalShare <= 0) return [];

  const tranches: ExitTranche[] = [];
  let assigned = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i] as { kind: ExitKind; price: number; share: number };
    const isLast = i === candidates.length - 1;
    const raw = isLast ? quantity - assigned : quantity * (candidate.share / totalShare);
    const amount = roundDownToStep(raw, filters.stepSize);
    assigned += amount;
    tranches.push({ kind: candidate.kind, price: candidate.price, quantity: amount });
  }
  return tranches;
}
