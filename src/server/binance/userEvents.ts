/**
 * Tradução dos eventos da conta. Módulo puro de propósito: é o que permite
 * provar a leitura de um `executionReport` sem abrir socket nenhum.
 */

export interface OrderExecutionEvent {
  eventTime: number;
  symbol: string;
  clientOrderId: string;
  /** id da ordem que originou este evento — é por ele que a operação é achada */
  orderId: number;
  orderListId: number;
  side: 'BUY' | 'SELL';
  /** LIMIT, STOP_LOSS_LIMIT, LIMIT_MAKER, MARKET… — é o que distingue stop de alvo */
  orderType: string;
  status: string;
  executionType: string;
  lastFilledQuantity: number;
  cumulativeFilledQuantity: number;
  lastFilledPrice: number;
  cumulativeQuoteQuantity: number;
  commission: number;
  commissionAsset: string | null;
  transactionTime: number;
  /** só futuros: a ordem apenas reduz posição (alvo, stop, saída manual) */
  reduceOnly?: boolean;
  /** só futuros: resultado realizado desta execução, direto da corretora */
  realizedProfit?: number;
}

/** Lê o evento de execução venha ele do spot ou de futuros. */
export function parseOrderEvent(raw: unknown): OrderExecutionEvent | null {
  return parseExecutionReport(raw) ?? parseFuturesOrderUpdate(raw);
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Preço médio dos preenchimentos até agora.
 *
 * O campo `L` traz só o último preenchimento e vem zerado em evento que não é
 * negócio (cancelamento, expiração). Quem diz o preço da posição é o
 * acumulado: valor financeiro dividido por quantidade.
 */
export function averageFillPrice(event: OrderExecutionEvent): number | null {
  if (event.cumulativeFilledQuantity <= 0) return null;
  if (event.cumulativeQuoteQuantity > 0) {
    return event.cumulativeQuoteQuantity / event.cumulativeFilledQuantity;
  }
  return event.lastFilledPrice > 0 ? event.lastFilledPrice : null;
}

/** A ordem acabou: não haverá mais preenchimento nela. */
export function isTerminal(status: string): boolean {
  return status === 'FILLED' || status === 'CANCELED' || status === 'REJECTED' || status === 'EXPIRED';
}

/**
 * Execução em FUTUROS.
 *
 * A corretora manda `ORDER_TRADE_UPDATE` com a ordem aninhada em `o`, e não
 * um `executionReport` plano. Também não existe `Z` (valor acumulado): o que
 * vem é `ap`, o preço médio da posição — o valor financeiro é reconstruído a
 * partir dele. Ler o evento errado não dá erro: dá silêncio, e silêncio aqui
 * é posição preenchida que o sistema não sabe que abriu.
 */
export function parseFuturesOrderUpdate(raw: unknown): OrderExecutionEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const envelope = raw as Record<string, unknown>;
  if (envelope['e'] !== 'ORDER_TRADE_UPDATE') return null;
  const data = envelope['o'];
  if (typeof data !== 'object' || data === null) return null;
  const order = data as Record<string, unknown>;

  const symbol = typeof order['s'] === 'string' ? order['s'] : null;
  const side = order['S'] === 'BUY' || order['S'] === 'SELL' ? order['S'] : null;
  if (!symbol || !side) return null;

  const cumulativeFilled = num(order['z']);
  const averagePrice = num(order['ap']);

  return {
    eventTime: num(envelope['E']),
    symbol,
    clientOrderId: typeof order['c'] === 'string' ? order['c'] : '',
    orderId: num(order['i']),
    orderListId: 0,
    side,
    orderType: typeof order['o'] === 'string' ? order['o'] : 'UNKNOWN',
    status: typeof order['X'] === 'string' ? order['X'] : 'UNKNOWN',
    executionType: typeof order['x'] === 'string' ? order['x'] : 'UNKNOWN',
    lastFilledQuantity: num(order['l']),
    cumulativeFilledQuantity: cumulativeFilled,
    lastFilledPrice: num(order['L']),
    // reconstruído: preço médio × quantidade acumulada
    cumulativeQuoteQuantity: averagePrice > 0 ? averagePrice * cumulativeFilled : 0,
    commission: num(order['n']),
    commissionAsset: typeof order['N'] === 'string' ? order['N'] : null,
    transactionTime: num(order['T']),
    reduceOnly: order['R'] === true,
    realizedProfit: num(order['rp']),
  };
}

export function parseExecutionReport(raw: unknown): OrderExecutionEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Record<string, unknown>;
  if (data['e'] !== 'executionReport') return null;
  const symbol = typeof data['s'] === 'string' ? data['s'] : null;
  const side = data['S'] === 'BUY' || data['S'] === 'SELL' ? data['S'] : null;
  if (!symbol || !side) return null;

  return {
    eventTime: num(data['E']),
    symbol,
    clientOrderId: typeof data['c'] === 'string' ? data['c'] : '',
    orderId: num(data['i']),
    orderListId: num(data['g']),
    side,
    orderType: typeof data['o'] === 'string' ? data['o'] : 'UNKNOWN',
    status: typeof data['X'] === 'string' ? data['X'] : 'UNKNOWN',
    executionType: typeof data['x'] === 'string' ? data['x'] : 'UNKNOWN',
    lastFilledQuantity: num(data['l']),
    cumulativeFilledQuantity: num(data['z']),
    lastFilledPrice: num(data['L']),
    cumulativeQuoteQuantity: num(data['Z']),
    commission: num(data['n']),
    commissionAsset: typeof data['N'] === 'string' ? data['N'] : null,
    transactionTime: num(data['T']),
  };
}
