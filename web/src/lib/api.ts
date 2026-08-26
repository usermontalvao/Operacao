import type {
  AlertRecord,
  AppSettings,
  AuditEntry,
  Candle,
  DashboardSnapshot,
  DecisionRecord,
  EquityPoint,
  EntryDecisionRecord,
  FactorPerformance,
  FunnelStage,
  MarketKind,
  ModeSettings,
  PerformanceStats,
  Side,
  Timeframe,
  Trade,
  TradeSetup,
} from './types.ts';
import { announceSessionLost } from './auth.ts';

export interface SettingsResponse extends AppSettings {
  store: string;
  /**
   * O que cada conta tem guardado NA MODALIDADE EM EXIBIÇÃO — risco, robô e
   * disjuntor são de cada conta, e agora também de cada modalidade.
   */
  byMode: Record<AppSettings['mode'], ModeSettings>;
  /** os dois conjuntos completos, para a tela comparar spot e futuros */
  byMarket: Record<MarketKind, Record<AppSettings['mode'], ModeSettings>>;
  binance: {
    activeEnvironment: 'production' | 'testnet' | 'futures-production' | 'futures-testnet';
    production: { credentialsConfigured: boolean; balance: BinanceBalanceSummary };
    testnet: { credentialsConfigured: boolean; balance: BinanceBalanceSummary };
    futuresProduction: { credentialsConfigured: boolean; balance: BinanceBalanceSummary };
    futuresTestnet: { credentialsConfigured: boolean; balance: BinanceBalanceSummary };
  };
  universe: {
    enabled: boolean;
    total: number;
    liquid: number;
    cursor: number;
    scannedThisCycle: number;
    lastCycleSeconds: number | null;
    lastError: string | null;
    updatedAt: string | null;
  };
}

export interface BinanceBalanceSummary {
  status: 'AVAILABLE' | 'NOT_CONFIGURED' | 'UNAVAILABLE';
  total: number | null;
  available: number | null;
  locked: number | null;
  brlRate: number | null;
}

export interface SystemHealth {
  persistencia: { tipo: string; disponivel: boolean; erro: string | null };
  binance: {
    ambienteAtivo: string;
    ambienteEsperado: string;
    publicaDisponivel: boolean;
    streamPrecos: string;
  };
  dados: {
    tick: { level: string; ageMs: number | null; at: string | null; blocksTrading: boolean };
    scan: { level: string; ageMs: number | null; at: string | null; blocksTrading: boolean };
  };
  sessoes: Array<{
    mode: AppSettings['mode'];
    emExibicao: boolean;
    robo: string;
    armadoAte: string | null;
    posicoesAbertas: number;
    disjuntorSilenciadoAte: string | null;
    descansos: Array<{ symbol: string; until: string; remainingMinutes: number }>;
  }>;
  modoEmExibicao: AppSettings['mode'];
  scannerAtivo: boolean;
  versoes: { estrategia: string; score: string; risco: string; execucao: string };
}

export interface FunnelResponse {
  steps: Array<{
    stage: FunnelStage;
    label: string;
    reached: number;
    stopped: number;
    reasons: Array<{ code: string; count: number; message: string }>;
  }>;
  total: number;
  decisions: number;
  since: string | null;
  mode: AppSettings['mode'];
}

export interface DecisionsResponse {
  decisions: EntryDecisionRecord[];
  reasons: Array<{ code: string; count: number; message: string; symbols: string[] }>;
}

export interface EquityResponse {
  points: EquityPoint[];
  startingCapital: number;
  currentEquity: number;
  available: number;
  invested: number;
  realizedPnl: number;
  unrealizedPnl: number;
  positions: Array<{
    id: string;
    symbol: string;
    status: 'PENDING' | 'OPEN';
    quantity: number;
    entryPrice: number;
    currentPrice: number | null;
    invested: number;
    currentValue: number | null;
    realizedPnl: number;
    unrealizedPnl: number | null;
    totalPnl: number | null;
    pnlPercent: number | null;
    stopLoss: number;
    target1: number;
    target2: number | null;
    target3: number | null;
    protectiveStop: number | null;
    distanceToStopPercent: number | null;
    distanceToTargetPercent: number | null;
    /** de qual modalidade é a posição — as duas aparecem na mesma lista */
    market: MarketKind;
    side: Side;
    /** 1 em spot */
    leverage: number;
    /** margem prendida pela posição */
    initialMargin: number;
    liquidationPrice: number | null;
    distanceToLiquidationPercent: number | null;
    feesPaid: number;
    automatic: boolean;
    setupType: string;
    score: number;
    openedAt: string;
  }>;
  brlRate: number | null;
  mode: AppSettings['mode'];
  /** a modalidade dos TOTAIS; a lista de posições pode trazer as duas */
  market: MarketKind;
  updatedAt: string;
}

