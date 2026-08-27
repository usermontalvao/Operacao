import type { SymbolAnalysis, TimeframeAnalysis } from '../analysis.ts';
import type { AppSettings, Candle, MarketContext, Timeframe } from '../types.ts';
import { computeIndicators } from '../engines/indicatorEngine.ts';
import { computeStructure } from '../engines/structureEngine.ts';
import { anchorFor, generateSetups } from '../engines/setupEngine.ts';
import type { Signal } from './types.ts';

export interface ReplayInput {
  symbol: string;
  trigger: Timeframe;
  /** séries completas por timeframe, em ordem crescente de tempo */
  series: Map<Timeframe, Candle[]>;
  settings: AppSettings;
  /** quantas barras entram no cálculo — a varredura usa 300 */
  window: number;
  /** primeira barra do gatilho elegível: aquecimento dos indicadores */
  warmupBars: number;
  /** contexto do BTC vigente naquele instante, se houver */
  contextAt?: (closeTime: number) => MarketContext | null;
  /** a mesma tese não vira sinal duas vezes dentro do cooldown */
  cooldownMinutes: number;
  /** auditoria: piso do corpo da explosão, para medir o que o piso descarta */
  pisoDoCorpoAtr?: number;
}

/**
 * Reproduz a varredura barra a barra.
 *
 * A regra que sustenta tudo: na barra i o motor só enxerga candles fechados
 * até i. O timeframe superior é cortado por closeTime <= fechamento da barra
 * do gatilho — sem isso o sinal nasceria sabendo como o candle de 4h ou o
 * diário terminaram, e o backtest inteiro viraria ficção.
 */
export function replaySignals(input: ReplayInput): Signal[] {
  const { symbol, trigger, series, settings, window, warmupBars, contextAt, cooldownMinutes } = input;
  const triggerSeries = series.get(trigger);
  if (!triggerSeries || triggerSeries.length <= warmupBars) return [];

  const anchorTimeframe = anchorFor(trigger, settings.scanner.anchorTimeframe);
  const higher = [...new Set([anchorTimeframe, '1d' as Timeframe])].filter((tf) => tf !== trigger);

  const replaySettings: AppSettings = {
    ...settings,
    scanner: { ...settings.scanner, triggerTimeframes: [trigger] },
  };

  // ponteiros que só avançam: o tempo do replay é monotônico
  const cursor = new Map<Timeframe, number>();
  const cached = new Map<Timeframe, { index: number; analysis: TimeframeAnalysis }>();
  for (const tf of higher) cursor.set(tf, 0);

  const signals: Signal[] = [];
  const lastSignalAt = new Map<string, number>();
  const cooldownMs = Math.max(cooldownMinutes, 0) * 60_000;
  let counter = 0;

  for (let i = warmupBars; i < triggerSeries.length; i += 1) {
    const bar = triggerSeries[i] as Candle;
    const closeTime = bar.closeTime;

    const timeframes: Partial<Record<Timeframe, TimeframeAnalysis>> = {};
    timeframes[trigger] = analysisOf(trigger, triggerSeries.slice(Math.max(0, i - window + 1), i + 1));

    let missingHigher = false;
    for (const tf of higher) {
      const list = series.get(tf);
      if (!list) { missingHigher = true; break; }
      // último candio do timeframe superior JÁ FECHADO neste instante
      let pointer = cursor.get(tf) ?? 0;
      while (pointer + 1 < list.length && (list[pointer + 1] as Candle).closeTime <= closeTime) pointer += 1;
      cursor.set(tf, pointer);
      if ((list[pointer] as Candle).closeTime > closeTime) { missingHigher = true; break; }

      const hit = cached.get(tf);
      if (hit && hit.index === pointer) {
        timeframes[tf] = hit.analysis;
      } else {
        const slice = list.slice(Math.max(0, pointer - window + 1), pointer + 1);
        if (slice.length < 60) { missingHigher = true; break; }
        const built = analysisOf(tf, slice);
        cached.set(tf, { index: pointer, analysis: built });
        timeframes[tf] = built;
      }
    }
    if (missingHigher) continue;

    const analysis: SymbolAnalysis = {
      symbol,
      price: bar.close,
      changePercent24h: null,
      timeframes,
      updatedAt: new Date(closeTime).toISOString(),
    };

    const generated = generateSetups({
      analysis,
      context: contextAt?.(closeTime) ?? null,
      settings: replaySettings,
      now: new Date(closeTime),
      makeId: () => `${symbol}-${(counter += 1)}`,
      pisoDoCorpoAtr: input.pisoDoCorpoAtr,
    });

    for (const setup of generated) {
      const previous = lastSignalAt.get(setup.fingerprint);
      if (previous !== undefined && closeTime - previous < cooldownMs) continue;
      lastSignalAt.set(setup.fingerprint, closeTime);
      signals.push({
        symbol,
        setup,
        barIndex: i,
        openTime: bar.openTime,
        atr: timeframes[trigger]?.indicators.atr14 ?? 0,
      });
    }
  }

  return signals;
}

function analysisOf(timeframe: Timeframe, candles: Candle[]): TimeframeAnalysis {
  const indicators = computeIndicators(candles, timeframe);
  return { timeframe, candles, indicators, structure: computeStructure(candles, indicators) };
}
