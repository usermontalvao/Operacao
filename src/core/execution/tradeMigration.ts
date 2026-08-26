import type { Trade } from '../types.ts';

/**
 * Normaliza uma operação gravada antes de uma versão que criou campos novos.
 *
 * O risco não é a operação antiga aparecer errada na tela — é a aritmética.
 * `undefined + 5` é NaN, e NaN atravessa soma, comparação e arredondamento sem
 * lançar erro nenhum: o resultado do dia vira NaN, o disjuntor compara NaN com
 * o limite e não dispara, e a tela mostra um traço. Por isso todo campo que
 * entra em conta ganha valor aqui, na porta de entrada.
 */
export function migrateTrade(raw: Trade): Trade {
  const trade = { ...raw } as Trade & Record<string, unknown>;

  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  // operação gravada antes dos futuros: spot, comprada, sem alavancagem. Sem
  // isto, `notional / undefined` vira NaN na primeira conta de margem.
  if (trade.market !== 'FUTURES' && trade.market !== 'SPOT') trade.market = 'SPOT';
  if (trade.side !== 'SELL') trade.side = 'BUY';
  trade.leverage = Math.max(number(trade.leverage, 1), 1);
  trade.initialMargin = number(trade.initialMargin, 0);
  if (typeof trade.liquidationPrice !== 'number' || !Number.isFinite(trade.liquidationPrice)) {
    trade.liquidationPrice = null;
  }

  trade.filledQuantity = number(trade.filledQuantity, 0);
  trade.requestedQuantity = number(trade.requestedQuantity, trade.filledQuantity);
  trade.realizedPnl = number(trade.realizedPnl, 0);
  trade.realizedPnlPercent = number(trade.realizedPnlPercent, 0);
  trade.feesPaid = number(trade.feesPaid, 0);
  trade.riskAmount = number(trade.riskAmount, 0);
  trade.notional = number(trade.notional, 0);
  if (trade.initialMargin === 0 && trade.notional > 0) {
    trade.initialMargin = trade.notional / trade.leverage;
  }
  trade.maxFavorablePercent = number(trade.maxFavorablePercent, 0);
  trade.maxAdversePercent = number(trade.maxAdversePercent, 0);

  // posição aberta sem quantidade restante gravada: o que entrou menos o que saiu
  const soldOut = (trade.fills ?? [])
    .filter((fill) => fill.kind !== 'ENTRY')
    .reduce((total, fill) => total + number(fill.quantity, 0), 0);
  trade.remainingQuantity = number(
    trade.remainingQuantity,
    Math.max(trade.filledQuantity - soldOut, 0),
  );

  if (!Array.isArray(trade.fills)) trade.fills = [];
  if (!Array.isArray(trade.exchangeOrderIds)) trade.exchangeOrderIds = [];
  if (!Array.isArray(trade.protectionListIds)) trade.protectionListIds = [];

  if (typeof trade.averageFillPrice !== 'number' || !Number.isFinite(trade.averageFillPrice)) {
    trade.averageFillPrice = trade.filledQuantity > 0 ? number(trade.entryPrice, 0) : null;
  }
  if (typeof trade.highWaterPrice !== 'number' || !Number.isFinite(trade.highWaterPrice)) {
    // sem topo gravado, o topo conhecido é a própria entrada — nunca zero, que
    // faria o trailing calcular proteção a partir do nada
    trade.highWaterPrice = trade.status === 'OPEN' ? trade.averageFillPrice ?? trade.entryPrice : null;
  }
  if (typeof trade.protectiveStop !== 'number' || !Number.isFinite(trade.protectiveStop)) {
    trade.protectiveStop = null;
  }
  if (trade.exitPlanKind !== 'SCALE_OUT' && trade.exitPlanKind !== 'SINGLE') {
    // operação anterior à saída em partes: era alvo único, e é assim que ela
    // tem de ser lida quando papel e conta real forem comparados
    trade.exitPlanKind = 'SINGLE';
  }
  if (typeof trade.automatic !== 'boolean') trade.automatic = false;
  if (typeof trade.closeReason !== 'string') trade.closeReason = null;

  return trade as Trade;
}
