import { type Side, isFavorable } from '../direction.ts';
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
  return detectDirectionalBreak(candles, resistances, atrPercent, 'BUY', lookback);
}

/**
 * O mesmo evento, do outro lado: perda de um suporte já provado.
 *
 * Vale a mesma exigência do rompimento de alta — não basta o preço furar o
 * nível, o vendedor precisa aparecer no reteste. Um suporte perdido sem
 * confirmação é candidato a pavio, e vender pavio é como comprar topo.
 */
export function detectBreakdown(
  candles: Candle[],
  supports: PriceLevel[],
  atrPercent: number,
  lookback = 12,
): BreakoutInfo | null {
  return detectDirectionalBreak(candles, supports, atrPercent, 'SELL', lookback);
}

/**
 * Rompimento nos dois sentidos. `far` é a borda que o preço precisa vencer
 * (o teto da resistência subindo, o piso do suporte caindo) e `near` é a
 * borda oposta, que define a falha.
 */
function detectDirectionalBreak(
  candles: Candle[],
  levels: PriceLevel[],
  atrPercent: number,
  side: Side,
  lookback: number,
): BreakoutInfo | null {
  if (candles.length < 5 || levels.length === 0) return null;
  const start = Math.max(1, candles.length - lookback);
  const tolerance = Math.min(Math.max(atrPercent * 0.5, 0.2), 2) / 100;

  let found: BreakoutInfo | null = null;

  for (const level of levels) {
    const far = side === 'SELL' ? level.low : level.high;
    const near = side === 'SELL' ? level.high : level.low;
    for (let i = start; i < candles.length; i += 1) {
      const candle = candles[i] as Candle;
      const previous = candles[i - 1] as Candle;
      const brokeNow =
        isFavorable(side, candle.close, far) && !isFavorable(side, previous.close, far);
      if (!brokeNow) continue;

      const after = candles.slice(i + 1);
      // volta a encostar no nível rompido: pela mínima quando subiu, pela
      // máxima quando caiu
      const touchOffset = after.findIndex((c) =>
        side === 'SELL'
          ? c.high >= far * (1 - tolerance)
          : c.low <= far * (1 + tolerance),
      );
      const retestIndex = touchOffset >= 0 ? i + 1 + touchOffset : null;
      const retested = retestIndex !== null;
      const failed = after.some((c) => isFavorable(side, near, c.close));
      const confirmation = confirmRetest(candles, retestIndex, level, side);
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
  side: Side = 'BUY',
): { index: number | null; reasons: string[] } {
  if (retestIndex === null) return { index: null, reasons: [] };
  const touch = candles[retestIndex];
  if (!touch) return { index: null, reasons: [] };

  const edge = side === 'SELL' ? level.low : level.high;
  const limit = Math.min(retestIndex + CONFIRMATION_WINDOW, candles.length - 1);
  for (let j = retestIndex; j <= limit; j += 1) {
    const bar = candles[j] as Candle;
    if (!isFavorable(side, bar.close, edge)) continue;

    const defended =
      j === retestIndex
        ? side === 'SELL'
          ? isBearishRejection(bar)
          : isBullishRejection(bar)
        : side === 'SELL'
          ? bar.high < touch.high
          : bar.low > touch.low;
    if (!defended) continue;

    const average = averageVolumeBefore(candles, j);
    if (average > 0 && bar.volume < average * MIN_CONFIRMATION_VOLUME) continue;

    const reasons = [
      `Fechamento de volta ${side === 'SELL' ? 'abaixo' : 'acima'} de ${edge.toPrecision(6)} ${j - retestIndex} candle(s) após o toque`,
      j === retestIndex
        ? 'Defesa na própria barra do toque'
        : side === 'SELL'
          ? 'Topo mais baixo que o do toque'
          : 'Fundo mais alto que o do toque',
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

/** Quanto o preço já subiu do fundo recente, em percentual — o espelho do pullback. */
export function bounceFromLow(candles: Candle[], window = 30): number | null {
  if (candles.length === 0) return null;
  const slice = candles.slice(-window);
  const low = Math.min(...slice.map((c) => c.low));
  const close = (slice[slice.length - 1] as Candle).close;
  if (low <= 0) return null;
  return ((close - low) / low) * 100;
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

/** Candle de exaustão compradora: fecha no terço inferior, com pavio em cima. */
export function isBearishRejection(candle: Candle): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) return false;
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const closesLow = (candle.high - candle.close) / range >= 0.6;
  return closesLow && (upperWick > body * 0.8 || candle.close < candle.open);
}
