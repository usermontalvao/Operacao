import type { BtcContextState, Side, Trade, TradingMode } from '../../core/types.ts';
import {
  computeRiskSnapshot,
  evaluateEntryGate,
  type EntryGateResult,
  type RiskSnapshot,
} from '../../core/risk/governor.ts';
import type { SymbolVerdict } from '../../core/news/types.ts';
import type { Repository } from '../store/index.ts';
import type { MarketDataService } from './marketDataService.ts';
import type { SettingsService } from './settingsService.ts';

/**
 * Liga o disjuntor puro aos dados vivos.
 *
 * Nada de estado próprio: o retrato do risco é recalculado das operações
 * gravadas a cada consulta. Se o servidor reiniciar no meio de uma sequência
 * ruim, o disjuntor continua acionado — um bloqueio que se apaga sozinho ao
 * reiniciar não é bloqueio.
 */
export class RiskService {
  private readonly repository: Repository;
  private readonly settings: SettingsService;
  private readonly market: MarketDataService;
  private contextProvider: () => BtcContextState | null = () => null;
  private newsProvider: (symbol: string) => SymbolVerdict | null = () => null;

  constructor(repository: Repository, settings: SettingsService, market: MarketDataService) {
    this.repository = repository;
    this.settings = settings;
    this.market = market;
  }

  /** O scanner nasce depois; o contexto do BTC entra por aqui. */
  setContextProvider(provider: () => BtcContextState | null): void {
    this.contextProvider = provider;
  }

  /** O monitor de eventos entra pela mesma porta — e é opcional de propósito. */
  setNewsProvider(provider: (symbol: string) => SymbolVerdict | null): void {
    this.newsProvider = provider;
  }

  private prices(trades: Trade[]): Record<string, number> {
    const prices: Record<string, number> = {};
    for (const trade of trades) {
      if (prices[trade.symbol] !== undefined) continue;
      const price = this.market.getPrice(trade.symbol);
      if (price !== null) prices[trade.symbol] = price;
    }
    return prices;
  }

  async snapshot(capital: number, mode?: TradingMode): Promise<RiskSnapshot> {
    const target = mode ?? this.settings.get().mode;
    const policy = this.settings.forMode(target);
    const trades = await this.repository.listTrades();
    return computeRiskSnapshot({
      trades,
      mode: target,
      capital,
      dailyLossLimitPercent: policy.risk.dailyLossLimitPercent,
      guard: policy.guard,
      prices: this.prices(trades),
      now: new Date(),
    });
  }

  /** Porteiro de uma entrada nova, com o retrato de risco já pronto. */
  gate(input: {
    snapshot: RiskSnapshot;
    symbol: string;
    quoteAmount: number;
    netRiskReward: number;
    openTrades: Trade[];
    /** direção da entrada; sem ela o porteiro julga tudo como compra */
    side?: Side;
    /** sessão avaliada; cada modo tem o seu disjuntor */
    mode?: TradingMode;
  }): EntryGateResult {
    const guard = this.settings.forMode(input.mode ?? this.settings.get().mode).guard;
    return evaluateEntryGate({
      snapshot: input.snapshot,
      guard,
      symbol: input.symbol,
      quoteAmount: input.quoteAmount,
      netRiskReward: input.netRiskReward,
      openTrades: input.openTrades,
      side: input.side,
      btcContext: this.contextProvider(),
      quoteVolume24h: this.market.getSnapshot(input.symbol)?.quoteVolume24h ?? null,
      newsVerdict: this.newsProvider(input.symbol),
      now: new Date(),
    });
  }
}
