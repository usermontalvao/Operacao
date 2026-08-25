/**
 * Custo real de uma operação: taxa da corretora e escorregamento.
 *
 * Sem isto, todo resultado simulado nasce melhor do que o mercado entrega —
 * a entrada preenche no preço exato, o stop preenche no preço exato e ninguém
 * paga corretagem. É o erro que aprova no papel um sistema que perde ao vivo.
 * Todo P&L do sistema passa por aqui e já sai líquido.
 */

/** Taxa spot padrão da Binance por lado, em percentual. */
export const DEFAULT_FEE_PERCENT = 0.1;

export interface CostSettings {
  /** taxa por lado, em % do valor negociado (0,1 = 0,1%) */
  feePercent: number;
  /** quanto o stop costuma preencher abaixo do gatilho, em % */
  stopSlippagePercent: number;
  /** quanto uma saída a mercado preenche abaixo do preço visto, em % */
  exitSlippagePercent: number;
}

export const DEFAULT_COSTS: CostSettings = {
  feePercent: DEFAULT_FEE_PERCENT,
  stopSlippagePercent: 0.15,
  exitSlippagePercent: 0.1,
};

function factor(percent: number): number {
  return Math.max(percent, 0) / 100;
}

/** Corretagem de uma perna, sempre sobre o valor financeiro negociado. */
export function feeFor(price: number, quantity: number, feePercent: number): number {
  if (price <= 0 || quantity <= 0) return 0;
  return price * quantity * factor(feePercent);
}

/**
 * Preço em que o stop realmente preenche. O gatilho é onde a ordem acorda;
 * o preenchimento sai abaixo porque o livro já andou.
 */
export function stopFillPrice(stopLoss: number, costs: CostSettings): number {
  return stopLoss * (1 - factor(costs.stopSlippagePercent));
}

/** Preço de uma saída a mercado (fechamento manual, pânico, stop de proteção). */
export function marketExitPrice(price: number, costs: CostSettings): number {
  return price * (1 - factor(costs.exitSlippagePercent));
}

/**
 * Resultado líquido de uma saída parcial: já desconta a taxa da compra
 * proporcional à quantidade que está saindo e a taxa da própria venda.
 */
export function netPnl(input: {
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  feePercent: number;
}): number {
  const { entryPrice, exitPrice, quantity, feePercent } = input;
  if (quantity <= 0) return 0;
  const gross = (exitPrice - entryPrice) * quantity;
  const fees = feeFor(entryPrice, quantity, feePercent) + feeFor(exitPrice, quantity, feePercent);
  return gross - fees;
}

/** Taxa total paga nas duas pontas de uma saída parcial. */
export function roundTripFee(input: {
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  feePercent: number;
}): number {
  const { entryPrice, exitPrice, quantity, feePercent } = input;
  return feeFor(entryPrice, quantity, feePercent) + feeFor(exitPrice, quantity, feePercent);
}

/**
 * Preço em que a operação empata depois de pagar as duas taxas.
 * É para cá que o stop vai quando o sistema protege o capital: no preço de
 * entrada puro a operação ainda fecharia no vermelho.
 */
export function breakevenPrice(entryPrice: number, feePercent: number): number {
  const fee = factor(feePercent);
  if (fee >= 1) return entryPrice;
  return (entryPrice * (1 + fee)) / (1 - fee);
}

/**
 * R/R depois dos custos. É esta a assimetria que decide se vale operar —
 * a bruta mente, sobretudo em alvo curto, onde a taxa come o lucro.
 */
export function netRiskReward(input: {
  entryPrice: number;
  stopLoss: number;
  target: number;
  costs: CostSettings;
}): number {
  const { entryPrice, stopLoss, target, costs } = input;
  if (entryPrice <= 0 || stopLoss <= 0 || target <= 0) return 0;
  if (stopLoss >= entryPrice || target <= entryPrice) return 0;

  const stopFill = stopFillPrice(stopLoss, costs);
  const risk = -netPnl({ entryPrice, exitPrice: stopFill, quantity: 1, feePercent: costs.feePercent });
  const reward = netPnl({ entryPrice, exitPrice: target, quantity: 1, feePercent: costs.feePercent });
  if (risk <= 0 || reward <= 0) return 0;
  return Math.round((reward / risk) * 100) / 100;
}