export interface RiskResponse {
  mode: AppSettings['mode'];
  capital: number;
  equity: number;
  peakEquity: number;
  drawdownPercent: number;
  dailyRealizedPnl: number;
  dailyUnrealizedPnl: number;
  dailyLossLimit: number;
  consecutiveLosses: number;
  /** quando a pausa por perdas seguidas acaba sozinha */
  resumesAt: string | null;
  tradesToday: number;
  openPositions: number;
  exposure: number;
  exposurePercent: number;
  altExposurePercent: number;
  lastLossAt: string | null;
  halted: boolean;
  haltReasons: string[];
  mutedReasons: string[];
  mutedUntil: string | null;
  guard: AppSettings['guard'];
  robot: {
    enabled: boolean;
    allowLive: boolean;
    armedUntil: string | null;
    serverAllowsLive: boolean;
    liveDenial: string | null;
  };
}

export interface AccountBalanceResponse {
  capital: number;
  available: number;
  source: string;
  currency: 'USDT';
  brlRate: number | null;
  mode: AppSettings['mode'];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const text = await response.text();

  /*
   * Resposta que não é JSON não pode derrubar o tratamento de erro.
   *
   * O JSON.parse ficava ANTES da checagem de status, então qualquer corpo em
   * HTML — o 404 padrão do Express, uma página de proxy, um 502 de gateway —
   * estourava "Unexpected token '<'" e engolia tudo o que vem abaixo,
   * inclusive o aviso de sessão vencida. O usuário via um erro de sintaxe onde
   * a informação útil era o status.
   */
  let payload: unknown = null;
  let parseFailed = false;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      parseFailed = true;
    }
  }

  if (parseFailed) {
    // 401 continua avisando a sessão mesmo sem corpo em JSON
    if (response.status === 401) announceSessionLost();
    const pareceHtml = text.trimStart().startsWith('<');
    if (response.status === 404 && pareceHtml) {
      throw new Error(
        `A rota ${path} não existe neste servidor. Se o painel foi atualizado sem reiniciar, o servidor em execução é mais antigo que a tela — feche a janela do Terminal e abra o Operacao.command de novo.`,
      );
    }
    throw new Error(
      pareceHtml
        ? `O servidor respondeu ${response.status} em HTML, não em JSON, para ${path}`
        : `Resposta ilegível do servidor (${response.status}) em ${path}`,
    );
  }

  if (!response.ok) {
    const detail = payload as { error?: string; retryAfterSeconds?: number } | null;
    // sessão vencida no meio do uso: a raiz devolve a tela de entrada em vez
    // de deixar o painel piscando erro em toda chamada
    if (response.status === 401) announceSessionLost();
    if (response.status === 429) {
      const espera = detail?.retryAfterSeconds ?? null;
      throw new Error(
        detail?.error ?? `Muitas chamadas seguidas${espera ? ` — espere ${espera}s` : ''}`,
      );
    }
    throw new Error(detail?.error ?? `Falha na requisição (${response.status})`);
  }
  return payload as T;
}

export interface SizingView {
  quantity: number;
  entryPrice: number;
  notional: number;
  riskAmount: number;
  riskPercentOfCapital: number;
  potentialProfitTarget1: number;
  potentialProfitTarget2: number | null;
  potentialProfitTarget3: number | null;
  riskReward: number;
  warnings: string[];
  blocked: boolean;
  blockReasons: string[];
}

export interface PreviewResponse {
  setup: TradeSetup;
  mode: AppSettings['mode'];
  /** modalidade e lado aprovados — mudar qualquer um invalida o token */
  market: MarketKind;
  side: Side;
  /** 1 em spot */
  leverage: number;
  /** o que a posição prende de saldo (notional ÷ alavancagem) */
  margin: number;
  liquidationPrice: number | null;
  /** maior alavancagem que ainda deixa a liquidação atrás do stop */
  safeLeverage: number | null;
  entryPrice: number;
  currentPrice: number;
  capital: number;
  available: number;
  brlRate: number | null;
  sizing: SizingView;
  filterErrors: string[];
  blockers: string[];
  warnings: string[];
  netRiskReward: number;
  canExecute: boolean;
  confirmationToken: string | null;
  expiresAt: string | null;
}

