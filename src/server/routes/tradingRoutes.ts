import { postMortemOf } from '../../core/journal/postMortem.ts';
import { Router } from 'express';
import { z } from 'zod';
import { computePerformance } from '../../core/performance.ts';
import { analyzeFactors, buildEquityCurve } from '../../core/analytics.ts';
import { round } from '../../core/risk/index.ts';
import { getTickers } from '../binance/rest.ts';
import { ExecutionError, liveAutoTradeDenial } from '../services/executionService.ts';
import { asyncHandler, type ApiContext } from './context.ts';

const previewSchema = z
  .object({
    setupId: z.string().min(1),
    quoteAmount: z.number().positive().max(1_000_000).optional(),
    percentOfCapital: z.number().positive().max(100).optional(),
  })
  .refine((value) => value.quoteAmount !== undefined || value.percentOfCapital !== undefined, {
    message: 'Informe o valor a investir ou o percentual do capital',
  });

const executeSchema = z.object({
  setupId: z.string().min(1),
  confirmationToken: z.string().min(10),
  idempotencyKey: z.string().min(8).max(64),
});

/**
 * Recorte de período das consultas de análise.
 *
 * Sem recorte, "taxa de acerto" vira um número que só cresce em cima de si
 * mesmo e nunca mostra que o sistema piorou nas últimas duas semanas. As datas
 * chegam em ISO; qualquer coisa ilegível é ignorada em vez de virar erro —
 * filtro quebrado não pode derrubar a tela inteira.
 */
function parseRange(query: Record<string, unknown>): { from: number; to: number } {
  const read = (value: unknown, fallback: number): number => {
    if (typeof value !== 'string' || value.length === 0) return fallback;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  };
  return {
    from: read(query.from, Number.NEGATIVE_INFINITY),
    to: read(query.to, Number.POSITIVE_INFINITY),
  };
}

function withinRange(iso: string | null, range: { from: number; to: number }): boolean {
  if (iso === null) return false;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return false;
  return time >= range.from && time <= range.to;
}

