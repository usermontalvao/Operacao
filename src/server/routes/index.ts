import { Router } from 'express';
import type { ApiContext } from './context.ts';
import { marketRoutes } from './marketRoutes.ts';
import { setupRoutes } from './setupRoutes.ts';
import { tradingRoutes } from './tradingRoutes.ts';
import { settingsRoutes } from './settingsRoutes.ts';

export type { ApiContext } from './context.ts';

export function apiRouter(context: ApiContext): Router {
  const router = Router();
  router.get('/health', (_request, response) => {
    response.json({
      status: 'ok',
      connection: context.market.getConnectionState(),
      binanceAvailable: context.market.isAvailable(),
      mode: context.settings.get().mode,
    });
  });
  router.use(marketRoutes(context));
  router.use(setupRoutes(context));
  router.use(tradingRoutes(context));
  router.use(settingsRoutes(context));
  return router;
}
