import { Router } from 'express';
import { z } from 'zod';
import { buildFunnel, groupBlockReasons } from '../../core/decision/funnel.ts';
import { activeCooldowns } from '../../core/decision/cooldown.ts';
import {
  SCAN_THRESHOLDS,
  TICK_THRESHOLDS,
  evaluateFreshness,
} from '../../core/health/freshness.ts';
import { activeSessionModes } from '../../core/session/sessions.ts';
import {
  EXECUTION_POLICY_VERSION,
  RISK_POLICY_VERSION,
  SCORING_VERSION,
  STRATEGY_VERSION,
} from '../../core/policy/snapshot.ts';
import { environmentForMode } from '../config.ts';
import { getActiveEnvironment } from '../binance/rest.ts';
import { asyncHandler, type ApiContext } from './context.ts';

const modeSchema = z.enum(['PAPER', 'TESTNET', 'LIVE']);

/**
 * Rotas de transparência: por que não entrou, onde os sinais param e se a
 * plataforma está de pé. Nenhuma delas move dinheiro — todas existem para
 * responder perguntas que antes só o log respondia, e mal.
 */
export function diagnosticsRoutes(context: ApiContext): Router {
  const router = Router();

  /**
   * "Por que o robô não entrou?"
   *
   * A pergunta que não tinha resposta no painel. Devolve as decisões gravadas,
   * já deduplicadas por situação, com o motivo que mandou e os números que o
   * sustentam.
   */
  router.get(
    '/entry-decisions',
    asyncHandler(async (request, response) => {
      if (context.persistence.degraded) {
        response.status(503).json({ error: 'Persistência principal indisponível' });
        return;
      }
      const limit = Math.min(Number(request.query.limit ?? 200), 500);
      // sem modo explícito, a sessão em exibição. Um funil que soma PAPER e
      // LIVE mostra "robô desligado" para metade dos sinais e não descreve
      // nenhuma das duas contas.
      const pedido = modeSchema.safeParse(request.query.mode);
      const mode = pedido.success ? pedido.data : context.settings.get().mode;
      const symbol = typeof request.query.symbol === 'string' ? request.query.symbol : null;

      let decisions = await context.repository.listEntryDecisions(limit);
      decisions = decisions.filter((item) => item.mode === mode);
      if (symbol) decisions = decisions.filter((item) => item.symbol === symbol);

      response.json({
        decisions,
        reasons: groupBlockReasons(decisions),
      });
    }),
  );

  /** O funil: de cem sinais, quantos morreram em cada porta. */
  router.get(
    '/funnel',
    asyncHandler(async (request, response) => {
      if (context.persistence.degraded) {
        response.status(503).json({ error: 'Persistência principal indisponível' });
        return;
      }
      const pedido = modeSchema.safeParse(request.query.mode);
      const mode = pedido.success ? pedido.data : context.settings.get().mode;
      const decisions = (await context.repository.listEntryDecisions(500)).filter(
        (item) => item.mode === mode,
      );
      response.json({ ...buildFunnel(decisions), mode });
    }),
  );

  /**
   * Saúde do sistema. Reúne num lugar tudo que o usuário só descobriria
   * lendo log — e o mais importante: a idade dos dados, que não se enxerga
   * olhando o preço na tela.
   */
  router.get(
    '/system',
    asyncHandler(async (_request, response) => {
      const settings = context.settings.get();
      const sessoes = activeSessionModes(settings.mode);
      const tick = evaluateFreshness(context.market.lastTickAt(), TICK_THRESHOLDS);
      const scan = evaluateFreshness(context.scanner.getLastScanAt(), SCAN_THRESHOLDS);

      const trades = context.persistence.degraded ? [] : await context.repository.listTrades();

      response.json({
        persistencia: {
          tipo: context.persistence.kind,
          disponivel: !context.persistence.degraded,
          erro: context.persistence.error,
        },
        binance: {
          ambienteAtivo: getActiveEnvironment().name,
          ambienteEsperado: environmentForMode(settings.mode).name,
          publicaDisponivel: context.market.isAvailable(),
          streamPrecos: context.market.getConnectionState(),
        },
        dados: { tick, scan },
        // o coração da mudança que o usuário pediu: as sessões que operam AGORA
        sessoes: sessoes.map((mode) => {
          const policy = context.settings.forMode(mode);
          const abertas = context.paper
            .getOpenTrades()
            .filter((trade) => trade.mode === mode);
          return {
            mode,
            emExibicao: mode === settings.mode,
            robo: policy.autoTrade.enabled ? 'LIGADO' : 'DESLIGADO',
            armadoAte: policy.autoTrade.liveArmedUntil,
            posicoesAbertas: abertas.length,
            disjuntorSilenciadoAte: policy.guard.mutedUntil,
            descansos: activeCooldowns({
              trades,
              mode,
              cooldownMinutes: policy.autoTrade.cooldownMinutes,
              now: Date.now(),
            }),
          };
        }),
        modoEmExibicao: settings.mode,
        scannerAtivo: context.scanner.getLastScanAt() !== null,
        universo: context.universe.getStatus(),
        versoes: {
          estrategia: STRATEGY_VERSION,
          score: SCORING_VERSION,
          risco: RISK_POLICY_VERSION,
          execucao: EXECUTION_POLICY_VERSION,
        },
      });
    }),
  );

  /**
   * Prontidão para operar. Diferente de /health: /health diz "o processo
   * responde"; isto diz "dá para abrir posição com segurança agora".
   */
  router.get('/ready', (_request, response) => {
    const tick = evaluateFreshness(context.market.lastTickAt(), TICK_THRESHOLDS);
    const impedimentos: string[] = [];
    if (context.persistence.degraded) impedimentos.push('Persistência principal indisponível');
    if (tick.blocksTrading) impedimentos.push(`Preço ${tick.level.toLowerCase()}`);
    if (!context.market.isAvailable()) impedimentos.push('Binance pública inacessível');

    response.status(impedimentos.length === 0 ? 200 : 503).json({
      pronto: impedimentos.length === 0,
      impedimentos,
    });
  });

  return router;
}
