import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Trade } from '../core/types.ts';
import { config, environmentForMode } from './config.ts';
import { logger } from './logger.ts';
import { EventBus } from './events.ts';
import { createRepository } from './store/index.ts';
import { ping, setActiveEnvironment, syncClock } from './binance/rest.ts';
import { AlertEngine } from './services/alertEngine.ts';
import { AutoTrader } from './services/autoTrader.ts';
import { DecisionJournal } from './services/decisionJournal.ts';
import { LiveTradeMonitor } from './services/liveTradeMonitor.ts';
import { LiveProtection } from './services/liveProtection.ts';
import { UserDataStream } from './binance/userStream.ts';
import { buildCuratedWatchlist } from './services/curatedWatchlist.ts';
import { AuditService } from './services/auditService.ts';
import { ExecutionService } from './services/executionService.ts';
import { MarketDataService } from './services/marketDataService.ts';
import { PaperTradingEngine } from './services/paperTradingEngine.ts';
import { CloseService } from './services/closeService.ts';
import { RiskService } from './services/riskService.ts';
import { ScannerService } from './services/scannerService.ts';
import { SettingsService } from './services/settingsService.ts';
import { apiRouter, type ApiContext } from './routes/index.ts';
import { authRoutes } from './routes/authRoutes.ts';
import { AuthService } from './auth/authService.ts';
import { RequestLimiter } from './auth/rateLimit.ts';
import { requireSession, throttle } from './auth/middleware.ts';
import { withBitcoin } from './services/focus.ts';
import { UniverseService } from './services/universeService.ts';
import { NewsService } from './services/newsService.ts';

