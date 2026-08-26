import type { LiquiditySnapshot } from '../types.ts';

/**
 * Transformar um livro de ofertas em números comparáveis — puro, para poder
 * ser testado sem rede.
 */

export interface BookSide {
  /** [preço, quantidade], do melhor para o pior */
  levels: Array<[number, number]>;
}

export interface MeasureLiquidityInput {
  symbol: string;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  quoteVolume24h: number;
  /** volume em USDT dos últimos 15 minutos, tirado dos candles de 1m */
  recentQuoteVolume: number;
  /** tamanho da ordem usada para medir o escorregamento, em USDT */
  probeOrderUsd: number;
  /** quantos níveis contam como "profundidade útil" de cada lado */
  depthLevels?: number;
  measuredAt: number;
}

/**
 * Quanto o preço médio piora ao varrer o book com uma ordem a mercado.
 *
 * É o escorregamento REAL desta ordem neste par neste momento — não uma
 * estimativa. Devolve null quando o book não tem profundidade nem para a
 * ordem inteira: nesse caso não existe "escorregamento estimado", existe
 * "não dá para executar", e as duas coisas não podem virar o mesmo número.
 */
export function sweepCost(
  levels: Array<[number, number]>,
  mid: number,
  notionalUsd: number,
  side: 'BUY' | 'SELL',
): number | null {
  if (mid <= 0 || notionalUsd <= 0 || levels.length === 0) return null;

  let restante = notionalUsd;
  let gasto = 0;
  let quantidade = 0;

  for (const [price, qty] of levels) {
    if (price <= 0 || qty <= 0) continue;
    const disponivel = price * qty;
    const usar = Math.min(restante, disponivel);
    gasto += usar;
    quantidade += usar / price;
    restante -= usar;
    if (restante <= 0) break;
  }

  if (restante > 0 || quantidade <= 0) return null;

  const precoMedio = gasto / quantidade;
  // comprando, pagar mais que o meio é custo; vendendo, receber menos é custo
  const custo = side === 'BUY' ? precoMedio / mid - 1 : 1 - precoMedio / mid;
  return Math.max(0, custo * 100);
}

/** Valor em USDT parado nos primeiros níveis de um lado do book. */
export function depthUsd(levels: Array<[number, number]>, count: number): number {
  return levels
    .slice(0, count)
    .reduce((total, [price, qty]) => total + Math.max(0, price) * Math.max(0, qty), 0);
}

export function measureLiquidity(input: MeasureLiquidityInput): LiquiditySnapshot | null {
  const { bids, asks, depthLevels = 20 } = input;
  const bestBid = bids[0]?.[0] ?? 0;
  const bestAsk = asks[0]?.[0] ?? 0;
  if (bestBid <= 0 || bestAsk <= 0) return null;

  const mid = (bestBid + bestAsk) / 2;

  /*
   * O escorregamento é o PIOR dos dois lados.
   *
   * A operação entra por um lado e sai pelo outro, então usar a média
   * esconderia o caso que mais importa: um book com compra farta e venda rasa
   * deixa entrar barato e cobra caro para sair — e sair é a metade que não é
   * opcional.
   */
  const compra = sweepCost(asks, mid, input.probeOrderUsd, 'BUY');
  const venda = sweepCost(bids, mid, input.probeOrderUsd, 'SELL');
  const slippagePercent =
    compra === null || venda === null ? null : Math.max(compra, venda);

  return {
    symbol: input.symbol,
    bid: bestBid,
    ask: bestAsk,
    spreadPercent: ((bestAsk - bestBid) / mid) * 100,
    slippagePercent,
    bidDepthUsd: depthUsd(bids, depthLevels),
    askDepthUsd: depthUsd(asks, depthLevels),
    quoteVolume24h: input.quoteVolume24h,
    recentQuoteVolume: input.recentQuoteVolume,
    measuredAt: input.measuredAt,
  };
}
