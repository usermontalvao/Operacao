/** BTC entra sempre: sem ele não há contexto de mercado para as altcoins. */
export function withBitcoin(symbols: string[]): string[] {
  return symbols.includes('BTCUSDT') ? symbols : ['BTCUSDT', ...symbols];
}

/** Teto de símbolos acompanhados ao vivo por WebSocket. */
export const MAX_FOCUS_SYMBOLS = 40;

/**
 * Monta o foco ao vivo por prioridade, contando o BTC dentro do teto.
 *
 * Os primeiros grupos nunca devem ser a watchlist quando existe dinheiro
 * reservado: ordens e posições precisam receber preço antes de qualquer par
 * apenas observado. Sem esta ordem, uma watchlist cheia expulsava do stream o
 * ativo comprado e a operação ficava congelada para sempre.
 */
export function prioritizedFocus(...groups: ReadonlyArray<readonly string[]>): string[] {
  const symbols = ['BTCUSDT', ...groups.flat()];
  return [...new Set(symbols)].slice(0, MAX_FOCUS_SYMBOLS);
}
