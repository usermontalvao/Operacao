import type { Candle, ExtensionCheck, IndicatorSnapshot } from '../types.ts';

/**
 * Trava anti-FOMO. Uma moeda pode estar em tendência perfeita e ainda assim
 * ser uma entrada ruim AGORA, porque o preço já se esticou demais do ponto de
 * invalidação. Aqui o setup não é destruído: ele é marcado como ESTICADO.
 */
export function checkExtension(
  indicators: IndicatorSnapshot,
  candles: Candle[],
): ExtensionCheck {
  const reasons: string[] = [];
  const { rsi14, ema20, atr14, close, bollinger, relativeVolume } = indicators;

  if (rsi14 !== null && rsi14 >= 75) {
    reasons.push(`RSI em ${rsi14.toFixed(0)} no ${indicators.timeframe} — sobrecomprado`);
  }
  if (ema20 !== null && atr14 !== null && atr14 > 0) {
    const distance = (close - ema20) / atr14;
    if (distance >= 3) {
      reasons.push(`Preço ${distance.toFixed(1)} ATR acima da EMA 20 — muito distante da média`);
    }
  }
  const last = candles[candles.length - 1];
  if (last && atr14 !== null && atr14 > 0) {
    const body = last.close - last.open;
    if (body > atr14 * 2.2) {
      reasons.push('Candle explosivo de alta — entrada no topo do movimento');
    }
  }
  if (bollinger && atr14 !== null && atr14 > 0 && close > bollinger.upper + atr14 * 0.5) {
    reasons.push('Preço acima da banda superior de Bollinger');
  }
  if (relativeVolume !== null && relativeVolume >= 3 && last && last.close > last.open) {
    reasons.push('Volume climático de compra — típico de exaustão');
  }

  const threeDayMove = percentMove(candles, 3);
  if (threeDayMove !== null && threeDayMove >= 25 && indicators.timeframe === '1d') {
    reasons.push(`Alta de ${threeDayMove.toFixed(0)}% em 3 dias — aguardar pullback`);
  }

  return { extended: reasons.length >= 2, reasons };
}

function percentMove(candles: Candle[], bars: number): number | null {
  if (candles.length <= bars) return null;
  const start = candles[candles.length - 1 - bars] as Candle;
  const end = candles[candles.length - 1] as Candle;
  if (start.close <= 0) return null;
  return ((end.close - start.close) / start.close) * 100;
}
