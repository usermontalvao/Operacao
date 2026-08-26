import { postMortemOf } from '../../core/journal/postMortem.ts';
import { Router } from 'express';
import { z } from 'zod';
import { computePerformance } from '../../core/performance.ts';
import { analyzeFactors, buildEquityCurve } from '../../core/analytics.ts';
import { gainPerUnit } from '../../core/direction.ts';
import { round } from '../../core/risk/index.ts';
import { PANIC_CLOSE_REASON } from '../../core/risk/governor.ts';
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
      const { mode, market } = context.settings.get();
      const trades = await context.repository.listTrades();
      response.json(trades.filter((trade) => trade.mode === mode && trade.market === market));
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
      const result = await context.close.closeAll(PANIC_CLOSE_REASON);
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
      const parsed = z
        .object({
          enabled: z.boolean(),
          // sem modo, o alvo é a sessão em exibição; com modo, dá para ligar o
          // robô do demo enquanto se olha a conta real
          mode: z.enum(['PAPER', 'TESTNET', 'LIVE']).optional(),
          // e sem modalidade, a que está na tela: o radar tem uma coluna por
          // modalidade e cada uma liga o SEU robô, sem encostar no outro
          market: z.enum(['SPOT', 'FUTURES']).optional(),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'Informe se o robô deve ficar ligado' });
        return;
      }
      const alvo = parsed.data.mode ?? context.settings.get().mode;
      const modalidade = parsed.data.market ?? context.settings.get().market;
      if (modalidade === 'FUTURES' && !context.settings.get().futuresEnabled) {
        response.status(400).json({ error: 'Futuros está barrado no painel' });
        return;
      }
      // targetMode/targetMarket e não mode/market: ajusta o balde pedido SEM
      // trocar a janela que o usuário está olhando
      const settings = await context.settings.update(
        { autoTrade: { enabled: parsed.data.enabled } },
        { targetMode: alvo, targetMarket: modalidade },
      );
      await context.audit.record({
        action: parsed.data.enabled ? 'ROBOT_ENABLED' : 'ROBOT_DISABLED',
        mode: alvo,
        detail: { origem: 'painel', modalidade },
      });

      // ligar reavalia o que já está no radar; desligar não precisa de nada
      if (parsed.data.enabled) void context.scanner.reconsiderAll(alvo);

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
      if (!context.settings.forMode('LIVE').autoTrade.allowLive) {
        response.status(400).json({
          error: 'Libere a compra automática em conta real nos ajustes antes de armar',
        });
        return;
      }
      const until = new Date(Date.now() + parsed.data.minutes * 60_000).toISOString();
      const settings = await context.settings.update(
        { autoTrade: { enabled: true, liveArmedUntil: until } },
        { targetMode: 'LIVE' },
      );
      const denial = liveAutoTradeDenial(context.settings.forMode('LIVE'));
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
      const settings = await context.settings.update(
        { autoTrade: { liveArmedUntil: null } },
        { targetMode: 'LIVE' },
      );
      await context.audit.record({ action: 'ROBOT_DISARMED_LIVE', mode: 'LIVE', detail: {} });
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
      /*
       * Duas listas de propósito.
       *
       * A CARTEIRA é do par modo+modalidade: capital, curva e realizado de
       * spot e de futuros são separados, e somá-los daria um patrimônio que
       * não existe em nenhuma das duas contas.
       *
       * A lista de POSIÇÕES ABERTAS não. Dinheiro exposto agora não pode
       * depender de qual aba está selecionada: esconder uma posição vendida
       * porque a tela está em spot é o jeito mais rápido de esquecer que ela
       * existe. Cada posição vai carimbada com a modalidade, e os totais
       * continuam sendo os da carteira em exibição.
       */
      const trades = allTrades.filter(
        (trade) => trade.mode === settings.mode && trade.market === settings.market,
      );
      const activeTrades = allTrades.filter(
        (trade) =>
          trade.mode === settings.mode &&
          (trade.status === 'PENDING' || trade.status === 'OPEN'),
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
          /*
           * Quanto a posição vale PARA QUEM ESTÁ NELA.
           *
           * Comprado, isso é preço × quantidade. Vendido, não: a posição vale
           * mais quando o preço cai, e `preço × quantidade` diria o contrário.
           * `investido + resultado em aberto` dá o mesmo número no comprado e
           * o número certo no vendido.
           */
          const currentValue =
            trade.status === 'OPEN' && currentPrice !== null ? invested : null;
          /*
           * `valor de agora − valor investido` só é lucro para quem comprou.
           * Na posição vendida a mesma subtração devolve o simétrico: a tela
           * mostraria prejuízo justo quando o preço cai, que é o momento em
           * que ela ganha. A diferença passa pela direção.
           */
          const unrealizedPnl =
            trade.status === 'OPEN' && currentPrice !== null
              ? round(
                  gainPerUnit(trade.side ?? 'BUY', entryPrice, currentPrice) *
                    trade.remainingQuantity,
                  2,
                )
              : null;
          const totalPnl =
            trade.status === 'OPEN' && unrealizedPnl !== null
              ? round(trade.realizedPnl + unrealizedPnl, 2)
              : null;
          const valorAgora =
            currentValue !== null && unrealizedPnl !== null
              ? round(currentValue + unrealizedPnl, 2)
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
          // distância até a linha da corretora: em posição alavancada é o
          // número que decide se dá para respirar ou se é hora de sair
          const toLiquidation =
            trade.liquidationPrice !== null &&
            trade.liquidationPrice !== undefined &&
            currentPrice !== null &&
            currentPrice > 0
              ? round(((trade.liquidationPrice - currentPrice) / currentPrice) * 100, 2)
              : null;

          return {
            id: trade.id,
            symbol: trade.symbol,
            status: trade.status,
            quantity,
            entryPrice,
            currentPrice,
            invested,
            currentValue: valorAgora,
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
            // linha por linha, a tela precisa saber de onde a posição é:
            // as duas modalidades aparecem juntas na mesma lista
            market: trade.market ?? 'SPOT',
            side: trade.side ?? 'BUY',
            leverage: trade.leverage ?? 1,
            initialMargin: trade.initialMargin ?? 0,
            liquidationPrice: trade.liquidationPrice ?? null,
            distanceToLiquidationPercent: toLiquidation,
            feesPaid: trade.feesPaid ?? 0,
            automatic: trade.automatic ?? false,
            setupType: trade.setupType,
            score: trade.score,
            openedAt: trade.openedAt,
          };
        });

      // os totais são da CARTEIRA em exibição; a posição da outra modalidade
      // aparece na lista, mas não entra no patrimônio desta conta
      const daCarteira = positions.filter((position) => position.market === settings.market);
      const unrealizedPnl = round(
        daCarteira.reduce((total, position) => total + (position.unrealizedPnl ?? 0), 0),
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
        invested: round(daCarteira.reduce((total, position) => total + position.invested, 0), 2),
        realizedPnl,
        unrealizedPnl,
        positions,
        brlRate: capital.brlRate,
        mode: settings.mode,
        market: settings.market,
        updatedAt: new Date().toISOString(),
      });
    }),
  );

  /** Diário de decisões: o que o sistema viu × o que aconteceu. */
  router.get(
    '/decisions',
    asyncHandler(async (request, response) => {
      const { mode, market } = context.settings.get();
      const range = parseRange(request.query as Record<string, unknown>);
      const decisions = await context.repository.listDecisions();
      response.json(
        decisions
          // registro sem modalidade é de antes de futuros: aquilo era spot
          .filter(
            (decision) =>
              decision.mode === mode &&
              (decision.market ?? 'SPOT') === market &&
              withinRange(decision.closedAt, range),
          )
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
      const { mode, market } = context.settings.get();
      const range = parseRange(request.query as Record<string, unknown>);
      const decisions = (await context.repository.listDecisions()).filter(
        (decision) =>
          decision.mode === mode &&
          (decision.market ?? 'SPOT') === market &&
          withinRange(decision.closedAt, range),
      );
      response.json({ total: decisions.length, factors: analyzeFactors(decisions) });
    }),
  );

  router.get(
    '/performance',
    asyncHandler(async (request, response) => {
      const { mode, market } = context.settings.get();
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
          trade.market === market &&
          (trade.closedAt === null || withinRange(trade.closedAt, range)),
      );
      response.json(computePerformance(trades, setups));
    }),
  );

  return router;
}
