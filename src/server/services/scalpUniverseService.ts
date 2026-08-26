import type { Candle, ScalpabilityReport } from '../../core/types.ts';
import { MICRO_TIMEFRAME } from '../../core/types.ts';
import { atr } from '../../core/indicators/index.ts';
import { measureLiquidity } from '../../core/scalp/liquidity.ts';
import { scoreScalpability } from '../../core/scalp/scalpability.ts';
import { getKlines, getOrderBook, getTickers, listTradableSymbols, parseKline } from '../binance/rest.ts';
import { logger } from '../logger.ts';
import type { SettingsService } from './settingsService.ts';

/**
 * O SCALP UNIVERSE.
 *
 * A varredura normal do projeto percorre os 484 pares USDT em lotes por REST,
 * e uma volta completa leva minutos. Isso funciona para uma tese de 1 hora e
 * é inútil para uma de 1 minuto: o sinal morre antes de o cursor chegar nele.
 *
 * Então o micro scalp inverte o desenho. Em vez de varrer todo mundo devagar,
 * ele mantém uma lista CURTA de pares realmente operáveis e os acompanha em
 * tempo real por WebSocket. A lista é remedida a cada poucos minutos — porque
 * liquidez muda em minutos, não em segundos — e o que decide quem entra não é
 * volume, é a nota de scalpabilidade.
 *
 * O custo disso é honesto e limitado: uma volta de medição gasta uma chamada
 * de ticker geral, uma de candles e uma de book por candidato. Só os
 * candidatos que já passaram no filtro de volume são medidos no book, porque
 * o book é a chamada cara (peso 5 contra 2 do klines).
 */

/** Candles de 1m baixados para medir ATR e volume recente. */
const PROBE_CANDLES = 120;
/** Barras que compõem o "volume recente" — 15 minutos. */
const RECENT_WINDOW = 15;

export interface ScalpUniverseStatus {
  enabled: boolean;
  /** pares que passaram em tudo e estão sendo acompanhados em 1m */
  active: string[];
  /** medições da volta atual, aprovados e reprovados, para a tela */
  reports: ScalpabilityReport[];
  candidatesMeasured: number;
  lastCycleSeconds: number | null;
  lastError: string | null;
  updatedAt: string | null;
}

export class ScalpUniverseService {
  private readonly settings: SettingsService;
  private reports = new Map<string, ScalpabilityReport>();
  private active: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private candidatesMeasured = 0;
  private lastCycleSeconds: number | null = null;
  private lastError: string | null = null;
  private updatedAt: string | null = null;
  private onChange: ((symbols: string[]) => void) | null = null;

  constructor(settings: SettingsService) {
    this.settings = settings;
  }

