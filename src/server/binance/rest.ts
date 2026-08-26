import type { MarketKind, SymbolFilters } from '../../core/types.ts';
import {
  ENVIRONMENTS,
  readCredentials,
  type BinanceEnvironment,
  type EnvironmentEndpoints,
} from '../config.ts';
import { logger } from '../logger.ts';
import { buildQuery, signQuery } from './signer.ts';

export class BinanceError extends Error {
  code: number;
  httpStatus: number;
  constructor(message: string, code: number, httpStatus: number) {
    super(message);
    this.name = 'BinanceError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface RawKline {
  0: number; 1: string; 2: string; 3: string; 4: string; 5: string;
  6: number; 7: string; 8: number; 9: string; 10: string; 11: string;
}

/** Ambiente ativo (produção ou testnet). Trocado quando o modo muda. */
let active: EnvironmentEndpoints = ENVIRONMENTS.production;

export function setActiveEnvironment(environment: BinanceEnvironment): void {
  if (active.name === environment) return;
  active = ENVIRONMENTS[environment];
  exchangeInfoCache.clear();
  universeCache.clear();
  pairStateCache.clear();
  logger.info('Ambiente da Binance alterado', { environment });
}

export function getActiveEnvironment(): EnvironmentEndpoints {
  return active;
}

/**
 * O ambiente irmão: mesma REDE, outra modalidade.
 *
 * Spot e futuros são duas corretoras que por acaso têm o mesmo dono: outros
 * endereços, outras chaves, outra carteira. Enquanto havia um único ambiente
 * ativo, uma posição de spot aberta com o painel em futuros era reconciliada
 * contra o endereço errado — caminho `/api/v3` batendo em `fapi`, resposta de
 * erro, e a operação parada no tempo sem ninguém saber.
 *
 * Produção continua produção e testnet continua testnet: o que muda aqui é só
 * a modalidade. Trocar de rede sem querer seria conferir ordem de dinheiro
 * real numa conta de brincadeira.
 */
export function environmentFor(market: MarketKind): EnvironmentEndpoints {
  const testnet = active.network === 'testnet';
  if (market === 'FUTURES') {
    return testnet ? ENVIRONMENTS['futures-testnet'] : ENVIRONMENTS['futures-production'];
  }
  return testnet ? ENVIRONMENTS.testnet : ENVIRONMENTS.production;
}

let bannedUntil = 0;
let lastRequestAt = 0;
const MIN_INTERVAL_MS = 60;
/** Diferença entre o relógio local e o da Binance, medida no boot. */
let clockOffsetMs = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  if (bannedUntil > now) {
    throw new BinanceError(
      `Limite de requisições atingido — liberado em ${Math.ceil((bannedUntil - now) / 1000)}s`,
      -1003,
      429,
    );
  }
  const wait = lastRequestAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  await throttle();
  const response = await fetch(url, init);

  if (response.status === 429 || response.status === 418) {
    const retryAfter = Number(response.headers.get('retry-after') ?? '30');
    bannedUntil = Date.now() + retryAfter * 1000;
    throw new BinanceError('Binance pediu para desacelerar (429/418)', -1003, response.status);
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new BinanceError(`Resposta inválida da Binance (${response.status})`, -1, response.status);
  }

  if (!response.ok) {
    const detail = payload as { code?: number; msg?: string } | null;
    throw new BinanceError(
      explicar(detail?.code ?? -1, detail?.msg ?? `Erro HTTP ${response.status} na Binance`),
      detail?.code ?? -1,
      response.status,
    );
  }
  return payload as T;
}

/**
 * A frase da Binance mais o que fazer com ela.
 *
 * "Invalid API-key, IP, or permissions for action" é literalmente três causas
 * numa frase só, e nenhuma delas diz onde clicar. O erro chega no pior
 * momento — depois de o usuário passar por todas as travas do painel e
 * confirmar a ordem — e a mensagem crua o deixa achando que a chave está
 * errada quando, na maioria das vezes, ela só não tem permissão de negociar.
 */
