import type { MarketKind, SymbolFilters } from '../../core/types.ts';
import {
  ENVIRONMENTS,
  readCredentials,
  type BinanceEnvironment,
  type EnvironmentEndpoints,
} from '../config.ts';
import { logger } from '../logger.ts';
import { buildQuery, signQuery } from './signer.ts';
import { wsApiCall } from './wsApi.ts';

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
/**
 * 480 chamadas/minuto deixam folga para o peso 2 dos candles e para chamadas
 * mais caras (exchangeInfo/ticker). Sessenta ms permitiam ~1.000 chamadas —
 * mas não ~1.000 de peso — e o scanner atravessava a cota mesmo sem erro de
 * concorrência.
 */
const MIN_INTERVAL_MS = 125;
/** Diferença entre o relógio local e o da Binance, remedida quando erra. */
let clockOffsetMs = 0;
/**
 * Folga do carimbo, em ms.
 *
 * Adiantar é recusado (-1021); atrasar cabe no `recvWindow`. Meio segundo
 * atrás cobre a deriva normal de um relógio de máquina entre duas medições.
 */
const MARGEM_DE_RELOGIO_MS = 500;
/**
 * Teto da folga. Acima disto o carimbo começa a se aproximar da outra borda
 * do `recvWindow` de 5 s, e o remédio viraria a doença.
 */
const TETO_DA_MARGEM_MS = 2_500;
/** Folga em uso agora: cresce quando a última medição veio com muita latência. */
let clockMarginMs = MARGEM_DE_RELOGIO_MS;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

interface RequestJob {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/*
 * Uma fila de verdade, não apenas um `sleep` antes de cada chamada.
 *
 * Antes, todas as centenas de promises do scanner liam o mesmo
 * `lastRequestAt`, dormiam juntas e acordavam juntas: o suposto limitador
 * criava a própria rajada. A fila mantém uma única chamada HTTP em voo e dá
 * prioridade a saldo, proteção e ordens assinadas; assim uma ordem nunca fica
 * atrás de centenas de candles já enfileirados.
 */
const signedQueue: RequestJob[] = [];
/**
 * A fila de quem está esperando na tela.
 *
 * Havia duas pistas: assinada (ordem, saldo, proteção) e pública. O scanner
 * varre centenas de pares e enche a pública de candles — então o gráfico que
 * o usuário acabou de abrir e a cotação que a Carteira precisa entravam ATRÁS
 * de uma varredura inteira. Medido em 26/08/2026: a Carteira levava de 1,3 a
 * 26 segundos, e o gráfico do modal abria vazio.
 *
 * Esta pista fica no meio. Não fura a assinada — dinheiro na frente de tudo —
 * mas passa na frente do trabalho de fundo, que é justamente o que pode
 * esperar: ninguém está olhando para a varredura.
 */
const viewQueue: RequestJob[] = [];
const publicQueue: RequestJob[] = [];
let drainingRequests = false;

function isSignedOrMutating(init: RequestInit): boolean {
  const headers = new Headers(init.headers);
  return headers.has('X-MBX-APIKEY') || (init.method !== undefined && init.method !== 'GET');
}

type RequestPriority = 'SIGNED' | 'VIEW' | 'PUBLIC';

const QUEUES: Record<RequestPriority, RequestJob[]> = {
  SIGNED: signedQueue,
  VIEW: viewQueue,
  PUBLIC: publicQueue,
};

function enqueueRequest<T>(run: () => Promise<T>, priority: RequestPriority): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const job: RequestJob = {
      run,
      resolve: (value) => resolve(value as T),
      reject,
    };
    QUEUES[priority].push(job);
    void drainRequestQueue();
  });
}

async function waitForRequestWindow(): Promise<void> {
  const wait = Math.max(bannedUntil, lastRequestAt + MIN_INTERVAL_MS) - Date.now();
  if (wait > 0) await delay(wait);
  lastRequestAt = Date.now();
}

