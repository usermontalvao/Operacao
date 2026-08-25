import type { SymbolAnalysis } from '../analysis.ts';
import type { BtcContextState, Candle, MarketContext } from '../types.ts';

const HIGH_VOLATILITY_ATR_PERCENT = 3.5;
const HIGH_VOLATILITY_DAILY_MOVE = 6;

/**
 * Altcoin não anda sozinha. Este motor lê só o BTC e devolve um modificador
 * de score que é somado (ou subtraído) de todo setup de altcoin.
 */
export function evaluateMarketContext(
  btc: SymbolAnalysis | null,
  now: string,
): MarketContext {
  if (!btc || !btc.timeframes['4h']) {
    return {
      state: 'BTC_NEUTRAL',
      scoreModifier: 0,
      reasons: ['Dados do BTC indisponíveis — contexto neutro por segurança'],
      btcPrice: btc?.price ?? null,
      btcChangePercent24h: btc?.changePercent24h ?? null,
      btcTrend4h: 'SIDEWAYS',
      btcTrend1d: 'SIDEWAYS',
      highVolatility: false,
      btcAboveDailyMean: null,
      updatedAt: now,
    };
  }

  const tf4h = btc.timeframes['4h'];
  const tf1d = btc.timeframes['1d'];
  const reasons: string[] = [];
  let modifier = 0;

  const trend4h = tf4h.structure.trend;
  const trend1d = tf1d?.structure.trend ?? 'SIDEWAYS';

  if (trend4h === 'UP' && trend1d === 'UP') {
    modifier += 10;
    reasons.push('BTC em tendência de alta no 4H e no diário');
  } else if (trend4h === 'UP' || trend1d === 'UP') {
    modifier += 5;
    reasons.push('BTC retomando tendência de alta');
  } else if (trend4h === 'DOWN' && trend1d === 'DOWN') {
    modifier -= 15;
    reasons.push('BTC em tendência de baixa no 4H e no diário');
  } else if (trend4h === 'DOWN') {
    modifier -= 8;
    reasons.push('BTC perdendo força no 4H');
  } else {
    reasons.push('BTC lateral — sem viés claro');
  }

  if (tf4h.structure.consolidating && trend4h !== 'DOWN') {
    modifier += 3;
    reasons.push('BTC consolidando sem pressão vendedora');
  }

  const support = tf4h.structure.nearestSupport;
  const lastCandle = tf4h.candles[tf4h.candles.length - 1];
  if (support && lastCandle && lastCandle.close < support.low) {
    modifier -= 10;
    reasons.push('BTC rompeu suporte relevante do 4H');
  } else if (support && lastCandle && lastCandle.low <= support.high && lastCandle.close > support.price) {
    modifier += 4;
    reasons.push('BTC defendeu suporte do 4H');
  }

  const atrValue = tf4h.indicators.atr14 ?? 0;
  if (lastCandle && atrValue > 0) {
    const body = lastCandle.open - lastCandle.close;
    if (body > atrValue * 1.5) {
      modifier -= 8;
      reasons.push('Candle vendedor forte no BTC 4H');
    }
  }

  const atrPercent = tf4h.indicators.atrPercent ?? 0;
  const change24h = btc.changePercent24h ?? 0;
  const highVolatility =
    atrPercent > HIGH_VOLATILITY_ATR_PERCENT || Math.abs(change24h) > HIGH_VOLATILITY_DAILY_MOVE;
  if (highVolatility) {
    modifier -= 6;
    reasons.push(`Volatilidade elevada no BTC (ATR ${atrPercent.toFixed(1)}% no 4H)`);
  }

  modifier = Math.max(-20, Math.min(10, modifier));

  return {
    state: resolveState(trend4h, trend1d, highVolatility, modifier),
    scoreModifier: modifier,
    reasons,
    btcPrice: btc.price,
    btcChangePercent24h: btc.changePercent24h,
    btcTrend4h: trend4h,
    btcTrend1d: trend1d,
    highVolatility,
    btcAboveDailyMean: aboveDailyMean(tf1d?.candles ?? []),
    updatedAt: now,
  };
}

function resolveState(
  trend4h: string,
  trend1d: string,
  highVolatility: boolean,
  modifier: number,
): BtcContextState {
  if (highVolatility && modifier < 0) return 'BTC_HIGH_VOLATILITY';
  if (modifier >= 6 && (trend4h === 'UP' || trend1d === 'UP')) return 'BTC_BULLISH';
  if (modifier <= -8) return 'BTC_BEARISH';
  return 'BTC_NEUTRAL';
}


/**
 * BTC acima da média simples de 200 candles diários.
 *
 * Média SIMPLES de propósito: é a mesma conta que o laboratório usou para
 * medir o regime, e trocar por exponencial aqui faria a produção operar uma
 * regra que ninguém mediu.
 */
export function aboveDailyMean(daily: Candle[], length = 200): boolean | null {
  if (daily.length < length) return null;
  const window = daily.slice(-length);
  const mean = window.reduce((total, candle) => total + candle.close, 0) / length;
  const last = daily[daily.length - 1];
  if (!last || mean <= 0) return null;
  return last.close > mean;
}
