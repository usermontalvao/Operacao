import { Router } from 'express';
import { z } from 'zod';
import {
  ENVIRONMENTS,
  config,
  environmentForMode,
  type BinanceEnvironment,
} from '../config.ts';
import {
  getAccountBalances,
  getActiveEnvironment,
  getSymbolFilters,
  getUsdtBrlRate,
  setActiveEnvironment,
} from '../binance/rest.ts';
import { logger } from '../logger.ts';
import { describeSettingsIssue, settingsUpdateSchema } from '../services/settingsService.ts';
import { buildCuratedWatchlist } from '../services/curatedWatchlist.ts';
import { withBitcoin } from '../services/focus.ts';
import { asyncHandler, type ApiContext } from './context.ts';

const symbolSchema = z.object({ symbol: z.string().regex(/^[A-Z0-9]{4,20}$/) });

type BalanceStatus = 'AVAILABLE' | 'NOT_CONFIGURED' | 'UNAVAILABLE';

interface UsdtBalanceSnapshot {
  status: BalanceStatus;
  total: number | null;
  available: number | null;
  locked: number | null;
}

async function readUsdtBalance(environment: BinanceEnvironment): Promise<UsdtBalanceSnapshot> {
  if (!ENVIRONMENTS[environment].hasCredentials) {
    return { status: 'NOT_CONFIGURED', total: null, available: null, locked: null };
  }
  try {
    const balances = await getAccountBalances(environment);
    const usdt = balances.find((balance) => balance.asset === 'USDT');
    const available = usdt?.free ?? 0;
    const locked = usdt?.locked ?? 0;
    return { status: 'AVAILABLE', total: available + locked, available, locked };
  } catch (error) {
    logger.warn('Saldo da Binance indisponível na tela de ajustes', {
      environment,
      error: (error as Error).message,
    });
    return { status: 'UNAVAILABLE', total: null, available: null, locked: null };
  }
}