export const api = {
  state: () => request<DashboardSnapshot>('/state'),
  setups: () => request<TradeSetup[]>('/setups'),
  setupHistory: () => request<TradeSetup[]>('/setups/history'),
  ignoreSetup: (id: string) => request<TradeSetup>(`/setups/${id}/ignore`, { method: 'POST' }),
  alerts: () => request<AlertRecord[]>('/alerts'),
  markAlertRead: (id: string) => request<AlertRecord>(`/alerts/${id}/read`, { method: 'POST' }),
  trades: () => request<Trade[]>('/trades'),
  closeTrade: (id: string, reason = 'encerramento manual pelo usuário') =>
    request<Trade>(`/trades/${id}/close`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  performance: (query = '') => request<PerformanceStats>(`/performance${query}`),
  audit: (limit = 100) => request<AuditEntry[]>(`/audit?limit=${limit}`),
  candles: (symbol: string, timeframe: Timeframe) =>
    request<{ symbol: string; timeframe: Timeframe; candles: Candle[] }>(
      `/candles/${symbol}/${timeframe}`,
    ),
  balance: () => request<AccountBalanceResponse>('/account/balance'),
  settings: () => request<SettingsResponse>('/settings'),
  systemHealth: () => request<SystemHealth>('/system'),
  funnel: (mode?: string) =>
    request<FunnelResponse>(`/funnel${mode ? `?mode=${mode}` : ''}`),
  entryDecisions: (mode?: string) =>
    request<DecisionsResponse>(`/entry-decisions${mode ? `?mode=${mode}` : ''}`),
  equity: () => request<EquityResponse>('/equity'),
  decisions: (query = '') => request<DecisionRecord[]>(`/decisions${query}`),
  factors: (query = '') =>
    request<{ total: number; factors: FactorPerformance[] }>(`/analytics/factors${query}`),
  curatedWatchlist: (limit = 30) =>
    request<AppSettings>('/watchlist/curated', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  updateSettings: (patch: unknown) =>
    request<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  addToWatchlist: (symbol: string) =>
    request<AppSettings>('/watchlist', { method: 'POST', body: JSON.stringify({ symbol }) }),
  removeFromWatchlist: (symbol: string) =>
    request<AppSettings>(`/watchlist/${symbol}`, { method: 'DELETE' }),
  searchSymbols: (term: string) =>
    request<Array<{ symbol: string; baseAsset: string }>>(
      `/symbols/search?q=${encodeURIComponent(term)}`,
    ),
  preview: (body: {
    setupId: string;
    quoteAmount?: number;
    percentOfCapital?: number;
    /** alavancagem desta ordem; ausente = a dos ajustes da modalidade */
    leverage?: number;
  }) =>
    request<PreviewResponse>('/orders/preview', { method: 'POST', body: JSON.stringify(body) }),
  execute: (body: { setupId: string; confirmationToken: string; idempotencyKey: string }) =>
    request<Trade>('/orders/execute', { method: 'POST', body: JSON.stringify(body) }),
  risk: () => request<RiskResponse>('/risk'),
  closeAll: () =>
    request<{ closed: string[]; failed: Array<{ id: string; error: string }>; robotStopped: boolean }>(
      '/trades/close-all',
      { method: 'POST' },
    ),
  /**
   * Liga ou desliga UM robô. Sem modalidade, o da tela; com ela, o da coluna
   * — o radar tem um interruptor por modalidade e eles são independentes.
   */
  setRobot: (enabled: boolean, options: { mode?: AppSettings['mode']; market?: MarketKind } = {}) =>
    request<AppSettings>('/robot', {
      method: 'POST',
      body: JSON.stringify({ enabled, ...options }),
    }),
  armRobot: (minutes: number) =>
    request<{ settings: AppSettings; denial: string | null }>('/robot/arm', {
      method: 'POST',
      body: JSON.stringify({ minutes }),
    }),
  disarmRobot: () => request<AppSettings>('/robot/disarm', { method: 'POST' }),
  acknowledgeRisk: (minutes: number) =>
    request<AppSettings>('/risk/acknowledge', {
      method: 'POST',
      body: JSON.stringify({ minutes }),
    }),
};
