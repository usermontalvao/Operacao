import { EventEmitter } from 'node:events';
import type { SymbolAnalysis, TimeframeAnalysis } from '../../core/analysis.ts';
import type { Candle, ConnectionState, Timeframe } from '../../core/types.ts';
import { MICRO_TIMEFRAME, TIMEFRAMES } from '../../core/types.ts';
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
  /*
   * Os pares que recebem candle de 1 minuto — e SÓ eles.
   *
   * Este conjunto é a diferença entre "o micro scalp é opt-in" e "o micro
   * scalp é opt-in na aparência". Se o 1m entrasse em TIMEFRAMES, todo par do
   * universo abriria um stream de 1 minuto no boot, ligado ou desligado o
   * módulo. Vazio, o sistema se comporta exatamente como antes de o 1m
   * existir — nenhum stream, nenhuma carga, nenhum recálculo.
   */
  private microSymbols = new Set<string>();
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
    /*
     * O preço vivo vem ANTES do histórico.
     *
     * São cerca de 150 chamadas de candles no boot. Quando o WebSocket era
     * aberto só depois delas, o processo já respondia HTTP, mas o painel
     * passava quase um minuto em OFFLINE e as ordens pendentes ficavam sem
     * acompanhamento nesse intervalo. Um retrato de ticker basta para o
     * primeiro quadro; o histórico pode terminar de carregar em seguida.
     */
    await this.loadTickers(this.symbols);
    this.stream.start(this.buildStreams(this.symbols));
    // Indicadores podem aquecer em segundo plano. Acompanhamento de ordem e
    // stop não pode esperar as ~150 chamadas históricas terminarem.
    void this.loadHistory(this.symbols).then(() => {
      this.emit('historyLoaded', { symbols: this.symbols });
    });
  }

  async setSymbols(symbols: string[]): Promise<void> {
    const next = [...new Set(symbols)];
    const added = next.filter((symbol) => !this.symbols.includes(symbol));
    this.symbols = next;
    if (added.length > 0) await this.loadTickers(added);
    // O novo ativo começa a receber preço já; candles servem aos indicadores
    // e podem chegar logo depois sem deixar a ordem cega enquanto carregam.
    this.stream.updateStreams(this.buildStreams(next));
    if (added.length > 0) {
      void this.loadHistory(added).then(() => {
        this.emit('historyLoaded', { symbols: added });
      });
    }
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

  /** Os timeframes que ESTE par recebe: os quatro de sempre, mais 1m se for do scalp. */
  private timeframesFor(symbol: string): Timeframe[] {
    return this.microSymbols.has(symbol) ? [...TIMEFRAMES, MICRO_TIMEFRAME] : TIMEFRAMES;
  }

  private buildStreams(symbols: string[]): string[] {
    const streams: string[] = [];
    for (const symbol of symbols) {
      streams.push(miniTickerStream(symbol));
      for (const timeframe of this.timeframesFor(symbol)) {
        streams.push(klineStream(symbol, timeframe));
      }
    }
    return streams;
  }

  /**
   * Troca a lista de pares que recebem 1 minuto.
   *
   * Chamado pelo universo de scalp a cada remedição. Assina o que entrou,
   * cancela o que saiu e joga fora os candles de quem saiu — guardar série de
   * 1m de um par que não é mais acompanhado é vazamento de memória lento e
   * silencioso, do tipo que só aparece depois de dias no ar.
   */
  async setMicroSymbols(symbols: string[]): Promise<void> {
    const proximo = new Set(symbols.filter((symbol) => this.symbols.includes(symbol)));
    const entraram = [...proximo].filter((symbol) => !this.microSymbols.has(symbol));
    const sairam = [...this.microSymbols].filter((symbol) => !proximo.has(symbol));
    if (entraram.length === 0 && sairam.length === 0) return;

    this.microSymbols = proximo;

    for (const symbol of sairam) {
      this.candles.delete(key(symbol, MICRO_TIMEFRAME));
      this.dirty.add(symbol);
    }

    this.stream.updateStreams(this.buildStreams(this.symbols));

    for (const symbol of entraram) {
      try {
        const raw = await getKlines(symbol, MICRO_TIMEFRAME, BOOTSTRAP_LIMIT);
        const candles = raw.map((item, index) => parseKline(item, index < raw.length - 1));
        this.candles.set(key(symbol, MICRO_TIMEFRAME), candles);
        this.dirty.add(symbol);
      } catch (error) {
        logger.error('Falha ao carregar candles de 1m', {
          symbol,
          error: (error as Error).message,
        });
      }
    }

    logger.info('Streams de 1m ajustados', {
      entraram: entraram.length,
      sairam: sairam.length,
      total: this.microSymbols.size,
    });
  }

  getMicroSymbols(): string[] {
    return [...this.microSymbols];
  }

  private async loadHistory(symbols: string[]): Promise<void> {
    for (const symbol of symbols) {
      for (const timeframe of this.timeframesFor(symbol)) {
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
  }

  private async loadTickers(symbols: string[]): Promise<void> {
    if (symbols.length === 0) return;
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
    const aceito =
      TIMEFRAMES.includes(timeframe) ||
      (timeframe === MICRO_TIMEFRAME && this.microSymbols.has(event.symbol));
    if (!aceito) return;
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

    for (const timeframe of this.timeframesFor(symbol)) {
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
