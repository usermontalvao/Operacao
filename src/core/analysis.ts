import type {
  Candle,
  IndicatorSnapshot,
  MarketContext,
  StructureSnapshot,
  Timeframe,
} from './types.ts';

/** Tudo que sabemos sobre um ativo em um timeframe, já calculado. */
export interface TimeframeAnalysis {
  timeframe: Timeframe;
  /** apenas candles fechados — o candle em formação nunca entra no cálculo */
  candles: Candle[];
  indicators: IndicatorSnapshot;
  structure: StructureSnapshot;
}

export interface SymbolAnalysis {
  symbol: string;
  /** último preço negociado (vem do ticker, não do candle fechado) */
  price: number;
  changePercent24h: number | null;
  timeframes: Partial<Record<Timeframe, TimeframeAnalysis>>;
  updatedAt: string;
}

export interface DetectorInput {
  analysis: SymbolAnalysis;
  trigger: TimeframeAnalysis;
  anchor: TimeframeAnalysis;
  context: MarketContext | null;
}
