/**
 * Endpoints assinados de FUTUROS USD-M.
 *
 * Vive separado do spot porque a corretora é outra por dentro, não só outro
 * endereço: não existe OCO, a posição tem alavancagem e margem, a saída é uma
 * ordem `reduceOnly` do lado contrário e quem fecha a posição forçadamente é
 * a liquidação, não o stop. Misturar isso no módulo do spot produziria
 * funções cheias de `if (futuros)` em cada linha — e a linha esquecida seria
 * uma ordem enviada com o parâmetro do mercado errado.
 *
 * O assinador, o controle de ritmo e o ajuste de relógio são os MESMOS do
 * spot: importados de rest.ts, nunca reescritos.
 */

import type { MarginMode, Side } from '../../core/types.ts';
import { ENVIRONMENTS, type BinanceEnvironment, type EnvironmentEndpoints } from '../config.ts';
import { BinanceError, environmentFor, signedRequest } from './rest.ts';
import { logger } from '../logger.ts';

/** Erros que significam "já estava assim" — não são falha, são confirmação. */
const ALREADY_SET = new Set([-4046, -4047, -4059, -4028]);

export interface FuturesBalance {
  asset: string;
  /** saldo total da carteira de futuros */
  walletBalance: number;
  /** o que dá para usar como margem agora */
  availableBalance: number;
  /** resultado em aberto das posições */
  unrealizedProfit: number;
}

const futuresBalanceInFlight = new Map<BinanceEnvironment, Promise<FuturesBalance[]>>();

/**
 * Saldo da carteira de futuros.
 *
 * O ambiente é parâmetro porque a tela de ajustes mostra os quatro de uma vez
 * — produção e testnet, spot e futuros. Sem ele, esta função respondia sempre
 * pela rede ativa, e o saldo do TESTNET aparecia rotulado como produção.
 */
export async function getFuturesBalances(
  environmentName?: BinanceEnvironment,
): Promise<FuturesBalance[]> {
  const environment: EnvironmentEndpoints = environmentName
    ? ENVIRONMENTS[environmentName]
    : environmentFor('FUTURES');
  const existing = futuresBalanceInFlight.get(environment.name);
  if (existing) return existing;
  const loading = (async () => {
    const balances = await signedRequest<
      Array<{
        asset: string;
        balance: string;
        availableBalance: string;
        crossUnPnl: string;
      }>
    >('GET', '/fapi/v2/balance', {}, environment);
    return balances.map((item) => ({
      asset: item.asset,
      walletBalance: Number(item.balance),
      availableBalance: Number(item.availableBalance),
      unrealizedProfit: Number(item.crossUnPnl),
    }));
  })().finally(() => futuresBalanceInFlight.delete(environment.name));
  futuresBalanceInFlight.set(environment.name, loading);
  return loading;
}

export interface FuturesPosition {
  symbol: string;
  /** positivo comprado, negativo vendido, zero sem posição */
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  leverage: number;
  marginMode: MarginMode;
  unrealizedProfit: number;
  isolatedMargin: number;
}

export async function getFuturesPositions(symbol?: string): Promise<FuturesPosition[]> {
  const raw = await signedRequest<
    Array<{
      symbol: string;
      positionAmt: string;
      entryPrice: string;
      markPrice: string;
      liquidationPrice: string;
      leverage: string;
      marginType: string;
      unRealizedProfit: string;
      isolatedMargin: string;
    }>
  >('GET', '/fapi/v2/positionRisk', symbol ? { symbol } : {});
  return raw.map((item) => ({
    symbol: item.symbol,
    positionAmt: Number(item.positionAmt),
    entryPrice: Number(item.entryPrice),
    markPrice: Number(item.markPrice),
    liquidationPrice: Number(item.liquidationPrice),
    leverage: Number(item.leverage),
    marginMode: item.marginType?.toUpperCase() === 'ISOLATED' ? 'ISOLATED' : 'CROSSED',
    unrealizedProfit: Number(item.unRealizedProfit),
    isolatedMargin: Number(item.isolatedMargin),
  }));
}

/**
 * Alavancagem do par. É por SÍMBOLO e fica guardada na conta: deixar de
 * ajustá-la antes da ordem faz a posição nascer com a alavancagem da última
 * vez que alguém mexeu — que pode ter sido outra pessoa, em outro dia.
 */
export async function setLeverage(symbol: string, leverage: number): Promise<number> {
  const result = await signedRequest<{ leverage: number; maxNotionalValue: string }>(
    'POST',
    '/fapi/v1/leverage',
    { symbol, leverage: Math.max(1, Math.round(leverage)) },
  );
  return Number(result.leverage);
}

/**
 * Margem isolada ou cruzada. A corretora recusa a troca com posição aberta e
 * responde -4046 quando já está no modo pedido: os dois casos são tratados
 * como "não precisa fazer nada", e só o segundo é silencioso.
 */
export async function setMarginMode(symbol: string, marginMode: MarginMode): Promise<void> {
  try {
    await signedRequest('POST', '/fapi/v1/marginType', { symbol, marginType: marginMode });
  } catch (error) {
    if (error instanceof BinanceError && ALREADY_SET.has(error.code)) return;
    throw error;
  }
}

export interface FuturesOrderResponse {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  price: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
  cumQuote: string;
  status: string;
  type: string;
  side: string;
  reduceOnly: boolean;
  closePosition: boolean;
  stopPrice: string;
  updateTime: number;
}

export interface FuturesOrderParams extends Record<string, string | number | boolean | undefined> {
  symbol: string;
  side: Side;
  type: 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  newClientOrderId: string;
  quantity?: string;
  price?: string;
  stopPrice?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTX';
  reduceOnly?: boolean;
  closePosition?: boolean;
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
}