export function tradingRoutes(context: ApiContext): Router {
  const router = Router();

  router.get(
    '/account/balance',
    asyncHandler(async (_request, response) => {
      try {
        const balance = await context.execution.getCapital();
        response.json({ ...balance, mode: context.settings.get().mode });
      } catch (error) {
        response.status(503).json({ error: `DADOS INDISPONÍVEIS: ${(error as Error).message}` });
      }
    }),
  );

  /** Passo 1 do COMPRAR SETUP: a conta completa, sem tocar na corretora. */
  router.post(
    '/orders/preview',
    asyncHandler(async (request, response) => {
      const parsed = previewSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Dados inválidos' });
        return;
      }
      const setup = context.scanner.getSetup(parsed.data.setupId);
      if (!setup) {
        response.status(404).json({ error: 'Setup não encontrado ou já encerrado' });
        return;
      }
      response.json(await context.execution.preview(parsed.data, setup));
    }),
  );

  /** Passo 2: exige o token da confirmação que o usuário aprovou na tela. */
  router.post(
    '/orders/execute',
    asyncHandler(async (request, response) => {
      const parsed = executeSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Dados inválidos' });
        return;
      }
      const setup = context.scanner.getSetup(parsed.data.setupId);
      if (!setup) {
        response.status(404).json({ error: 'Setup não encontrado ou já encerrado' });
        return;
      }
      try {
        const trade = await context.execution.execute(parsed.data, setup);
        await context.scanner.markBought(setup);
        response.status(201).json(trade);
      } catch (error) {
        if (error instanceof ExecutionError) {
          response.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  router.get(
    '/trades',
    asyncHandler(async (_request, response) => {
      const mode = context.settings.get().mode;
      const trades = await context.repository.listTrades();
      response.json(trades.filter((trade) => trade.mode === mode));
    }),
  );

  /**
   * Encerrar uma posição agora, pelo preço de mercado.
   *
   * Faltava por completo: o sistema sabia abrir e sabia esperar alvo ou stop,
   * mas não tinha caminho para "sai agora" — e é justamente quando o plano
   * deixa de valer que se quer sair.
   */
  router.post(
    '/trades/:id/close',
    asyncHandler(async (request, response) => {
      const body = request.body as { reason?: unknown } | undefined;
      const reason =
        typeof body?.reason === 'string' && body.reason.trim().length > 0
          ? body.reason.trim().slice(0, 120)
          : 'encerrado pelo usuário';
      try {
        response.json(await context.close.close(String(request.params.id), reason));
      } catch (error) {
        if (error instanceof ExecutionError) {
          response.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  /** Pânico: desliga o robô e encerra tudo que estiver aberto. */
  router.post(
    '/trades/close-all',
    asyncHandler(async (_request, response) => {
      const settings = await context.settings.update({ autoTrade: { enabled: false } });
      const result = await context.close.closeAll('pânico: encerrar tudo');
      context.bus.broadcast({ type: 'settings', payload: settings });
      response.json({ ...result, robotStopped: true });
    }),
  );

  /**
   * Liga e desliga o robô — o clique no distintivo do topo da tela. É o
   * caminho mais curto entre perceber que algo está errado e parar.
   */
  router.post(
    '/robot',
    asyncHandler(async (request, response) => {
      const parsed = z.object({ enabled: z.boolean() }).safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'Informe se o robô deve ficar ligado' });
        return;
      }
      const settings = await context.settings.update({
        autoTrade: { enabled: parsed.data.enabled },
      });
      await context.audit.record({
        action: parsed.data.enabled ? 'ROBOT_ENABLED' : 'ROBOT_DISABLED',
        mode: settings.mode,
        detail: { origem: 'painel' },
      });
      context.bus.broadcast({ type: 'settings', payload: settings });
      response.json(settings);
    }),
  );

  /**
   * Arma o robô para a conta real por tempo limitado — e ele desarma sozinho.
   * Robô que fica armado para sempre é robô que ninguém está vigiando.
   */
  router.post(
    '/robot/arm',
    asyncHandler(async (request, response) => {
      const parsed = z.object({ minutes: z.number().int().min(5).max(720) }).safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'Informe por quantos minutos armar (5 a 720)' });
        return;
      }
      if (!context.settings.get().autoTrade.allowLive) {
        response.status(400).json({
          error: 'Libere a compra automática em conta real nos ajustes antes de armar',
        });
        return;
      }
      const until = new Date(Date.now() + parsed.data.minutes * 60_000).toISOString();
      const settings = await context.settings.update({
        autoTrade: { enabled: true, liveArmedUntil: until },
      });
      const denial = liveAutoTradeDenial(settings);
      await context.audit.record({
        action: 'ROBOT_ARMED_LIVE',
        mode: settings.mode,
        detail: { until, minutos: parsed.data.minutes, pendencia: denial },
      });
      context.bus.broadcast({ type: 'settings', payload: settings });
      response.json({ settings, denial });
    }),
  );

  router.post(
    '/robot/disarm',
    asyncHandler(async (_request, response) => {
      const settings = await context.settings.update({ autoTrade: { liveArmedUntil: null } });
      await context.audit.record({ action: 'ROBOT_DISARMED_LIVE', mode: settings.mode, detail: {} });
      context.bus.broadcast({ type: 'settings', payload: settings });
      response.json(settings);
    }),
  );

  /** O que o disjuntor está vendo agora. */
  router.get(
    '/risk',
    asyncHandler(async (_request, response) => {
      const capital = await context.execution.getCapital();
      const snapshot = await context.risk.snapshot(capital.capital);
      const settings = context.settings.get();
      response.json({
        ...snapshot,
        guard: settings.guard,
        robot: {
          enabled: settings.autoTrade.enabled,
          allowLive: settings.autoTrade.allowLive,
          armedUntil: settings.autoTrade.liveArmedUntil,
          serverAllowsLive: liveAutoTradeDenial({
            ...settings,
            autoTrade: { ...settings.autoTrade, allowLive: true, liveArmedUntil: new Date(Date.now() + 60_000).toISOString() },
          }) === null,
          liveDenial: settings.mode === 'LIVE' ? liveAutoTradeDenial(settings) : null,
        },
      });
    }),
  );

  /**
   * Reconhecer o disjuntor: volta a operar por um tempo sem apagar o motivo.
   * O motivo continua aparecendo — quem retomou precisa seguir vendo por quê.
   */
  router.post(
    '/risk/acknowledge',
    asyncHandler(async (request, response) => {
      const parsed = z.object({ minutes: z.number().int().min(5).max(720) }).safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'Informe por quantos minutos retomar (5 a 720)' });
        return;
      }
      const until = new Date(Date.now() + parsed.data.minutes * 60_000).toISOString();
      const settings = await context.settings.update({ guard: { mutedUntil: until } });
      await context.audit.record({
        action: 'RISK_HALT_ACKNOWLEDGED',
        mode: settings.mode,
        detail: { until },
      });
      context.bus.broadcast({ type: 'settings', payload: settings });
      response.json(settings);
    }),
  );

  /** Curva de patrimônio da carteira de teste. */
  router.get(
    '/equity',
    asyncHandler(async (_request, response) => {
      const [allTrades, capital] = await Promise.all([
        context.repository.listTrades(),
        context.execution.getCapital(),
      ]);
      const settings = context.settings.get();
      const trades = allTrades.filter((trade) => trade.mode === settings.mode);
      const activeTrades = trades.filter(
        (trade) => trade.status === 'PENDING' || trade.status === 'OPEN',
      );
      const missingSymbols = [
        ...new Set(
          activeTrades
            .map((trade) => trade.symbol)
            .filter((symbol) => context.market.getPrice(symbol) === null),
        ),
      ];
      const fallbackTickers =
        missingSymbols.length > 0 ? await getTickers(missingSymbols).catch(() => []) : [];
      const fallbackPrices = new Map(
        fallbackTickers.map((ticker) => [ticker.symbol, Number(ticker.lastPrice)]),
      );
      const realizedPnl = round(
        trades.reduce((total, trade) => total + trade.realizedPnl, 0),
        2,
      );
      const startingCapital =
        settings.mode === 'PAPER'
          ? capital.capital - trades.filter((t) => t.status === 'CLOSED').reduce((acc, t) => acc + t.realizedPnl, 0)
          : capital.capital;

      const positions = activeTrades
        .map((trade) => {
          const entryPrice = trade.averageFillPrice ?? trade.entryPrice;
          const currentPrice =
            context.market.getPrice(trade.symbol) ?? fallbackPrices.get(trade.symbol) ?? null;
          const quantity = trade.status === 'PENDING' ? trade.requestedQuantity : trade.remainingQuantity;
          const invested =
            trade.status === 'PENDING' ? trade.notional : round(entryPrice * trade.remainingQuantity, 2);
          const currentValue =
            trade.status === 'OPEN' && currentPrice !== null
              ? round(currentPrice * trade.remainingQuantity, 2)
              : null;
          const unrealizedPnl =
            currentValue !== null ? round(currentValue - invested, 2) : null;
          const totalPnl =
            trade.status === 'OPEN' && unrealizedPnl !== null
              ? round(trade.realizedPnl + unrealizedPnl, 2)
              : null;
          const pnlPercent =
            totalPnl !== null && trade.notional > 0
              ? round((totalPnl / trade.notional) * 100, 2)
              : null;

          // o plano de saída viaja junto com a posição: sem alvo e sem stop
          // na mesma linha, olhar para o preço atual não informa nada
          const toStop =
            currentPrice !== null && currentPrice > 0
              ? round(((trade.stopLoss - currentPrice) / currentPrice) * 100, 2)
              : null;
          const toTarget =
            currentPrice !== null && currentPrice > 0
              ? round(((trade.target1 - currentPrice) / currentPrice) * 100, 2)
              : null;

          return {
            id: trade.id,
            symbol: trade.symbol,
            status: trade.status,
            quantity,
            entryPrice,
            currentPrice,
            invested,
            currentValue,
            realizedPnl: trade.realizedPnl,
            unrealizedPnl,
            totalPnl,
            pnlPercent,
            stopLoss: trade.stopLoss,
            target1: trade.target1,
            target2: trade.target2,
            target3: trade.target3,
            // operações gravadas antes destes campos vêm sem eles; sem o ?? null
            // o JSON omite a chave e a tela lê "undefined" como "tem proteção"
            protectiveStop: trade.protectiveStop ?? null,
            distanceToStopPercent: toStop,
            distanceToTargetPercent: toTarget,
            feesPaid: trade.feesPaid ?? 0,
            automatic: trade.automatic ?? false,
            setupType: trade.setupType,
            score: trade.score,
            openedAt: trade.openedAt,
          };
        });

      const unrealizedPnl = round(
        positions.reduce((total, position) => total + (position.unrealizedPnl ?? 0), 0),
        2,
      );
      const currentEquity =
        settings.mode === 'PAPER'
          ? round(startingCapital + realizedPnl + unrealizedPnl, 2)
          : capital.capital;

      response.json({
        points: buildEquityCurve(trades, startingCapital),
        startingCapital,
        currentEquity,
        available: capital.available,
        invested: round(positions.reduce((total, position) => total + position.invested, 0), 2),
        realizedPnl,
        unrealizedPnl,
        positions,
        brlRate: capital.brlRate,
        mode: settings.mode,
        updatedAt: new Date().toISOString(),
      });
    }),
  );

  /** Diário de decisões: o que o sistema viu × o que aconteceu. */
  router.get(
    '/decisions',
    asyncHandler(async (request, response) => {
      const mode = context.settings.get().mode;
      const range = parseRange(request.query as Record<string, unknown>);
      const decisions = await context.repository.listDecisions();
      response.json(
        decisions
          .filter((decision) => decision.mode === mode && withinRange(decision.closedAt, range))
          // registro gravado antes da autópsia existir recebe a dela agora: a
          // conta é pura e sai dos mesmos números que já estão guardados
          .map((decision) =>
            decision.postMortem
              ? decision
              : { ...decision, postMortem: postMortemOf(decision) },
          ),
      );
    }),
  );

  /** Acerto por fator: quais indicadores estavam certos. */
  router.get(
    '/analytics/factors',
    asyncHandler(async (request, response) => {
      const mode = context.settings.get().mode;
      const range = parseRange(request.query as Record<string, unknown>);
      const decisions = (await context.repository.listDecisions()).filter(
        (decision) => decision.mode === mode && withinRange(decision.closedAt, range),
      );
      response.json({ total: decisions.length, factors: analyzeFactors(decisions) });
    }),
  );

  router.get(
    '/performance',
    asyncHandler(async (request, response) => {
      const mode = context.settings.get().mode;
      const range = parseRange(request.query as Record<string, unknown>);
      const [allTrades, setups] = await Promise.all([
        context.repository.listTrades(),
        context.repository.listSetups(),
      ]);
      // posição aberta não tem data de fechamento: ela entra em qualquer
      // recorte, porque continua sendo dinheiro exposto agora
      const trades = allTrades.filter(
        (trade) =>
          trade.mode === mode &&
          (trade.closedAt === null || withinRange(trade.closedAt, range)),
      );
      response.json(computePerformance(trades, setups));
    }),
  );

  return router;
}
