import type { TradingMode } from '../types.ts';
import { environmentNameForMode, type BinanceEnvironmentName } from './environment.ts';

/**
 * Sessões que operam ao mesmo tempo.
 *
 * O modo deixou de ser "o que o sistema está fazendo" e passou a ser "qual
 * janela estou olhando". O robô do demo continua trabalhando enquanto o
 * usuário examina a conta real, e vice-versa: cada modo é uma sessão com o seu
 * capital, o seu descanso por ativo e o seu disjuntor.
 *
 * O limite não é de gosto, é de endereço. PAPER e LIVE leem os MESMOS
 * endpoints de produção da Binance, então dividem a conexão de mercado sem
 * ambiguidade. TESTNET lê outro servidor, com outros preços e outra lista de
 * pares — misturar as duas fontes num processo só produziria setups gerados
 * com um preço e executados em outro. Por isso TESTNET é exclusivo: enquanto
 * ele estiver em exibição, é a única sessão que opera.
 */
export function activeSessionModes(displayed: TradingMode): TradingMode[] {
  const environment = environmentNameForMode(displayed);
  return environment === 'testnet' ? ['TESTNET'] : ['PAPER', 'LIVE'];
}

/** true quando a sessão do modo pedido está operando com esta exibição. */
export function isSessionActive(displayed: TradingMode, mode: TradingMode): boolean {
  return activeSessionModes(displayed).includes(mode);
}

/** O ambiente da Binance que o processo precisa ter aberto. */
export function environmentForDisplay(displayed: TradingMode): BinanceEnvironmentName {
  return environmentNameForMode(displayed);
}