function explicar(code: number, mensagem: string): string {
  if (code === -2015) {
    return `${mensagem} — quase sempre é a permissão de negociação desligada na chave (Binance › Gerenciamento de API › "Habilitar Trading Spot e de Margem"), ou o IP desta máquina fora da lista permitida. Leitura funcionar não quer dizer que negociar funcione: são permissões separadas`;
  }
  if (code === -2010) {
    return `${mensagem} — a corretora recusou a ordem: normalmente saldo insuficiente no momento do envio ou preço fora do que o livro aceita`;
  }
  if (code === -1021) {
    return `${mensagem} — o relógio desta máquina está fora de sincronia com o da Binance`;
  }
  return mensagem;
}

/**
 * Os mesmos dados, endereços diferentes. Spot fala /api/v3 e futuros /fapi/v1;
 * o resto da leitura de mercado é idêntico, então o único lugar que precisa
 * saber da diferença é esta tabela.
 */
const PATHS: Record<MarketKind, Record<'ping' | 'time' | 'klines' | 'ticker24h' | 'exchangeInfo', string>> = {
  SPOT: {
    ping: '/api/v3/ping',
    time: '/api/v3/time',
    klines: '/api/v3/klines',
    ticker24h: '/api/v3/ticker/24hr',
    exchangeInfo: '/api/v3/exchangeInfo',
  },
  FUTURES: {
    ping: '/fapi/v1/ping',
    time: '/fapi/v1/time',
    klines: '/fapi/v1/klines',
    ticker24h: '/fapi/v1/ticker/24hr',
    exchangeInfo: '/fapi/v1/exchangeInfo',
  },
};

function endpoint(
  key: keyof (typeof PATHS)['SPOT'],
  environment: EnvironmentEndpoints = active,
): string {
  return PATHS[environment.market][key];
}

function publicUrl(
  path: string,
  params: Record<string, string | number | undefined> = {},
  environment: EnvironmentEndpoints = active,
): string {
  const query = buildQuery(params);
  return `${environment.marketRestBase}${path}${query ? `?${query}` : ''}`;
}

/**
 * O caminho DIZ a modalidade.
 *
 * `/fapi/...` só existe em futuros e `/api/v3/...` só existe em spot — não é
 * convenção, é o desenho da corretora. Deixar isso a cargo de quem chama era
 * pedir para esquecer: bastava a tela estar em futuros para a reconciliação
 * de uma posição de spot sair contra `fapi.binance.com`, receber erro e
 * congelar a operação no tempo. Inferir aqui torna o engano impossível.
 *
 * A REDE não muda: produção continua produção, testnet continua testnet.
 */
export function environmentForPath(path: string): EnvironmentEndpoints {
  return environmentFor(path.startsWith('/fapi') ? 'FUTURES' : 'SPOT');
}

/**
 * Chamada assinada. Só existe caminho para cá com credenciais configuradas.
 *
 * Exportada para que o módulo de futuros use exatamente o mesmo assinador, o
 * mesmo controle de ritmo e o mesmo ajuste de relógio: uma segunda cópia
 * disso é uma segunda chance de assinar errado.
 */
export async function signedRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  environment: EnvironmentEndpoints = environmentForPath(path),
): Promise<T> {
  const credentials = readCredentials(environment.name);
  if (!credentials) {
    throw new BinanceError('Credenciais da Binance não configuradas no servidor', -2015, 401);
  }
  const query = buildQuery({
    ...params,
    timestamp: Date.now() + clockOffsetMs,
    recvWindow: 5000,
  });
  const signature = signQuery(query, credentials.apiSecret);
  const url = `${environment.tradeRestBase}${path}?${query}&signature=${signature}`;
  return request<T>(url, {
    method,
    headers: { 'X-MBX-APIKEY': credentials.apiKey },
  });
}

