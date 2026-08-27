import { DEFAULT_MICRO_SCALP } from '../core/scalp/config.ts';
import type { SymbolAnalysis, TimeframeAnalysis } from '../core/analysis.ts';
import type { AppSettings, Candle, MarketContext, Timeframe } from '../core/types.ts';
import { DEFAULT_GUARD } from '../core/risk/governor.ts';
import { DEFAULT_COSTS, type CostSettings } from '../core/risk/costs.ts';
import { computeIndicators } from '../core/engines/indicatorEngine.ts';
import { computeStructure } from '../core/engines/structureEngine.ts';
import { evaluateMarketContext } from '../core/engines/marketContextEngine.ts';
import { replaySignals } from '../core/backtest/replay.ts';
import { simulateSignal } from '../core/backtest/simulate.ts';
import type { ExitPolicy, Outcome, Signal } from '../core/backtest/types.ts';
import { loadKlines } from './klineCache.ts';

export const LAB_TIMEFRAMES: Timeframe[] = ['1h', '4h', '1d'];

export interface Dataset {
  symbol: string;
  series: Map<Timeframe, Candle[]>;
}

/**
 * As mesmas configurações que rodam em produção, escritas aqui em vez de
 * importadas do servidor: o laboratório não pode depender de .env nem mudar
 * de comportamento porque alguém mexeu no painel.
 */
export function labSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    mode: 'PAPER',
    market: 'SPOT',
    futuresEnabled: false,
    futures: {
      leverage: 3,
      maxLeverage: 10,
      marginMode: 'ISOLATED',
      allowShort: false,
      minLiquidationBufferPercent: 1.5,
    },
    risk: {
      paperCapital: 5000,
      paperCapitalCurrency: 'BRL',
      maxPositionPercent: 25,
      riskPerTradePercent: 1,
      maxOpenTrades: 3,
      dailyLossLimitPercent: 5,
      minimumRiskReward: 2,
      minimumScoreToAlert: 75,
      minimumScoreToShow: 60,
    },
    scanner: {
      watchlist: [],
      triggerTimeframes: ['1h'],
      anchorTimeframe: '1d',
      setupTtlMinutes: 720,
      cooldownMinutes: 120,
      burstRequireBtcRegime: true,
      microScalp: DEFAULT_MICRO_SCALP,
      universe: 'ALL_USDT',
      minQuoteVolume24h: 3_000_000,
    },
    autoTrade: {
      enabled: true,
      minimumScore: 90,
      minimumRiskReward: 2.5,
      percentOfCapital: 10,
      maxConcurrentTrades: 1,
      cooldownMinutes: 180,
      requireInsideEntryZone: true,
      allowLive: false,
      liveArmedUntil: null,
      liveArmedIndefinitely: false,
      maxNotionalPerTrade: 50,
      strategies: {
        PULLBACK: { enabled: true, minimumScore: 50, minimumRiskReward: 1 },
        BREAKOUT_RETEST: { enabled: true, minimumScore: 50, minimumRiskReward: 1 },
        SUPPORT_REVERSAL: { enabled: true, minimumScore: 50, minimumRiskReward: 1 },
        MOMENTUM_BURST: { enabled: true, minimumScore: 50, minimumRiskReward: 1 },
        RANGE_FADE: { enabled: true, minimumScore: 50, minimumRiskReward: 1 },
      },
    },
    guard: { ...DEFAULT_GUARD },
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

export const BASE_POLICY: ExitPolicy = {
  name: 'atual (50/30/20 + empate após alvo 1)',
  scaleOut: [0.5, 0.3, 0.2],
  breakevenAfterTarget1: true,
  trailingStopPercent: 0,
  partialAtR: null,
  partialShare: 0,
  breakevenAtR: null,
  atrTrailMultiple: null,
  timeStopBars: null,
  giveBackFraction: null,
  giveBackArmAtR: 1,
};

export const LAB_COSTS: CostSettings = { ...DEFAULT_COSTS };

/**
 * Mínimo de barras para um par entrar no estudo.
 *
 * O número acompanha o tamanho da barra: 1500 barras de 1h são dois meses,
 * 1500 barras de 15m são duas semanas. Exigir o mesmo dos dois deixaria
 * passar em 15m uma amostra curta demais para significar alguma coisa.
 */
const MINIMO_DE_BARRAS: Partial<Record<Timeframe, number>> = {
  '15m': 4000,
  '1h': 1500,
};

export async function loadDataset(
  symbols: string[],
  days: number,
  timeframes: Timeframe[] = LAB_TIMEFRAMES,
): Promise<Dataset[]> {
  const dataset: Dataset[] = [];
  for (const symbol of symbols) {
    const series = new Map<Timeframe, Candle[]>();
    let usable = true;
    for (const timeframe of timeframes) {
      const candles = await loadKlines(symbol, timeframe, days);
      // sem histórico não há o que medir; moeda nova entra viesada
      if (candles.length < (MINIMO_DE_BARRAS[timeframe] ?? 90)) usable = false;
      series.set(timeframe, candles);
    }
    if (usable) dataset.push({ symbol, series });
  }
  return dataset;
}