async function main(): Promise<void> {
  const store = await createRepository();
  const repository = store.repository;
  const settings = new SettingsService(repository);
  // em modo degradado NADA é lido: o SettingsService fica no padrão só para o
  // painel ter o que desenhar enquanto explica que a persistência caiu
  if (!store.degraded) await settings.load();

  const bus = new EventBus();
  const audit = new AuditService(repository);
  const market = new MarketDataService();
  const alerts = new AlertEngine(repository, bus);
  const paper = new PaperTradingEngine(repository, bus, audit, settings);
  if (!store.degraded) await paper.load();

  const risk = new RiskService(repository, settings, market);
  const scanner = new ScannerService(market, repository, settings, bus, alerts, paper, audit);
  risk.setContextProvider(() => scanner.getContext()?.state ?? null);

  // o que acontece com o ativo fora do gráfico entra no porteiro de entrada
  const news = new NewsService();
  risk.setNewsProvider((symbol) => news.verdict(symbol));

  const universe = new UniverseService(settings, scanner);
  const execution = new ExecutionService(repository, settings, market, paper, audit, bus, risk);

  // diário de decisões: toda operação encerrada vira material de análise
  const journal = new DecisionJournal(repository);
  paper.setOnClosed((trade) => journal.record(trade));

  // o setup comprado pelo robô sai do radar; senão ele expira depois e
  // cancela a própria ordem que acabou de ser aberta
  execution.setOnBought((setup) => scanner.markBought(setup));

  const autoTrader = new AutoTrader(settings, execution, paper, audit, repository, market);
  autoTrader.setPersistenceAvailable(!store.degraded);
  scanner.setAutoTrader(autoTrader);

  const close = new CloseService(repository, paper, market, audit, settings, bus, (trade) =>
    journal.record(trade),
  );

  // fluxo da conta: a corretora avisa a execução em vez de sermos nós a perguntar
  const userStream = new UserDataStream();
  const protection = new LiveProtection(audit, settings);
  const liveMonitor = new LiveTradeMonitor(
    repository,
    paper,
    bus,
    audit,
    settings,
    market,
    protection,
    (trade: Trade) => journal.record(trade),
    userStream,
  );

  // o ambiente segue o modo: PAPER e LIVE usam produção, TESTNET usa o testnet
  setActiveEnvironment(environmentForMode(settings.get().mode).name);

  const context: ApiContext = {
    repository,
    settings,
    market,
    scanner,
    universe,
    news,
    execution,
    close,
    risk,
    paper,
    audit,
    bus,
    persistence: store,
  };

  const auth = new AuthService(config.auth);
  if (!auth.configured) {
    logger.error(
      'Supabase Auth NÃO configurado — confira PANEL_USER, SUPABASE_URL e SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY',
    );
  }

  const app = express();
  app.disable('x-powered-by');
  // sem isto request.ip vira sempre o do proxy do Vite em desenvolvimento, e
  // a trava por origem passaria a contar todo mundo como uma pessoa só
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '100kb' }));
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  /**
   * O painel escuta só em 127.0.0.1, mas isso não basta: uma página aberta no
   * navegador pode apontar um domínio próprio para 127.0.0.1 e falar com esta
   * API como se fosse local. Conferir o Host fecha essa porta — e ela dá para
   * uma API que envia ordem com dinheiro real.
   */
  app.use('/api', (request, response, next) => {
    const host = (request.headers.host ?? '').toLowerCase();
    if (config.allowedHosts.length > 0 && !config.allowedHosts.includes(host)) {
      logger.warn('Chamada recusada por Host desconhecido', { host });
      response.status(403).json({ error: 'Host não autorizado' });
      return;
    }
    next();
  });

  /**
   * Teto geral: um painel aberto faz dezenas de chamadas por minuto, não
   * milhares. O limite é folgado para o uso normal e estreito o bastante para
   * um laço acidental na tela não virar enxurrada de ordens.
   */
  const apiFlood = new RequestLimiter({ max: 600, windowMs: 60_000 });
  const floodSweeper = setInterval(() => apiFlood.sweep(), 5 * 60_000);
  floodSweeper.unref?.();
  app.use('/api', throttle(apiFlood, 'api'));

  // as rotas de entrada vêm ANTES da porta trancada, senão ninguém entra
  app.use('/api', authRoutes(auth));
  app.use('/api', requireSession(config.appSecret, (path) => path === '/health'));
  app.use('/api', apiRouter(context));

  /*
   * Rota /api desconhecida responde em JSON, nunca em HTML.
   *
   * Sem isto, o 404 padrão do Express devolve uma página HTML, e todo cliente
   * que faz response.json() estoura "Unexpected token '<'" — um erro de
   * sintaxe no lugar da informação útil, que é o status e o caminho. Acontece
   * de verdade sempre que a tela é atualizada sem reiniciar o servidor: o
   * navegador pede uma rota que o processo em execução ainda não tem.
   */
  app.use('/api', (request, response) => {
    response.status(404).json({
      error: `Rota ${request.method} ${request.path} não existe nesta versão do servidor`,
    });
  });

  const distDirectory = join(process.cwd(), 'dist');
  if (existsSync(distDirectory)) {
    app.use(express.static(distDirectory));
    app.get(/^(?!\/api).*/, (_request, response) => {
      response.sendFile(join(distDirectory, 'index.html'));
    });
  }

  app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
    logger.error('Erro não tratado na API', { error: error.message });
    response.status(500).json({ error: 'Erro interno — verifique os logs do servidor' });
  });

  const server = app.listen(config.port, config.host, () => {
    logger.info('Crypto Setup Hunter no ar', {
      url: `http://${config.host}:${config.port}`,
      mode: settings.get().mode,
      binanceEnv: environmentForMode(settings.get().mode).name,
      credentials: environmentForMode(settings.get().mode).hasCredentials ? 'configuradas' : 'ausentes',
      store: config.store,
      persistencia: store.degraded ? 'INDISPONÍVEL — modo degradado' : 'ok',
      login: auth.backend,
    });
  });

  const heartbeat = setInterval(() => bus.heartbeat(), 25_000);
  heartbeat.unref?.();

  const available = await ping();
  if (!available) {
    logger.error('Binance inacessível no boot — o painel vai mostrar DADOS INDISPONÍVEIS');
  } else if (environmentForMode(settings.get().mode).hasCredentials) {
    await syncClock().catch((error) =>
      logger.warn('Não foi possível sincronizar o relógio', { error: (error as Error).message }),
    );
  }

  // primeira execução: já nasce com os pares mais líquidos da Binance
  if (settings.firstRun && available && !store.degraded) {
    try {
      const curated = await buildCuratedWatchlist({ limit: 30 });
      if (curated.length > 0) await settings.update({ scanner: { watchlist: curated } });
    } catch (error) {
      logger.warn('Não foi possível montar a watchlist inicial', {
        error: (error as Error).message,
      });
    }
  }

  if (store.degraded) {
    // Fail-closed. Sem persistência principal não se varre, não se decide e não
    // se opera: cada uma dessas coisas grava, e gravar no lugar errado é como
    // nascem dois históricos. O painel fica de pé apenas para mostrar o motivo.
    logger.error(
      'MODO DEGRADADO — scanner, robô e execução DESLIGADOS até a persistência principal voltar',
      { store: store.kind, error: store.error },
    );
  } else {
    await market.start(withBitcoin(settings.get().scanner.watchlist));
    await scanner.start();
    universe.start();
    news.start();
    liveMonitor.start();
    // só faz sentido abrir o fluxo da conta quando existe conta: em PAPER não há
    // ordem na corretora para acompanhar
    if (settings.get().mode !== 'PAPER' && environmentForMode(settings.get().mode).hasCredentials) {
      userStream.start();
    }
  }

  const shutdown = (): void => {
    logger.info('Encerrando…');
    scanner.stop();
    universe.stop();
    news.stop();
    liveMonitor.stop();
    void userStream.stop();
    market.stop();
    clearInterval(heartbeat);
    clearInterval(floodSweeper);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error('Falha fatal ao iniciar', { error: (error as Error).message, stack: error.stack });
  process.exit(1);
});