export async function ping(): Promise<boolean> {
  try {
    await request(publicUrl(endpoint('ping')));
    return true;
  } catch (error) {
    logger.warn('Binance indisponível', { error: (error as Error).message });
    return false;
  }
}

/** Sincroniza o relógio: assinatura fora da janela é recusada com -1021. */
export async function syncClock(): Promise<number> {
  const before = Date.now();
  const result = await request<{ serverTime: number }>(publicUrl(endpoint('time')));
  const latency = (Date.now() - before) / 2;
  clockOffsetMs = Math.round(result.serverTime - (before + latency));
  if (Math.abs(clockOffsetMs) > 1000) {
    logger.warn('Relógio local fora de sincronia com a Binance', { clockOffsetMs });
  }
  return clockOffsetMs;
}

export function getClockOffset(): number {
  return clockOffsetMs;
}

export async function getKlines(
  symbol: string,
  interval: string,
  limit = 300,
): Promise<RawKline[]> {
  return request<RawKline[]>(publicUrl(endpoint('klines'), { symbol, interval, limit }));
}

export interface Ticker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}

let brlRate = { value: 0, fetchedAt: 0 };
const BRL_RATE_TTL_MS = 5 * 60 * 1000;

/**
 * Cotação USDT→BRL pelo próprio par da Binance. O motor opera em USDT; isto
 * existe só para o usuário informar e ler valores em reais.
 * Guarda a última cotação boa: se a chamada falhar, é melhor uma cotação de
 * minutos atrás do que um número inventado.
 */
export async function getUsdtBrlRate(): Promise<number | null> {
  if (brlRate.value > 0 && Date.now() - brlRate.fetchedAt < BRL_RATE_TTL_MS) return brlRate.value;
  try {
    const result = await request<{ price: string }>(
      `https://data-api.binance.vision/api/v3/ticker/price?symbol=USDTBRL`,
    );
    const value = Number(result.price);
    if (Number.isFinite(value) && value > 0) {
      brlRate = { value, fetchedAt: Date.now() };
      return value;
    }
  } catch (error) {
    logger.warn('Cotação USDT/BRL indisponível', { error: (error as Error).message });
  }
  return brlRate.value > 0 ? brlRate.value : null;
}

/** Acima deste tamanho a lista não cabe na URL (a Binance devolve 414). */
const TICKER_URL_LIMIT = 80;

export async function getTickers(symbols: string[]): Promise<Ticker24h[]> {
  if (symbols.length === 0) return [];

  // futuros não aceita a lista `symbols` no ticker: ou um par, ou o mercado
  // inteiro. Pedir a lista ali devolve 400, então o caminho é sempre o geral.
  if (symbols.length > TICKER_URL_LIMIT || active.market === 'FUTURES') {
    // uma chamada só para o mercado inteiro e filtragem local sai mais barato
    const all = await request<Ticker24h[]>(publicUrl(endpoint('ticker24h')));
    const wanted = new Set(symbols);
    return all.filter((ticker) => wanted.has(ticker.symbol));
  }

  const list = JSON.stringify(symbols);
  return request<Ticker24h[]>(publicUrl(endpoint('ticker24h'), { symbols: list }));
}

interface ExchangeInfoResponse {
  symbols: Array<{
    symbol: string;
    status: string;
    baseAsset: string;
    quoteAsset: string;
    baseAssetPrecision?: number;
    quotePrecision?: number;
    isSpotTradingAllowed?: boolean;
    otoAllowed?: boolean;
    ocoAllowed?: boolean;
    filters: Array<Record<string, string>>;
    permissionSets?: string[][];
    /** só futuros: PERPETUAL, CURRENT_QUARTER… */
    contractType?: string;
    /** só futuros: casas decimais aceitas em preço e quantidade */
    pricePrecision?: number;
    quantityPrecision?: number;
  }>;
}

