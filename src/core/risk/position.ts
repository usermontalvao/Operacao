import type { PositionSizing, RiskSettings, TradeSetup } from '../types.ts';
import { computeRiskReward, round } from './riskReward.ts';

export interface SizingRequest {
  setup: TradeSetup;
  /** quanto o usuário quer investir, na moeda de cotação (USDT) */
  quoteAmount: number;
  /** preço de referência da entrada */
  entryPrice: number;
  capital: number;
}

export interface SizingResult extends PositionSizing {
  warnings: string[];
  blocked: boolean;
  blockReasons: string[];
}

/**
 * Converte "quero investir X USDT" em quantidade, risco monetário e lucro
 * potencial. Nada é enviado à corretora aqui — isto é só a conta que o
 * usuário vê antes de confirmar.
 */
export function computeSizing(request: SizingRequest, risk: RiskSettings): SizingResult {
  const { setup, quoteAmount, entryPrice, capital } = request;
  const warnings: string[] = [];
  const blockReasons: string[] = [];

  if (entryPrice <= 0) blockReasons.push('Preço de entrada inválido');
  if (quoteAmount <= 0) blockReasons.push('Informe um valor maior que zero');
  if (setup.stopLoss >= entryPrice) blockReasons.push('Stop precisa ficar abaixo da entrada');

  const quantity = entryPrice > 0 ? quoteAmount / entryPrice : 0;
  const notional = quantity * entryPrice;
  const riskAmount = quantity * Math.max(entryPrice - setup.stopLoss, 0);
  const riskPercentOfCapital = capital > 0 ? (riskAmount / capital) * 100 : 0;

  const maxNotional = capital * (risk.maxPositionPercent / 100);
  if (capital > 0 && notional > maxNotional) {
    blockReasons.push(
      `Posição de ${notional.toFixed(2)} passa do limite de ${risk.maxPositionPercent}% do capital (${maxNotional.toFixed(2)})`,
    );
  }
  const maxRisk = capital * (risk.riskPerTradePercent / 100);
  if (capital > 0 && riskAmount > maxRisk) {
    warnings.push(
      `Risco de ${riskAmount.toFixed(2)} acima do teto de ${risk.riskPerTradePercent}% por trade (${maxRisk.toFixed(2)})`,
    );
  }

  const profit = (target: number | null): number | null =>
    target === null ? null : round(quantity * (target - entryPrice), 2);

  return {
    quantity: round(quantity, 8),
    entryPrice: round(entryPrice, 8),
    notional: round(notional, 2),
    riskAmount: round(riskAmount, 2),
    riskPercentOfCapital: round(riskPercentOfCapital, 2),
    potentialProfitTarget1: profit(setup.target1) ?? 0,
    potentialProfitTarget2: profit(setup.target2),
    potentialProfitTarget3: profit(setup.target3),
    riskReward: computeRiskReward(entryPrice, setup.stopLoss, setup.target1),
    warnings,
    blocked: blockReasons.length > 0,
    blockReasons,
  };
}

/** Quantidade sugerida a partir do risco por trade, não do "chute" do usuário. */
export function suggestedQuoteAmount(
  capital: number,
  entryPrice: number,
  stopLoss: number,
  risk: RiskSettings,
): number {
  if (capital <= 0 || entryPrice <= 0 || stopLoss >= entryPrice) return 0;
  const riskBudget = capital * (risk.riskPerTradePercent / 100);
  const riskPerUnit = entryPrice - stopLoss;
  const quantity = riskBudget / riskPerUnit;
  const notional = quantity * entryPrice;
  const cap = capital * (risk.maxPositionPercent / 100);
  return round(Math.min(notional, cap), 2);
}
