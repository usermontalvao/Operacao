import { Router } from 'express';
import type { ApiContext } from './context.ts';
import { marketRoutes } from './marketRoutes.ts';
import { setupRoutes } from './setupRoutes.ts';
import { tradingRoutes } from './tradingRoutes.ts';
import { settingsRoutes } from './settingsRoutes.ts';
import { diagnosticsRoutes } from './diagnosticsRoutes.ts';

export type { ApiContext } from './context.ts';

export function apiRouter(context: ApiContext): Router {
  const router = Router();
  router.get('/health', (_request, response) => {
    response.json({
      status: 'ok',
      connection: context.market.getConnectionState(),
      binanceAvailable: context.market.isAvailable(),
      mode: context.settings.get().mode,
      // o health é a única rota que responde sem sessão: precisa dizer se a
      // persistência caiu, senão o painel de login não tem como explicar nada
      persistencia: context.persistence.degraded ? 'indisponivel' : 'ok',
    });
  });
  router.use(marketRoutes(context));
  router.use(setupRoutes(context));
  router.use(tradingRoutes(context));
  router.use(settingsRoutes(context));
  router.use(diagnosticsRoutes(context));
  return router;
}
