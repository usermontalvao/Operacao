/** BTC entra sempre: sem ele não há contexto de mercado para as altcoins. */
export function withBitcoin(symbols: string[]): string[] {
  return symbols.includes('BTCUSDT') ? symbols : ['BTCUSDT', ...symbols];
}

/** Teto de símbolos acompanhados ao vivo por WebSocket. */
export const MAX_FOCUS_SYMBOLS = 40;
