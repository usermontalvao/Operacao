import type { PerformanceBucket, PerformanceStats, Trade, TradeSetup } from './types.ts';
import { round } from './risk/riskReward.ts';

/**
 * Métricas básicas de desempenho. Nada sofisticado de propósito: o que
 * importa no MVP é saber se o motor tem alguma vantagem antes de arriscar.
 */
export function computePerformance(trades: Trade[], setups: TradeSetup[]): PerformanceStats {
  const closed = trades.filter((trade) => trade.status === 'CLOSED');
  const open = trades.filter((trade) => trade.status === 'OPEN' || trade.status === 'PENDING');

  const wins = closed.filter((trade) => trade.realizedPnl > 0);
  const losses = closed.filter((trade) => trade.realizedPnl < 0);

  const grossProfit = wins.reduce((acc, trade) => acc + trade.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((acc, trade) => acc + trade.realizedPnl, 0));

  const averageWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const averageLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const expectancy =
    closed.length > 0 ? (winRate / 100) * averageWin - (1 - winRate / 100) * averageLoss : 0;

  return {
    totalSetups: setups.length,
    totalTrades: trades.length,
    openTrades: open.length,
    closedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(winRate, 1),
    averageWin: round(averageWin, 2),
    averageLoss: round(averageLoss, 2),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 2) : grossProfit > 0 ? 99 : 0,
    expectancy: round(expectancy, 2),
    totalPnl: round(closed.reduce((acc, trade) => acc + trade.realizedPnl, 0), 2),
    byOrigin: bucketBy(closed, (trade) => (trade.automatic === true ? 'Robô' : 'Manual')),
    bySymbol: bucketBy(closed, (trade) => trade.symbol),
    bySetupType: bucketBy(closed, (trade) => trade.setupType),
    byTimeframe: bucketBy(closed, (trade) => trade.timeframe),
  };
}

function bucketBy(trades: Trade[], pick: (trade: Trade) => string): PerformanceBucket[] {
  const map = new Map<string, PerformanceBucket>();
  for (const trade of trades) {
    const key = pick(trade);
    const bucket = map.get(key) ?? { key, trades: 0, wins: 0, winRate: 0, pnl: 0 };
    bucket.trades += 1;
    if (trade.realizedPnl > 0) bucket.wins += 1;
    bucket.pnl = round(bucket.pnl + trade.realizedPnl, 2);
    bucket.winRate = round((bucket.wins / bucket.trades) * 100, 1);
    map.set(key, bucket);
  }
  return [...map.values()].sort((a, b) => b.pnl - a.pnl);
}
