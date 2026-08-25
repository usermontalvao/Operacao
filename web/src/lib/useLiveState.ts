import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AccountBalanceResponse, type EquityResponse, type RiskResponse } from './api.ts';
import type {
  AlertRecord,
  ConnectionState,
  DashboardSnapshot,
  MarketContext,
  Trade,
  TradeSetup,
  EntryDecision,
} from './types.ts';

const REFRESH_MS = 15_000;

export interface LiveState {
  snapshot: DashboardSnapshot | null;
  balance: AccountBalanceResponse | null;
  /** retrato do disjuntor — o topo da tela precisa saber se a operação parou */
  risk: RiskResponse | null;
  /** contas do servidor, com preço de todas as posições (mesmo fora da watchlist) */
  equity: EquityResponse | null;
  setups: TradeSetup[];
  /** decisão do robô por setup — a explicação de por que não entrou */
  decisions: Record<string, EntryDecision>;
  prices: Record<string, number>;
  alerts: AlertRecord[];
  trades: Trade[];
  context: MarketContext | null;
  connection: ConnectionState;
  streamConnected: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  dismissAlert: (id: string) => void;
  removeSetup: (id: string) => void;
}

/**
 * Estado vivo do painel: uma chamada inicial, um canal SSE e um refresh leve
 * de segurança. Preço chega por evento — a tela nunca recarrega sozinha.
 */
export function useLiveState(): LiveState {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [balance, setBalance] = useState<AccountBalanceResponse | null>(null);
  const [risk, setRisk] = useState<RiskResponse | null>(null);
  const [equity, setEquity] = useState<EquityResponse | null>(null);
  const [setups, setSetups] = useState<TradeSetup[]>([]);
  const [decisions, setDecisions] = useState<Record<string, EntryDecision>>({});
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [context, setContext] = useState<MarketContext | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('OFFLINE');
  const [streamConnected, setStreamConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [state, openAlerts, accountBalance, riskSnapshot, equitySnapshot] = await Promise.all([
        api.state(),
        api.alerts(),
        api.balance().catch(() => null),
        api.risk().catch(() => null),
        api.equity().catch(() => null),
      ]);
      setSnapshot(state);
      setBalance(accountBalance);
      setRisk(riskSnapshot);
      setEquity(equitySnapshot);
      setSetups(state.setups);
      setDecisions(state.decisions ?? {});
      setContext(state.marketContext);
      setConnection(state.connection);
      setTrades(state.openTrades);
      setAlerts(openAlerts.filter((alert) => alert.readAt === null).slice(0, 4));
      setPrices((current) => {
        const next = { ...current };
        for (const asset of state.assets) if (asset.price !== null) next[asset.symbol] = asset.price;
        return next;
      });
      setError(null);
    } catch (failure) {
      setError((failure as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const source = new EventSource('/api/stream');
    sourceRef.current = source;

    source.onopen = () => setStreamConnected(true);
    source.onerror = () => setStreamConnected(false);

    source.addEventListener('prices', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as Record<string, number>;
      setPrices((current) => ({ ...current, ...payload }));
    });
    source.addEventListener('setup', (event) => {
      const setup = JSON.parse((event as MessageEvent).data) as TradeSetup;
      setSetups((current) => {
        const rest = current.filter((item) => item.id !== setup.id);
        return [...rest, setup].sort((a, b) => b.score - a.score);
      });
    });
    source.addEventListener('setupRemoved', (event) => {
      const { id } = JSON.parse((event as MessageEvent).data) as { id: string };
      setSetups((current) => current.filter((item) => item.id !== id));
    });
    source.addEventListener('alert', (event) => {
      const alert = JSON.parse((event as MessageEvent).data) as AlertRecord;
      // o mesmo alerta chega pelo SSE e pelo carregamento inicial
      setAlerts((current) =>
        current.some((item) => item.id === alert.id) ? current : [alert, ...current].slice(0, 4),
      );
    });
    source.addEventListener('trade', (event) => {
      const trade = JSON.parse((event as MessageEvent).data) as Trade;
      setTrades((current) => {
        const rest = current.filter((item) => item.id !== trade.id);
        const open = trade.status === 'PENDING' || trade.status === 'OPEN';
        return open ? [trade, ...rest] : rest;
      });
    });
    source.addEventListener('context', (event) => {
      setContext(JSON.parse((event as MessageEvent).data) as MarketContext);
    });
    source.addEventListener('status', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { connection: ConnectionState };
      setConnection(payload.connection);
    });
    source.addEventListener('settings', () => void refresh());

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [refresh]);

  const dismissAlert = useCallback((id: string) => {
    setAlerts((current) => current.filter((alert) => alert.id !== id));
    void api.markAlertRead(id).catch(() => undefined);
  }, []);

  const removeSetup = useCallback((id: string) => {
    setSetups((current) => current.filter((setup) => setup.id !== id));
  }, []);

  return {
    snapshot,
    balance,
    risk,
    equity,
    setups,
    decisions,
    prices,
    alerts,
    trades,
    context,
    connection,
    streamConnected,
    error,
    refresh,
    dismissAlert,
    removeSetup,
  };
}
