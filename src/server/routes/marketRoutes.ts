import { Router } from 'express';
import { z } from 'zod';
import type { DashboardSnapshot, Timeframe } from '../../core/types.ts';
import { TIMEFRAMES } from '../../core/types.ts';
import { environmentForMode } from '../config.ts';
import { getKlines, getUsdtBrlRate, parseKline, searchSymbols } from '../binance/rest.ts';
import { asyncHandler, type ApiContext } from './context.ts';

export function marketRoutes(context: ApiContext): Router {
  const router = Router();

  router.get(
    '/state',
    asyncHandler(async (_request, response) => {
      const mode = context.settings.get().mode;
      const snapshot: DashboardSnapshot = {
        mode,
        connection: context.market.getConnectionState(),
        marketContext: context.scanner.getContext(),
        assets: context.scanner.getAssets(),
        setups: context.scanner.getSetups(),
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
      const timeframe = request.params.timeframe as Timeframe;
      if (!TIMEFRAMES.includes(timeframe)) {
        response.status(400).json({ error: 'Timeframe inválido' });
        return;
      }
      const symbol = String(request.params.symbol).toUpperCase();
      const cached = context.market.getCandles(symbol, timeframe);
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
