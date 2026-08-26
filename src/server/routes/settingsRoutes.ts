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
  getApiKeyPowers,
  getSymbolFilters,
  getUsdtBrlRate,
  setActiveEnvironment,
} from '../binance/rest.ts';
import { getFuturesBalances } from '../binance/futures.ts';
import { logger } from '../logger.ts';
import { describeSettingsIssue, settingsUpdateSchema } from '../services/settingsService.ts';
import { missingCredentialsMessage } from '../services/executionService.ts';
import { buildCuratedWatchlist } from '../services/curatedWatchlist.ts';
import { prioritizedFocus } from '../services/focus.ts';
import { asyncHandler, type ApiContext } from './context.ts';

const symbolSchema = z.object({ symbol: z.string().regex(/^[A-Z0-9]{4,20}$/) });

type BalanceStatus = 'AVAILABLE' | 'NOT_CONFIGURED' | 'UNAVAILABLE';

interface UsdtBalanceSnapshot {
  status: BalanceStatus;
  total: number | null;
  available: number | null;
  locked: number | null;
}

/**
 * O aviso que evita a ordem recusada.
 *
 * Chave só de leitura mostra saldo, mostra ordem, mostra tudo — e recusa a
 * única coisa que importa, com um -2015 que chega depois de o usuário
 * atravessar todas as travas e confirmar. Aqui ele aparece em repouso, na
 * tela onde as chaves são configuradas.
 */
async function readKeyWarning(environment: BinanceEnvironment): Promise<string | null> {
  if (!ENVIRONMENTS[environment].hasCredentials) return null;
  const powers = await getApiKeyPowers(environment);
  if (powers === null) return null;

  const futuros = ENVIRONMENTS[environment].market === 'FUTURES';
  const pode = futuros ? powers.canFutures : powers.canTrade;
  if (pode) {
    return powers.ipRestricted
      ? 'Chave com lista de IPs: se o endereço desta máquina mudar, as ordens passam a ser recusadas'
      : null;
  }
  return futuros
    ? 'Esta chave NÃO pode operar futuros — ela lê saldo, mas toda ordem será recusada. Habilite "Futuros" na Binance › Gerenciamento de API'
    : 'Esta chave é SÓ DE LEITURA — ela mostra saldo, mas toda ordem será recusada. Habilite "Trading Spot e de Margem" na Binance › Gerenciamento de API';
}

async function readUsdtBalance(environment: BinanceEnvironment): Promise<UsdtBalanceSnapshot> {
  if (!ENVIRONMENTS[environment].hasCredentials) {
    return { status: 'NOT_CONFIGURED', total: null, available: null, locked: null };
  }
  try {
    // futuros tem carteira própria: o saldo do spot não abre posição nenhuma
    // ali, e mostrar um pelo outro faria a tela prometer margem que não existe
    if (ENVIRONMENTS[environment].market === 'FUTURES') {
      const balances = await getFuturesBalances(environment);
      const usdt = balances.find((balance) => balance.asset === 'USDT');
      const total = usdt?.walletBalance ?? 0;
      const available = usdt?.availableBalance ?? 0;
      return { status: 'AVAILABLE', total, available, locked: Math.max(total - available, 0) };
    }
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

const INDISPONIVEL: UsdtBalanceSnapshot = {
  status: 'UNAVAILABLE',
  total: null,
  available: null,
  locked: null,
};

/** O valor quando dá certo; o combinado quando não dá — nunca uma rejeição. */
async function quandoDer<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    logger.warn('Parte da tela de ajustes não pôde ser lida', {
      error: (error as Error).message,
    });
    return fallback;
  }
}

