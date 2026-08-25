import { z } from 'zod';
import type { TradingMode } from '../core/types.ts';

const DEFAULT_WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'OPUSDT', 'ONDOUSDT'];

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3010),
  HOST: z.string().default('127.0.0.1'),
  TRADING_MODE: z.enum(['PAPER', 'TESTNET', 'LIVE']).default('PAPER'),
  BINANCE_API_KEY: z.string().optional(),
  BINANCE_API_SECRET: z.string().optional(),
  BINANCE_TESTNET_API_KEY: z.string().optional(),
  BINANCE_TESTNET_API_SECRET: z.string().optional(),
  APP_SECRET: z.string().optional(),
  STORE: z.enum(['json', 'supabase']).default('json'),
  DATA_DIR: z.string().default('data'),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_OWNER_ID: z.string().optional(),
  WATCHLIST: z.string().optional(),
  /**
   * Segunda chave da compra automática em conta real. Fica só no servidor de
   * propósito: quem opera pelo painel não consegue ligar isto sem abrir o
   * arquivo, e quem abre o arquivo sabe o que está fazendo.
   */
  ALLOW_LIVE_AUTOTRADE: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  /** exige este cabeçalho Host — barra acesso por rebind de DNS de outra página */
  ALLOWED_HOSTS: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const parsed = schema.parse(process.env);

export type BinanceEnvironment = 'production' | 'testnet';

export interface EnvironmentEndpoints {
  name: BinanceEnvironment;
  /** dados públicos de mercado — não consomem peso da conta de trading */
  marketRestBase: string;
  /** endpoints assinados (conta e ordens) */
  tradeRestBase: string;
  wsBase: string;
  /**
   * Host do fluxo da CONTA. Não é o mesmo do mercado: data-stream.binance.vision
   * só serve dados públicos, e um listenKey apontado para lá nunca recebe nada.
   */
  userWsBase: string;
  hasCredentials: boolean;
}

export const ENVIRONMENTS: Record<BinanceEnvironment, EnvironmentEndpoints> = {
  production: {
    name: 'production',
    marketRestBase: 'https://data-api.binance.vision',
    tradeRestBase: 'https://api.binance.com',
    wsBase: 'wss://data-stream.binance.vision',
    userWsBase: 'wss://stream.binance.com:9443',
    hasCredentials: !!parsed.BINANCE_API_KEY && !!parsed.BINANCE_API_SECRET,
  },
  testnet: {
    name: 'testnet',
    marketRestBase: 'https://testnet.binance.vision',
    tradeRestBase: 'https://testnet.binance.vision',
    wsBase: 'wss://stream.testnet.binance.vision',
    userWsBase: 'wss://stream.testnet.binance.vision',
    hasCredentials: !!parsed.BINANCE_TESTNET_API_KEY && !!parsed.BINANCE_TESTNET_API_SECRET,
  },
};

/**
 * Cada modo tem seu ambiente. TESTNET usa os dados de mercado do próprio
 * testnet: assim o preço que gera o setup é o mesmo preço em que a ordem
 * executa — misturar preço real com execução de teste produziria ordens que
 * nunca preenchem.
 */
export function environmentForMode(mode: TradingMode): EnvironmentEndpoints {
  return mode === 'TESTNET' ? ENVIRONMENTS.testnet : ENVIRONMENTS.production;
}

export interface AppConfig {
  port: number;
  host: string;
  mode: TradingMode;
  store: 'json' | 'supabase';
  dataDir: string;
  supabase: { url: string; serviceRoleKey: string; ownerId: string } | null;
  watchlist: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** segredo usado só para assinar o token de confirmação de ordem */
  appSecret: string;
  /** libera o robô na conta real; sem isto o painel não consegue armá-lo */
  allowLiveAutoTrade: boolean;
  /** valores aceitos no cabeçalho Host das chamadas à API */
  allowedHosts: string[];
}

const supabaseReady =
  parsed.STORE === 'supabase' && !!parsed.SUPABASE_URL && !!parsed.SUPABASE_SERVICE_ROLE_KEY;

export const config: AppConfig = {
  port: parsed.PORT,
  host: parsed.HOST,
  mode: parsed.TRADING_MODE,
  store: supabaseReady ? 'supabase' : 'json',
  dataDir: parsed.DATA_DIR,
  supabase: supabaseReady
    ? {
        url: parsed.SUPABASE_URL as string,
        serviceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY as string,
        ownerId: parsed.SUPABASE_OWNER_ID ?? '00000000-0000-0000-0000-000000000000',
      }
    : null,
  watchlist: (parsed.WATCHLIST ?? DEFAULT_WATCHLIST.join(','))
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean),
  logLevel: parsed.LOG_LEVEL,
  appSecret: parsed.APP_SECRET ?? 'dev-secret-troque-em-producao',
  allowLiveAutoTrade: parsed.ALLOW_LIVE_AUTOTRADE === true,
  allowedHosts: (parsed.ALLOWED_HOSTS ?? `localhost:${parsed.PORT},127.0.0.1:${parsed.PORT},[::1]:${parsed.PORT}`)
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
};

/**
 * As credenciais ficam SÓ aqui dentro. Nenhuma rota devolve estes valores e
 * apenas o assinador HMAC tem acesso a eles.
 */
export function readCredentials(
  environment: BinanceEnvironment,
): { apiKey: string; apiSecret: string } | null {
  if (environment === 'testnet') {
    if (!parsed.BINANCE_TESTNET_API_KEY || !parsed.BINANCE_TESTNET_API_SECRET) return null;
    return {
      apiKey: parsed.BINANCE_TESTNET_API_KEY,
      apiSecret: parsed.BINANCE_TESTNET_API_SECRET,
    };
  }
  if (!parsed.BINANCE_API_KEY || !parsed.BINANCE_API_SECRET) return null;
  return { apiKey: parsed.BINANCE_API_KEY, apiSecret: parsed.BINANCE_API_SECRET };
}

export const DEFAULT_WATCHLIST_SYMBOLS = DEFAULT_WATCHLIST;