/** exchangeInfo é pesado: fica em cache por 12h como manda o bom senso de rate limit. */
const exchangeInfoCache = new Map<string, { value: SymbolFilters; fetchedAt: number }>();
const universeCache = new Map<string, { symbols: SymbolFilters[]; fetchedAt: number }>();
const EXCHANGE_INFO_TTL_MS = 12 * 60 * 60 * 1000;
const pairStateCache = new Map<string, { symbols: SymbolFilters[]; fetchedAt: number }>();
/** Estado do par envelhece rápido: uma suspensão de 12h atrás não serve. */
const PAIR_STATE_TTL_MS = 5 * 60 * 1000;

/**
 * Filtros do par NA MODALIDADE PEDIDA.
 *
 * Passo de lote, tique e mínimo de nocional são diferentes em spot e em
 * futuros para o mesmo símbolo. Ler os de um e enviar ordem no outro produz
 * recusa da corretora no melhor caso — e quantidade arredondada errada no
 * pior. O cache é por ambiente, então os dois convivem sem se sobrescrever.
 */
export async function getSymbolFilters(
  symbols: string[],
  market?: MarketKind,
): Promise<Map<string, SymbolFilters>> {
  const environment = market ? environmentFor(market) : active;
  const now = Date.now();
  const result = new Map<string, SymbolFilters>();
  const missing: string[] = [];

  for (const symbol of symbols) {
    const cached = exchangeInfoCache.get(cacheKey(symbol, environment));
    if (cached && now - cached.fetchedAt < EXCHANGE_INFO_TTL_MS) result.set(symbol, cached.value);
    else missing.push(symbol);
  }
  if (missing.length === 0) return result;

  // spot filtra a consulta pelos pares pedidos; futuros não aceita o parâmetro
  // `symbols` e devolve o mercado inteiro — o cache logo abaixo é o que
  // impede que isso vire uma chamada pesada por par
  const info = await request<ExchangeInfoResponse>(
    environment.market === 'FUTURES'
      ? publicUrl(endpoint('exchangeInfo', environment), {}, environment)
      : publicUrl(endpoint('exchangeInfo', environment), { symbols: JSON.stringify(missing) }, environment),
  );

  const wanted = new Set(missing);
  for (const entry of info.symbols) {
    const value = toFilters(entry, environment);
    exchangeInfoCache.set(cacheKey(entry.symbol, environment), { value, fetchedAt: now });
    if (wanted.has(entry.symbol)) result.set(entry.symbol, value);
  }
  return result;
}

function cacheKey(symbol: string, environment: EnvironmentEndpoints = active): string {
  return `${environment.name}:${symbol}`;
}

function toFilters(
  entry: ExchangeInfoResponse['symbols'][number],
  environment: EnvironmentEndpoints = active,
): SymbolFilters {
  const filters = new Map(entry.filters.map((filter) => [filter.filterType as string, filter]));
  const priceFilter = filters.get('PRICE_FILTER');
  const notional = filters.get('NOTIONAL') ?? filters.get('MIN_NOTIONAL');
  const futures = environment.market === 'FUTURES';
  // em futuros o lote que vale para ordem a mercado é o MARKET_LOT_SIZE, que
  // costuma ser mais restrito que o LOT_SIZE do livro
  const lotSize = futures
    ? filters.get('MARKET_LOT_SIZE') ?? filters.get('LOT_SIZE')
    : filters.get('LOT_SIZE');
  const bookLot = filters.get('LOT_SIZE');
  return {
    symbol: entry.symbol,
    baseAsset: entry.baseAsset,
    quoteAsset: entry.quoteAsset,
    status: entry.status,
    tickSize: Number(priceFilter?.tickSize ?? '0.00000001'),
    stepSize: Number(lotSize?.stepSize ?? bookLot?.stepSize ?? '0.00000001'),
    minQty: Number(lotSize?.minQty ?? bookLot?.minQty ?? '0'),
    maxQty: Number(lotSize?.maxQty ?? bookLot?.maxQty ?? '0'),
    minNotional: Number(notional?.minNotional ?? notional?.notional ?? '0'),
    // futuros exige o mínimo também na ordem a mercado, e não declara a flag
    applyMinToMarket: futures ? true : (notional?.applyMinToMarket ?? 'true') !== 'false',
    baseAssetPrecision: entry.baseAssetPrecision ?? entry.quantityPrecision ?? 8,
    quotePrecision: entry.quotePrecision ?? entry.pricePrecision ?? 8,
    // em futuros não existe "negociação spot": o que vale é o contrato estar
    // negociando, e é isso que o campo passa a significar
    isSpotTradingAllowed: futures ? entry.status === 'TRADING' : entry.isSpotTradingAllowed ?? false,
    // futuros não tem OCO; a proteção é montada com duas ordens reduceOnly
    ocoAllowed: futures ? false : entry.ocoAllowed ?? true,
    market: environment.market,
  };
}

