import type { SymbolFilters } from '../types.ts';

export interface OrderValidation {
  valid: boolean;
  errors: string[];
  quantity: number;
  price: number;
  notional: number;
}

/** Casas decimais implícitas em um passo (0.001 → 3). */
export function decimalsFromStep(step: number): number {
  if (step <= 0) return 8;
  const text = step.toExponential();
  const [mantissa, exponent] = text.split('e') as [string, string];
  const exp = Number(exponent);
  const mantissaDecimals = (mantissa.split('.')[1] ?? '').replace(/0+$/, '').length;
  return Math.max(0, mantissaDecimals - exp);
}

/** Arredonda para baixo no múltiplo do passo — nunca para cima, para não estourar saldo. */
export function roundDownToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const decimals = decimalsFromStep(step);
  const steps = Math.floor(value / step + 1e-9);
  return Number((steps * step).toFixed(decimals));
}

/** Preços vão para o tick mais próximo. */
export function roundToTick(value: number, tickSize: number): number {
  if (tickSize <= 0) return value;
  const decimals = decimalsFromStep(tickSize);
  return Number((Math.round(value / tickSize) * tickSize).toFixed(decimals));
}

export function formatQuantity(value: number, filters: SymbolFilters): string {
  return value.toFixed(decimalsFromStep(filters.stepSize));
}

export function formatPrice(value: number, filters: SymbolFilters): string {
  return value.toFixed(decimalsFromStep(filters.tickSize));
}

/**
 * Aplica LOT_SIZE, PRICE_FILTER e NOTIONAL antes de qualquer envio.
 * Sem isso a Binance devolve -1013 e o usuário fica sem saber o motivo.
 */
export function validateOrder(
  filters: SymbolFilters,
  rawQuantity: number,
  rawPrice: number,
  isMarketOrder = false,
): OrderValidation {
  const errors: string[] = [];
  const price = roundToTick(rawPrice, filters.tickSize);
  const quantity = roundDownToStep(rawQuantity, filters.stepSize);
  const notional = quantity * price;

  if (!filters.isSpotTradingAllowed || filters.status !== 'TRADING') {
    errors.push(`Par ${filters.symbol} não está disponível para spot no momento`);
  }
  if (quantity <= 0) {
    errors.push('Quantidade zerada depois de aplicar o stepSize');
  }
  if (quantity < filters.minQty) {
    errors.push(`Quantidade abaixo do mínimo (${filters.minQty})`);
  }
  if (filters.maxQty > 0 && quantity > filters.maxQty) {
    errors.push(`Quantidade acima do máximo (${filters.maxQty})`);
  }
  if (price <= 0) {
    errors.push('Preço inválido depois de aplicar o tickSize');
  }
  const notionalApplies = !isMarketOrder || filters.applyMinToMarket;
  if (notionalApplies && filters.minNotional > 0 && notional < filters.minNotional) {
    errors.push(
      `Valor da ordem (${notional.toFixed(2)}) abaixo do mínimo da Binance (${filters.minNotional})`,
    );
  }

  return { valid: errors.length === 0, errors, quantity, price, notional };
}
