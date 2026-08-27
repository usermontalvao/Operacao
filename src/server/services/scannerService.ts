import { randomUUID } from 'node:crypto';
import type { SymbolAnalysis } from '../../core/analysis.ts';
import type {
  AppSettings,
  AssetView,
  EntryDecision,
  MarketContext,
  MarketKind,
  Timeframe,
  TradeSetup,
  TradingMode,
} from '../../core/types.ts';
import { evaluateMarketContext } from '../../core/engines/marketContextEngine.ts';
import { MICRO_TIMEFRAME } from '../../core/types.ts';
import { applyPriceUpdate, generateSetups } from '../../core/engines/setupEngine.ts';
import { generateMicroSetups, type MicroBlock } from '../../core/engines/microScalpEngine.ts';
import type { ScalpUniverseService } from './scalpUniverseService.ts';
import type { EventBus } from '../events.ts';
import { listTradableSymbols } from '../binance/rest.ts';
import { logger } from '../logger.ts';
import type { Repository } from '../store/index.ts';
import type { AlertEngine } from './alertEngine.ts';
import type { AuditService } from './auditService.ts';
import type { MarketDataService } from './marketDataService.ts';
import type { PaperTradingEngine } from './paperTradingEngine.ts';
import type { SettingsService } from './settingsService.ts';
import type { AutoTrader } from './autoTrader.ts';
import { prioritizedFocus } from './focus.ts';

const SCAN_INTERVAL_MS = 30_000;
/**
 * O micro scalp roda em outro relógio — e tinha de rodar.
 *
 * Trinta segundos é metade da vida de um candle de 1 minuto: um sinal nascido
 * logo depois de uma varredura só seria visto quando já tivesse metade da
 * idade máxima. Dez segundos é barato porque o universo de scalp é curto e os
 * candles já estão em memória, vindos do WebSocket — esta volta não faz uma
 * única chamada de rede.
 */
const MICRO_SCAN_INTERVAL_MS = 10_000;
const LIVE_STATUSES: TradeSetup['status'][] = ['WATCHING', 'ACTIVE', 'TRIGGERED'];
/** Por quanto tempo a fingerprint de um setup morto continua sendo lembrada. */
const RETIRED_MEMORY_MS = 24 * 60 * 60 * 1000;
const OPPORTUNITY_WINDOW_MS = 24 * 60 * 60_000;

interface ScanOpportunitySample {
  at: number;
  source: 'WATCHLIST' | 'UNIVERSE' | 'MICRO';
  generated: Array<{ setupType: TradeSetup['setupType']; timeframe: Timeframe }>;
}