/**
 * exchangeInfo da modalidade ativa. Em spot dá para pedir só a permissão SPOT;
 * em futuros o endpoint não filtra nada e devolve todos os contratos.
 */
async function fetchExchangeInfo(
  environment: EnvironmentEndpoints = active,
): Promise<ExchangeInfoResponse> {
  return request<ExchangeInfoResponse>(
    environment.market === 'FUTURES'
      ? publicUrl(endpoint('exchangeInfo', environment), {}, environment)
      : publicUrl(endpoint('exchangeInfo', environment), { permissions: 'SPOT' }, environment),
  );
}

/** O par é negociável AGORA na modalidade pedida. */
function isTradable(
  entry: ExchangeInfoResponse['symbols'][number],
  environment: EnvironmentEndpoints = active,
): boolean {
  if (entry.status !== 'TRADING') return false;
  if (environment.market === 'FUTURES') {
    // só perpétuo: contrato com vencimento tem rolagem, e o motor não sabe rolar
    return entry.contractType === 'PERPETUAL';
  }
  return entry.isSpotTradingAllowed === true;
}

/**
 * Todos os pares negociáveis de uma moeda de cotação na modalidade ativa. É a
 * base do modo "universo": uma chamada de exchangeInfo (peso 20) por
 * ambiente, cacheada por 12h, alimenta a varredura de centenas de ativos.
 */
export async function listTradableSymbols(
  quoteAsset = 'USDT',
  market?: MarketKind,
): Promise<SymbolFilters[]> {
  const environment = market ? environmentFor(market) : active;
  const key = `${environment.name}:${quoteAsset}`;
  const cached = universeCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < EXCHANGE_INFO_TTL_MS) return cached.symbols;

  const info = await fetchExchangeInfo(environment);
  const symbols = info.symbols
    .filter((entry) => isTradable(entry, environment) && entry.quoteAsset === quoteAsset)
    .map((entry) => toFilters(entry, environment));

  universeCache.set(key, { symbols, fetchedAt: Date.now() });
  const now = Date.now();
  for (const value of symbols) {
    exchangeInfoCache.set(cacheKey(value.symbol, environment), { value, fetchedAt: now });
  }
  return symbols;
}

/**
 * Todos os pares de uma moeda de cotação COM o estado que a corretora declara,
 * inclusive os que não estão negociando.
 *
 * `listTradableSymbols` corta quem não é TRADING — é o que a varredura quer. O
 * monitor quer o contrário: é justamente o par suspenso que precisa aparecer,
 * porque sumir da lista e estar parado são notícias diferentes, e sem esta
 * leitura as duas ficariam indistinguíveis.
 */
export async function listPairsWithState(quoteAsset = 'USDT'): Promise<SymbolFilters[]> {
  const key = `${active.name}:${quoteAsset}:all`;
  const cached = pairStateCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PAIR_STATE_TTL_MS) return cached.symbols;

  const info = await fetchExchangeInfo();
  const symbols = info.symbols.filter((entry) => entry.quoteAsset === quoteAsset).map((entry) => toFilters(entry));
  pairStateCache.set(key, { symbols, fetchedAt: Date.now() });
  return symbols;
}

