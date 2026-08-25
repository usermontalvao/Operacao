import { randomUUID } from 'node:crypto';
import type { SymbolAnalysis } from '../../core/analysis.ts';
import type { AssetView, MarketContext, TradeSetup } from '../../core/types.ts';
import { evaluateMarketContext } from '../../core/engines/marketContextEngine.ts';
import { applyPriceUpdate, generateSetups } from '../../core/engines/setupEngine.ts';
import type { EventBus } from '../events.ts';
import { logger } from '../logger.ts';
import type { Repository } from '../store/index.ts';
import type { AlertEngine } from './alertEngine.ts';
import type { AuditService } from './auditService.ts';
import type { MarketDataService } from './marketDataService.ts';
import type { PaperTradingEngine } from './paperTradingEngine.ts';
import type { SettingsService } from './settingsService.ts';
import type { AutoTrader } from './autoTrader.ts';
import { MAX_FOCUS_SYMBOLS, withBitcoin } from './focus.ts';

const SCAN_INTERVAL_MS = 30_000;
const LIVE_STATUSES: TradeSetup['status'][] = ['WATCHING', 'ACTIVE', 'TRIGGERED'];
/** Por quanto tempo a fingerprint de um setup morto continua sendo lembrada. */
const RETIRED_MEMORY_MS = 24 * 60 * 60 * 1000;

/**
 * Orquestrador: junta dados de mercado, contexto do BTC e detectores, cuida
 * do ciclo de vida dos setups e avisa o navegador. É o único lugar que decide
 * quando um setup nasce, muda ou morre.
 */
export class ScannerService {
  private readonly market: MarketDataService;
  private readonly repository: Repository;
  private readonly settings: SettingsService;
  private readonly bus: EventBus;
  private readonly alerts: AlertEngine;
  private readonly paper: PaperTradingEngine;
  private readonly audit: AuditService;

  private setups = new Map<string, TradeSetup>();
  /** fingerprint -> instante em que a tese morreu; sobrevive ao reinício */
  private retired = new Map<string, number>();
  private autoTrader: AutoTrader | null = null;
  private context: MarketContext | null = null;
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(
    market: MarketDataService,
    repository: Repository,
    settings: SettingsService,
    bus: EventBus,
    alerts: AlertEngine,
    paper: PaperTradingEngine,
    audit: AuditService,
  ) {
    this.market = market;
    this.repository = repository;
    this.settings = settings;
    this.bus = bus;
    this.alerts = alerts;
    this.paper = paper;
    this.audit = audit;
  }

  /** O robô só entra em cena depois de montado — e só nas contas de teste. */
  setAutoTrader(autoTrader: AutoTrader): void {
    this.autoTrader = autoTrader;
  }

