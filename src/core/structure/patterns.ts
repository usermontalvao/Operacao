import type { BreakoutInfo, Candle, MarketStructure, PriceLevel, SwingPoint } from '../types.ts';
import { lastSwings } from './swings.ts';

/** Janela para o comprador aparecer depois do toque no nível. */
const CONFIRMATION_WINDOW = 5;
/** Volume mínimo da barra de confirmação, em múltiplos da média recente. */
const MIN_CONFIRMATION_VOLUME = 0.9;

/** HH/HL, LH/LL ou lateral, lendo os dois últimos topos e fundos. */
export function classifyStructure(swings: SwingPoint[]): MarketStructure {
  const highs = lastSwings(swings, 'HIGH', 2);
  const lows = lastSwings(swings, 'LOW', 2);
  if (highs.length < 2 || lows.length < 2) return 'UNDEFINED';

  const [prevHigh, lastHigh] = highs as [SwingPoint, SwingPoint];
  const [prevLow, lastLow] = lows as [SwingPoint, SwingPoint];
  const higherHigh = lastHigh.price > prevHigh.price;
  const higherLow = lastLow.price > prevLow.price;
  const lowerHigh = lastHigh.price < prevHigh.price;
  const lowerLow = lastLow.price < prevLow.price;

  if (higherHigh && higherLow) return 'HH_HL';
  if (lowerHigh && lowerLow) return 'LH_LL';
  return 'RANGE';
}

/**
 * Procura o rompimento de resistência mais recente e diz se ele foi
 * retestado ou se falhou. Só olha para trás uma janela curta — rompimento
 * de 40 barras atrás não é mais gatilho de entrada.
 */
export function detectBreakout(
  candles: Candle[],
  resistances: PriceLevel[],
  atrPercent: number,
  lookback = 12,
): BreakoutInfo | null {
  if (candles.length < 5 || resistances.length === 0) return null;
  const start = Math.max(1, candles.length - lookback);
  const tolerance = Math.min(Math.max(atrPercent * 0.5, 0.2), 2) / 100;

  let found: BreakoutInfo | null = null;

  for (const level of resistances) {
    for (let i = start; i < candles.length; i += 1) {
      const candle = candles[i] as Candle;
      const previous = candles[i - 1] as Candle;
      const brokeNow = candle.close > level.high && previous.close <= level.high;
      if (!brokeNow) continue;

      const after = candles.slice(i + 1);
      const touchOffset = after.findIndex((c) => c.low <= level.high * (1 + tolerance));
      const retestIndex = touchOffset >= 0 ? i + 1 + touchOffset : null;
      const retested = retestIndex !== null;
      const failed = after.some((c) => c.close < level.low);
      const confirmation = confirmRetest(candles, retestIndex, level);
      const info: BreakoutInfo = {
        level,
        breakoutIndex: i,
        breakoutClose: candle.close,
        retested,
        failed,
        barsSinceBreakout: candles.length - 1 - i,
        retestIndex,
        confirmed: confirmation.index !== null,
        confirmationIndex: confirmation.index,
        confirmationReasons: confirmation.reasons,
        barsSinceConfirmation:
          confirmation.index === null ? null : candles.length - 1 - confirmation.index,
      };
      if (found === null || info.breakoutIndex > found.breakoutIndex) found = info;
    }
  }
  return found;
}

/** Volume médio das barras anteriores a `index` — a régua do "volume voltou". */
function averageVolumeBefore(candles: Candle[], index: number, window = 20): number {
  const start = Math.max(0, index - window);
  if (index <= start) return 0;
  let total = 0;
  for (let i = start; i < index; i += 1) total += (candles[i] as Candle).volume;
  return total / (index - start);
}

/**
 * O toque no nível não é o sinal — a reação ao toque é.
 *
 * Antes bastava qualquer mínima posterior encostar na tolerância para o
 * rompimento ser dado como retestado. Isso trata igual o nível que foi
 * defendido e o nível que o preço atravessou de passagem. A confirmação exige
 * três coisas na mesma barra, dentro de uma janela curta:
 *   1. fechamento de volta acima do teto rompido — o nível virou chão;
 *   2. fundo mais alto que o do toque (ou candle de rejeição, quando a defesa
 *      acontece na própria barra do toque);
 *   3. volume presente — defesa sem volume é falta de vendedor, não compra.
 */
function confirmRetest(
  candles: Candle[],
  retestIndex: number | null,
  level: PriceLevel,
): { index: number | null; reasons: string[] } {
  if (retestIndex === null) return { index: null, reasons: [] };
  const touch = candles[retestIndex];
  if (!touch) return { index: null, reasons: [] };

  const limit = Math.min(retestIndex + CONFIRMATION_WINDOW, candles.length - 1);
  for (let j = retestIndex; j <= limit; j += 1) {
    const bar = candles[j] as Candle;
    if (bar.close <= level.high) continue;

    const higherLow = j === retestIndex ? isBullishRejection(bar) : bar.low > touch.low;
    if (!higherLow) continue;

    const average = averageVolumeBefore(candles, j);
    if (average > 0 && bar.volume < average * MIN_CONFIRMATION_VOLUME) continue;

    const reasons = [
      `Fechamento de volta acima de ${level.high.toPrecision(6)} ${j - retestIndex} candle(s) após o toque`,
      j === retestIndex ? 'Defesa na própria barra do toque' : 'Fundo mais alto que o do toque',
    ];
    if (average > 0) reasons.push(`Volume ${(bar.volume / average).toFixed(1)}x a média na confirmação`);
    return { index: j, reasons };
  }
  return { index: null, reasons: [] };
}

/** Faixa das últimas barras estreita em relação ao ATR = consolidação. */
export function isConsolidating(candles: Candle[], atrValue: number, window = 8): boolean {
  if (candles.length < window || atrValue <= 0) return false;
  const slice = candles.slice(-window);
  const high = Math.max(...slice.map((c) => c.high));
  const low = Math.min(...slice.map((c) => c.low));
  return high - low < atrValue * 2.2;
}

/** Quanto o preço já recuou do topo recente, em percentual. */
export function pullbackFromHigh(candles: Candle[], window = 30): number | null {
  if (candles.length === 0) return null;
  const slice = candles.slice(-window);
  const high = Math.max(...slice.map((c) => c.high));
  const close = (slice[slice.length - 1] as Candle).close;
  if (high <= 0) return null;
  return ((high - close) / high) * 100;
}

/** Candle de defesa: fecha no terço superior e reage a partir da mínima. */
export function isBullishRejection(candle: Candle): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = Math.abs(candle.close - candle.open);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const closesHigh = (candle.close - candle.low) / range >= 0.6;
  return closesHigh && (lowerWick > body * 0.8 || candle.close > candle.open);
}