export async function newFuturesOrder(params: FuturesOrderParams): Promise<FuturesOrderResponse> {
  return signedRequest<FuturesOrderResponse>('POST', '/fapi/v1/order', {
    ...params,
    // closePosition e quantity são mutuamente exclusivos; enviar os dois é -1106
    quantity: params.closePosition === true ? undefined : params.quantity,
    newOrderRespType: 'RESULT',
  });
}

/** Entrada limitada, no lado da tese. */
export async function futuresEntryOrder(input: {
  symbol: string;
  side: Side;
  quantity: string;
  price: string;
  clientOrderId: string;
}): Promise<FuturesOrderResponse> {
  return newFuturesOrder({
    symbol: input.symbol,
    side: input.side,
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: input.quantity,
    price: input.price,
    newClientOrderId: input.clientOrderId,
  });
}

/**
 * Stop da posição inteira.
 *
 * `closePosition: true` é o que mais se aproxima do OCO do spot: a ordem não
 * carrega quantidade, fecha o que existir e a própria corretora a cancela
 * quando a posição zera. Sem isso, um stop com quantidade fixa sobraria no
 * livro depois de uma saída parcial e viraria uma posição invertida.
 *
 * O gatilho é o PREÇO DE MARCA, não o último negócio: é o preço de marca que
 * a corretora usa para liquidar, e um stop preso ao último negócio pode ser
 * disparado por um pavio que não existiu para a liquidação.
 */
export async function futuresStopOrder(input: {
  symbol: string;
  /** lado da POSIÇÃO; a ordem sai automaticamente do lado contrário */
  positionSide: Side;
  stopPrice: string;
  clientOrderId: string;
}): Promise<FuturesOrderResponse> {
  return newFuturesOrder({
    symbol: input.symbol,
    side: input.positionSide === 'BUY' ? 'SELL' : 'BUY',
    type: 'STOP_MARKET',
    stopPrice: input.stopPrice,
    closePosition: true,
    workingType: 'MARK_PRICE',
    newClientOrderId: input.clientOrderId,
  });
}

/** Uma parcela de alvo: ordem limitada do lado contrário, só reduzindo. */
export async function futuresTakeProfitOrder(input: {
  symbol: string;
  positionSide: Side;
  quantity: string;
  price: string;
  clientOrderId: string;
}): Promise<FuturesOrderResponse> {
  return newFuturesOrder({
    symbol: input.symbol,
    side: input.positionSide === 'BUY' ? 'SELL' : 'BUY',
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: input.quantity,
    price: input.price,
    reduceOnly: true,
    newClientOrderId: input.clientOrderId,
  });
}

/** Saída a mercado do que ainda está na mão. */
export async function futuresMarketExit(input: {
  symbol: string;
  positionSide: Side;
  quantity: string;
  clientOrderId: string;
}): Promise<FuturesOrderResponse> {
  return newFuturesOrder({
    symbol: input.symbol,
    side: input.positionSide === 'BUY' ? 'SELL' : 'BUY',
    type: 'MARKET',
    quantity: input.quantity,
    reduceOnly: true,
    newClientOrderId: input.clientOrderId,
  });
}

/**
 * Limpa o livro do par.
 *
 * Em futuros não existe lista OCO para cancelar de uma vez, e ordens
 * `reduceOnly` que sobram depois de a posição fechar não somem sozinhas.
 * Antes de qualquer rearme ou fechamento manual, o livro do par é zerado.
 */
export async function cancelAllFuturesOrders(symbol: string): Promise<void> {
  try {
    await signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol });
  } catch (error) {
    if (error instanceof BinanceError && error.code === -2011) return; // nada para cancelar
    throw error;
  }
}

export async function getFuturesOrder(
  symbol: string,
  origClientOrderId: string,
): Promise<FuturesOrderResponse> {
  return signedRequest<FuturesOrderResponse>('GET', '/fapi/v1/order', {
    symbol,
    origClientOrderId,
  });
}

export async function getFuturesOrderById(
  symbol: string,
  orderId: string,
): Promise<FuturesOrderResponse> {
  return signedRequest<FuturesOrderResponse>('GET', '/fapi/v1/order', { symbol, orderId });
}

export async function getFuturesOpenOrders(symbol?: string): Promise<FuturesOrderResponse[]> {
  return signedRequest<FuturesOrderResponse[]>(
    'GET',
    '/fapi/v1/openOrders',
    symbol ? { symbol } : {},
  );
}

/** Teto de alavancagem que a corretora aceita no par, por faixa de notional. */
export async function getMaxLeverage(symbol: string): Promise<number | null> {
  try {
    const brackets = await signedRequest<
      Array<{ symbol: string; brackets: Array<{ initialLeverage: number }> }>
    >('GET', '/fapi/v1/leverageBracket', { symbol });
    const first = brackets[0]?.brackets?.[0]?.initialLeverage;
    return typeof first === 'number' ? first : null;
  } catch (error) {
    logger.debug('Teto de alavancagem indisponível', {
      symbol,
      error: (error as Error).message,
    });
    return null;
  }
}

/**
 * Modo de posição da conta. O motor só sabe operar UMA posição por par
 * (one-way): em modo hedge a mesma ordem precisaria dizer se abre ou fecha, e
 * `reduceOnly` deixa de ter o sentido que a proteção depende.
 */
export async function isHedgeMode(): Promise<boolean> {
  const result = await signedRequest<{ dualSidePosition: boolean }>(
    'GET',
    '/fapi/v1/positionSide/dual',
  );
  return result.dualSidePosition === true;
}
