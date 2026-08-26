export interface RawSpotHolding {
  asset: string;
  free: number;
  locked?: number;
}

export interface SpotHoldingView {
  asset: string;
  free: number;
  locked: number;
  quantity: number;
  symbol: string | null;
  price: number | null;
  value: number | null;
}

/**
 * Traduz os saldos físicos da conta Spot para o retrato da Carteira.
 * Um ativo sem par direto em USDT continua aparecendo, só fica sem cotação.
 */
export function buildSpotHoldings(
  balances: RawSpotHolding[],
  symbolByAsset: ReadonlyMap<string, string>,
  priceBySymbol: ReadonlyMap<string, number>,
): SpotHoldingView[] {
  return balances
    .map((balance) => {
      const locked = balance.locked ?? 0;
      const quantity = balance.free + locked;
      const symbol = symbolByAsset.get(balance.asset) ?? null;
      const quoted = symbol === null ? null : priceBySymbol.get(symbol) ?? null;
      const price = quoted !== null && Number.isFinite(quoted) && quoted > 0 ? quoted : null;
      return {
        asset: balance.asset,
        free: balance.free,
        locked,
        quantity,
        symbol,
        price,
        value: price === null ? null : quantity * price,
      };
    })
    .filter((holding) => holding.quantity > 0)
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
}