async function drainRequestQueue(): Promise<void> {
  if (drainingRequests) return;
  drainingRequests = true;
  try {
    while (signedQueue.length > 0 || viewQueue.length > 0 || publicQueue.length > 0) {
      // A ordem das pistas é a ordem de quem não pode esperar: dinheiro, tela,
      // trabalho de fundo. Nenhuma interrompe a única chamada que já começou —
      // na prática o atraso de uma ordem é <= 1 HTTP.
      const job = signedQueue.shift() ?? viewQueue.shift() ?? publicQueue.shift();
      if (!job) continue;
      await waitForRequestWindow();
      try {
        job.resolve(await job.run());
      } catch (error) {
        job.reject(error);
      }
    }
  } finally {
    drainingRequests = false;
    // Cobre o caso raro de uma chamada entrar entre o último `while` e o
    // `finally`; `enqueueRequest` viu a fila como ocupada e não abriu outra.
    if (signedQueue.length > 0 || viewQueue.length > 0 || publicQueue.length > 0) {
      void drainRequestQueue();
    }
  }
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get('retry-after');
  if (!raw) return 30_000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? 30_000 : Math.max(1_000, date - Date.now());
}

async function performRequest<T>(url: string, init: RequestInit): Promise<T> {
  let response = await fetch(url, init);

  if (response.status === 429 || response.status === 418) {
    const wait = retryAfterMs(response);
    bannedUntil = Math.max(bannedUntil, Date.now() + wait);
    logger.warn('Binance pediu para desacelerar; aguardando e repetindo uma vez', {
      status: response.status,
      waitMs: wait,
    });
    // O bloqueio é global. Permanecer dentro deste job impede que outras
    // chamadas escapem durante o Retry-After e evita despejar 503 na tela.
    await waitForRequestWindow();
    response = await fetch(url, init);
  }

  if (response.status === 429 || response.status === 418) {
    const wait = retryAfterMs(response);
    bannedUntil = Math.max(bannedUntil, Date.now() + wait);
    throw new BinanceError(
      'A Binance continuou limitando após a espera automática; a fila permanecerá pausada',
      -1003,
      response.status,
    );
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
      explicar(detail?.code ?? -1, detail?.msg ?? `Erro HTTP ${response.status} na Binance`, url),
      detail?.code ?? -1,
      response.status,
    );
  }
  return payload as T;
}

