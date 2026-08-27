import { Router } from 'express';
import { asyncHandler, type ApiContext } from './context.ts';

const DEFAULT_HISTORY_LIMIT = 150;
const MAX_HISTORY_LIMIT = 1_000;

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

  /**
   * O histórico de teses, do mais novo para o mais velho e com teto.
   *
   * A tabela cresce para sempre e a rota devolvia tudo: medido em 26/08/2026,
   * 600 teses = 1,25 MB por resposta, e a tela de Operações pedia isto a cada
   * 5 segundos. Era o maior peso do painel — e nenhum olho lê seiscentas
   * linhas. O teto é generoso e ajustável; o que ele impede é a resposta
   * crescer sem limite junto com o banco.
   */
  router.get(
    '/setups/history',
    asyncHandler(async (request, response) => {
      const pedido = Number(request.query.limit ?? DEFAULT_HISTORY_LIMIT);
      const limit = Number.isFinite(pedido)
        ? Math.min(Math.max(Math.trunc(pedido), 1), MAX_HISTORY_LIMIT)
        : DEFAULT_HISTORY_LIMIT;
      const stored = await context.repository.listSetups();
      const recentes = [...stored]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit);
      response.json(recentes);
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