/** Busca pares por texto — usado pelo "+ Adicionar ativo" da watchlist. */
export async function searchSymbols(term: string, quoteAsset = 'USDT'): Promise<SymbolFilters[]> {
  const needle = term.trim().toUpperCase();
  const universe = await listTradableSymbols(quoteAsset);
  return universe
    .filter((entry) => entry.baseAsset.includes(needle) || entry.symbol.includes(needle))
    .sort((a, b) => a.symbol.length - b.symbol.length)
    .slice(0, 20);
}

// ---------------------------------------------------------------------------
// Endpoints assinados (conta e ordens)
// ---------------------------------------------------------------------------

export interface AccountBalance {
  asset: string;
  free: number;
  locked: number;
}

/**
 * Lê o saldo de um ambiente específico sem trocar o mercado ativo do robô.
 * Sem argumento, preserva o comportamento operacional: usa a conta do modo
 * atualmente selecionado.
 */
/** O que a chave PODE fazer, segundo a própria Binance. */
export interface ApiKeyPowers {
  /** a chave consegue enviar ordem de spot */
  canTrade: boolean;
  /** a chave está limitada a uma lista de IPs */
  ipRestricted: boolean;
  canFutures: boolean;
}

const powersCache = new Map<string, { value: ApiKeyPowers; fetchedAt: number }>();
const POWERS_TTL_MS = 5 * 60 * 1000;

/**
 * As permissões da chave, lidas na Binance.
 *
 * Existe porque "a chave funciona" e "a chave pode negociar" são coisas
 * diferentes, e o painel só descobria a diferença no -2015, depois de o
 * usuário atravessar todas as travas e confirmar uma ordem. Uma chave só de
 * leitura lê saldo, lê ordens, mostra tudo — e recusa a única coisa que
 * importa. Melhor dizer isso na tela de ajustes, em repouso.
 *
 * Null quando a leitura falha: não saber não é o mesmo que não poder, e
 * inventar um "não pode" a partir de um timeout seria pior que o silêncio.
 */
export async function getApiKeyPowers(
  environmentName?: BinanceEnvironment,
): Promise<ApiKeyPowers | null> {
  const environment = environmentName ? ENVIRONMENTS[environmentName] : environmentFor('SPOT');
  if (!environment.hasCredentials) return null;
  // o testnet não expõe o endpoint de restrições; lá a chave é sempre de teste
  if (environment.network === 'testnet') return null;

  const cached = powersCache.get(environment.name);
  if (cached && Date.now() - cached.fetchedAt < POWERS_TTL_MS) return cached.value;

  try {
    const raw = await signedRequest<{
      enableSpotAndMarginTrading?: boolean;
      ipRestrict?: boolean;
      enableFutures?: boolean;
    }>('GET', '/sapi/v1/account/apiRestrictions', {}, environment);
    const value: ApiKeyPowers = {
      canTrade: raw.enableSpotAndMarginTrading === true,
      ipRestricted: raw.ipRestrict === true,
      canFutures: raw.enableFutures === true,
    };
    powersCache.set(environment.name, { value, fetchedAt: Date.now() });
    return value;
  } catch (error) {
    logger.debug('Não foi possível ler as permissões da chave', {
      environment: environment.name,
      error: (error as Error).message,
    });
    return null;
  }
}

export async function getAccountBalances(environmentName?: BinanceEnvironment): Promise<AccountBalance[]> {
  // sem ambiente pedido, o spot da rede atual: `/api/v3/account` não existe
  // em futuros, e cair no ambiente ativo levaria a consulta para o lugar errado
  const environment = environmentName ? ENVIRONMENTS[environmentName] : environmentFor('SPOT');
  const account = await signedRequest<{
    balances: Array<{ asset: string; free: string; locked: string }>;
    canTrade: boolean;
  }>('GET', '/api/v3/account', { omitZeroBalances: true }, environment);
  return account.balances.map((balance) => ({
    asset: balance.asset,
    free: Number(balance.free),
    locked: Number(balance.locked),
  }));
}