  async start(): Promise<void> {
    const stored = await this.repository.listSetups();
    for (const setup of stored) {
      // explosão NUNCA volta ao radar depois de um reinício. Ela é uma tese de
      // entrada imediata: se não preencheu na janela dela, acabou. Medir a
      // idade do registro não resolveria — o TLMUSDT tinha 11 minutos de
      // cadastro e três horas de atraso em relação à barra que o gerou.
      if (setup.setupType === 'MOMENTUM_BURST') {
        this.rememberRetired(setup);
        continue;
      }
      if (LIVE_STATUSES.includes(setup.status) && !setup.ignoredAt) {
        this.setups.set(setup.id, setup);
      } else {
        this.rememberRetired(setup);
      }
    }

    this.market.on('price', ({ symbol, price }: { symbol: string; price: number }) => {
      this.bus.queuePrice(symbol, price);
      void this.onPrice(symbol, price);
    });
    this.market.on('candleClosed', () => {
      void this.scan();
    });
    this.market.on('status', (connection) => {
      this.bus.broadcast({
        type: 'status',
        payload: { connection, binanceAvailable: this.market.isAvailable() },
      });
    });

    this.timer = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
    this.timer.unref?.();
    await this.scan();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getContext(): MarketContext | null {
    return this.context;
  }

  getSetups(): TradeSetup[] {
    return [...this.setups.values()].sort((a, b) => b.score - a.score);
  }

  getSetup(id: string): TradeSetup | null {
    return this.setups.get(id) ?? null;
  }

  async ignoreSetup(id: string): Promise<TradeSetup | null> {
    const setup = this.setups.get(id);
    if (!setup) return null;
    const updated: TradeSetup = {
      ...setup,
      ignoredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.setups.delete(id);
    this.rememberRetired(updated);
    await this.repository.saveSetup(updated);
    this.bus.broadcast({ type: 'setupRemoved', payload: { id } });
    await this.audit.record({
      action: 'SETUP_IGNORED',
      mode: this.settings.get().mode,
      symbol: setup.symbol,
      setupId: setup.id,
    });
    return updated;
  }

  /** Marca o setup como comprado — daí em diante quem manda é a operação. */
  async markBought(setup: TradeSetup): Promise<TradeSetup> {
    const updated: TradeSetup = { ...setup, status: 'BOUGHT', updatedAt: new Date().toISOString() };
    this.setups.set(updated.id, updated);
    await this.repository.saveSetup(updated);
    this.bus.broadcast({ type: 'setup', payload: updated });
    return updated;
  }

  /**
   * Entrada para análises vindas de fora (varredura do universo por REST).
   * Passa pelo mesmo funil dos ativos da watchlist: gerar, casar e alertar.
   */
  async ingest(analysis: SymbolAnalysis): Promise<void> {
    const settings = this.settings.get();
    const generated = generateSetups({
      analysis,
      context: this.context,
      settings,
      now: new Date(),
      makeId: () => randomUUID(),
    });
    if (generated.length === 0) return;
    await this.reconcile(analysis.symbol, generated, analysis);
    await this.syncFocus();
  }

  /**
   * Quem tem setup vivo ganha acompanhamento em tempo real; quem perdeu o
   * setup sai do stream. Assim o WebSocket segue enxuto mesmo varrendo
   * centenas de pares.
   */
  private async syncFocus(): Promise<void> {
    const watchlist = this.settings.get().scanner.watchlist;
    const withSetups = [...new Set([...this.setups.values()].map((setup) => setup.symbol))];
    const focus = withBitcoin(
      [...new Set([...watchlist, ...withSetups])].slice(0, MAX_FOCUS_SYMBOLS),
    );
    const current = this.market.getSymbols();
    const same =
      focus.length === current.length && focus.every((symbol) => current.includes(symbol));
    if (same) return;
    await this.market.setSymbols(focus);
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const settings = this.settings.get();
      const now = new Date();

      const btc = this.market.getAnalysis('BTCUSDT');
      const context = evaluateMarketContext(btc, now.toISOString());
      const contextChanged =
        this.context === null ||
        this.context.state !== context.state ||
        this.context.scoreModifier !== context.scoreModifier;
      this.context = context;
      if (contextChanged) this.bus.broadcast({ type: 'context', payload: context });

      for (const symbol of settings.scanner.watchlist) {
        const analysis = this.market.getAnalysis(symbol);
        if (!analysis) continue;
        const generated = generateSetups({
          analysis,
          context,
          settings,
          now,
          makeId: () => randomUUID(),
        });
        await this.reconcile(symbol, generated, analysis);
      }

      await this.sweepExpired(now);
      this.pruneRetired(now.getTime());
      await this.syncFocus();
      logger.debug('Varredura concluída', {
        setups: this.setups.size,
        contexto: context.state,
        ativos: settings.scanner.watchlist.length,
      });
    } catch (error) {
      logger.error('Falha na varredura', { error: (error as Error).message });
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Casa os setups recém-gerados com os que já estavam na tela pela
   * fingerprint (ativo + tipo + timeframe + nível). Mesma tese = mesmo card
   * atualizado, não um card novo a cada 30 segundos.
   */
  private async reconcile(
    symbol: string,
    generated: TradeSetup[],
    analysis: SymbolAnalysis,
  ): Promise<void> {
    const settings = this.settings.get();
    const existing = [...this.setups.values()].filter((setup) => setup.symbol === symbol);

    for (const candidate of generated) {
      const previous = existing.find((setup) => setup.fingerprint === candidate.fingerprint);
      if (previous) {
        if (previous.status === 'BOUGHT') continue;
        const merged: TradeSetup = {
          ...candidate,
          id: previous.id,
          createdAt: previous.createdAt,
          status: previous.status === 'TRIGGERED' ? 'TRIGGERED' : candidate.status,
          ignoredAt: previous.ignoredAt,
          expiresAt: previous.expiresAt,
        };
        const scoreMoved = Math.abs(merged.score - previous.score) >= 3;
        const stateMoved = merged.visualState !== previous.visualState;
        this.setups.set(merged.id, merged);
        if (scoreMoved || stateMoved) {
          await this.repository.saveSetup(merged);
          this.bus.broadcast({ type: 'setup', payload: merged });
          if (merged.score > previous.score) await this.alerts.emit(merged, settings);
        await this.autoTrader?.consider(merged);
        }
        continue;
      }

      // a tese já morreu há pouco: não renasce, não alerta, não vai para o disco
      if (this.inCooldown(candidate.fingerprint, Date.now())) continue;

      this.setups.set(candidate.id, candidate);
      await this.repository.saveSetup(candidate);
      this.bus.broadcast({ type: 'setup', payload: candidate });
      await this.audit.record({
        action: 'SETUP_CREATED',
        mode: settings.mode,
        symbol: candidate.symbol,
        setupId: candidate.id,
        detail: {
          setupType: candidate.setupType,
          score: candidate.score,
          riskReward: candidate.riskReward,
          timeframe: candidate.timeframe,
        },
      });
      await this.alerts.emit(candidate, settings);
      await this.autoTrader?.consider(candidate);
    }

    const price = analysis.price;
    if (price > 0) await this.onPrice(symbol, price);
  }

  private async onPrice(symbol: string, price: number): Promise<void> {
    for (const setup of [...this.setups.values()]) {
      if (setup.symbol !== symbol) continue;
      const updated = applyPriceUpdate(setup, price, new Date());
      if (updated === setup) continue;

      const statusChanged = updated.status !== setup.status;
      const visualChanged = updated.visualState !== setup.visualState;
      this.setups.set(updated.id, updated);

      if (statusChanged || visualChanged) {
        await this.repository.saveSetup(updated);
        this.bus.broadcast({ type: 'setup', payload: updated });
        // é aqui que o preço entra na zona: momento em que o robô decide
        if (updated.visualState === 'COMPRAVEL') await this.autoTrader?.consider(updated);
      }
      if (statusChanged && (updated.status === 'INVALIDATED' || updated.status === 'EXPIRED')) {
        this.setups.delete(updated.id);
        this.rememberRetired(updated);
        this.bus.broadcast({ type: 'setupRemoved', payload: { id: updated.id } });
        await this.paper.cancelPending(updated.id, updated.invalidationNote ?? 'Setup encerrado');
        await this.audit.record({
          action: updated.status === 'INVALIDATED' ? 'SETUP_INVALIDATED' : 'SETUP_EXPIRED',
          mode: this.settings.get().mode,
          symbol: updated.symbol,
          setupId: updated.id,
          detail: { price, note: updated.invalidationNote },
        });
      }
    }

    await this.paper.onPrice(symbol, price);
  }

  /**
   * Setup que morreu — invalidado, expirado ou dispensado — fica anotado pela
   * fingerprint. Sem esta lembrança ele some só da memória, e a varredura
   * seguinte cria a mesma tese outra vez: foi assim que 26 teses distintas
   * viraram 159 registros em disco, com a mesma tese repetida 63 vezes.
   */
  private rememberRetired(setup: TradeSetup): void {
    const at = Date.parse(setup.updatedAt || setup.createdAt);
    if (!Number.isFinite(at)) return;
    const previous = this.retired.get(setup.fingerprint) ?? 0;
    if (at > previous) this.retired.set(setup.fingerprint, at);
  }

  /** Dentro do cooldown, a mesma tese não volta à tela nem ao disco. */
  private inCooldown(fingerprint: string, now: number): boolean {
    const at = this.retired.get(fingerprint);
    if (at === undefined) return false;
    const cooldownMs = Math.max(this.settings.get().scanner.cooldownMinutes, 0) * 60_000;
    if (cooldownMs <= 0) return false;
    return now - at < cooldownMs;
  }

  /** A lembrança não precisa ser eterna: passado um dia, a tese pode voltar. */
  private pruneRetired(now: number): void {
    for (const [fingerprint, at] of this.retired) {
      if (now - at > RETIRED_MEMORY_MS) this.retired.delete(fingerprint);
    }
  }

  private async sweepExpired(now: Date): Promise<void> {
    for (const setup of [...this.setups.values()]) {
      if (now.getTime() <= new Date(setup.expiresAt).getTime()) continue;
      if (setup.status === 'BOUGHT') continue;
      const expired: TradeSetup = {
        ...setup,
        status: 'EXPIRED',
        invalidationNote: 'Setup expirou sem acionar o gatilho',
        updatedAt: now.toISOString(),
      };
      this.setups.delete(setup.id);
      this.rememberRetired(expired);
      await this.repository.saveSetup(expired);
      this.bus.broadcast({ type: 'setupRemoved', payload: { id: setup.id } });
      await this.paper.cancelPending(setup.id, 'Setup expirado');
    }
  }

  /** Linha do dashboard para cada ativo da watchlist. */
  getAssets(): AssetView[] {
    const settings = this.settings.get();
    return settings.scanner.watchlist.map((symbol) => {
      const analysis = this.market.getAnalysis(symbol);
      const snapshot = this.market.getSnapshot(symbol);
      const setups = this.getSetups().filter((setup) => setup.symbol === symbol);
      const best = setups[0] ?? null;
      const tf4h = analysis?.timeframes['4h'] ?? null;
      const tf1h = analysis?.timeframes['1h'] ?? null;

      return {
        symbol,
        baseAsset: symbol.replace(/USDT$/, ''),
        price: snapshot?.price ?? null,
        changePercent24h: snapshot?.changePercent24h ?? null,
        volumeQuote24h: snapshot?.quoteVolume24h ?? null,
        trend4h: tf4h?.structure.trend ?? 'SIDEWAYS',
        structure4h: tf4h?.structure.structure ?? 'UNDEFINED',
        rsi1h: tf1h?.indicators.rsi14 ?? null,
        relativeVolume1h: tf1h?.indicators.relativeVolume ?? null,
        bestSetupId: best?.id ?? null,
        bestScore: best?.score ?? null,
        setupType: best?.setupType ?? null,
        visualState: best?.visualState ?? null,
        extended: best?.extended ?? false,
        dataAvailable: analysis !== null && snapshot !== null,
        updatedAt: analysis?.updatedAt ?? null,
      } satisfies AssetView;
    });
  }
}