async function request<T>(
  url: string,
  init: RequestInit = {},
  /** 'VIEW' para o que alguém está esperando aparecer na tela */
  priority: RequestPriority = 'PUBLIC',
): Promise<T> {
  return enqueueRequest(
    () => performRequest<T>(url, init),
    isSignedOrMutating(init) ? 'SIGNED' : priority,
  );
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
function explicar(code: number, mensagem: string, url = ''): string {
  if (code === -2015) {
    // a permissão que falta é a DA MODALIDADE que foi chamada: mandar alguém
    // ligar "Trading Spot" para destravar futuros é enviá-lo ao lugar errado
    const futuros = url.includes('/fapi/') || url.includes('fapi.binance');
    const onde = futuros
      ? 'Binance › Gerenciamento de API › "Habilitar Futuros"'
      : 'Binance › Gerenciamento de API › "Habilitar Trading Spot e de Margem"';
    return `${mensagem} — quase sempre é a permissão ${futuros ? 'de FUTUROS' : 'de negociação'} desligada na chave (${onde}), ou o IP desta máquina fora da lista permitida. Leitura funcionar não quer dizer que negociar funcione: são permissões separadas`;
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
const PATHS: Record<
  MarketKind,
  Record<'ping' | 'time' | 'klines' | 'ticker24h' | 'exchangeInfo' | 'depth', string>
> = {
  SPOT: {
    ping: '/api/v3/ping',
    time: '/api/v3/time',
    klines: '/api/v3/klines',
    ticker24h: '/api/v3/ticker/24hr',
    exchangeInfo: '/api/v3/exchangeInfo',
    depth: '/api/v3/depth',
  },
  FUTURES: {
    ping: '/fapi/v1/ping',
    time: '/fapi/v1/time',
    klines: '/fapi/v1/klines',
    ticker24h: '/fapi/v1/ticker/24hr',
    exchangeInfo: '/fapi/v1/exchangeInfo',
    depth: '/fapi/v1/depth',
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

  const enviar = async (): Promise<T> => {
    const query = buildQuery({
      ...params,
      /*
       * O carimbo sai de propósito um pouco ATRASADO.
       *
       * As duas direções não são simétricas na Binance: adiantar mais de
       * 1000 ms é recusado na hora (-1021), enquanto atrasar é aceito até o
       * `recvWindow` inteiro — cinco segundos. Ficar de propósito um pouco
       * atrás troca uma falha por folga, e não custa nada. A folga é meio
       * segundo quando a última medição do relógio veio limpa e cresce com a
       * latência dela: quanto menos certeza, mais atrás fica o carimbo.
       */
      timestamp: Date.now() + clockOffsetMs - clockMarginMs,
      recvWindow: 5000,
    });
    const signature = signQuery(query, credentials.apiSecret);
    const url = `${environment.tradeRestBase}${path}?${query}&signature=${signature}`;
    return request<T>(url, { method, headers: { 'X-MBX-APIKEY': credentials.apiKey } });
  };

  try {
    return await enviar();
  } catch (error) {
    /*
     * Relógio fora de hora não pode derrubar a chamada.
     *
     * O ajuste era medido UMA VEZ, no boot, e nunca mais: o relógio da
     * máquina anda sozinho e horas depois o desvio volta. Em 26/08/2026 isso
     * derrubou `GET /api/equity` — a carteira inteira sumiu da tela porque o
     * carimbo estava 1 segundo à frente.
     *
     * Aqui a recusa vira o gatilho da remedição: pergunta a hora à corretora,
     * corrige o desvio e tenta de novo, uma vez. Se falhar de novo, aí sim é
     * problema de verdade e sobe.
     */
    if (error instanceof BinanceError && error.code === -1021) {
      logger.warn('Carimbo recusado pela Binance — remedindo o relógio e repetindo', {
        desvioAnterior: clockOffsetMs,
      });
      await remedirRelogio();
      return enviar();
    }
    throw error;
  }
}

/**
 * Remedição compartilhada.
 *
 * Um desvio errado recusa TODAS as chamadas assinadas ao mesmo tempo, e cada
 * uma pedia a própria medição: uma dúzia de leituras simultâneas de `/time`,
 * cada uma com três amostras, para descobrir o mesmo número. Quem chega
 * durante uma medição em curso espera por ela; logo depois de uma, aproveita
 * o resultado que acabou de chegar.
 */
let medicaoEmCurso: Promise<unknown> | null = null;
let ultimaMedicaoEm = 0;
const INTERVALO_MINIMO_DE_MEDICAO_MS = 5_000;

async function remedirRelogio(): Promise<void> {
  if (medicaoEmCurso) {
    await medicaoEmCurso;
    return;
  }
  if (Date.now() - ultimaMedicaoEm < INTERVALO_MINIMO_DE_MEDICAO_MS) return;
  medicaoEmCurso = syncClock()
    .catch(() => undefined)
    .finally(() => {
      ultimaMedicaoEm = Date.now();
      medicaoEmCurso = null;
    });
  await medicaoEmCurso;
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

/**
 * Sincroniza o relógio: assinatura fora da janela é recusada com -1021.
 *
 * A medição NÃO passa pela fila de requisições, e é isso que a conserta. Por
 * `request()` ela entrava na pista pública ATRÁS da varredura do universo —
 * centenas de candles a 125 ms cada. O `before` era carimbado ao ENTRAR na
 * fila e o `serverTime` chegava segundos depois, então o tempo de espera na
 * própria fila virava "desvio do relógio". Em 27/08/2026 isso produziu
 * desvios medidos de +6,8 s a +8,2 s numa máquina sincronizada: o painel
 * passou a assinar com carimbo no FUTURO e a Binance recusou tudo com -1021,
 * inclusive a proteção de uma posição real já aberta.
 *
 * Três amostras, e vale a de menor ida-e-volta. Tirada a fila do caminho, o
 * único erro que sobra é a assimetria da latência — e a amostra mais rápida é
 * a menos contaminada por ela.
 */
export async function syncClock(): Promise<number> {
  const url = publicUrl(endpoint('time'));
  let melhor: { offset: number; roundTrip: number } | null = null;

  for (let amostra = 0; amostra < 3; amostra += 1) {
    try {
      const before = Date.now();
      const response = await fetch(url);
      const roundTrip = Date.now() - before;
      if (!response.ok) continue;
      const { serverTime } = (await response.json()) as { serverTime?: number };
      if (!Number.isFinite(serverTime)) continue;
      const offset = Math.round((serverTime as number) - (before + roundTrip / 2));
      if (melhor === null || roundTrip < melhor.roundTrip) melhor = { offset, roundTrip };
      // amostra boa o bastante: insistir só adicionaria ruído
      if (roundTrip <= 150) break;
    } catch {
      // uma amostra perdida na rede não invalida as outras
    }
  }

  if (melhor === null) {
    throw new BinanceError('Não foi possível ler a hora da Binance', -1, 503);
  }

  clockOffsetMs = melhor.offset;
  /*
   * A folga do carimbo cresce com a incerteza da medição.
   *
   * Meia ida-e-volta é o erro máximo que a assimetria de latência pode ter
   * introduzido. Como adiantar é recusado na hora e atrasar cabe no
   * `recvWindow` inteiro, a folga passa a ser sempre maior que esse erro: uma
   * medição ruim atrasa o carimbo em vez de adiantá-lo.
   */
  clockMarginMs = Math.min(
    Math.max(MARGEM_DE_RELOGIO_MS, Math.round(melhor.roundTrip / 2) + 100),
    TETO_DA_MARGEM_MS,
  );
  if (Math.abs(clockOffsetMs) > 1000) {
    logger.warn('Relógio local fora de sincronia com a Binance', {
      clockOffsetMs,
      idaEVoltaMs: melhor.roundTrip,
      margemMs: clockMarginMs,
    });
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
  /**
   * true quando é o gráfico de alguém que está olhando a tela agora. A
   * varredura pede os mesmos candles às centenas; sem esta distinção, abrir um
   * gráfico significava esperar a varredura inteira terminar e a janela abria
   * vazia.
   */
  paraTela = false,
): Promise<RawKline[]> {
  return request<RawKline[]>(
    publicUrl(endpoint('klines'), { symbol, interval, limit }),
    {},
    paraTela ? 'VIEW' : 'PUBLIC',
  );
}

export interface OrderBook {
  symbol: string;
  /** [preço, quantidade], do melhor para o pior */
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

interface RawDepth {
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
}

/**
 * O livro de ofertas — a única fonte honesta de spread e escorregamento.
 *
 * O resto do sistema trabalhava com escorregamento DECLARADO nas
 * Configurações, e para tese de horas isso basta. O micro scalp não pode:
 * ali o custo é o termo dominante, e um número igual para todos os pares
 * erraria nos dois sentidos — o BTC tem spread zero e uma altcoin de book
 * raso engole 0,3% numa ordem de US$ 50.
 *
 * `limit` de 100 níveis pesa 5 na cota da Binance (contra 2 de um klines).
 * É pouco, mas multiplica por par: por isso só o universo de scalp é medido,
 * e a cada poucos minutos, nunca a cada varredura.
 */
export async function getOrderBook(symbol: string, limit = 100): Promise<OrderBook> {
  const raw = await request<RawDepth>(publicUrl(endpoint('depth'), { symbol, limit }));
  return {
    symbol,
    bids: raw.bids.map(([price, qty]) => [Number(price), Number(qty)] as [number, number]),
    asks: raw.asks.map(([price, qty]) => [Number(price), Number(qty)] as [number, number]),
  };
}

export interface Ticker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}

let brlRate = { value: 0, fetchedAt: 0 };
let brlRateInFlight: Promise<number | null> | null = null;
const BRL_RATE_TTL_MS = 5 * 60 * 1000;

/**
 * Cotação USDT→BRL pelo próprio par da Binance. O motor opera em USDT; isto
 * existe só para o usuário informar e ler valores em reais.
 * Guarda a última cotação boa: se a chamada falhar, é melhor uma cotação de
 * minutos atrás do que um número inventado.
 */
export async function getUsdtBrlRate(): Promise<number | null> {
  if (brlRate.value > 0 && Date.now() - brlRate.fetchedAt < BRL_RATE_TTL_MS) return brlRate.value;
  if (brlRateInFlight) return brlRateInFlight;
  brlRateInFlight = (async () => {
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
  })().finally(() => {
    brlRateInFlight = null;
  });
  return brlRateInFlight;
}

/** Acima deste tamanho a lista não cabe na URL (a Binance devolve 414). */
const TICKER_URL_LIMIT = 80;

export async function getTickers(
  symbols: string[],
  priority: RequestPriority = 'PUBLIC',
): Promise<Ticker24h[]> {
  if (symbols.length === 0) return [];

  // futuros não aceita a lista `symbols` no ticker: ou um par, ou o mercado
  // inteiro. Pedir a lista ali devolve 400, então o caminho é sempre o geral.
  if (symbols.length > TICKER_URL_LIMIT || active.market === 'FUTURES') {
    // uma chamada só para o mercado inteiro e filtragem local sai mais barato
    const all = await request<Ticker24h[]>(publicUrl(endpoint('ticker24h')), {}, priority);
    const wanted = new Set(symbols);
    return all.filter((ticker) => wanted.has(ticker.symbol));
  }

  const list = JSON.stringify(symbols);
  return request<Ticker24h[]>(
    publicUrl(endpoint('ticker24h'), { symbols: list }),
    {},
    priority,
  );
}

/**
 * Preço de referência para a TELA, com memória curta.
 *
 * A fila de chamadas públicas é uma só e o scanner a mantém cheia de candles:
 * medido em 26/08/2026, a Carteira levava de 1,3 a 26 segundos para responder
 * porque os seus dois `getTickers` esperavam centenas de candles já
 * enfileirados. E a tela pede a Carteira a cada 5 segundos — as respostas
 * chegavam depois do pedido seguinte, e o painel inteiro parecia travado.
 *
 * Quinze segundos de memória cortam isso pela raiz: várias voltas da tela
 * passam a custar UMA chamada. O preço vivo continua vindo do WebSocket; isto
 * aqui só cobre os pares que não estão nele — posição fora da watchlist e
 * moeda parada na conta —, onde quinze segundos de idade não mudam decisão
 * nenhuma. Ordem e proteção nunca leem daqui: elas usam `getTickers` direto.
 */
const TICKER_VIEW_TTL_MS = 15_000;
const tickerViewCache = new Map<string, { at: number; value: Ticker24h }>();
let tickerViewInFlight: Promise<Ticker24h[]> | null = null;
let tickerViewPending: string[] = [];

export async function getTickersForView(symbols: string[]): Promise<Ticker24h[]> {
  if (symbols.length === 0) return [];
  const now = Date.now();
  const fresh: Ticker24h[] = [];
  const missing: string[] = [];
  for (const symbol of new Set(symbols)) {
    const cached = tickerViewCache.get(symbol);
    if (cached && now - cached.at < TICKER_VIEW_TTL_MS) fresh.push(cached.value);
    else missing.push(symbol);
  }
  if (missing.length === 0) return fresh;

  // uma busca por vez: cinco pares faltando não viram cinco chamadas, e o
  // pedido que chega no meio de uma busca espera por ela em vez de abrir outra
  tickerViewPending = [...new Set([...tickerViewPending, ...missing])];
  if (tickerViewInFlight === null) {
    const wanted = tickerViewPending;
    tickerViewPending = [];
    tickerViewInFlight = getTickers(wanted, 'VIEW').finally(() => {
      tickerViewInFlight = null;
    });
  }
  const loaded = await tickerViewInFlight.catch(() => [] as Ticker24h[]);
  const at = Date.now();
  for (const ticker of loaded) tickerViewCache.set(ticker.symbol, { at, value: ticker });

  const wanted = new Set(missing);
  return [...fresh, ...loaded.filter((ticker) => wanted.has(ticker.symbol))];
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
/**
 * Vai pela pista da tela, e não é privilégio: é dependência.
 *
 * Este é o catálogo do mercado inteiro, cacheado por 12 horas — uma chamada
 * por reinício. Só que meio painel espera por ele (a Carteira precisa dele
 * para saber que par cotar cada moeda parada), e na pista de fundo ele saía
 * atrás de uma varredura inteira: medido em 26/08/2026, a Carteira levava 9,9
 * segundos na primeira volta depois do reinício, e a tela pede a Carteira a
 * cada 5. Uma chamada rara da qual muita coisa depende não pertence à fila do
 * trabalho de fundo.
 */
async function fetchExchangeInfo(
  environment: EnvironmentEndpoints = active,
): Promise<ExchangeInfoResponse> {
  return request<ExchangeInfoResponse>(
    environment.market === 'FUTURES'
      ? publicUrl(endpoint('exchangeInfo', environment), {}, environment)
      : publicUrl(endpoint('exchangeInfo', environment), { permissions: 'SPOT' }, environment),
    {},
    'VIEW',
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

  /*
   * A pergunta é feita no host de SPOT, sempre.
   *
   * `/sapi/v1/account/apiRestrictions` não existe em `fapi.binance.com`: pedir
   * as permissões no ambiente de futuros dava erro, o erro virava `null`, e
   * `null` significa "não sei" — então o aviso "esta chave NÃO pode operar
   * futuros" nunca aparecia justamente na chave que não pode. A resposta é a
   * mesma para as duas modalidades (ela traz `enableFutures`); o que muda é só
   * onde se pergunta.
   */
  // a rede já está garantida como produção pela saída acima
  const consulta = environment.market === 'FUTURES' ? ENVIRONMENTS.production : environment;
  if (!consulta.hasCredentials) return null;

  try {
    const raw = await signedRequest<{
      enableSpotAndMarginTrading?: boolean;
      ipRestrict?: boolean;
      enableFutures?: boolean;
    }>('GET', '/sapi/v1/account/apiRestrictions', {}, consulta);
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

/**
 * Memória curtíssima do saldo.
 *
 * O caminho de uma ordem pergunta o saldo duas vezes: uma na prévia, para
 * montar a conta que o usuário aprova, e outra na execução, para conferir que
 * a conta ainda vale. São ~300 ms cada, separados por segundos — e o segundo
 * pedido quase sempre recebe exatamente o mesmo número.
 *
 * Dois segundos é o prazo porque este cache NÃO pode atrasar a notícia que
 * importa: o saldo depois de um preenchimento. Quem empurra o saldo para a
 * tela chama `invalidateAccountCache()` antes de ler, então o número que o
 * usuário vê continua vindo fresco da corretora.
 */
const ACCOUNT_CACHE_TTL_MS = 2_000;
const accountCache = new Map<BinanceEnvironment, { at: number; value: AccountBalance[] }>();
const accountInFlight = new Map<BinanceEnvironment, Promise<AccountBalance[]>>();

export function invalidateAccountCache(): void {
  accountCache.clear();
}

export async function getAccountBalances(environmentName?: BinanceEnvironment): Promise<AccountBalance[]> {
  // sem ambiente pedido, o spot da rede atual: `/api/v3/account` não existe
  // em futuros, e cair no ambiente ativo levaria a consulta para o lugar errado
  const environment = environmentName ? ENVIRONMENTS[environmentName] : environmentFor('SPOT');
  const cached = accountCache.get(environment.name);
  if (cached && Date.now() - cached.at < ACCOUNT_CACHE_TTL_MS) return cached.value;
  const existing = accountInFlight.get(environment.name);
  if (existing) return existing;
  const loading = (async () => {
    const account = await signedRequest<{
      balances: Array<{ asset: string; free: string; locked: string }>;
      canTrade: boolean;
    }>('GET', '/api/v3/account', { omitZeroBalances: true }, environment);
    const balances = account.balances.map((balance) => ({
      asset: balance.asset,
      free: Number(balance.free),
      locked: Number(balance.locked),
    }));
    accountCache.set(environment.name, { at: Date.now(), value: balances });
    return balances;
  })().finally(() => accountInFlight.delete(environment.name));
  accountInFlight.set(environment.name, loading);
  return loading;
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

export interface MyTrade {
  id: number;
  orderId: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
}

/**
 * Os negócios REALMENTE executados no par — a verdade da corretora.
 *
 * A reconciliação por ordem só enxerga ordem que este servidor lembra. Basta
 * a proteção nascer e o id dela não ser gravado (ou alguém vender pelo app da
 * Binance) para a posição sumir da conta sem o painel notar: ele segue
 * mostrando aberta uma posição que já foi encerrada, e soma o valor dela ao
 * patrimônio. Aqui a pergunta muda de "o que aconteceu com as ordens que eu
 * conheço?" para "o que aconteceu neste par?".
 */
export async function getMyTrades(symbol: string, limit = 50): Promise<MyTrade[]> {
  return signedRequest<MyTrade[]>('GET', '/api/v3/myTrades', { symbol, limit });
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

/**
 * Cancela TUDO que estiver aberto no par — o único jeito confiável de soltar
 * a moeda antes de vender.
 *
 * Cancelar por lista depende de o servidor lembrar QUAL lista segura a
 * posição, e essa lembrança falha: a proteção rearmada nasce com ids novos
 * que nem sempre chegam ao banco, e o usuário pode ter criado ordem pelo app
 * da Binance. O sintoma é sempre o mesmo — "Saldo insuficiente para vender"
 * com a moeda inteira presa numa ordem que ninguém cancelou.
 *
 * Aqui a pergunta deixa de ser "qual ordem eu criei?" e passa a ser "o que
 * está aberto neste par?". Encerrar uma posição é justamente o momento em que
 * nada deve continuar no livro.
 */
export async function cancelAllOpenOrders(symbol: string): Promise<void> {
  await signedRequest('DELETE', '/api/v3/openOrders', { symbol });
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
/**
 * O endereço da chave, por modalidade. Separado da chamada de propósito: é a
 * escolha que estava errada, e é a única parte disto que dá para provar sem
 * abrir socket nem gastar peso de requisição na corretora.
 */
export function listenKeyPath(market: MarketKind): string {
  return market === 'FUTURES' ? '/fapi/v1/listenKey' : '/api/v3/userDataStream';
}

async function keyedRequest<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  params: Record<string, string> = {},
  market: MarketKind = 'SPOT',
): Promise<T> {
  /*
   * Cada modalidade tem o SEU fluxo de conta.
   *
   * `/api/v3/userDataStream` é spot e `/fapi/v1/listenKey` é futuros — chaves
   * diferentes, sockets diferentes, contas diferentes. Enquanto isto pedia
   * sempre a chave do spot, o fluxo de futuros simplesmente não existia: a
   * posição preenchia na corretora e o painel só descobria na volta seguinte
   * da reconciliação, com a ordem parada em AGUARDANDO no meio tempo.
   *
   * Em futuros a chave é da CONTA, não da ordem: renovar e encerrar não levam
   * o listenKey na query, e mandá-lo ali é ignorado.
   */
  const environment = environmentFor(market);
  const credentials = readCredentials(environment.name);
  if (!credentials) {
    throw new BinanceError('Credenciais da Binance não configuradas no servidor', -2015, 401);
  }
  const path = listenKeyPath(market);
  const query = market === 'FUTURES' ? '' : buildQuery(params);
  const url = `${environment.tradeRestBase}${path}${query ? `?${query}` : ''}`;
  return request<T>(url, { method, headers: { 'X-MBX-APIKEY': credentials.apiKey } });
}

/*
 * SPOT pede a chave pela WebSocket API; FUTUROS continua no REST.
 *
 * `POST /api/v3/userDataStream` foi REMOVIDO pela Binance: responde `410 Gone`
 * numa página HTML do nginx. Como não é JSON, nem código de erro havia — a
 * abertura do fluxo falhava calada, o painel ficava sem aviso de execução em
 * tempo real, e a ordem preenchida na corretora só aparecia na volta seguinte
 * da reconciliação. O substituto é `userDataStream.start` na WebSocket API; o
 * socket da conta continua em `stream.binance.com`, com a mesma chave.
 *
 * `/fapi/v1/listenKey` segue de pé, e é por ele que futuros continua.
 */
export function listenKeySource(market: MarketKind, wsApiBase: string): 'WS_API' | 'REST' {
  return market === 'SPOT' && wsApiBase !== '' ? 'WS_API' : 'REST';
}

function usaWebSocketApi(market: MarketKind): boolean {
  return listenKeySource(market, environmentFor('SPOT').wsApiBase) === 'WS_API';
}

export async function createListenKey(market: MarketKind = 'SPOT'): Promise<string> {
  if (usaWebSocketApi(market)) {
    const result = await wsApiCall<{ listenKey: string }>(
      'userDataStream.start',
      {},
      environmentFor('SPOT'),
    );
    return result.listenKey;
  }
  const result = await keyedRequest<{ listenKey: string }>('POST', {}, market);
  return result.listenKey;
}

export async function keepAliveListenKey(listenKey: string, market: MarketKind = 'SPOT'): Promise<void> {
  if (usaWebSocketApi(market)) {
    await wsApiCall('userDataStream.ping', { listenKey }, environmentFor('SPOT'));
    return;
  }
  await keyedRequest('PUT', { listenKey }, market);
}

export async function closeListenKey(listenKey: string, market: MarketKind = 'SPOT'): Promise<void> {
  if (usaWebSocketApi(market)) {
    await wsApiCall('userDataStream.stop', { listenKey }, environmentFor('SPOT'));
    return;
  }
  await keyedRequest('DELETE', { listenKey }, market);
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
