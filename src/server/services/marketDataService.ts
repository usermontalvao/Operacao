import { EventEmitter } from 'node:events';
import type { SymbolAnalysis, TimeframeAnalysis } from '../../core/analysis.ts';
import type { Candle, ConnectionState, Timeframe } from '../../core/types.ts';
import { TIMEFRAMES } from '../../core/types.ts';
import { computeIndicators } from '../../core/engines/indicatorEngine.ts';
import { computeStructure } from '../../core/engines/structureEngine.ts';
import { getKlines, getTickers, parseKline } from '../binance/rest.ts';
import {
  BinanceStreamClient,
  klineStream,
  miniTickerStream,
  type KlineEvent,
  type TickerEvent,
} from '../binance/streams.ts';
import { logger } from '../logger.ts';

const MAX_CANDLES = 400;
const BOOTSTRAP_LIMIT = 320;
/** Mínimo de candles para confiar nos indicadores (EMA 200 precisa de história). */
const MIN_CANDLES = 60;

export interface MarketSnapshot {
  price: number;
  changePercent24h: number;
  quoteVolume24h: number;
  updatedAt: number;
}

/**
 * Fonte única de dados de mercado. Uma conexão WebSocket para todos os pares,
 * candles em memória e análise recalculada apenas quando um candle fecha —
 * tick de preço não dispara recálculo de indicador.
 */
export class MarketDataService extends EventEmitter {
  private readonly candles = new Map<string, Candle[]>();
  private readonly tickers = new Map<string, MarketSnapshot>();
  private readonly analysisCache = new Map<string, SymbolAnalysis>();
  private readonly dirty = new Set<string>();
  private readonly stream = new BinanceStreamClient();
  private symbols: string[] = [];
  private available = false;

  constructor() {
    super();
    this.stream.on('kline', (event: KlineEvent) => this.onKline(event));
    this.stream.on('ticker', (event: TickerEvent) => this.onTicker(event));
    this.stream.on('status', (status: ConnectionState) => this.emit('status', status));
  }

  getConnectionState(): ConnectionState {
    return this.stream.getStatus();
  }

  isAvailable(): boolean {
    return this.available;
  }

  getSymbols(): string[] {
    return [...this.symbols];
  }

  getSnapshot(symbol: string): MarketSnapshot | null {
    return this.tickers.get(symbol) ?? null;
  }

  getPrice(symbol: string): number | null {
    return this.tickers.get(symbol)?.price ?? null;
  }

  /**
   * Instante do tick mais recente entre TODOS os pares.
   *
   * É o sinal de vida do fluxo de preços. Um par isolado pode ficar minutos
   * sem negócio sem que nada esteja errado; o fluxo inteiro parar é o que
   * indica conexão morta — e operar com preço velho é operar às cegas.
   */
  lastTickAt(): number | null {
    let newest: number | null = null;
    for (const snapshot of this.tickers.values()) {
      if (newest === null || snapshot.updatedAt > newest) newest = snapshot.updatedAt;
    }
    return newest;
  }

  /** Idade do preço de um par, em ms. null = nunca houve preço. */
  priceAgeMs(symbol: string, now = Date.now()): number | null {
    const snapshot = this.tickers.get(symbol);
    return snapshot === undefined ? null : now - snapshot.updatedAt;
  }

  getCandles(symbol: string, timeframe: Timeframe): Candle[] {
    return this.candles.get(key(symbol, timeframe)) ?? [];
  }

  /** Carrega o histórico e abre os streams. Sem histórico não há indicador. */
  async start(symbols: string[]): Promise<void> {
    this.symbols = [...new Set(symbols)];
    await this.loadHistory(this.symbols);
    this.stream.start(this.buildStreams(this.symbols));
  }

  async setSymbols(symbols: string[]): Promise<void> {
    const next = [...new Set(symbols)];
    const added = next.filter((symbol) => !this.symbols.includes(symbol));
    this.symbols = next;
    if (added.length > 0) await this.loadHistory(added);
    this.stream.updateStreams(this.buildStreams(next));
  }

  stop(): void {
    this.stream.stop();
  }

  /**
   * Troca de ambiente (produção ↔ testnet) exige recomeçar do zero: os
   * candles em memória são de outro mercado e não podem ser reaproveitados.
   */
  async restart(symbols: string[]): Promise<void> {
    this.stream.stop();
    this.candles.clear();
    this.tickers.clear();
    this.analysisCache.clear();
    this.dirty.clear();
    this.available = false;
    await this.start(symbols);
  }

