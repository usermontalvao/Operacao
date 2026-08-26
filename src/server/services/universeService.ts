import type { SymbolAnalysis, TimeframeAnalysis } from '../../core/analysis.ts';
import type { Candle, SymbolFilters, Timeframe } from '../../core/types.ts';
import { computeIndicators } from '../../core/engines/indicatorEngine.ts';
import { computeStructure } from '../../core/engines/structureEngine.ts';
import { anchorFor } from '../../core/engines/setupEngine.ts';
import type { RawKline } from '../binance/rest.ts';
import { getKlines, getTickers, listTradableSymbols, parseKline } from '../binance/rest.ts';
import { logger } from '../logger.ts';
import type { ScannerService } from './scannerService.ts';
import type { SettingsService } from './settingsService.ts';

const TICK_MS = 8_000;
/**
 * Quarenta pares por lote mantêm a pressão previsível na API sem deixar o
 * sinal vencer na fila. Cada par pede três séries no cenário atual e cada
 * chamada de klines pesa 2: são 240 de peso por lote, espaçados em 8 s.
 *
 * O ganho importante vem de buscar os PARES em paralelo. Os timeframes de
 * cada par continuam em sequência, então a Binance recebe no máximo quarenta
 * chamadas de klines de uma vez, não cento e vinte.
 */
const BATCH_SIZE = 40;
const KLINE_LIMIT = 300;
/** Mínimo de candles para os indicadores fazerem sentido. */
const MIN_CANDLES = 60;

export interface UniverseStatus {
  enabled: boolean;
  total: number;
  liquid: number;
  cursor: number;
  scannedThisCycle: number;
  lastCycleSeconds: number | null;
  lastError: string | null;
  updatedAt: string | null;
}

/**
 * Varredura do mercado inteiro. Em vez de abrir centenas de WebSockets, este
 * serviço percorre o universo em lotes por REST: uma volta completa a cada
 * poucos minutos, dentro do limite de peso da Binance. Os candles são
 * descartados depois da análise — só o setup encontrado sobrevive.
 */
export class UniverseService {
  private readonly settings: SettingsService;
  private readonly scanner: ScannerService;
  private symbols: SymbolFilters[] = [];
  private liquid: string[] = [];
  private volumes = new Map<string, number>();
  private cursor = 0;
  private scannedThisCycle = 0;
  private cycleStartedAt = 0;
  private lastCycleSeconds: number | null = null;
  private lastError: string | null = null;
  private updatedAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(settings: SettingsService, scanner: ScannerService) {
    this.settings = settings;
    this.scanner = scanner;
  }

