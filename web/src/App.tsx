import { useCallback, useEffect, useMemo, useState } from 'react';
import { Header } from './components/Header.tsx';
import { NavTabs, type Tab } from './components/NavTabs.tsx';
import { AlertToasts } from './components/AlertToasts.tsx';
import { SetupSheet } from './components/SetupSheet.tsx';
import { Diagnostico } from './pages/Diagnostico.tsx';
import { BuyModal } from './components/BuyModal.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { History } from './pages/History.tsx';
import { Journal } from './pages/Journal.tsx';
import { Performance } from './pages/Performance.tsx';
import { Settings } from './pages/Settings.tsx';
import { api } from './lib/api.ts';
import { computeLiveEquity } from './lib/equity.ts';
import { logout } from './lib/auth.ts';
import { esquecerTudo } from './lib/resource.ts';
import { adiantarAba } from './lib/telas.ts';
import { useLiveState } from './lib/useLiveState.ts';
import { ChartViewerProvider } from './lib/chartViewer.tsx';
import type { Trade, TradeSetup, TradingMode } from './lib/types.ts';

export function App({ userLabel, onLoggedOut }: { userLabel: string | null; onLoggedOut: () => void }) {
  const live = useLiveState();
  const [tab, setTab] = useState<Tab>('RADAR');
  const [openSetup, setOpenSetup] = useState<TradeSetup | null>(null);
  const [buying, setBuying] = useState<TradeSetup | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const [robotBusy, setRobotBusy] = useState(false);

  const mode = live.snapshot?.mode ?? 'PAPER';
  // recalcula a cada preço novo: é o que faz o número do topo andar sozinho
  const liveEquity = useMemo(
    () =>
      computeLiveEquity({
        balance: live.balance,
        trades: live.trades,
        prices: live.prices,
        mode,
        // segunda fonte de preço: par fora da watchlist não recebe tique
        serverPositions: live.equity?.positions,
      }),
    [live.balance, live.trades, live.prices, live.equity, mode],
  );

  const sair = useCallback(async (): Promise<void> => {
    await logout();
    // nada do usuário que saiu pode sobreviver para o próximo que entrar
    esquecerTudo();
    onLoggedOut();
  }, [onLoggedOut]);

  // ativos com posição em andamento: o radar precisa parar de oferecer compra
  const openSymbols = useMemo(
    () => new Set(live.trades.filter((trade) => trade.mode === mode).map((trade) => trade.symbol)),
    [live.trades, mode],
  );

  // trocar de aba tem de começar do começo: manter a rolagem da tela anterior
  // faz a aba nova abrir no meio, o que parece falha de carregamento
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [tab]);

  const setups = live.setups;
  const currentSetup = useMemo(
    () => (openSetup ? (setups.find((item) => item.id === openSetup.id) ?? openSetup) : null),
    [openSetup, setups],
  );

  const ignore = useCallback(
    async (setup: TradeSetup) => {
      live.removeSetup(setup.id);
      setOpenSetup(null);
      try {
        await api.ignoreSetup(setup.id);
      } catch {
        void live.refresh();
      }
    },
    [live],
  );

  const executed = useCallback(
    (trade: Trade) => {
      setBuying(null);
      setOpenSetup(null);
      setToast(
        trade.mode === 'PAPER'
          ? `Operação simulada criada em ${trade.symbol.replace('USDT', '')}`
          : `Ordem enviada à Binance em ${trade.symbol.replace('USDT', '')}`,
      );
      setTimeout(() => setToast(null), 4000);
      void live.refresh();
    },
    [live],
  );

  const openById = useCallback(
    (setupId: string) => {
      const setup = setups.find((item) => item.id === setupId);
      if (setup) {
        setOpenSetup(setup);
        setTab('RADAR');
        const alert = live.alerts.find((item) => item.setupId === setupId);
        if (alert) live.dismissAlert(alert.id);
      }
    },
    [setups, live],
  );

  /**
   * Desligar precisa ser instantâneo e sem cerimônia. Ligar em conta real,
   * não: aí a confirmação é o último degrau antes de dinheiro de verdade.
   */
  const toggleRobot = useCallback(async (): Promise<void> => {
    const enabled = live.snapshot?.settings.autoTrade.enabled ?? false;
    const mode = live.snapshot?.mode ?? 'PAPER';
    if (!enabled && mode === 'LIVE') {
      const ok = window.confirm(
        'Ligar o robô na conta REAL?\n\nEle só compra sozinho se também estiver armado nos Ajustes, e o armamento vence sozinho.',
      );
      if (!ok) return;
    }
    setRobotBusy(true);
    try {
      await api.setRobot(!enabled);
      await live.refresh();
      setToast(!enabled ? 'Robô ligado' : 'Robô desligado');
      setTimeout(() => setToast(null), 3500);
    } catch (failure) {
      setModeError((failure as Error).message);
    } finally {
      setRobotBusy(false);
    }
  }, [live]);

  const changeAccount = useCallback(
    async (mode: Extract<TradingMode, 'PAPER' | 'LIVE'>): Promise<void> => {
      if (mode === (live.snapshot?.mode ?? 'PAPER') || switchingMode) return;
      setSwitchingMode(true);
      setModeError(null);
      try {
        // o que está guardado é da OUTRA conta — mantê-lo mostraria o
        // histórico da demo dentro da conta real por um instante
        esquecerTudo();
        await api.updateSettings({ mode });
        await live.refresh();
        setToast(mode === 'LIVE' ? 'Conta REAL selecionada' : 'Conta DEMO selecionada');
        setTimeout(() => setToast(null), 4000);
      } catch (failure) {
        setModeError((failure as Error).message);
      } finally {
        setSwitchingMode(false);
      }
    },
    [live, switchingMode],
  );

  return (
    // o gráfico é pedido de qualquer tela: quem o guarda é o topo da árvore
    <ChartViewerProvider prices={live.prices}>
    <div className="min-h-full pb-20 sm:pb-6">
      <Header
        mode={live.snapshot?.mode ?? 'PAPER'}
        balance={live.balance}
        liveEquity={liveEquity}
        switchingMode={switchingMode}
        modeError={modeError}
        onModeChange={(mode) => void changeAccount(mode)}
        connection={live.connection}
        streamConnected={live.streamConnected}
        context={live.context}
        activeSetups={setups.filter((setup) => setup.ignoredAt === null).length}
        autoTradeOn={live.snapshot?.settings.autoTrade.enabled ?? false}
        robotBusy={robotBusy}
        onToggleRobot={() => void toggleRobot()}
        halted={live.risk?.halted ?? false}
        tabs={
          <NavTabs
            active={tab}
            onChange={setTab}
            onPrefetch={adiantarAba}
            variant="top"
            counts={{ HISTORICO: live.trades.length }}
          />
        }
        watchedSymbols={live.snapshot?.settings.scanner.watchlist.length ?? 0}
        universe={live.snapshot?.universe ?? null}
        userLabel={userLabel}
        onLogout={() => void sair()}
      />

      <main className="mx-auto max-w-6xl px-4 py-4">
        {live.error ? (
          <p className="mb-3 rounded-lg border border-bear/40 bg-bear/10 p-3 text-sm text-bear">{live.error}</p>
        ) : null}

        {/*
          A chave leva a conta junto: trocar DEMO↔REAL troca todos os números,
          e sem remontar a aba ficaria mostrando o histórico da conta anterior
          até o próximo ciclo de atualização.
        */}
        <div key={`${tab}:${mode}`} className="aba-entra">
        {tab === 'RADAR' ? (
          <Dashboard
            assets={live.snapshot?.assets ?? []}
            setups={setups}
            decisions={live.decisions}
            prices={live.prices}
            openTrades={live.trades}
            openSymbols={openSymbols}
            binanceAvailable={live.snapshot?.binanceAvailable ?? false}
            onOpenSetup={setOpenSetup}
            onGoToWallet={() => setTab('HISTORICO')}
          />
        ) : null}
        {tab === 'DIAGNOSTICO' ? <Diagnostico /> : null}
        {tab === 'HISTORICO' ? <History /> : null}
        {tab === 'DESEMPENHO' ? <Performance /> : null}
        {tab === 'AJUSTES' ? (
          <Settings onChanged={() => void live.refresh()} onLoggedOut={onLoggedOut} />
        ) : null}
        {tab === 'DIARIO' ? <Journal /> : null}
        </div>
      </main>

      <NavTabs
        active={tab}
        onChange={setTab}
        onPrefetch={adiantarAba}
        variant="bottom"
        counts={{ HISTORICO: live.trades.length }}
      />

      {currentSetup && !buying ? (
        <SetupSheet
          setup={currentSetup}
          livePrice={live.prices[currentSetup.symbol] ?? null}
          onClose={() => setOpenSetup(null)}
          onBuy={setBuying}
          onIgnore={(setup) => void ignore(setup)}
          inTrade={openSymbols.has(currentSetup.symbol)}
          decision={live.decisions[currentSetup.id]}
        />
      ) : null}

      {buying ? <BuyModal setup={buying} onClose={() => setBuying(null)} onExecuted={executed} /> : null}

      <AlertToasts alerts={live.alerts} onOpen={openById} onDismiss={live.dismissAlert} />

      {toast ? (
        <div className="fixed inset-x-0 top-16 z-50 mx-auto w-fit rounded-lg border border-bull/40 bg-terminal-panel px-4 py-2 text-sm text-bull">
          {toast}
        </div>
      ) : null}
    </div>
    </ChartViewerProvider>
  );
}
