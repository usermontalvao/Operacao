import { type Side, directionOf } from '../direction.ts';
import type { Candle, ExtensionCheck, IndicatorSnapshot } from '../types.ts';

/**
 * Trava anti-FOMO. Uma moeda pode estar em tendência perfeita e ainda assim
 * ser uma entrada ruim AGORA, porque o preço já se esticou demais do ponto de
 * invalidação. Aqui o setup não é destruído: ele é marcado como ESTICADO.
 *
 * Vale para os dois lados: vender depois de o preço já ter desabado 25% em
 * três dias é o mesmo erro que comprar depois da alta — a distância até a
 * invalidação virou grande demais para o que sobrou de movimento.
 */
export function checkExtension(
  indicators: IndicatorSnapshot,
  candles: Candle[],
  side: Side = 'BUY',
): ExtensionCheck {
  const reasons: string[] = [];
  const short = side === 'SELL';
  const direction = directionOf(side);
  const { rsi14, ema20, atr14, close, bollinger, relativeVolume } = indicators;

  if (rsi14 !== null && (short ? rsi14 <= 25 : rsi14 >= 75)) {
    reasons.push(
      `RSI em ${rsi14.toFixed(0)} no ${indicators.timeframe} — ${short ? 'sobrevendido' : 'sobrecomprado'}`,
    );
  }
  if (ema20 !== null && atr14 !== null && atr14 > 0) {
    const distance = ((close - ema20) / atr14) * direction;
    if (distance >= 3) {
      reasons.push(
        `Preço ${distance.toFixed(1)} ATR ${short ? 'abaixo' : 'acima'} da EMA 20 — muito distante da média`,
      );
    }
  }
  const last = candles[candles.length - 1];
  if (last && atr14 !== null && atr14 > 0) {
    const body = (last.close - last.open) * direction;
    if (body > atr14 * 2.2) {
      reasons.push(`Candle explosivo de ${short ? 'baixa' : 'alta'} — entrada no fim do movimento`);
    }
  }
  if (bollinger && atr14 !== null && atr14 > 0) {
    const band = short ? bollinger.lower - atr14 * 0.5 : bollinger.upper + atr14 * 0.5;
    if (short ? close < band : close > band) {
      reasons.push(`Preço além da banda ${short ? 'inferior' : 'superior'} de Bollinger`);
    }
  }
  if (
    relativeVolume !== null &&
    relativeVolume >= 3 &&
    last &&
    (short ? last.close < last.open : last.close > last.open)
  ) {
    reasons.push(`Volume climático de ${short ? 'venda' : 'compra'} — típico de exaustão`);
  }

  const threeDayMove = percentMove(candles, 3);
  if (threeDayMove !== null && threeDayMove * direction >= 25 && indicators.timeframe === '1d') {
    reasons.push(
      `${short ? 'Queda' : 'Alta'} de ${Math.abs(threeDayMove).toFixed(0)}% em 3 dias — aguardar ${short ? 'repique' : 'pullback'}`,
    );
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
