import { Router } from 'express';
import { z } from 'zod';
import type {
  ChartInterval,
  DashboardSnapshot,
  EntryDecision,
  MarketKind,
  RobotState,
  Timeframe,
  TradeSetup,
  TradingMode,
} from '../../core/types.ts';
import { CHART_INTERVALS, TIMEFRAMES, MICRO_TIMEFRAME } from '../../core/types.ts';
import { environmentForMode } from '../config.ts';
import { getKlines, getUsdtBrlRate, parseKline, searchSymbols } from '../binance/rest.ts';
import { liveAutoTradeDenial } from '../services/executionService.ts';
import { asyncHandler, type ApiContext } from './context.ts';

/** O interruptor de uma modalidade, já com o motivo de a conta real recusar. */
function robotStateOf(context: ApiContext, mode: TradingMode, market: MarketKind): RobotState {
  const policy = context.settings.forMode(mode, market);
  return {
    enabled: policy.autoTrade.enabled,
    liveDenial: mode === 'LIVE' ? liveAutoTradeDenial(policy) : null,
  };
}

export function marketRoutes(context: ApiContext): Router {
  const router = Router();

  router.get(
    '/state',
    asyncHandler(async (_request, response) => {
      const mode = context.settings.get().mode;
      const setups = context.scanner.getSetups();
      const markets = context.settings.activeMarkets();
      const snapshot: DashboardSnapshot = {
        mode,
        markets,
        // um estado por modalidade: a coluna de futuros liga o robô dela sem
        // encostar no de spot, e vice-versa
        robots: {
          SPOT: robotStateOf(context, mode, 'SPOT'),
          FUTURES: robotStateOf(context, mode, 'FUTURES'),
        },
        // a explicação do robô viaja junto com os setups: o card precisa poder
        // dizer POR QUE não houve entrada sem uma segunda chamada, e sobretudo
        // sem reimplementar a regra no navegador
        decisions: await explainSetups(context, setups, mode),
        connection: context.market.getConnectionState(),
        marketContext: context.scanner.getContext(),
        assets: context.scanner.getAssets(),
        setups,
        alerts: [],
        openTrades: context.paper.getOpenTrades().filter((trade) => trade.mode === mode),
        settings: context.settings.get(),
        serverTime: new Date().toISOString(),
        binanceAvailable: context.market.isAvailable(),
        tradingCredentialsConfigured: environmentForMode(mode).hasCredentials,
        brlRate: await getUsdtBrlRate(),
        universe: context.universe.getStatus(),
        news: context.news.getStatus(),
      };
      response.json(snapshot);
    }),
  );

  router.get('/stream', (request, response) => {
    context.bus.subscribe(response);
    request.on('close', () => response.end());
  });

  router.get(
    '/alerts',
    asyncHandler(async (_request, response) => {
      response.json(await context.repository.listAlerts());
    }),
  );

  /** Marca o alerta como lido — o aviso não volta no próximo carregamento. */
  router.post(
    '/alerts/:id/read',
    asyncHandler(async (request, response) => {
      const alerts = await context.repository.listAlerts();
      const alert = alerts.find((item) => item.id === String(request.params.id));
      if (!alert) {
        response.status(404).json({ error: 'Alerta não encontrado' });
        return;
      }
      const updated = { ...alert, readAt: new Date().toISOString() };
      await context.repository.saveAlert(updated);
      response.json(updated);
    }),
  );

  /**
   * Candles para o gráfico. Usa o que já está em memória e, para um par que
   * ainda não está no stream (setup achado na varredura do mercado), busca na
   * Binance na hora. Nunca devolve número inventado: ou tem dado, ou 503.
   */
  router.get(
    '/candles/:symbol/:timeframe',
    asyncHandler(async (request, response) => {
      const timeframe = request.params.timeframe as ChartInterval;
      if (!CHART_INTERVALS.includes(timeframe)) {
        response.status(400).json({ error: 'Tempo gráfico inválido' });
        return;
      }
      const symbol = String(request.params.symbol).toUpperCase();
      /*
       * Os quatro tempos do motor sempre têm stream vivo. O 1m tem stream
       * apenas para os pares do universo de scalp — para os outros ele é como
       * 3m, 5m e 30m: existe para olhar e vem do REST na hora.
       *
       * `getCandles` devolve lista vazia quando não há série em memória, então
       * pedir o cache primeiro é seguro para qualquer par: quem tem, responde
       * do stream; quem não tem, cai no REST logo abaixo.
       */
      const doMotor =
        (TIMEFRAMES as readonly string[]).includes(timeframe) || timeframe === MICRO_TIMEFRAME;
      const cached = doMotor ? context.market.getCandles(symbol, timeframe as Timeframe) : [];
      if (cached.length > 0) {
        response.json({ symbol, timeframe, candles: cached.slice(-300), source: 'stream' });
        return;
      }
      try {
        const raw = await getKlines(symbol, timeframe, 300);
        const candles = raw.map((item, index) => parseKline(item, index < raw.length - 1));
        response.json({ symbol, timeframe, candles, source: 'rest' });
      } catch (error) {
        response.status(503).json({ error: `DADOS INDISPONÍVEIS: ${(error as Error).message}` });
      }
    }),
  );

  router.get(
    '/symbols/search',
    asyncHandler(async (request, response) => {
      const query = z.object({ q: z.string().min(1).max(20) }).safeParse(request.query);
      if (!query.success) {
        response.status(400).json({ error: 'Informe o termo de busca' });
        return;
      }
      const results = await searchSymbols(query.data.q);
      response.json(results.map((item) => ({ symbol: item.symbol, baseAsset: item.baseAsset })));
    }),
  );

  return router;
}

/**
 * Decisão do robô para cada setup do radar, na sessão em exibição.
 *
 * Sai do backend de propósito: a regra que decide entrada não pode ter uma
 * segunda implementação no navegador. Duas cópias divergem, e a que o usuário
 * lê passa a ser a errada justamente quando ele mais precisa dela.
 */
async function explainSetups(
  context: ApiContext,
  setups: TradeSetup[],
  mode: TradingMode,
): Promise<Record<string, EntryDecision>> {
  if (context.persistence.degraded) return {};
  const pares = await Promise.all(
    setups.map(async (setup) => [setup.id, await context.scanner.explain(setup, mode)] as const),
  );
  const resultado: Record<string, EntryDecision> = {};
  for (const [id, decision] of pares) if (decision !== null) resultado[id] = decision;
  return resultado;
}
