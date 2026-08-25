import type {
  AlertRecord,
  AppSettings,
  AuditEntry,
  Candle,
  DashboardSnapshot,
  DecisionRecord,
  EquityPoint,
  FactorPerformance,
  PerformanceStats,
  Timeframe,
  Trade,
  TradeSetup,
} from './types.ts';
import { announceSessionLost } from './auth.ts';

export interface SettingsResponse extends AppSettings {
  store: string;
  binance: {
    activeEnvironment: 'production' | 'testnet';
    production: { credentialsConfigured: boolean };
    testnet: { credentialsConfigured: boolean };
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
    feesPaid: number;
    automatic: boolean;
    setupType: string;
    score: number;
    openedAt: string;
  }>;
  brlRate: number | null;
  mode: AppSettings['mode'];
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
  const payload = text ? (JSON.parse(text) as unknown) : null;
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
  preview: (body: { setupId: string; quoteAmount?: number; percentOfCapital?: number }) =>
    request<PreviewResponse>('/orders/preview', { method: 'POST', body: JSON.stringify(body) }),
  execute: (body: { setupId: string; confirmationToken: string; idempotencyKey: string }) =>
    request<Trade>('/orders/execute', { method: 'POST', body: JSON.stringify(body) }),
  risk: () => request<RiskResponse>('/risk'),
  closeAll: () =>
    request<{ closed: string[]; failed: Array<{ id: string; error: string }>; robotStopped: boolean }>(
      '/trades/close-all',
      { method: 'POST' },
    ),
  setRobot: (enabled: boolean) =>
    request<AppSettings>('/robot', { method: 'POST', body: JSON.stringify({ enabled }) }),
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