export function settingsRoutes(context: ApiContext): Router {
  const router = Router();

  router.get(
    '/settings',
    asyncHandler(async (_request, response) => {
      // São retratos somente de leitura. Informar o ambiente diretamente evita
      // trocar o feed de mercado do robô só para desenhar os cartões da tela.
      const [brlRate, productionBalance, testnetBalance] = await Promise.all([
        getUsdtBrlRate(),
        readUsdtBalance('production'),
        readUsdtBalance('testnet'),
      ]);
      response.json({
        ...context.settings.get(),
        binance: {
          activeEnvironment: getActiveEnvironment().name,
          // A interface recebe saldos, nunca as credenciais usadas para lê-los.
          production: {
            credentialsConfigured: ENVIRONMENTS.production.hasCredentials,
            balance: { ...productionBalance, brlRate },
          },
          testnet: {
            credentialsConfigured: ENVIRONMENTS.testnet.hasCredentials,
            balance: { ...testnetBalance, brlRate },
          },
        },
        // a tela mostra o que cada modo tem guardado: trocar de conta não pode
        // ser uma surpresa ("eu tinha desligado o robô" era o robô do outro modo)
        byMode: context.settings.all().byMode,
        universe: context.universe.getStatus(),
        store: config.store,
      });
    }),
  );

  router.put(
    '/settings',
    asyncHandler(async (request, response) => {
      const parsed = settingsUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: describeSettingsIssue(parsed.error) });
        return;
      }
      const nextMode = parsed.data.mode;
      if (nextMode && nextMode !== 'PAPER' && !environmentForMode(nextMode).hasCredentials) {
        response.status(400).json({
          error:
            nextMode === 'LIVE'
              ? 'Configure BINANCE_API_KEY e BINANCE_API_SECRET no arquivo .env antes de ativar o modo real'
              : 'Configure BINANCE_TESTNET_API_KEY e BINANCE_TESTNET_API_SECRET no arquivo .env antes de usar o testnet',
        });
        return;
      }

      const previous = context.settings.get();
      const updated = await context.settings.update(parsed.data);

      // trocar de ambiente troca o mercado inteiro: recomeça dados e streams
      const previousEnvironment = environmentForMode(previous.mode).name;
      const nextEnvironment = environmentForMode(updated.mode).name;
      if (previousEnvironment !== nextEnvironment) {
        setActiveEnvironment(nextEnvironment);
        context.universe.reset();
        // outra lista de pares: comparar com a anterior inventaria deslistagens
        context.news.reset();
        void context.news.refresh();
        await context.market.restart(withBitcoin(updated.scanner.watchlist));
      } else if (parsed.data.scanner?.watchlist) {
        await context.market.setSymbols(withBitcoin(updated.scanner.watchlist));
      }
      if (parsed.data.scanner?.universe && parsed.data.scanner.universe !== previous.scanner.universe) {
        context.universe.reset();
      }
      if (parsed.data.scanner || previousEnvironment !== nextEnvironment) void context.scanner.scan();

      if (nextMode && nextMode !== previous.mode) {
        await context.audit.record({
          action: 'MODE_CHANGED',
          mode: updated.mode,
          detail: { from: previous.mode, to: updated.mode, environment: nextEnvironment },
        });
      }
      context.bus.broadcast({ type: 'settings', payload: updated });
      response.json(updated);
    }),
  );

  router.post(
    '/watchlist',
    asyncHandler(async (request, response) => {
      const parsed = symbolSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: 'Símbolo inválido' });
        return;
      }
      const symbol = parsed.data.symbol.toUpperCase();
      const filters = await getSymbolFilters([symbol]).catch(() => null);
      const entry = filters?.get(symbol);
      if (!entry || entry.status !== 'TRADING' || !entry.isSpotTradingAllowed) {
        response.status(400).json({ error: `${symbol} não está disponível para spot na Binance` });
        return;
      }
      const current = context.settings.get().scanner.watchlist;
      if (current.includes(symbol)) {
        response.json(context.settings.get());
        return;
      }
      const updated = await context.settings.update({
        scanner: { watchlist: [...current, symbol] },
      });
      await context.market.setSymbols(withBitcoin(updated.scanner.watchlist));
      void context.scanner.scan();
      context.bus.broadcast({ type: 'settings', payload: updated });
      response.json(updated);
    }),
  );

  /**
   * Preenche a watchlist com os pares mais líquidos do momento — os que
   * realmente dá para operar. Substitui a lista atual.
   */
  router.post(
    '/watchlist/curated',
    asyncHandler(async (request, response) => {
      const options = z
        .object({
          limit: z.number().int().min(5).max(40).optional(),
          minQuoteVolume24h: z.number().min(0).optional(),
        })
        .safeParse(request.body ?? {});
      try {
        const watchlist = await buildCuratedWatchlist(options.success ? options.data : {});
        if (watchlist.length === 0) {
          response.status(503).json({ error: 'DADOS INDISPONÍVEIS para montar a watchlist' });
          return;
        }
        const updated = await context.settings.update({ scanner: { watchlist } });
        await context.market.setSymbols(withBitcoin(updated.scanner.watchlist));
        context.universe.reset();
        void context.scanner.scan();
        context.bus.broadcast({ type: 'settings', payload: updated });
        response.json(updated);
      } catch (error) {
        response.status(503).json({ error: (error as Error).message });
      }
    }),
  );

  router.delete(
    '/watchlist/:symbol',
    asyncHandler(async (request, response) => {
      const symbol = String(request.params.symbol).toUpperCase();
      const current = context.settings.get().scanner.watchlist;
      if (current.length <= 1) {
        response.status(400).json({ error: 'A watchlist precisa ter pelo menos um ativo' });
        return;
      }
      const updated = await context.settings.update({
        scanner: { watchlist: current.filter((item) => item !== symbol) },
      });
      await context.market.setSymbols(withBitcoin(updated.scanner.watchlist));
      context.bus.broadcast({ type: 'settings', payload: updated });
      response.json(updated);
    }),
  );

  router.get(
    '/audit',
    asyncHandler(async (request, response) => {
      const limit = Math.min(Number(request.query.limit ?? 100), 500);
      response.json(await context.audit.list(limit));
    }),
  );

  return router;
}
