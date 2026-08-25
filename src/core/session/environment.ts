import type { TradingMode } from '../types.ts';

export type BinanceEnvironmentName = 'production' | 'testnet';

/**
 * A qual servidor da Binance cada modo pertence.
 *
 * Vive no núcleo, sem depender da configuração do servidor, para que as regras
 * puras — e os testes — possam raciocinar sobre convivência de sessões sem
 * carregar `.env` junto.
 */
export function environmentNameForMode(mode: TradingMode): BinanceEnvironmentName {
  return mode === 'TESTNET' ? 'testnet' : 'production';
}
