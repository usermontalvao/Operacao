import { randomBytes } from 'node:crypto';
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
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_OWNER_ID: z.string().optional(),
  /** quem entra no painel: e-mail do Supabase ou usuário local */
  PANEL_USER: z.string().optional(),
  /** hash scrypt gerado por `npm run senha` — jamais a senha em texto */
  PANEL_PASSWORD_HASH: z.string().optional(),
  /** 'auto' decide sozinho: hash local vence, senão Supabase Auth */
  AUTH_BACKEND: z.enum(['auto', 'supabase', 'local']).default('auto'),
  SESSION_HOURS: z.coerce.number().positive().max(720).default(12),
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
  supabase: { url: string; serviceRoleKey: string; anonKey: string; ownerId: string } | null;
  auth: AuthConfig;
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

/**
 * Onde a senha é conferida. Nunca há um modo "sem login": quando nada está
 * configurado o backend é `none`, e aí a API recusa tudo e a tela de entrada
 * explica o que rodar. Um painel que envia ordem com dinheiro real não pode
 * ter um interruptor que o deixa aberto por engano.
 */
export type AuthBackendName = 'supabase' | 'local' | 'none';

export interface AuthConfig {
  backend: AuthBackendName;
  /** usuário aceito; em Supabase é o e-mail da conta */
  user: string | null;
  passwordHash: string | null;
  /** endpoint e chave usados só para conferir a senha no Supabase Auth */
  supabaseAuth: { url: string; apiKey: string } | null;
  sessionMs: number;
  /** cookie com Secure — só quando o painel é servido por https */
  secureCookie: boolean;
}

function resolveAuth(): AuthConfig {
  const hasLocal = !!parsed.PANEL_PASSWORD_HASH && !!parsed.PANEL_USER;
  const authKey = selectSupabaseAuthKey(
    parsed.SUPABASE_ANON_KEY,
    parsed.SUPABASE_SERVICE_ROLE_KEY,
  );
  const hasSupabase = !!parsed.SUPABASE_URL && !!authKey && !!parsed.PANEL_USER;

  let backend: AuthBackendName = 'none';
  if (parsed.AUTH_BACKEND === 'local') backend = hasLocal ? 'local' : 'none';
  else if (parsed.AUTH_BACKEND === 'supabase') backend = hasSupabase ? 'supabase' : 'none';
  else if (hasLocal) backend = 'local';
  else if (hasSupabase) backend = 'supabase';

  return {
    backend,
    user: parsed.PANEL_USER ?? null,
    passwordHash: parsed.PANEL_PASSWORD_HASH ?? null,
    supabaseAuth:
      parsed.SUPABASE_URL && authKey
        ? { url: parsed.SUPABASE_URL.replace(/\/+$/, ''), apiKey: authKey }
        : null,
    sessionMs: parsed.SESSION_HOURS * 60 * 60_000,
    secureCookie: false,
  };
}

/**
 * O Compose envia SUPABASE_ANON_KEY="" quando ela não foi configurada.
 * Coalescência nula (`??`) não trata string vazia como ausente e acabava
 * descartando uma SERVICE_ROLE_KEY válida, apesar de a persistência já estar
 * conectada com ela. Para autenticação, anon vence quando existe; caso
 * contrário a service role é o fallback já aceito pelo projeto.
 */
export function selectSupabaseAuthKey(
  anonKey: string | undefined,
  serviceRoleKey: string | undefined,
): string | undefined {
  return anonKey?.trim() || serviceRoleKey?.trim() || undefined;
}

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
        anonKey: parsed.SUPABASE_ANON_KEY ?? '',
        ownerId: parsed.SUPABASE_OWNER_ID ?? '',
      }
    : null,
  auth: resolveAuth(),
  watchlist: (parsed.WATCHLIST ?? DEFAULT_WATCHLIST.join(','))
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean),
  logLevel: parsed.LOG_LEVEL,
  /**
   * Sem APP_SECRET no arquivo, sorteamos um agora. Um segredo constante e
   * conhecido seria pior que nenhum: qualquer um poderia assinar um cookie de
   * sessão válido. Sorteado, o custo é que reiniciar o servidor pede login de
   * novo — e isso é aviso, não falha.
   */
  appSecret: parsed.APP_SECRET && parsed.APP_SECRET.length >= 16
    ? parsed.APP_SECRET
    : randomBytes(32).toString('hex'),
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