export function settingsRoutes(context: ApiContext): Router {
  const router = Router();
  const liveFocus = (watchlist: string[]): string[] =>
    prioritizedFocus(
      context.paper.getOpenTrades().map((trade) => trade.symbol),
      watchlist,
      context.scanner.getSetups().map((setup) => setup.symbol),
    );

  router.get(
    '/settings',
    asyncHandler(async (_request, response) => {
      // São retratos somente de leitura. Informar o ambiente diretamente evita
      // trocar o feed de mercado do robô só para desenhar os cartões da tela.
      /*
       * Nenhuma leitura destas pode derrubar a página.
       *
       * Esta rota desenha a tela de ajustes INTEIRA — modo, robô, watchlist,
       * chaves. Enquanto uma rejeição podia escapar, ela levava junto tudo o
       * que já tinha respondido e a tela caía inteira com 500. Um cartão sem
       * número é um cartão sem número; não pode custar a página.
       */
      const [brlRate, productionBalance, testnetBalance, futuresBalance, futuresTestnetBalance] =
        await Promise.all([
          quandoDer(getUsdtBrlRate(), null),
          quandoDer(readUsdtBalance('production'), INDISPONIVEL),
          quandoDer(readUsdtBalance('testnet'), INDISPONIVEL),
          quandoDer(readUsdtBalance('futures-production'), INDISPONIVEL),
          quandoDer(readUsdtBalance('futures-testnet'), INDISPONIVEL),
        ]);
      const [productionKey, futuresKey] = await Promise.all([
        quandoDer(readKeyWarning('production'), null),
        quandoDer(readKeyWarning('futures-production'), null),
      ]);
      response.json({
        ...context.settings.get(),
        binance: {
          activeEnvironment: getActiveEnvironment().name,
          // A interface recebe saldos, nunca as credenciais usadas para lê-los.
          production: {
            credentialsConfigured: ENVIRONMENTS.production.hasCredentials,
            balance: { ...productionBalance, brlRate },
            keyWarning: productionKey,
          },
          testnet: {
            credentialsConfigured: ENVIRONMENTS.testnet.hasCredentials,
            balance: { ...testnetBalance, brlRate },
          },
          futuresProduction: {
            credentialsConfigured: ENVIRONMENTS['futures-production'].hasCredentials,
            balance: { ...futuresBalance, brlRate },
            keyWarning: futuresKey,
          },
          futuresTestnet: {
            credentialsConfigured: ENVIRONMENTS['futures-testnet'].hasCredentials,
            balance: { ...futuresTestnetBalance, brlRate },
          },
        },
        // a tela mostra o que cada modo tem guardado: trocar de conta não pode
        // ser uma surpresa ("eu tinha desligado o robô" era o robô do outro modo)
        byMode: context.settings.buckets(),
        byMarket: context.settings.all().byMarket,
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
      const previous = context.settings.get();
      const nextMode = parsed.data.mode;
      const nextMarket = parsed.data.market ?? previous.market;
      if (
        nextMode &&
        nextMode !== 'PAPER' &&
        !environmentForMode(nextMode, nextMarket).hasCredentials
      ) {
        response.status(400).json({ error: missingCredentialsMessage(nextMode, nextMarket) });
        return;
      }
      // trocar de modalidade com a conta já em TESTNET/LIVE exige as chaves
      // daquela modalidade: sem isso a tela mudaria e a primeira ordem falharia
      if (
        parsed.data.market &&
        previous.mode !== 'PAPER' &&
        !environmentForMode(previous.mode, parsed.data.market).hasCredentials
      ) {
        response.status(400).json({ error: missingCredentialsMessage(previous.mode, parsed.data.market) });
        return;
      }

      const updated = await context.settings.update(parsed.data);

      // trocar de ambiente troca o mercado inteiro: recomeça dados e streams
      const previousEnvironment = environmentForMode(previous.mode, previous.market).name;
      const nextEnvironment = environmentForMode(updated.mode, updated.market).name;
      if (previousEnvironment !== nextEnvironment) {
        setActiveEnvironment(nextEnvironment);
        context.universe.reset();
        // outra lista de pares: comparar com a anterior inventaria deslistagens
        context.news.reset();
        void context.news.refresh();
        await context.market.restart(liveFocus(updated.scanner.watchlist));
      } else if (parsed.data.scanner?.watchlist) {
        await context.market.setSymbols(liveFocus(updated.scanner.watchlist));
      }
      if (parsed.data.scanner?.universe && parsed.data.scanner.universe !== previous.scanner.universe) {
        context.universe.reset();
      }
      /*
       * Liberar futuros muda o RADAR, não o ambiente.
       *
       * O ambiente continua o mesmo (a tela segue em spot), então a condição
       * antiga não disparava varredura nenhuma — o interruptor virava e a
       * coluna nova nascia vazia até o ciclo seguinte, o que dava a impressão
       * de que nada tinha acontecido. Barrar é o inverso: as teses da
       * modalidade saem do radar na hora.
       */
      const modalidadeMudou = parsed.data.futuresEnabled !== undefined &&
        parsed.data.futuresEnabled !== previous.futuresEnabled;
      if (modalidadeMudou && !updated.futuresEnabled) context.scanner.dropMarket('FUTURES');

      if (
        parsed.data.scanner ||
        modalidadeMudou ||
        previousEnvironment !== nextEnvironment
      ) {
        void context.scanner.scan();
      }

      if (nextMode && nextMode !== previous.mode) {
        await context.audit.record({
          action: 'MODE_CHANGED',
          mode: updated.mode,
          detail: { from: previous.mode, to: updated.mode, environment: nextEnvironment },
        });
      }
      if (parsed.data.market && parsed.data.market !== previous.market) {
        await context.audit.record({
          action: 'MARKET_CHANGED',
          mode: updated.mode,
          detail: { de: previous.market, para: updated.market, ambiente: nextEnvironment },
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
        response.status(400).json({
          error: `${symbol} não está disponível para ${context.settings.get().market === 'FUTURES' ? 'futuros' : 'spot'} na Binance`,
        });
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
      await context.market.setSymbols(liveFocus(updated.scanner.watchlist));
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
        await context.market.setSymbols(liveFocus(updated.scanner.watchlist));
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
      await context.market.setSymbols(liveFocus(updated.scanner.watchlist));
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
