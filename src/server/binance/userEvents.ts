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