export interface ScannerOpportunityStats {
  windowHours: number;
  assetsAnalyzed: number;
  analysesWithSetup: number;
  setupsGenerated: number;
  bySource: Record<ScanOpportunitySample['source'], number>;
  bySetup: Array<{ setupType: TradeSetup['setupType']; count: number }>;
  byTimeframe: Array<{ timeframe: Timeframe; count: number }>;
}

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
  private scalpUniverse: ScalpUniverseService | null = null;
  private context: MarketContext | null = null;
  private timer: NodeJS.Timeout | null = null;
  private microTimer: NodeJS.Timeout | null = null;
  private microScanning = false;
  /**
   * Por que cada par do universo de scalp NÃO gerou tese agora.
   *
   * Guardar o motivo é metade do módulo. Um scanner que simplesmente não
   * mostra nada é indistinguível de um scanner quebrado — e a diferença entre
   * "não há faixa" e "a faixa não paga o custo" é justamente o que o usuário
   * precisa saber para decidir se vale mexer nos limites.
   */
  private microBlocks = new Map<string, MicroBlock>();
  /** fim da última varredura; a idade disto entra na saúde do sistema */
  private lastScanAt: number | null = null;
  private scanning = false;
  private opportunitySamples: ScanOpportunitySample[] = [];

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

  /**
   * Uma tese por (ativo, tipo, timeframe, lado, modalidade).
   *
   * A fingerprint é o que casa a tese de uma varredura com a da anterior — e
   * ela mudou quando futuros entrou (passou a incluir a modalidade). Toda
   * tese gravada ANTES disso deixou de casar com a que a varredura gera
   * agora: as duas ficaram vivas ao mesmo tempo, com ids diferentes, e o
   * radar passou a mostrar ONT, WIF e JASMY duas vezes. Duas linhas idênticas
   * não são duas oportunidades — são a mesma, contada em dobro, num painel
   * cujo trabalho é dizer quantas existem.
   *
   * Roda na carga porque é ali que o passado entra. A mais recente vence: ela
   * tem o preço e o score de agora.
   */
  private deduplicar(): void {
    const porTese = new Map<string, TradeSetup>();
    const descartar: TradeSetup[] = [];

    for (const setup of this.setups.values()) {
      const chave = [
        setup.symbol,
        setup.setupType,
        setup.timeframe,
        setup.side ?? 'BUY',
        setup.market ?? 'SPOT',
      ].join(':');
      const anterior = porTese.get(chave);
      if (!anterior) {
        porTese.set(chave, setup);
        continue;
      }
      const maisNova =
        new Date(setup.updatedAt).getTime() >= new Date(anterior.updatedAt).getTime()
          ? setup
          : anterior;
      descartar.push(maisNova === setup ? anterior : setup);
      porTese.set(chave, maisNova);
    }

    for (const setup of descartar) this.setups.delete(setup.id);
    if (descartar.length > 0) {
      logger.info('Teses repetidas removidas do radar na carga', { removidas: descartar.length });
    }
  }

  /** O universo de scalp é montado depois; sem ele o micro scalp não roda. */
  setScalpUniverse(universe: ScalpUniverseService): void {
    this.scalpUniverse = universe;
  }

  getMicroBlocks(): MicroBlock[] {
    return [...this.microBlocks.values()];
  }

  /** O robô só entra em cena depois de montado — e só nas contas de teste. */
  setAutoTrader(autoTrader: AutoTrader): void {
    this.autoTrader = autoTrader;
  }

  async start(): Promise<void> {
    const stored = await this.repository.listSetups();
    const settingsNaCarga = this.settings.get();
    /*
     * Os tempos gráficos que estão LIGADOS agora.
     *
     * O 1m entra na lista quando o micro scalp está ligado — ele não vive em
     * `triggerTimeframes`, mas as teses dele são tão legítimas quanto as
     * outras e não podem ser varridas junto.
     */
    const ativos = new Set<Timeframe>(settingsNaCarga.scanner.triggerTimeframes);
    if (settingsNaCarga.scanner.microScalp.enabled) ativos.add(MICRO_TIMEFRAME);

    for (const setup of stored) {
      // explosão NUNCA volta ao radar depois de um reinício. Ela é uma tese de
      // entrada imediata: se não preencheu na janela dela, acabou. Medir a
      // idade do registro não resolveria — o TLMUSDT tinha 11 minutos de
      // cadastro e três horas de atraso em relação à barra que o gerou.
      if (setup.setupType === 'MOMENTUM_BURST') {
        this.rememberRetired(setup);
        continue;
      }
      /*
       * Tese de um timeframe desligado NÃO volta ao radar.
       *
       * `dropTimeframe` limpa no instante em que o interruptor gira, e isso
       * cobria só metade do problema: quem já estava com 4h desligado antes de
       * reiniciar via as teses ressuscitarem do banco, intactas. Foi
       * exatamente o que aconteceu — o painel abriu com 64 teses de tendência
       * na tela e a configuração dizendo `triggerTimeframes: []`.
       *
       * A tela então mostra uma coisa e a configuração diz outra, e a tela
       * ganha, porque é nela que se clica.
       */
      if (!ativos.has(setup.timeframe)) {
        this.rememberRetired(setup);
        continue;
      }
      if (LIVE_STATUSES.includes(setup.status) && !setup.ignoredAt) {
        this.setups.set(setup.id, setup);
      } else {
        this.rememberRetired(setup);
      }
    }

    this.deduplicar();

    const descartadasPorTimeframe = stored.filter(
      (setup) =>
        setup.setupType !== 'MOMENTUM_BURST' &&
        !ativos.has(setup.timeframe) &&
        LIVE_STATUSES.includes(setup.status) &&
        !setup.ignoredAt,
    ).length;
    if (descartadasPorTimeframe > 0) {
      logger.info('Teses de timeframe desligado não voltaram ao radar', {
        quantidade: descartadasPorTimeframe,
        ligados: [...ativos].join(',') || '(nenhum)',
      });
    }

    this.market.on('price', ({ symbol, price }: { symbol: string; price: number }) => {
      this.bus.queuePrice(symbol, price);
      void this.onPrice(symbol, price);
    });
    this.market.on('candleClosed', () => {
      void this.scan();
    });
    // O histórico aquece em segundo plano para o preço vivo (e as ordens)
    // começarem primeiro. Assim que ele termina, não esperamos o próximo
    // intervalo para produzir o radar completo.
    this.market.on('historyLoaded', () => {
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
    this.microTimer = setInterval(() => void this.scanMicro(), MICRO_SCAN_INTERVAL_MS);
    this.microTimer.unref?.();
    await this.scan();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.microTimer) clearInterval(this.microTimer);
    this.microTimer = null;
  }

  /** A decisão do robô para este setup, sem executar nada. */
  async explain(setup: TradeSetup, mode: TradingMode): Promise<EntryDecision | null> {
    if (!this.autoTrader) return null;
    return this.autoTrader.explain(setup, mode).catch(() => null);
  }

  /**
   * Reavalia o radar inteiro para uma sessão. Chamado quando o robô é ligado.
   * As regras continuam sendo as mesmas: nada aqui perdoa sinal velho.
   */
  async reconsiderAll(mode: TradingMode): Promise<void> {
    if (!this.autoTrader) return;
    // Só o radar vivo. A lista do repositório também contém teses antigas,
    // expiradas e de timeframes já desligados; reavaliá-la fazia o clique em
    // "ligar robô" percorrer sinais que a própria tela já tinha retirado.
    await this.autoTrader.reconsiderExisting(this.getSetups(), mode);
  }

  /** Quando a última varredura TERMINOU — a idade disto é saúde do sistema. */
  getLastScanAt(): number | null {
    return this.lastScanAt;
  }

  /** Funil anterior à decisão: quantos ativos foram de fato analisados. */
  getOpportunityStats(now = Date.now()): ScannerOpportunityStats {
    this.pruneOpportunitySamples(now);
    const samples = this.opportunitySamples;
    const setup = new Map<TradeSetup['setupType'], number>();
    const timeframe = new Map<Timeframe, number>();
    const bySource: ScannerOpportunityStats['bySource'] = { WATCHLIST: 0, UNIVERSE: 0, MICRO: 0 };
    for (const sample of samples) {
      bySource[sample.source] += 1;
      for (const item of sample.generated) {
        setup.set(item.setupType, (setup.get(item.setupType) ?? 0) + 1);
        timeframe.set(item.timeframe, (timeframe.get(item.timeframe) ?? 0) + 1);
      }
    }
    const first = samples[0]?.at ?? now;
    return {
      windowHours: Math.round(Math.max(0, now - first) / 36_000) / 100,
      assetsAnalyzed: samples.length,
      analysesWithSetup: samples.filter((sample) => sample.generated.length > 0).length,
      setupsGenerated: samples.reduce((sum, sample) => sum + sample.generated.length, 0),
      bySource,
      bySetup: [...setup.entries()].map(([setupType, count]) => ({ setupType, count })).sort((a, b) => b.count - a.count),
      byTimeframe: [...timeframe.entries()].map(([timeframe, count]) => ({ timeframe, count })).sort((a, b) => b.count - a.count),
    };
  }

  private recordOpportunitySample(
    source: ScanOpportunitySample['source'],
    generated: TradeSetup[],
    at = Date.now(),
  ): void {
    this.opportunitySamples.push({
      at,
      source,
      generated: generated.map((setup) => ({ setupType: setup.setupType, timeframe: setup.timeframe })),
    });
    this.pruneOpportunitySamples(at);
  }

  private pruneOpportunitySamples(now: number): void {
    const cutoff = now - OPPORTUNITY_WINDOW_MS;
    const firstValid = this.opportunitySamples.findIndex((sample) => sample.at >= cutoff);
    if (firstValid > 0) this.opportunitySamples.splice(0, firstValid);
    else if (firstValid === -1) this.opportunitySamples = [];
  }

  getContext(): MarketContext | null {
    return this.context;
  }

  /**
   * O radar inteiro — as duas modalidades, cada tese carimbada com a sua.
   *
   * A tela separa em colunas; filtrar aqui pela modalidade em exibição faria
   * a coluna de futuros nascer vazia. Com o interruptor geral barrado nem
   * chegam a existir setups de futuros: `activeMarkets()` já não os gera.
   */
  getSetups(): TradeSetup[] {
    return [...this.setups.values()].sort((a, b) => b.score - a.score);
  }

  getSetup(id: string): TradeSetup | null {
    return this.setups.get(id) ?? null;
  }

  /**
   * Tira do radar tudo de uma modalidade — usado quando ela é barrada.
   *
   * Sem isto as teses de futuros ficariam guardadas em memória: a coluna some
   * da tela junto com a modalidade, mas ao religar o interruptor elas voltam
   * com o preço de meia hora atrás, como se nada tivesse acontecido. Quem
   * barra uma modalidade está dizendo "não quero isto aqui" — e a lembrança
   * de uma tese que ninguém pode executar é só uma armadilha esperando.
   */
  dropMarket(market: MarketKind): number {
    let removidos = 0;
    for (const setup of [...this.setups.values()]) {
      if (setup.market !== market) continue;
      this.setups.delete(setup.id);
      this.bus.broadcast({ type: 'setupRemoved', payload: { id: setup.id } });
      removidos += 1;
    }
    if (removidos > 0) logger.info('Modalidade barrada: teses retiradas do radar', { market, removidos });
    return removidos;
  }

  /**
   * Tira do radar as teses de um timeframe que acabou de ser desligado.
   *
   * O mesmo problema que `dropMarket` resolve, por outro eixo. Um setup de 4h
   * vive 12 horas; desligar o gatilho apenas impede que NOVOS nasçam, e os que
   * já estavam ficariam na tela metade de um dia — clicáveis, com entrada e
   * alvo, de uma estratégia que o usuário acabou de desligar. Quem desliga um
   * timeframe está dizendo "não quero operar isto"; deixar os cards antigos é
   * deixar a armadilha de pé.
   *
   * Posição já comprada não é tese de radar: quem manda nela é o
   * acompanhamento da operação, e mexer aqui deixaria dinheiro aberto sem
   * plano de saída.
   */
  async dropTimeframe(timeframe: Timeframe): Promise<number> {
    let removidos = 0;
    const agora = new Date().toISOString();
    for (const setup of [...this.setups.values()]) {
      if (setup.timeframe !== timeframe) continue;
      if (setup.status === 'BOUGHT') continue;
      const motivo = `o gatilho de ${timeframe} foi desligado nas Configurações`;
      const invalidado: TradeSetup = {
        ...setup,
        status: 'INVALIDATED',
        invalidationNote: motivo,
        updatedAt: agora,
      };
      this.setups.delete(setup.id);
      this.rememberRetired(invalidado);
      await this.repository.saveSetup(invalidado);
      this.bus.broadcast({ type: 'setupRemoved', payload: { id: setup.id } });
      await this.paper.cancelPending(setup.id, motivo);
      removidos += 1;
    }
    if (removidos > 0) {
      logger.info('Timeframe desligado: teses retiradas do radar', { timeframe, removidos });
    }
    return removidos;
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
    this.audit.record({
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
   * Devolve o setup ao radar quando a ordem morreu sem comprar nada.
   *
   * `markBought` é definitivo por desenho — comprou, o setup sai do radar e
   * quem manda passa a ser a operação. Só que ele também era chamado quando a
   * ordem apenas foi ENVIADA, e ordem enviada pode ser cancelada sem executar
   * nada. Nesse caso o setup ficava carimbado "EM OPERAÇÃO" para sempre: some
   * do radar, o scanner pula (`status === 'BOUGHT'` continua), e a tese segue
   * viva no mercado sem que ninguém possa entrar nela de novo.
   */
  async releaseSetup(setupId: string): Promise<void> {
    const atual = this.setups.get(setupId);
    if (!atual || atual.status !== 'BOUGHT') return;
    const updated: TradeSetup = { ...atual, status: 'ACTIVE', updatedAt: new Date().toISOString() };
    this.setups.set(updated.id, updated);
    await this.repository.saveSetup(updated);
    this.bus.broadcast({ type: 'setup', payload: updated });
    logger.info('Setup devolvido ao radar — a ordem saiu sem executar', {
      setupId,
      symbol: updated.symbol,
    });
  }

  /**
   * Entrada para análises vindas de fora (varredura do universo por REST).
   * Passa pelo mesmo funil dos ativos da watchlist: gerar, casar e alertar.
   */
  async ingest(analysis: SymbolAnalysis, scanCycleMs?: number): Promise<void> {
    const generated = this.settings.activeMarkets().flatMap((market) =>
      generateSetups({
        analysis,
        context: this.context,
        settings: this.settings.viewFor(market),
        now: new Date(),
        makeId: () => randomUUID(),
        scanCycleMs,
      }),
    );
    this.recordOpportunitySample('UNIVERSE', generated);
    if (generated.length === 0) return;
    await this.reconcile(analysis.symbol, generated, analysis);
    await this.syncFocus();
  }

  /**
   * Tira do radar a tese que o mercado não aceita mais.
   *
   * A peneira de pares só valia na GERAÇÃO: uma tese criada antes de o
   * contrato entrar em liquidação — ou antes de a modalidade ser barrada —
   * continuava na tela, sobrevivia ao reinício (ela vem do disco) e só saía
   * ao expirar. O usuário clicava e recebia a recusa da corretora, horas
   * depois, no lugar mais caro possível: a tela de confirmação da ordem.
   */
  private async retirarForaDeMercado(
    negociavel: (market: MarketKind, symbol: string) => boolean,
    markets: MarketKind[],
    now: Date,
  ): Promise<void> {
    const ativas = new Set(markets);
    for (const setup of [...this.setups.values()]) {
      const market = setup.market ?? 'SPOT';
      if (ativas.has(market) && negociavel(market, setup.symbol)) continue;
      const motivo = ativas.has(market)
        ? `${setup.symbol} não está mais negociando em ${market === 'FUTURES' ? 'futuros' : 'spot'}`
        : `a modalidade ${market} foi barrada no painel`;
      const invalidado: TradeSetup = {
        ...setup,
        status: 'INVALIDATED',
        invalidationNote: motivo,
        updatedAt: now.toISOString(),
      };
      this.setups.delete(setup.id);
      this.rememberRetired(invalidado);
      await this.repository.saveSetup(invalidado);
      this.bus.broadcast({ type: 'setupRemoved', payload: { id: setup.id } });
      await this.paper.cancelPending(setup.id, motivo);
      logger.info('Tese retirada do radar', { symbol: setup.symbol, market, motivo });
    }
  }

  /**
   * Quais pares existem em cada modalidade.
   *
   * Nem tudo que se compra no spot tem contrato perpétuo: XAUT, pares novos e
   * boa parte das listagens pequenas só existem à vista. Sem esta peneira a
   * coluna de futuros mostraria teses que a corretora recusa na hora da
   * ordem — e a recusa chegaria depois do clique, não antes.
   *
   * Falha de leitura NÃO barra a modalidade: ficar sem coluna por causa de um
   * timeout seria pior que uma linha a mais, que ainda assim é bloqueada no
   * momento da ordem pelos filtros do par.
   */
  private async tradableIn(
    markets: MarketKind[],
  ): Promise<(market: MarketKind, symbol: string) => boolean> {
    const porModalidade = new Map<MarketKind, Set<string> | null>();
    for (const market of markets) {
      try {
        const pairs = await listTradableSymbols('USDT', market);
        porModalidade.set(market, new Set(pairs.map((pair) => pair.symbol)));
      } catch (error) {
        logger.debug('Lista de pares da modalidade indisponível', {
          market,
          error: (error as Error).message,
        });
        porModalidade.set(market, null);
      }
    }
    return (market, symbol) => {
      const conhecidos = porModalidade.get(market);
      return conhecidos === null || conhecidos === undefined || conhecidos.has(symbol);
    };
  }

  /**
   * Quem tem setup vivo ganha acompanhamento em tempo real; quem perdeu o
   * setup sai do stream. Assim o WebSocket segue enxuto mesmo varrendo
   * centenas de pares.
   */
  private async syncFocus(): Promise<void> {
    const watchlist = this.settings.get().scanner.watchlist;
    const withSetups = [...new Set([...this.setups.values()].map((setup) => setup.symbol))];
    const withTrades = this.paper.getOpenTrades().map((trade) => trade.symbol);
    const focus = prioritizedFocus(withTrades, watchlist, withSetups);
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

      /*
       * Uma varredura, duas modalidades.
       *
       * O mesmo candle produz a mesma tese comprada em spot e em futuros — e
       * as duas são executáveis ao mesmo tempo, com tamanhos e robôs
       * diferentes. Por isso os detectores rodam uma vez por modalidade
       * ativa, com as configurações DAQUELA modalidade: é o que faz a venda a
       * descoberto aparecer só na coluna de futuros e o robô de cada coluna
       * responder ao seu próprio ajuste. Barrado o interruptor geral,
       * `activeMarkets()` devolve só spot e a segunda coluna nem nasce.
       */
      const markets = this.settings.activeMarkets();
      const negociavel = await this.tradableIn(markets);

      for (const symbol of settings.scanner.watchlist) {
        const analysis = this.market.getAnalysis(symbol);
        if (!analysis) continue;
        const generated = markets
          .filter((market) => negociavel(market, symbol))
          .flatMap((market) =>
            generateSetups({
              analysis,
              context,
              settings: this.settings.viewFor(market),
              now,
              makeId: () => randomUUID(),
            }),
          );
        this.recordOpportunitySample('WATCHLIST', generated);
        await this.reconcile(symbol, generated, analysis);
      }

      await this.retirarForaDeMercado(negociavel, markets, now);
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
      this.lastScanAt = Date.now();
    }
  }

  /**
   * A varredura do micro scalp — curta, frequente e sem rede.
   *
   * Percorre só o universo de scalp (uma dezena de pares, no máximo), lendo
   * candles de 1m que o WebSocket já entregou. É por isso que ela pode rodar a
   * cada dez segundos sem pesar: a parte cara — medir book e liquidez — mora
   * no ScalpUniverseService e acontece a cada poucos minutos.
   */
  async scanMicro(): Promise<void> {
    if (this.microScanning) return;
    this.microScanning = true;
    try {
      const settings = this.settings.get();
      const micro = settings.scanner.microScalp;

      /*
       * Desligar o módulo RETIRA as teses de 1m do radar.
       *
       * Deixá-las de pé seria pior que inútil: são teses de três minutos de
       * validade que ficariam na tela mostrando entrada, alvo e stop de um
       * mercado que já passou, sem nada mais atualizando-as. Quem desliga o
       * micro scalp está dizendo "não quero operar isto" — e um card clicável
       * é um convite a operar.
       */
      if (!micro.enabled) {
        if (this.microBlocks.size > 0) this.microBlocks.clear();
        await this.retirarMicroSetups('o micro scalp foi desligado nas Configurações');
        return;
      }

      const universe = this.scalpUniverse;
      if (!universe) return;

      const symbols = universe.getActiveSymbols();
      const now = new Date();
      const markets = this.settings.activeMarkets();
      const vistos = new Set<string>();

      for (const symbol of symbols) {
        const analysis = this.market.getAnalysis(symbol);
        const scalpability = universe.getReport(symbol);
        if (!analysis || !scalpability) continue;
        vistos.add(symbol);

        const gerados: TradeSetup[] = [];
        let bloqueio: MicroBlock | null = null;

        for (const market of markets) {
          const resultado = generateMicroSetups({
            analysis,
            scalpability,
            settings: this.settings.viewFor(market),
            now,
            makeId: () => randomUUID(),
          });
          gerados.push(...resultado.setups);
          if (resultado.blocked) bloqueio = resultado.blocked;
        }

        if (bloqueio && gerados.length === 0) {
          this.microBlocks.set(symbol, bloqueio);
        } else {
          this.microBlocks.delete(symbol);
        }

        this.recordOpportunitySample('MICRO', gerados);

        if (gerados.length > 0) await this.reconcile(symbol, gerados, analysis);
      }

      // par que saiu do universo não deixa motivo velho para trás
      for (const symbol of [...this.microBlocks.keys()]) {
        if (!vistos.has(symbol)) this.microBlocks.delete(symbol);
      }

      await this.sweepExpired(now);
      this.bus.broadcast({
        type: 'microScalp',
        payload: { active: symbols, blocks: this.getMicroBlocks() },
      });
    } catch (error) {
      logger.error('Falha na varredura de micro scalp', { error: (error as Error).message });
    } finally {
      this.microScanning = false;
    }
  }

  /** Tira do radar toda tese de 1m — usado ao desligar o módulo. */
  private async retirarMicroSetups(motivo: string): Promise<void> {
    for (const setup of [...this.setups.values()]) {
      if (setup.setupType !== 'RANGE_FADE') continue;
      // uma posição já comprada não é mais uma tese de radar: quem manda
      // nela é o acompanhamento da operação, e desligar o scanner não pode
      // deixar dinheiro aberto sem plano de saída
      if (setup.status === 'BOUGHT') continue;
      const invalidado: TradeSetup = {
        ...setup,
        status: 'INVALIDATED',
        invalidationNote: motivo,
        updatedAt: new Date().toISOString(),
      };
      this.setups.delete(setup.id);
      this.rememberRetired(invalidado);
      await this.repository.saveSetup(invalidado);
      this.bus.broadcast({ type: 'setupRemoved', payload: { id: setup.id } });
      await this.paper.cancelPending(setup.id, motivo);
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
    // o alerta é do bolso de quem vai operar: o piso de score é ajuste DA
    // MODALIDADE, e usar o do spot para avisar de uma tese de futuros faria
    // uma coluna gritar com a régua da outra
    const settingsOf = (setup: TradeSetup): AppSettings => this.settings.viewFor(setup.market);
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
          if (merged.score > previous.score) await this.alerts.emit(merged, settingsOf(merged));
        await this.autoTrader?.consider(merged);
        }
        continue;
      }

      // a tese já morreu há pouco: não renasce, não alerta, não vai para o disco
      if (this.inCooldown(candidate.fingerprint, Date.now())) continue;

      this.setups.set(candidate.id, candidate);
      await this.repository.saveSetup(candidate);
      this.bus.broadcast({ type: 'setup', payload: candidate });
      this.audit.record({
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
      await this.alerts.emit(candidate, settingsOf(candidate));
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
        this.audit.record({
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
