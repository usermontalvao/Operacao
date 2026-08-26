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
import type { MarketKind, Trade, TradeSetup, TradingMode } from './lib/types.ts';

export function App({ userLabel, onLoggedOut }: { userLabel: string | null; onLoggedOut: () => void }) {
  const live = useLiveState();
  const [tab, setTab] = useState<Tab>('RADAR');
  const [openSetup, setOpenSetup] = useState<TradeSetup | null>(null);
  const [buying, setBuying] = useState<TradeSetup | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  // qual robô está sendo alternado agora — são dois, e travar os dois botões
  // por causa de um clique esconderia que eles são independentes
  const [robotBusy, setRobotBusy] = useState<MarketKind | null>(null);

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

  /*
   * Ativos com posição em andamento — POR MODALIDADE.
   *
   * O radar precisa parar de oferecer entrada onde já existe posição, mas a
   * trava é por modalidade: quem está comprado em XRP no spot pode
   * perfeitamente abrir uma posição em XRP nos futuros, e é assim que o
   * servidor decide. Uma lista única marcaria a coluna errada como "em
   * operação" e esconderia uma entrada legítima.
   */
  const openSymbols = useMemo(() => {
    const porModalidade: Record<MarketKind, Set<string>> = { SPOT: new Set(), FUTURES: new Set() };
    for (const trade of live.trades) {
      if (trade.mode !== mode) continue;
      porModalidade[trade.market ?? 'SPOT'].add(trade.symbol);
    }
    return porModalidade;
  }, [live.trades, mode]);

  /*
   * Modalidades e robôs vêm do servidor.
   *
   * O padrão é só spot com tudo desligado: é o que o painel mostra enquanto a
   * primeira resposta não chega, e também o que um servidor antigo (sem estes
   * campos) produz — uma coluna, exatamente como antes.
   */
  const markets = live.snapshot?.markets ?? ['SPOT'];
  const robots = live.snapshot?.robots ?? {
    SPOT: { enabled: false, liveDenial: null },
    FUTURES: { enabled: false, liveDenial: null },
  };

  /** Qualquer modalidade — para a lista "Acompanhando", que não tem coluna. */
  const anyOpenSymbols = useMemo(
    () => new Set([...openSymbols.SPOT, ...openSymbols.FUTURES]),
    [openSymbols],
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
  /**
   * Liga ou desliga UM robô — o da modalidade pedida.
   *
   * Sem modalidade é o da tela, que é o que o distintivo do topo faz. Com
   * ela, é o botão da coluna do radar: são dois robôs independentes, e mexer
   * num não pode mexer no outro.
   */
  const toggleRobot = useCallback(
    async (market?: MarketKind, next?: boolean): Promise<void> => {
      const alvo = market ?? live.snapshot?.settings.market ?? 'SPOT';
      const atual =
        next !== undefined
          ? !next
          : live.snapshot?.robots?.[alvo]?.enabled ??
            live.snapshot?.settings.autoTrade.enabled ??
            false;
      const enabled = next ?? !atual;
      const mode = live.snapshot?.mode ?? 'PAPER';
      if (enabled && mode === 'LIVE') {
        const ok = window.confirm(
          `Ligar o robô de ${alvo === 'FUTURES' ? 'FUTUROS' : 'SPOT'} na conta REAL?\n\nEle só opera sozinho se também estiver armado nos Ajustes, e o armamento vence sozinho.`,
        );
        if (!ok) return;
      }
      setRobotBusy(alvo);
      try {
        await api.setRobot(enabled, { market: alvo });
        await live.refresh();
        setToast(
          `${enabled ? 'Robô ligado' : 'Robô desligado'} em ${alvo === 'FUTURES' ? 'futuros' : 'spot'}`,
        );
        setTimeout(() => setToast(null), 3500);
      } catch (failure) {
        setModeError((failure as Error).message);
      } finally {
        setRobotBusy(null);
      }
    },
    [live],
  );

  /**
   * Parar TUDO — o distintivo do topo.
   *
   * Ligar é decisão de cada coluna; desligar não pode depender de lembrar
   * quantos robôs estão soltos. Percorre as modalidades ligadas e desliga
   * uma a uma.
   */
  const stopAllRobots = useCallback(async (): Promise<void> => {
    const ligados = markets.filter((market) => robots[market]?.enabled);
    if (ligados.length === 0) return;
    setRobotBusy(ligados[0] ?? null);
    try {
      for (const market of ligados) await api.setRobot(false, { market });
      await live.refresh();
      setToast(ligados.length > 1 ? `${ligados.length} robôs desligados` : 'Robô desligado');
      setTimeout(() => setToast(null), 3500);
    } catch (failure) {
      setModeError((failure as Error).message);
    } finally {
      setRobotBusy(null);
    }
  }, [live, markets, robots]);

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
        market={live.snapshot?.settings.market ?? 'SPOT'}
        balance={live.balance}
        liveEquity={liveEquity}
        switchingMode={switchingMode}
        modeError={modeError}
        onModeChange={(mode) => void changeAccount(mode)}
        connection={live.connection}
        streamConnected={live.streamConnected}
        carregando={live.carregando}
        robots={robots}
        markets={markets}
        robotBusy={robotBusy !== null}
        onStopRobots={() => void stopAllRobots()}
        halted={live.risk?.halted ?? false}
        resumesAt={live.risk?.resumesAt ?? null}
        onHome={() => {
          setTab('RADAR');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        tabs={
          <NavTabs
            active={tab}
            onChange={setTab}
            onPrefetch={adiantarAba}
            variant="top"
            counts={{ HISTORICO: live.trades.length }}
          />
        }
        userLabel={userLabel}
        onLogout={() => void sair()}
      />

      <main className="mx-auto max-w-6xl px-4 py-4">
        {live.error && !live.carregando ? (
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
            anyOpenSymbols={anyOpenSymbols}
            binanceAvailable={live.snapshot?.binanceAvailable ?? false}
            carregando={live.carregando}
            markets={markets}
            robots={robots}
            robotBusy={robotBusy}
            onToggleRobot={(market, enabled) => void toggleRobot(market, enabled)}
            onOpenSetup={setOpenSetup}
            onGoToWallet={() => setTab('HISTORICO')}
          />
        ) : null}
        {tab === 'DIAGNOSTICO' ? <Diagnostico /> : null}
        {/* os preços vivos entram: sem eles a carteira só se mexia a cada
            5 segundos, enquanto o radar ao lado andava a cada tique */}
        {tab === 'HISTORICO' ? <History prices={live.prices} /> : null}
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
          inTrade={openSymbols[currentSetup.market ?? 'SPOT'].has(currentSetup.symbol)}
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
