import { type Side, gainPerUnit } from '../direction.ts';
import type { CostSettings } from '../risk/costs.ts';
import { netRiskReward } from '../risk/costs.ts';
import type { LiquiditySnapshot, MicroEconomics } from '../types.ts';

/**
 * O custo VERDADEIRO de uma viagem, par a par.
 *
 * O resto do sistema trabalha com um custo declarado nas Configurações — uma
 * taxa e dois escorregamentos, iguais para todos os pares. Para tese de 1h
 * isso basta: o custo é ruído perto do alvo. Para o micro scalp é o contrário,
 * o custo é o termo dominante da conta, e um número igual para todos os pares
 * mentiria nos dois sentidos: superestimaria o BTC (spread zero) e
 * subestimaria uma altcoin de book raso, que é justamente onde a nota alta de
 * volatilidade convidaria a operar.
 *
 * Por isso aqui o spread e o escorregamento vêm MEDIDOS do book, e só a taxa
 * vem da configuração — porque a taxa é da conta e da modalidade (spot cobra
 * o dobro de futuros), não do par.
 */
export interface MicroCostInput {
  /** taxa por lado, em %; vem do guard da conta/modalidade ativa */
  feePercent: number;
  /** medição real do book deste par */
  liquidity: LiquiditySnapshot;
  /** piso de escorregamento quando o book não pôde ser varrido */
  fallbackSlippagePercent: number;
}

/**
 * Tudo que a operação paga só por existir, em % do valor negociado.
 *
 * As duas taxas, metade do spread (que é o que se paga ao cruzar o book) e o
 * escorregamento medido — contado nas DUAS pontas, porque entra e sai.
 */
export function allInCostPercent(input: MicroCostInput): number {
  const { feePercent, liquidity, fallbackSlippagePercent } = input;
  const slippage = liquidity.slippagePercent ?? fallbackSlippagePercent;
  const spreadCost = Math.max(liquidity.spreadPercent, 0) / 2;
  return feePercent * 2 + spreadCost * 2 + Math.max(slippage, 0) * 2;
}

export interface MicroEconomicsInput {
  side: Side;
  entryPrice: number;
  stopLoss: number;
  target: number;
  feePercent: number;
  liquidity: LiquiditySnapshot;
  /** custos declarados da conta — usados só para o R/R líquido e o fallback */
  costs: CostSettings;
}

/**
 * A conta completa de uma oportunidade de micro scalp.
 *
 * `costMultiple` é o número que decide: quantas vezes o movimento esperado
 * paga o custo. Abaixo de 1 a operação nasce no prejuízo mesmo ACERTANDO —
 * e é essa a situação que o módulo inteiro existe para nunca deixar passar.
 */
export function computeMicroEconomics(input: MicroEconomicsInput): MicroEconomics {
  const { side, entryPrice, stopLoss, target, feePercent, liquidity, costs } = input;

  const slippage = liquidity.slippagePercent ?? costs.exitSlippagePercent;
  const spreadCost = Math.max(liquidity.spreadPercent, 0) / 2;
  const allIn = allInCostPercent({
    feePercent,
    liquidity,
    fallbackSlippagePercent: costs.exitSlippagePercent,
  });

  const gross =
    entryPrice > 0 ? (gainPerUnit(side, entryPrice, target) / entryPrice) * 100 : 0;
  const net = gross - allIn;

  return {
    entryFeePercent: feePercent,
    exitFeePercent: feePercent,
    spreadCostPercent: spreadCost * 2,
    estimatedSlippagePercent: Math.max(slippage, 0) * 2,
    allInCostPercent: allIn,
    grossExpectedProfitPercent: gross,
    netExpectedProfitPercent: net,
    // custo zero não existe na prática; guardar contra divisão por zero evita
    // que um book perfeito devolva Infinity e passe em qualquer trava
    costMultiple: allIn > 0 ? gross / allIn : 0,
    // preenchido por quem chama, que é quem conhece os limites configurados
    warning: null,
    netRiskReward: netRiskReward({
      entryPrice,
      stopLoss,
      target,
      side,
      costs: {
        ...costs,
        feePercent,
        // o escorregamento medido substitui o declarado: é o mesmo conceito,
        // só que com o número deste par em vez do número médio da conta
        exitSlippagePercent: Math.max(slippage, costs.exitSlippagePercent),
      },
    }),
  };
}

/**
 * O guarda de oportunidade. Duas perguntas, ambas obrigatórias:
 * o movimento paga o custo o suficiente? e o risco compensa depois de tudo?
 */
export function microOpportunityRejection(
  economics: MicroEconomics,
  minCostMultiple: number,
  minNetRiskReward: number,
): string | null {
  if (economics.netExpectedProfitPercent <= 0) {
    return `lucro líquido estimado de ${economics.netExpectedProfitPercent.toFixed(3)}% — a operação nasce no prejuízo mesmo acertando`;
  }
  if (economics.costMultiple < minCostMultiple) {
    return `movimento esperado paga só ${economics.costMultiple.toFixed(1)}x o custo (mínimo ${minCostMultiple}x)`;
  }
  if (economics.netRiskReward < minNetRiskReward) {
    return `R/R líquido de ${economics.netRiskReward.toFixed(2)} abaixo do mínimo ${minNetRiskReward}`;
  }
  return null;
}