  private buildStreams(symbols: string[]): string[] {
    const streams: string[] = [];
    for (const symbol of symbols) {
      streams.push(miniTickerStream(symbol));
      for (const timeframe of TIMEFRAMES) streams.push(klineStream(symbol, timeframe));
    }
    return streams;
  }

  private async loadHistory(symbols: string[]): Promise<void> {
    for (const symbol of symbols) {
      for (const timeframe of TIMEFRAMES) {
        try {
          const raw = await getKlines(symbol, timeframe, BOOTSTRAP_LIMIT);
          const candles = raw.map((item, index) => parseKline(item, index < raw.length - 1));
          this.candles.set(key(symbol, timeframe), candles);
          this.available = true;
        } catch (error) {
          logger.error('Falha ao carregar candles', {
            symbol,
            timeframe,
            error: (error as Error).message,
          });
        }
      }
      this.dirty.add(symbol);
    }

    try {
      const tickers = await getTickers(symbols);
      for (const ticker of tickers) {
        this.tickers.set(ticker.symbol, {
          price: Number(ticker.lastPrice),
          changePercent24h: Number(ticker.priceChangePercent),
          quoteVolume24h: Number(ticker.quoteVolume),
          updatedAt: Date.now(),
        });
      }
      this.available = true;
    } catch (error) {
      logger.error('Falha ao carregar tickers', { error: (error as Error).message });
    }
  }

  private onKline(event: KlineEvent): void {
    const timeframe = event.interval as Timeframe;
    if (!TIMEFRAMES.includes(timeframe)) return;
    const seriesKey = key(event.symbol, timeframe);
    const series = this.candles.get(seriesKey);
    if (!series) return;

    const candle: Candle = {
      openTime: event.openTime,
      open: event.open,
      high: event.high,
      low: event.low,
      close: event.close,
      volume: event.volume,
      quoteVolume: event.quoteVolume,
      closeTime: event.closeTime,
      closed: event.closed,
    };

    const last = series[series.length - 1];
    if (last && last.openTime === candle.openTime) series[series.length - 1] = candle;
    else series.push(candle);
    if (series.length > MAX_CANDLES) series.splice(0, series.length - MAX_CANDLES);

    if (event.closed) {
      this.dirty.add(event.symbol);
      this.analysisCache.delete(event.symbol);
      this.emit('candleClosed', { symbol: event.symbol, timeframe });
    }
  }

  private onTicker(event: TickerEvent): void {
    this.tickers.set(event.symbol, {
      price: event.price,
      changePercent24h: event.changePercent,
      quoteVolume24h: event.quoteVolume,
      updatedAt: Date.now(),
    });
    this.available = true;
    this.emit('price', { symbol: event.symbol, price: event.price });
  }

  /**
   * Análise completa do ativo. Reaproveita o cache enquanto nenhum candle
   * fechar — só o preço corrente é atualizado a cada leitura.
   */
  getAnalysis(symbol: string): SymbolAnalysis | null {
    const snapshot = this.tickers.get(symbol);
    const cached = this.analysisCache.get(symbol);
    if (cached && !this.dirty.has(symbol)) {
      if (snapshot) {
        cached.price = snapshot.price;
        cached.changePercent24h = snapshot.changePercent24h;
      }
      return cached;
    }

    const timeframes: Partial<Record<Timeframe, TimeframeAnalysis>> = {};
    let hasData = false;

    for (const timeframe of TIMEFRAMES) {
      const series = this.candles.get(key(symbol, timeframe));
      if (!series) continue;
      const closed = series.filter((candle) => candle.closed);
      if (closed.length < MIN_CANDLES) continue;
      const indicators = computeIndicators(closed, timeframe);
      timeframes[timeframe] = {
        timeframe,
        candles: closed,
        indicators,
        structure: computeStructure(closed, indicators),
      };
      hasData = true;
    }
    if (!hasData) return null;

    const analysis: SymbolAnalysis = {
      symbol,
      price: snapshot?.price ?? timeframes['1h']?.indicators.close ?? 0,
      changePercent24h: snapshot?.changePercent24h ?? null,
      timeframes,
      updatedAt: new Date().toISOString(),
    };
    this.analysisCache.set(symbol, analysis);
    this.dirty.delete(symbol);
    return analysis;
  }
}

function key(symbol: string, timeframe: Timeframe): string {
  return `${symbol}|${timeframe}`;
}
