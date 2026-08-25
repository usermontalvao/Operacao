import type { AccountBalanceResponse } from './api.ts';
import type { Trade, TradingMode } from './types.ts';

export interface LiveEquity {
  /** patrimônio agora: caixa + o que as posições valem neste preço */
  equity: number;
  /** resultado das posições que ainda estão abertas */
  unrealized: number;
  /** quanto está parado em posição */
  invested: number;
  /** true quando faltou preço de alguma posição e o número está incompleto */
  partial: boolean;
  /** quantas posições entraram na conta — 0 significa "ainda não há o que somar" */
  positions: number;
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
  /**
   * Retrato do servidor. O canal ao vivo só manda preço dos pares que estão
   * na watchlist — uma posição em par fora dela nunca receberia tique, e o
   * topo da tela mostrava "+0,00 aberto" enquanto a Carteira mostrava o
   * prejuízo de verdade. O preço que o servidor já calculou entra como
   * segunda fonte para esses casos.
   */
  serverPositions?: Array<{ symbol: string; currentPrice: number | null }>;
}): LiveEquity {
  const { balance, trades, prices, mode, serverPositions } = input;
  const capital = balance?.capital ?? 0;

  const fallback: Record<string, number> = {};
  for (const position of serverPositions ?? []) {
    if (position.currentPrice !== null && position.currentPrice > 0) {
      fallback[position.symbol] = position.currentPrice;
    }
  }

  let unrealized = 0;
  let invested = 0;
  let marketValue = 0;
  let partial = false;
  let positions = 0;

  for (const trade of trades) {
    if (trade.mode !== mode) continue;
    if (trade.status !== 'OPEN' && trade.status !== 'PENDING') continue;

    positions += 1;
    const entry = trade.averageFillPrice ?? trade.entryPrice;
    if (trade.status === 'PENDING') {
      // ordem ainda não preencheu: o dinheiro está reservado, não exposto
      invested += trade.notional;
      marketValue += trade.notional;
      continue;
    }

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
  }

  const equity = mode === 'PAPER' ? capital + unrealized : capital + marketValue;
  return {
    equity: Math.round(equity * 100) / 100,
    unrealized: Math.round(unrealized * 100) / 100,
    invested: Math.round(invested * 100) / 100,
    partial,
    positions,
  };
}
