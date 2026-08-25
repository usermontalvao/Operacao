import type { SymbolFilters } from '../../core/types.ts';
import { stateEventsFrom, transitionEventsFrom } from '../../core/news/exchangeState.ts';
import { isActive, mergeEvents, verdictFor } from '../../core/news/rules.ts';
import type { MarketEvent, SymbolVerdict } from '../../core/news/types.ts';
import { listSpotPairsWithState } from '../binance/rest.ts';
import { logger } from '../logger.ts';

const TICK_MS = 5 * 60 * 1000;

export type PairStateFetcher = () => Promise<SymbolFilters[]>;

export interface NewsStatus {
  events: MarketEvent[];
  blockedSymbols: string[];
  lastRefreshAt: string | null;
  lastError: string | null;
}

/**
 * Monitor do que acontece com o ativo fora do gráfico.
 *
 * A primeira camada — e a única que não depende de ninguém publicar texto — é
 * o que a própria corretora declara. Duas naturezas convivem aqui e não podem
 * ser misturadas:
 *
 * - ESTADO: recalculado do zero a cada leitura. O par voltou a negociar? O
 *   bloqueio some sozinho, sem ninguém precisar retirá-lo.
 * - NOTÍCIA: a transição entre duas leituras. Acumula, porque o fato de o par
 *   ter sumido da lista não está mais visível em leitura nenhuma depois.
 */
export class NewsService {
  private readonly fetchPairs: PairStateFetcher;
  private stateEvents: MarketEvent[] = [];
  private newsEvents: MarketEvent[] = [];
  private previousPairs: SymbolFilters[] | null = null;
  private lastRefreshAt: string | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(fetchPairs: PairStateFetcher = () => listSpotPairsWithState('USDT')) {
    this.fetchPairs = fetchPairs;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Troca de ambiente: o testnet tem outra lista de pares, e comparar as duas
   * produziria uma enxurrada de deslistagens que nunca aconteceram.
   */
  reset(): void {
    this.stateEvents = [];
    this.newsEvents = [];
    this.previousPairs = null;
    this.lastError = null;
  }

  async refresh(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pairs = await this.fetchPairs();
      if (pairs.length === 0) return; // lista vazia é falha de leitura, não mercado fechado

      this.stateEvents = stateEventsFrom(pairs, now);
      const transitions = transitionEventsFrom(this.previousPairs, pairs, now);
      if (transitions.length > 0) {
        this.newsEvents = mergeEvents(this.newsEvents, transitions);
        for (const event of transitions) {
          if (event.severity === 'BLOCK') {
            logger.warn('Evento de mercado bloqueia um ativo', {
              symbol: event.symbols[0],
              titulo: event.title,
            });
          }
        }
      }
      this.newsEvents = this.newsEvents.filter((event) => isActive(event, now));
      this.previousPairs = pairs;
      this.lastRefreshAt = now.toISOString();
      this.lastError = null;
    } catch (error) {
      // Falha de leitura não é "nada acontecendo": o último veredito continua
      // valendo. Apagar os eventos aqui liberaria a compra de um par suspenso
      // justamente quando a corretora está instável.
      this.lastError = (error as Error).message;
      logger.warn('Falha ao ler o estado dos pares', { error: this.lastError });
    } finally {
      this.running = false;
    }
  }

  private allEvents(): MarketEvent[] {
    return [...this.stateEvents, ...this.newsEvents];
  }

  /** O que se sabe sobre um ativo agora. Sem nada sabido, veredito neutro. */
  verdict(symbol: string, now = new Date()): SymbolVerdict {
    return verdictFor(symbol, this.allEvents(), now);
  }

  getStatus(now = new Date()): NewsStatus {
    const events = this.allEvents().filter((event) => isActive(event, now));
    const blocked = new Set<string>();
    for (const event of events) {
      if (event.severity !== 'BLOCK') continue;
      for (const symbol of event.symbols) {
        if (verdictFor(symbol, events, now).blocked) blocked.add(symbol);
      }
    }
    return {
      events,
      blockedSymbols: [...blocked].sort(),
      lastRefreshAt: this.lastRefreshAt,
      lastError: this.lastError,
    };
  }
}
