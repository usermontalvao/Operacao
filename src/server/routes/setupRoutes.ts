import { Router } from 'express';
import { asyncHandler, type ApiContext } from './context.ts';

export function setupRoutes(context: ApiContext): Router {
  const router = Router();

  router.get('/setups', (request, response) => {
    const status = String(request.query.status ?? 'live').toUpperCase();
    const setups = context.scanner.getSetups();
    if (status === 'LIVE') {
      response.json(setups.filter((setup) => setup.ignoredAt === null));
      return;
    }
    response.json(setups);
  });

  router.get(
    '/setups/history',
    asyncHandler(async (_request, response) => {
      const stored = await context.repository.listSetups();
      response.json(stored);
    }),
  );

  router.get('/setups/:id', (request, response) => {
    const setup = context.scanner.getSetup(String(request.params.id));
    if (!setup) {
      response.status(404).json({ error: 'Setup não encontrado ou já encerrado' });
      return;
    }
    response.json(setup);
  });

  router.post(
    '/setups/:id/ignore',
    asyncHandler(async (request, response) => {
      const setup = await context.scanner.ignoreSetup(String(request.params.id));
      if (!setup) {
        response.status(404).json({ error: 'Setup não encontrado' });
        return;
      }
      response.json(setup);
    }),
  );

  return router;
}