/**
 * Linha do tempo do contexto do BTC. O contexto muda a cada candle de 4H, e
 * é consultado pelo instante do sinal — nunca pelo estado de hoje.
 */
export async function buildBtcContexts(days: number): Promise<(closeTime: number) => MarketContext | null> {
  const tf4h = await loadKlines('BTCUSDT', '4h', days);
  const tf1d = await loadKlines('BTCUSDT', '1d', days);
  const hourly = await loadKlines('BTCUSDT', '1h', days);

  const timeline: Array<{ closeTime: number; context: MarketContext }> = [];
  let dailyPointer = 0;
  let hourlyPointer = 0;

  for (let i = 200; i < tf4h.length; i += 1) {
    const bar = tf4h[i] as Candle;
    while (dailyPointer + 1 < tf1d.length && (tf1d[dailyPointer + 1] as Candle).closeTime <= bar.closeTime) {
      dailyPointer += 1;
    }
    while (hourlyPointer + 1 < hourly.length && (hourly[hourlyPointer + 1] as Candle).closeTime <= bar.closeTime) {
      hourlyPointer += 1;
    }
    if (dailyPointer < 60) continue;

    const timeframes: Partial<Record<Timeframe, TimeframeAnalysis>> = {
      '4h': analysisOf('4h', tf4h.slice(Math.max(0, i - 299), i + 1)),
      '1d': analysisOf('1d', tf1d.slice(Math.max(0, dailyPointer - 299), dailyPointer + 1)),
    };
    const dayAgo = hourly[hourlyPointer - 24];
    const now = hourly[hourlyPointer];
    const analysis: SymbolAnalysis = {
      symbol: 'BTCUSDT',
      price: bar.close,
      changePercent24h:
        dayAgo && now && dayAgo.close > 0 ? ((now.close - dayAgo.close) / dayAgo.close) * 100 : null,
      timeframes,
      updatedAt: new Date(bar.closeTime).toISOString(),
    };
    timeline.push({
      closeTime: bar.closeTime,
      context: evaluateMarketContext(analysis, new Date(bar.closeTime).toISOString()),
    });
  }

  return (closeTime: number): MarketContext | null => {
    // busca binária pelo último contexto JÁ conhecido naquele instante
    let low = 0;
    let high = timeline.length - 1;
    let found: MarketContext | null = null;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const entry = timeline[mid] as { closeTime: number; context: MarketContext };
      if (entry.closeTime <= closeTime) {
        found = entry.context;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  };
}

function analysisOf(timeframe: Timeframe, candles: Candle[]): TimeframeAnalysis {
  const indicators = computeIndicators(candles, timeframe);
  return { timeframe, candles, indicators, structure: computeStructure(candles, indicators) };
}

export interface ReplayOptions {
  trigger: Timeframe;
  settings: AppSettings;
  contextAt?: (closeTime: number) => MarketContext | null;
  window?: number;
  warmupBars?: number;
}

export function collectSignals(dataset: Dataset[], options: ReplayOptions): Signal[] {
  const signals: Signal[] = [];
  for (const entry of dataset) {
    signals.push(
      ...replaySignals({
        symbol: entry.symbol,
        trigger: options.trigger,
        series: entry.series,
        settings: options.settings,
        window: options.window ?? 300,
        warmupBars: options.warmupBars ?? 250,
        contextAt: options.contextAt,
        cooldownMinutes: options.settings.scanner.cooldownMinutes,
      }),
    );
  }
  return signals.sort((a, b) => a.openTime - b.openTime);
}

export function simulateAll(
  signals: Signal[],
  dataset: Dataset[],
  trigger: Timeframe,
  policy: ExitPolicy,
  settings: AppSettings,
  costs: CostSettings = LAB_COSTS,
  intrabar: 'STOP_FIRST' | 'TARGET_FIRST' = 'STOP_FIRST',
): Outcome[] {
  const bySymbol = new Map(dataset.map((entry) => [entry.symbol, entry.series.get(trigger) ?? []]));
  const ttlBars = Math.max(
    1,
    Math.round((settings.scanner.setupTtlMinutes * 60_000) / intervalOf(trigger)),
  );

  return signals.map((signal) => {
    const series = bySymbol.get(signal.symbol) ?? [];
    return simulateSignal({
      signal,
      candles: series.slice(signal.barIndex),
      policy,
      costs,
      entryTtlBars: ttlBars,
      intrabar,
    });
  });
}

function intervalOf(timeframe: Timeframe): number {
  if (timeframe === '15m') return 900_000;
  if (timeframe === '4h') return 14_400_000;
  if (timeframe === '1d') return 86_400_000;
  return 3_600_000;
}
