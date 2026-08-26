import type { AppSettings, Candle, Timeframe } from '../types.ts';
import type { SymbolAnalysis, TimeframeAnalysis } from '../analysis.ts';
import { computeIndicators } from '../engines/indicatorEngine.ts';
import { computeStructure } from '../engines/structureEngine.ts';
import { DEFAULT_GUARD } from '../risk/governor.ts';

export interface CandleOptions {
  /** amplitude do pavio como fração do preço */
  wick?: number;
  volume?: number;
  startTime?: number;
  intervalMs?: number;
  /** permite forjar volume climático ou volume secando */
  volumeAt?: (index: number, changePercent: number) => number;
}

/** Constrói candles a partir de um caminho de fechamentos. */
export function candlesFromPath(path: number[], options: CandleOptions = {}): Candle[] {
  const wick = options.wick ?? 0.004;
  const baseVolume = options.volume ?? 1000;
  const start = options.startTime ?? Date.UTC(2026, 0, 1);
  const interval = options.intervalMs ?? 3_600_000;

  return path.map((close, index) => {
    // corpo de 60% do movimento: evita que a máxima de uma barra empate com a
    // da vizinha, o que apagaria os pivôs
    const previous = index === 0 ? close : (path[index - 1] as number);
    const open = close - (close - previous) * 0.6;
    const high = Math.max(open, close) * (1 + wick);
    const low = Math.min(open, close) * (1 - wick);
    const changePercent = open === 0 ? 0 : ((close - open) / open) * 100;
    const volume = options.volumeAt
      ? options.volumeAt(index, changePercent)
      : baseVolume * (1 + Math.abs(changePercent) * 1.5);
    return {
      openTime: start + index * interval,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume: volume * close,
      closeTime: start + (index + 1) * interval - 1,
      closed: true,
    };
  });
}

export function analysisFrom(
  symbol: string,
  candles: Candle[],
  timeframes: Timeframe[],
  price?: number,
): SymbolAnalysis {
  const map: Partial<Record<Timeframe, TimeframeAnalysis>> = {};
  for (const timeframe of timeframes) {
    const indicators = computeIndicators(candles, timeframe);
    map[timeframe] = {
      timeframe,
      candles,
      indicators,
      structure: computeStructure(candles, indicators),
    };
  }
  const last = candles[candles.length - 1];
  return {
    symbol,
    price: price ?? last?.close ?? 0,
    changePercent24h: 0,
    timeframes: map,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Caminho sintético: alta consistente com oscilações (gera pivôs), topo,
 * correção até uma região já visitada e estabilização com defesa compradora.
 */
export function uptrendWithPullback(): number[] {
  const path: number[] = [];
  // alta com ondas largas o bastante para gerar topos e fundos ascendentes
  for (let i = 0; i < 200; i += 1) {
    path.push(round(100 + i * 0.28 + Math.sin(i / 3) * 4.5));
  }
  // correção até a região de um fundo anterior
  const high = path[path.length - 1] as number;
  for (let i = 1; i <= 8; i += 1) path.push(round(high - i * 0.62));
  // estabilização com defesa compradora
  const bottom = path[path.length - 1] as number;
  path.push(round(bottom - 0.15), round(bottom + 0.05), round(bottom + 0.2), round(bottom + 0.7));
  return path;
}

/** Consolidação, rompimento com volume e reteste do nível rompido. */
export function breakoutWithRetest(): number[] {
  const path: number[] = [];
  for (let i = 0; i < 120; i += 1) {
    path.push(round(50 + i * 0.09 + Math.sin(i / 3) * 2.2));
  }
  // três tentativas frustradas no mesmo teto
  const ceiling = 65;
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (const offset of [-2.4, -1.2, -0.2, -1.4, -2.6, -1.6]) {
      path.push(round(ceiling + offset));
    }
  }
  // rompimento, volta ao nível e DEFESA: o comprador reaparece com força
  for (const value of [65.6, 66.9, 67.6]) path.push(value);
  for (const value of [66.4, 65.5, 65.35, 66.6, 66.2]) path.push(value);
  return path;
}

/**
 * O mesmo rompimento, mas o preço só passa pelo nível: encosta, não fecha de
 * volta acima dele com fundo mais alto e segue de lado morrendo. É o caso que
 * a definição antiga de reteste tratava como bom.
 */
export function breakoutWithWeakRetest(): number[] {
  const path: number[] = [];
  for (let i = 0; i < 120; i += 1) {
    path.push(round(50 + i * 0.09 + Math.sin(i / 3) * 2.2));
  }
  const ceiling = 65;
  for (let cycle = 0; cycle < 3; cycle += 1) {
    for (const offset of [-2.4, -1.2, -0.2, -1.4, -2.6, -1.6]) {
      path.push(round(ceiling + offset));
    }
  }
  for (const value of [65.6, 66.9, 67.6]) path.push(value);
  // toca o nível e continua descendo: ninguém defendeu
  for (const value of [66.4, 65.4, 64.9, 64.7, 64.8]) path.push(value);
  return path;
}

export function defaultTestSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    mode: 'PAPER',
    market: 'SPOT',
    futures: {
      leverage: 3,
      maxLeverage: 10,
      marginMode: 'ISOLATED',
      allowShort: false,
      minLiquidationBufferPercent: 1.5,
    },
    risk: {
      paperCapital: 1000,
      paperCapitalCurrency: 'USDT',
      maxPositionPercent: 25,
      riskPerTradePercent: 1,
      maxOpenTrades: 3,
      dailyLossLimitPercent: 5,
      minimumRiskReward: 1.8,
      minimumScoreToAlert: 75,
      minimumScoreToShow: 60,
    },
    scanner: {
      watchlist: ['BTCUSDT'],
      triggerTimeframes: ['1h', '4h'],
      anchorTimeframe: '1d',
      setupTtlMinutes: 240,
      cooldownMinutes: 90,
      universe: 'WATCHLIST',
      minQuoteVolume24h: 5_000_000,
    },
    autoTrade: {
      enabled: false,
      minimumScore: 90,
      minimumRiskReward: 2.5,
      percentOfCapital: 10,
      maxConcurrentTrades: 1,
      cooldownMinutes: 180,
      requireInsideEntryZone: true,
      allowLive: false,
      liveArmedUntil: null,
      maxNotionalPerTrade: 50,
    },
    guard: { ...DEFAULT_GUARD },
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