export interface OrderResponse {
  symbol: string;
  orderId: number;
  orderListId: number;
  clientOrderId: string;
  transactTime?: number;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: string;
  type: string;
  side: string;
  fills?: Array<{ price: string; qty: string; commission: string; commissionAsset: string }>;
}

export interface NewOrderParams extends Record<string, string | number | boolean | undefined> {
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  quantity: string;
  price?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  newClientOrderId: string;
}

export async function newOrder(params: NewOrderParams): Promise<OrderResponse> {
  return signedRequest<OrderResponse>('POST', '/api/v3/order', {
    ...params,
    newOrderRespType: 'FULL',
  });
}

/** Valida a ordem na Binance sem enviá-la para o livro. */
export async function testOrder(params: NewOrderParams): Promise<void> {
  await signedRequest('POST', '/api/v3/order/test', params);
}

export interface OtocoParams {
  symbol: string;
  listClientOrderId: string;
  workingQuantity: string;
  workingPrice: string;
  pendingQuantity: string;
  /** preço do take profit (LIMIT_MAKER acima) */
  takeProfitPrice: string;
  /** gatilho do stop */
  stopPrice: string;
  /** preço limite do stop (um tick abaixo do gatilho evita ordem parada) */
  stopLimitPrice: string;
}

export interface OrderListResponse {
  orderListId: number;
  contingencyType: string;
  listStatusType: string;
  listOrderStatus: string;
  listClientOrderId: string;
  orders: Array<{ symbol: string; orderId: number; clientOrderId: string }>;
}

/**
 * Bracket real da Binance: a entrada LIMIT entra no livro e, quando preenchida
 * por completo, dispara automaticamente o par OCO de alvo e stop.
 * Endpoint atual (`/api/v3/orderList/otoco`) — o antigo `/api/v3/order/oco`
 * está marcado como deprecated na documentação oficial.
 */
export async function newOtocoOrder(params: OtocoParams): Promise<OrderListResponse> {
  return signedRequest<OrderListResponse>('POST', '/api/v3/orderList/otoco', {
    symbol: params.symbol,
    listClientOrderId: params.listClientOrderId,
    workingType: 'LIMIT',
    workingSide: 'BUY',
    workingPrice: params.workingPrice,
    workingQuantity: params.workingQuantity,
    workingTimeInForce: 'GTC',
    pendingSide: 'SELL',
    pendingQuantity: params.pendingQuantity,
    pendingAboveType: 'LIMIT_MAKER',
    pendingAbovePrice: params.takeProfitPrice,
    pendingBelowType: 'STOP_LOSS_LIMIT',
    pendingBelowStopPrice: params.stopPrice,
    pendingBelowPrice: params.stopLimitPrice,
    pendingBelowTimeInForce: 'GTC',
    newOrderRespType: 'RESULT',
  });
}

export interface OcoSellParams {
  symbol: string;
  listClientOrderId: string;
  quantity: string;
  /** preço do take profit (LIMIT_MAKER, acima do mercado) */
  takeProfitPrice: string;
  stopPrice: string;
  stopLimitPrice: string;
}

/**
 * Proteção de uma posição que JÁ existe: alvo e stop, os dois vendendo.
 *
 * Não confundir com o OTOCO. O OTOCO nasce com uma ordem de trabalho de
 * COMPRA — usá-lo para reposicionar o stop de uma posição aberta manda comprar
 * de novo, no preço do alvo, acima do mercado. Quando a posição já está na
 * mão, o que se envia é este OCO puro de venda.
 */