  /** Avisado quando a lista muda — é assim que os streams de 1m sobem e descem. */
  setOnChange(listener: (symbols: string[]) => void): void {
    this.onChange = listener;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    // o intervalo é reavaliado a cada volta: mudar a configuração não exige reiniciar
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getActiveSymbols(): string[] {
    return [...this.active];
  }

  getReport(symbol: string): ScalpabilityReport | null {
    return this.reports.get(symbol) ?? null;
  }

  getStatus(): ScalpUniverseStatus {
    return {
      enabled: this.settings.get().scanner.microScalp.enabled,
      active: [...this.active],
      reports: [...this.reports.values()].sort((a, b) => b.score - a.score),
      candidatesMeasured: this.candidatesMeasured,
      lastCycleSeconds: this.lastCycleSeconds,
      lastError: this.lastError,
      updatedAt: this.updatedAt,
    };
  }

  private lastRunAt = 0;

  /**
   * Força uma remedição imediata, ignorando o intervalo.
   *
   * Existe para o interruptor da tela: quem acabou de ligar o micro scalp não
   * pode esperar três minutos para ver o primeiro par entrar. Fora daí, o
   * intervalo manda — medir book de sessenta pares a cada dez segundos seria
   * gastar cota da Binance para descobrir que a liquidez não mudou.
   */
  async refreshNow(): Promise<void> {
    this.lastRunAt = 0;
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    const settings = this.settings.get();
    const micro = settings.scanner.microScalp;

    /*
     * Desligado, o serviço não é só inerte: ele DESMONTA o que tinha montado.
     *
     * Deixar a lista de pé com o módulo desligado manteria vinte streams de
     * 1m abertos e o scanner continuaria recebendo candles que ninguém lê —
     * "desligado" precisa significar o estado anterior ao ligamento, não um
     * ligado que ninguém consulta.
     */
    if (!micro.enabled) {
      if (this.active.length > 0) {
        this.active = [];
        this.reports.clear();
        this.onChange?.([]);
        logger.info('Micro scalp desligado: universo de scalp desmontado');
      }
      return;
    }

    const intervaloMs = Math.max(30, micro.universeRefreshSeconds) * 1000;
    if (Date.now() - this.lastRunAt < intervaloMs) return;

    this.running = true;
    const inicio = Date.now();
    try {
      await this.remedir();
      this.lastRunAt = Date.now();
      this.lastCycleSeconds = Math.round((Date.now() - inicio) / 1000);
      this.lastError = null;
      this.updatedAt = new Date().toISOString();
    } catch (error) {
      this.lastError = (error as Error).message;
      logger.warn('Falha ao medir o universo de scalp', { error: this.lastError });
    } finally {
      this.running = false;
    }
  }

  private async remedir(): Promise<void> {
    const settings = this.settings.get();
    const micro = settings.scanner.microScalp;
    const filtros = micro.filters;

    /*
     * O funil começa pelo mais barato. Uma chamada de ticker traz o mercado
     * inteiro; dela sai a lista de quem tem volume de 24h suficiente, e só
     * esses gastam klines e book. Medir o book de 484 pares por volta seria
     * 2420 de peso a cada três minutos — desnecessário, porque volume de 24h
     * já elimina a maioria sem custo nenhum.
     */
    /*
     * A lista de pares vem de `listTradableSymbols`, não de uma chamada de
     * ticker sem argumentos: `getTickers([])` devolve lista VAZIA por
     * contrato, e passar array vazio esperando "o mercado inteiro" fazia o
     * universo de scalp medir zero par sem erro nenhum — o módulo ficava
     * ligado e permanentemente sem candidatos.
     *
     * É também o caminho certo por outro motivo: só entra par que a corretora
     * está de fato negociando AGORA. Um par suspenso continua aparecendo no
     * ticker de 24h com volume alto do dia anterior.
     */
    const negociaveis = await listTradableSymbols('USDT');
    const tickers = await getTickers(negociaveis.map((item) => item.symbol));
    const candidatos = tickers
      .filter((ticker) => ticker.symbol.endsWith('USDT'))
      .map((ticker) => ({ symbol: ticker.symbol, volume: Number(ticker.quoteVolume) }))
      .filter((item) => Number.isFinite(item.volume) && item.volume >= filtros.minQuoteVolume24h)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, Math.max(1, micro.maxCandidates));

    const relatorios: ScalpabilityReport[] = [];

    for (const candidato of candidatos) {
      try {
        const relatorio = await this.medirPar(candidato.symbol, candidato.volume);
        if (relatorio) relatorios.push(relatorio);
      } catch (error) {
        // um par que falha não derruba a volta: ele simplesmente não entra
        logger.debug?.('Par ignorado na medição de scalp', {
          symbol: candidato.symbol,
          error: (error as Error).message,
        });
      }
    }

    this.candidatesMeasured = relatorios.length;
    this.reports = new Map(relatorios.map((item) => [item.symbol, item]));

    /*
     * Quem entra no universo de tempo real.
     *
     * Vetando, só os pares sem nenhum impedimento. Sem vetar, o ranking por
     * nota decide — o que continua sendo uma escolha, e não "todos": cada par
     * aqui abre um stream de 1m, e o teto existe para o WebSocket que o painel
     * inteiro usa não virar refém desta lista.
     */
    const aprovados = relatorios
      .filter((item) => !item.blocked)
      .sort((a, b) => b.score - a.score)
      .slice(0, micro.maxUniverseSize)
      .map((item) => item.symbol);

    const mudou =
      aprovados.length !== this.active.length ||
      aprovados.some((symbol, index) => symbol !== this.active[index]);

    this.active = aprovados;

    if (mudou) {
      logger.info('Universo de scalp atualizado', {
        aprovados: aprovados.length,
        medidos: relatorios.length,
        pares: aprovados.join(','),
      });
      this.onChange?.(aprovados);
    }
  }

  private async medirPar(symbol: string, quoteVolume24h: number): Promise<ScalpabilityReport | null> {
    const settings = this.settings.get();
    const micro = settings.scanner.microScalp;

    const raw = await getKlines(symbol, MICRO_TIMEFRAME, PROBE_CANDLES);
    const candles: Candle[] = raw.map((item, index) => parseKline(item, index < raw.length - 1));
    // o candle em formação não conta: ele mudaria a medição a cada segundo
    const fechados = candles.filter((candle) => candle.closed);
    if (fechados.length < 40) return null;

    const atrSerie = atr(fechados, 14);
    const atrValor = ultimo(atrSerie);
    const preco = fechados[fechados.length - 1]?.close ?? 0;
    const microAtrPercent = atrValor !== null && preco > 0 ? (atrValor / preco) * 100 : null;

    const recentQuoteVolume = fechados
      .slice(-RECENT_WINDOW)
      .reduce((total, candle) => total + candle.quoteVolume, 0);

    const book = await getOrderBook(symbol, 100);
    const liquidez = measureLiquidity({
      symbol,
      bids: book.bids,
      asks: book.asks,
      quoteVolume24h,
      recentQuoteVolume,
      probeOrderUsd: micro.probeOrderUsd,
      measuredAt: Date.now(),
    });
    if (!liquidez) return null;

    return scoreScalpability({
      liquidity: liquidez,
      microAtrPercent,
      filters: micro.filters,
      weights: micro.weights,
      // taxa da conta E da modalidade ativas: spot e futuros são diferentes
      feePercent: settings.guard.feePercent,
      fallbackSlippagePercent: settings.guard.exitSlippagePercent,
      // o mesmo múltiplo que o guarda de oportunidade cobra lá na frente:
      // o piso de amplitude e a recusa final passam a falar do mesmo critério
      minCostMultiple: micro.regime.minCostMultiple,
      enforce: micro.enforceFilters,
    });
  }
}

function ultimo(series: (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}
