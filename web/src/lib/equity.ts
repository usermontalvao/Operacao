import type { AccountBalanceResponse } from './api.ts';
import type { MarketKind, Trade, TradingMode } from './types.ts';

export interface LiveEquity {
  /** patrimônio agora: caixa + o que as posições valem neste preço */
  equity: number;
  /** resultado das posições que ainda estão abertas */
  unrealized: number;
  /** quanto está parado em posição */
  invested: number;
  /** quanto está reservado por ordens que ainda não preencheram */
  reserved: number;
  /** true quando faltou preço de alguma posição e o número está incompleto */
  partial: boolean;
  /** quantas posições foram realmente preenchidas */
  positions: number;
  /** ordens enviadas que ainda aguardam o preço de entrada */
  pendingOrders: number;
}

/**
 * Saldo em tempo real, calculado no navegador.
 *
 * O saldo que vem do servidor só muda quando uma operação ENCERRA — entre uma
 * coisa e outra ele fica parado enquanto o preço corre. Como o preço já chega
 * de graça pelo canal ao vivo, o patrimônio é recomposto aqui a cada tique.
 *
 * As duas contas são diferentes de propósito:
 *  - na conta demo o capital já embute o custo das posições, então basta somar
 *    a variação desde a entrada;
 *  - na conta real o saldo é só o USDT parado; a moeda comprada não está nele
 *    e precisa entrar pelo valor de mercado.
 */
export function computeLiveEquity(input: {
  balance: AccountBalanceResponse | null;
  trades: Trade[];
  prices: Record<string, number>;
  mode: TradingMode;
  market: MarketKind;
  /**
   * Retrato do servidor. O canal ao vivo só manda preço dos pares que estão
   * na watchlist — uma posição em par fora dela nunca receberia tique, e o
   * topo da tela mostrava "+0,00 aberto" enquanto a Carteira mostrava o
   * prejuízo de verdade. O preço que o servidor já calculou entra como
   * segunda fonte para esses casos.
   */
  serverPositions?: Array<{ symbol: string; currentPrice: number | null }>;
}): LiveEquity {
  const { balance, trades, prices, mode, market, serverPositions } = input;
  const capital = balance?.capital ?? 0;

  const fallback: Record<string, number> = {};
  for (const position of serverPositions ?? []) {
    if (position.currentPrice !== null && position.currentPrice > 0) {
      fallback[position.symbol] = position.currentPrice;
    }
  }

  let unrealized = 0;
  let invested = 0;
  let reserved = 0;
  let marketValue = 0;
  let holdingsAdjustment = 0;
  let partial = false;
  let positions = 0;
  let pendingOrders = 0;

  for (const trade of trades) {
    if (trade.mode !== mode) continue;
    if ((trade.market ?? 'SPOT') !== market) continue;
    if (trade.status !== 'OPEN' && trade.status !== 'PENDING') continue;

    const entry = trade.averageFillPrice ?? trade.entryPrice;
    if (trade.status === 'PENDING') {
      // a ordem ainda não preencheu: não há posição nem PnL. Em conta real o
      // saldo `capital` já inclui o USDT bloqueado, então somá-lo outra vez
      // inflaria o patrimônio.
      pendingOrders += 1;
      reserved += trade.market === 'FUTURES' && trade.initialMargin > 0
        ? trade.initialMargin
        : trade.notional;
      continue;
    }

    positions += 1;
    const quantity = trade.remainingQuantity;
    const price = prices[trade.symbol] ?? fallback[trade.symbol];
    invested += entry * quantity;
    if (price === undefined || price <= 0) {
      partial = true;
      marketValue += entry * quantity;
      continue;
    }
    unrealized += (price - entry) * quantity;
    marketValue += price * quantity;

    /*
     * O saldo spot já inclui o valor agregado das moedas em holdingsValue.
     * Somar marketValue de novo duplicava toda posição durante a pequena
     * janela entre o evento de saldo e o evento de encerramento: foi assim
     * que 24,76 USDT viraram 48,69 USDT na tela.
     *
     * Para o patrimônio continuar andando a cada tique, aplica-se somente a
     * variação desde o último preço calculado pelo servidor.
     */
    const serverPrice = fallback[trade.symbol];
    if (market === 'SPOT' && serverPrice !== undefined && serverPrice > 0) {
      holdingsAdjustment += (price - serverPrice) * quantity;
    }
  }

  const hasHoldingsSnapshot = typeof balance?.holdingsValue === 'number';
  const equity =
    mode === 'PAPER' || market === 'FUTURES'
      ? capital + unrealized
      : hasHoldingsSnapshot
        ? capital + (balance?.holdingsValue ?? 0) + holdingsAdjustment
        // compatibilidade com um servidor antigo durante atualização da tela
        : capital + marketValue;
  return {
    equity: Math.round(equity * 100) / 100,
    unrealized: Math.round(unrealized * 100) / 100,
    invested: Math.round(invested * 100) / 100,
    reserved: Math.round(reserved * 100) / 100,
    partial,
    positions,
    pendingOrders,
  };
}