  start(): void {
    if (this.timer) return;
    // Não desperdiça os primeiros oito segundos depois de subir/reiniciar.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Troca de ambiente ou de modo de universo: recomeça a volta do zero. */
  reset(): void {
    this.symbols = [];
    this.liquid = [];
    this.volumes.clear();
    this.cursor = 0;
    this.scannedThisCycle = 0;
    this.cycleStartedAt = 0;
    this.lastError = null;
  }

  getStatus(): UniverseStatus {
    return {
      enabled: this.settings.get().scanner.universe === 'ALL_USDT',
      total: this.symbols.length,
      liquid: this.liquid.length,
      cursor: this.cursor,
      scannedThisCycle: this.scannedThisCycle,
      lastCycleSeconds: this.lastCycleSeconds,
      lastError: this.lastError,
      updatedAt: this.updatedAt,
    };
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    const settings = this.settings.get();
    if (settings.scanner.universe !== 'ALL_USDT') return;

    this.running = true;
    try {
      if (this.liquid.length === 0) await this.loadUniverse();
      if (this.liquid.length === 0) return;

      if (this.cursor === 0) this.cycleStartedAt = Date.now();
      const batch = this.liquid.slice(this.cursor, this.cursor + BATCH_SIZE);
      const timeframes = this.requiredTimeframes();

      const analyses = await analyzeSymbols(batch, timeframes);
      for (const analysis of analyses) {
        if (analysis) await this.scanner.ingest(analysis);
        this.scannedThisCycle += 1;
      }

      this.cursor += batch.length;
      this.updatedAt = new Date().toISOString();

      if (this.cursor >= this.liquid.length) {
        this.lastCycleSeconds = Math.round((Date.now() - this.cycleStartedAt) / 1000);
        logger.info('Volta completa no universo', {
          pares: this.liquid.length,
          segundos: this.lastCycleSeconds,
        });
        this.cursor = 0;
        this.scannedThisCycle = 0;
        this.liquid = [];
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = (error as Error).message;
      logger.warn('Falha na varredura do universo', { error: this.lastError });
    } finally {
      this.running = false;
    }
  }

  /**
   * Lista todos os pares Spot/USDT negociáveis.
   *
   * Liquidez continua sendo uma trava para EXECUTAR a operação no governador
   * de risco, mas não para ENXERGAR o mercado. Assim "Todo o spot USDT" não
   * esconde moedas só porque negociaram pouco nas últimas 24 horas.
   */
  private async loadUniverse(): Promise<void> {
    const settings = this.settings.get();
    this.symbols = await listTradableSymbols('USDT');

    const tickers = await getTickers(this.symbols.map((item) => item.symbol));
    this.volumes.clear();
    for (const ticker of tickers) this.volumes.set(ticker.symbol, Number(ticker.quoteVolume));

    const watchlist = new Set(settings.scanner.watchlist);
    this.liquid = selectUniverseSymbols(
      this.symbols.map((item) => item.symbol),
      watchlist,
      this.volumes,
    );

    logger.info('Universo carregado', {
      pares: this.symbols.length,
      varreduraPorLotes: this.liquid.length,
      tempoReal: watchlist.size,
    });
  }

  private requiredTimeframes(): Timeframe[] {
    const settings = this.settings.get();
    const required = new Set<Timeframe>(settings.scanner.triggerTimeframes);
    for (const trigger of settings.scanner.triggerTimeframes) {
      required.add(anchorFor(trigger, settings.scanner.anchorTimeframe));
    }
    required.add('1d');
    return [...required];
  }
}

/**
 * A watchlist já é analisada pelo WebSocket; a volta REST recebe todo o resto,
 * inclusive pares sem volume recente. Volume só ordena a fila para os mais
 * ativos serem vistos primeiro.
 */
export function selectUniverseSymbols(
  symbols: string[],
  watchlist: ReadonlySet<string>,
  volumes: ReadonlyMap<string, number>,
): string[] {
  return [...new Set(symbols)]
    .filter((symbol) => !watchlist.has(symbol))
    .sort((a, b) => (volumes.get(b) ?? 0) - (volumes.get(a) ?? 0));
}

export type KlineFetcher = (symbol: string, interval: string, limit: number) => Promise<RawKline[]>;

/**
 * Faz o trabalho de rede do lote em paralelo e deixa a ingestão fora daqui.
 * A ingestão continua sequencial no serviço para não criar corridas no mapa
 * de setups nem uma rajada de gravações no Supabase.
 */
export async function analyzeSymbols(
  symbols: string[],
  timeframes: Timeframe[],
  fetchKlines: KlineFetcher = getKlines,
): Promise<Array<SymbolAnalysis | null>> {
  return Promise.all(
    symbols.map((symbol) =>
      analyzeSymbol(symbol, timeframes, fetchKlines).catch(() => null),
    ),
  );
}

/**
 * Analisa um par pelo REST. O buscador de candles entra por parâmetro para que
 * o teste consiga provar qual preço sai daqui sem falar com a Binance.
 */
export async function analyzeSymbol(
  symbol: string,
  timeframes: Timeframe[],
  fetchKlines: KlineFetcher = getKlines,
): Promise<SymbolAnalysis | null> {
  const map: Partial<Record<Timeframe, TimeframeAnalysis>> = {};
  // Preço de agora, não de ontem: a volta passa por 1h, 4h e 1d, e o
  // fechamento do último timeframe analisado é o do dia anterior. Quem diz
  // onde o preço está é o candle em formação — o mesmo que a análise corta.
  let livePrice = 0;
  let triggerClose = 0;

  for (const timeframe of timeframes) {
    let raw: RawKline[];
    try {
      raw = await fetchKlines(symbol, timeframe, KLINE_LIMIT);
    } catch {
      return null;
    }
    // indicador só olha candle fechado; o candle cortado guarda o último negócio
    const candles: Candle[] = raw.slice(0, -1).map((item) => parseKline(item, true));
    if (candles.length < MIN_CANDLES) return null;

    const forming = raw[raw.length - 1];
    const formingClose = forming ? Number(forming[4]) : Number.NaN;
    if (Number.isFinite(formingClose) && formingClose > 0) livePrice = formingClose;

    const indicators = computeIndicators(candles, timeframe);
    map[timeframe] = {
      timeframe,
      candles,
      indicators,
      structure: computeStructure(candles, indicators),
    };
    // reserva: o fechamento do timeframe de gatilho, nunca o do diário
    if (timeframe === timeframes[0]) triggerClose = indicators.close;
  }

  return {
    symbol,
    price: livePrice > 0 ? livePrice : triggerClose,
    changePercent24h: null,
    timeframes: map,
    updatedAt: new Date().toISOString(),
  };
}