export async function newOcoSellOrder(params: OcoSellParams): Promise<OrderListResponse> {
  return signedRequest<OrderListResponse>('POST', '/api/v3/orderList/oco', {
    symbol: params.symbol,
    listClientOrderId: params.listClientOrderId,
    side: 'SELL',
    quantity: params.quantity,
    aboveType: 'LIMIT_MAKER',
    abovePrice: params.takeProfitPrice,
    belowType: 'STOP_LOSS_LIMIT',
    belowStopPrice: params.stopPrice,
    belowPrice: params.stopLimitPrice,
    belowTimeInForce: 'GTC',
    newOrderRespType: 'RESULT',
  });
}

/** Venda a mercado do que sobrou: usada quando a proteção não pôde ser recriada. */
export async function marketSell(symbol: string, quantity: string, clientOrderId: string): Promise<OrderResponse> {
  return signedRequest<OrderResponse>('POST', '/api/v3/order', {
    symbol,
    side: 'SELL',
    type: 'MARKET',
    quantity,
    newClientOrderId: clientOrderId,
    newOrderRespType: 'RESULT',
  });
}

export async function getOrder(symbol: string, origClientOrderId: string): Promise<OrderResponse> {
  return signedRequest<OrderResponse>('GET', '/api/v3/order', { symbol, origClientOrderId });
}

export async function getOrderById(symbol: string, orderId: string): Promise<OrderResponse> {
  return signedRequest<OrderResponse>('GET', '/api/v3/order', { symbol, orderId });
}

export async function getOpenOrders(symbol?: string): Promise<OrderResponse[]> {
  return signedRequest<OrderResponse[]>('GET', '/api/v3/openOrders', symbol ? { symbol } : {});
}

export async function cancelOrder(symbol: string, origClientOrderId: string): Promise<OrderResponse> {
  return signedRequest<OrderResponse>('DELETE', '/api/v3/order', { symbol, origClientOrderId });
}

export async function cancelOrderList(symbol: string, listClientOrderId: string): Promise<OrderListResponse> {
  return signedRequest<OrderListResponse>('DELETE', '/api/v3/orderList', { symbol, listClientOrderId });
}

export async function getOrderList(listClientOrderId: string): Promise<OrderListResponse> {
  return signedRequest<OrderListResponse>('GET', '/api/v3/orderList', { origClientOrderId: listClientOrderId });
}

/**
 * Chave do fluxo da conta.
 *
 * É o único grupo de endpoints assinado só pelo cabeçalho: não leva
 * assinatura HMAC nem timestamp. A chave morre em 60 minutos e precisa de
 * renovação — sem ela o socket fecha sozinho e as execuções passam a chegar
 * apenas pela reconciliação lenta.
 */
async function keyedRequest<T>(method: 'POST' | 'PUT' | 'DELETE', params: Record<string, string> = {}): Promise<T> {
  // `/api/v3/userDataStream` é spot; futuros tem endpoint e socket próprios.
  // O fluxo da conta é o atalho rápido para saber de um preenchimento — em
  // futuros ele ainda não existe, e quem cobre é a reconciliação por tempo
  const environment = environmentFor('SPOT');
  const credentials = readCredentials(environment.name);
  if (!credentials) {
    throw new BinanceError('Credenciais da Binance não configuradas no servidor', -2015, 401);
  }
  const query = buildQuery(params);
  const url = `${environment.tradeRestBase}/api/v3/userDataStream${query ? `?${query}` : ''}`;
  return request<T>(url, { method, headers: { 'X-MBX-APIKEY': credentials.apiKey } });
}

export async function createListenKey(): Promise<string> {
  const result = await keyedRequest<{ listenKey: string }>('POST');
  return result.listenKey;
}

export async function keepAliveListenKey(listenKey: string): Promise<void> {
  await keyedRequest('PUT', { listenKey });
}

export async function closeListenKey(listenKey: string): Promise<void> {
  await keyedRequest('DELETE', { listenKey });
}

export function parseKline(raw: RawKline, closed: boolean) {
  return {
    openTime: raw[0],
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close: Number(raw[4]),
    volume: Number(raw[5]),
    closeTime: raw[6],
    quoteVolume: Number(raw[7]),
    closed,
  };
}
