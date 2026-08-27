import { useEffect, useRef, useState } from 'react';
import type { ConnectionState, MarketKind, RobotState, TradingMode } from '../lib/types.ts';
import type { AccountBalanceResponse } from '../lib/api.ts';
import { brl, quantity, usd } from '../lib/format.ts';
import { Marca } from './Marca.tsx';
import type { LiveEquity } from '../lib/equity.ts';

interface HeaderProps {
  mode: TradingMode;
  /** modalidade ativa; só aparece quando é futuros — spot é o silêncio */
  market: MarketKind;
  balance: AccountBalanceResponse | null;
  /** patrimônio recalculado a cada tique de preço */
  liveEquity: LiveEquity;
  switchingMode: boolean;
  modeError: string | null;
  onModeChange: (mode: 'PAPER' | 'LIVE') => void;
  connection: ConnectionState;
  streamConnected: boolean;
  /** a primeira leitura ainda não voltou — o topo não sabe de nada ainda */
  carregando: boolean;
  /** o interruptor de cada modalidade — são dois robôs, não um */
  robots: Record<MarketKind, RobotState>;
  /** modalidades operando agora; com uma só, o distintivo age como sempre agiu */
  markets: MarketKind[];
  robotBusy: boolean;
  /** desligar daqui vale para TODOS; ligar é decisão de cada coluna do radar */
  onStopRobots: () => void;
  halted: boolean;
  /** hora em que o intervalo por perdas seguidas acaba sozinho */
  resumesAt: string | null;
  /** as abas de navegação, renderizadas dentro do cabeçalho no monitor */
  tabs: React.ReactNode;
  /** volta para a tela inicial ao clicar na marca */
  onHome: () => void;
  /** quem está logado; null enquanto a sessão não foi lida */
  userLabel: string | null;
  onLogout: () => void;
}

export function Header(props: HeaderProps) {
  const {
    mode,
    market,
    balance,
    liveEquity,
    switchingMode,
    modeError,
    onModeChange,
    connection,
    streamConnected,
    carregando,
    robots,
    markets,
    robotBusy,
    onStopRobots,
    halted,
    resumesAt,
    tabs,
    onHome,
    userLabel,
    onLogout,
  } = props;
  /*
    OFFLINE é um diagnóstico, e no primeiro quadro ninguém tem diagnóstico
    nenhum: o canal nasce fechado e o distintivo nascia vermelho por isso, em
    toda abertura de painel. Enquanto a primeira leitura não volta, o estado
    honesto é CONECTANDO.
  */
  const connectionLabel = carregando
    ? 'CONECTANDO'
    : !streamConnected
      ? 'OFFLINE'
      : connection === 'LIVE'
        ? 'LIVE'
        : connection === 'RECONNECTING'
          ? 'RECONECTANDO'
          : 'OFFLINE';
  const connectionTone =
    connectionLabel === 'LIVE'
      ? 'text-bull border-bull/25 bg-bull/[0.07]'
      : connectionLabel === 'RECONECTANDO' || connectionLabel === 'CONECTANDO'
        ? 'text-warn border-warn/25 bg-warn/[0.07]'
        : 'text-bear border-bear/25 bg-bear/[0.07]';
  const connectionDot =
    connectionLabel === 'LIVE'
      ? 'bg-bull shadow-[0_0_10px_rgba(22,199,132,0.7)]'
      : connectionLabel === 'RECONECTANDO' || connectionLabel === 'CONECTANDO'
        ? 'bg-warn'
        : 'bg-bear';
  /*
    Enquanto a primeira leitura não volta, NENHUMA conta está selecionada.

    `mode` nasce 'PAPER' porque algum valor tem de existir antes da resposta,
    e o botão DEMO acendia por causa disso: quem abre o painel numa conta REAL
    vê "DEMO" aceso por alguns segundos. É o pior lugar possível para um
    palpite — a pergunta "que conta é esta?" é a que decide se um clique gasta
    dinheiro de verdade. Sem resposta, o certo é não afirmar nada.
  */
  const demoSelected = !carregando && mode !== 'LIVE';
  const realSelected = !carregando && mode === 'LIVE';

  /*
    O distintivo do robô com DUAS modalidades no ar.

    Ligar é uma decisão por modalidade — é na coluna do radar que se sabe qual
    robô se está soltando, e um botão central obrigaria a lembrar qual deles
    estava comandando. Desligar é o contrário: quem percebe que algo está
    errado quer parar TUDO, e quer num clique. Por isso o distintivo continua
    sendo um botão, mas só no sentido que não pode esperar.
  */
  const ligados = markets.filter((each) => robots[each]?.enabled).length;
  const autoTradeOn = ligados > 0;
  const varios = markets.length > 1;
  const robotLabel = varios ? `ROBÔS ${ligados}/${markets.length}` : autoTradeOn ? 'ROBÔ ON' : 'ROBÔ OFF';

  // o saldo do topo é o patrimônio AGORA, com as posições marcadas a mercado —
  // não o caixa parado, que só se mexe quando uma operação encerra
  const balanceReady = balance !== null && !switchingMode;
  // '···' é espera; '—' é ausência. Trocar os dois era dizer "sem saldo" antes
  // de ter perguntado o saldo
  const balanceLabel = balanceReady
    ? `${quantity(liveEquity.equity)} USDT`
    : carregando
      ? '···'
      : '—';
  const balanceInBrl =
    balanceReady && balance?.brlRate && balance.brlRate > 0
      ? brl(liveEquity.equity * balance.brlRate)
      : null;

  /**
   * O resultado em aberto só aparece quando é um número de verdade.
   *
   * Antes ele nascia em 0 — e como 0 conta como "não negativo", a tela abria
   * verde com "+US$ 0,00" e virava vermelha assim que o primeiro preço
   * chegava. Pior: posição em par fora da watchlist nunca recebe tique, então
   * aquele 0 verde não era carregamento, era resposta errada.
   *
   * Agora há três estados, e nenhum deles mente: sem posição não mostra nada,
   * faltando preço mostra reticências, e zero exato é neutro — verde e
   * vermelho ficam reservados para lucro e prejuízo mesmo.
   */
  const openState: 'nenhuma' | 'carregando' | 'pronto' =
    liveEquity.positions === 0 ? 'nenhuma' : liveEquity.partial || !balanceReady ? 'carregando' : 'pronto';
  const awaitingOnly = liveEquity.positions === 0 && liveEquity.pendingOrders > 0;
  const hasActivity = liveEquity.positions > 0 || liveEquity.pendingOrders > 0;
  const openTone =
    liveEquity.unrealized > 0 ? 'text-bull' : liveEquity.unrealized < 0 ? 'text-bear' : 'text-terminal-muted';

  return (
    <header className="app-header sticky top-0 z-30 border-b border-white/[0.07] bg-terminal-bg/90 backdrop-blur-xl">
      <div className="mx-auto max-w-6xl px-4">
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 py-2 lg:grid-cols-[1fr_auto_1fr] lg:gap-x-4">
          <button
            type="button"
            onClick={onHome}
            aria-label="Ir para o início"
            title="Ir para o Radar"
            className="flex min-w-0 items-center gap-3 rounded-lg text-left transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bull/70"
          >
            <div className="rounded-lg border border-white/[0.06] bg-white/[0.025] p-0.5 shadow-[0_8px_24px_rgba(0,0,0,0.18)]">
              <Marca tamanho={28} />
            </div>
            <div className="min-w-0 leading-none">
              <span className="block truncate text-[15px] font-semibold tracking-[-0.02em] text-white sm:text-base">
                Crypto Hunter
              </span>
              <span className="mt-1.5 hidden text-[9px] font-semibold uppercase tracking-[0.2em] text-terminal-muted sm:block">
                Terminal de operações
              </span>
            </div>
          </button>

          <div className="order-3 col-span-2 flex min-w-0 items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.025] p-1 shadow-[0_10px_26px_rgba(0,0,0,0.16)] lg:order-none lg:col-span-1 lg:justify-start">
            <div
              className="flex shrink-0 rounded-lg border border-white/[0.05] bg-black/25 p-0.5"
              // trocar de conta antes de saber em qual se está é o mesmo erro
              // por outro caminho: o seletor só aceita clique depois da resposta
              aria-busy={carregando}
            >
              <AccountButton
                label="DEMO"
                active={demoSelected}
                disabled={switchingMode || carregando}
                onClick={() => onModeChange('PAPER')}
              />
              <AccountButton
                label="REAL"
                active={realSelected}
                danger
                disabled={switchingMode || carregando}
                onClick={() => onModeChange('LIVE')}
              />
            </div>
            {/*
              Em futuros, o topo diz. Alavancado, a mesma tela com os mesmos
              botões tem outra consequência — e o lugar onde o usuário olha
              para saber "onde eu estou" é aqui, não os ajustes.
            */}
            {market === 'FUTURES' ? (
              <span
                className="shrink-0 rounded-lg border border-info/40 bg-info/10 px-2 py-1 text-[9px] font-bold tracking-[0.14em] text-info"
                title="modalidade ativa: futuros USD-M"
              >
                FUTUROS
              </span>
            ) : null}
            <div className="flex min-w-0 items-center gap-3 border-l border-white/[0.07] pl-3 pr-1">
              <div className="min-w-0 text-left tabular leading-tight">
                <div className="mb-0.5 text-[8px] font-semibold uppercase tracking-[0.18em] text-terminal-muted">
                  Patrimônio
                </div>
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-sm font-semibold tracking-[-0.01em] text-white">{balanceLabel}</span>
                  <span className="hidden shrink-0 text-[9px] text-terminal-muted sm:inline">
                    {balanceInBrl ?? (mode === 'LIVE' ? 'conta real' : 'conta demo')}
                  </span>
                </div>
              </div>

              {hasActivity ? (
                <div
                  className={`shrink-0 rounded-lg border px-2 py-1 text-right leading-tight tabular ${
                    awaitingOnly
                      ? 'border-warn/25 bg-warn/[0.07] text-warn'
                      : openState === 'carregando'
                      ? 'border-white/[0.07] bg-black/20 text-terminal-muted'
                      : liveEquity.unrealized > 0
                        ? 'border-bull/20 bg-bull/[0.07]'
                        : liveEquity.unrealized < 0
                          ? 'border-bear/20 bg-bear/[0.07]'
                          : 'border-white/[0.07] bg-black/20'
                  }`}
                  title={
                    awaitingOnly
                      ? `${liveEquity.pendingOrders} ${liveEquity.pendingOrders === 1 ? 'ordem' : 'ordens'} aguardando entrada`
                      : `${liveEquity.positions} ${liveEquity.positions === 1 ? 'posição aberta' : 'posições abertas'}${
                          liveEquity.pendingOrders > 0
                            ? ` e ${liveEquity.pendingOrders} ${liveEquity.pendingOrders === 1 ? 'ordem aguardando' : 'ordens aguardando'}`
                            : ''
                        }`
                  }
                >
                  <div className={`text-xs font-bold ${!awaitingOnly && openState === 'pronto' ? openTone : ''}`}>
                    {awaitingOnly
                      ? `${liveEquity.pendingOrders} ${liveEquity.pendingOrders === 1 ? 'ordem' : 'ordens'}`
                      : openState === 'carregando'
                      ? '···'
                      : `${liveEquity.unrealized > 0 ? '+' : ''}${usd(liveEquity.unrealized)}`}
                  </div>
                  <div className="text-[9px] uppercase tracking-wide text-terminal-muted">
                    {awaitingOnly ? 'aguardando' : 'aberto'}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 lg:min-w-0">
            {/*
              O distintivo do robô é um botão, não um enfeite. Quem percebe que
              algo está errado precisa de um clique até parar — não de uma
              viagem até a aba de ajustes.
            */}
            <button
              type="button"
              disabled={robotBusy || carregando || !autoTradeOn}
              onClick={onStopRobots}
              aria-pressed={autoTradeOn}
              title={
                resumesAt
                  ? `No intervalo até ${new Date(resumesAt).toLocaleTimeString('pt-BR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })} — depois volta sozinho`
                  : autoTradeOn
                    ? varios
                      ? `Clique para desligar os ${ligados} robôs`
                      : 'Clique para desligar o robô'
                    : varios
                      ? 'Ligue o robô na coluna da modalidade, no Radar'
                      : 'Ligue o robô na coluna do Radar'
              }
              className={`group flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[9px] font-bold tracking-[0.13em] transition-all duration-200 disabled:opacity-50 sm:px-3 ${
                carregando
                  ? 'border-white/[0.07] bg-white/[0.035] text-terminal-muted'
                  : halted
                  ? 'border-warn/25 bg-warn/[0.07] text-warn'
                  : autoTradeOn
                    ? 'border-bull/25 bg-bull/[0.07] text-bull hover:border-bull/40 hover:bg-bull/10'
                    : 'border-white/[0.07] bg-white/[0.035] text-terminal-muted hover:border-white/[0.13] hover:text-terminal-text'
              }`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${
                  carregando || robotBusy
                    ? 'bg-terminal-muted'
                    : resumesAt || halted
                      ? 'bg-warn'
                      : autoTradeOn
                        ? 'bg-bull shadow-[0_0_8px_rgba(22,199,132,0.55)]'
                        : 'bg-terminal-muted/60'
                }`}
              />
              {carregando
                ? 'ROBÔ ···'
                : robotBusy
                  ? 'ROBÔ …'
                  : resumesAt
                    ? 'ROBÔ EM PAUSA'
                    : halted
                      ? 'ROBÔ PARADO'
                      : robotLabel}
            </button>
            <span
              className={`flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[9px] font-bold tracking-[0.13em] sm:px-3 ${connectionTone}`}
            >
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${connectionDot}`} />
              {connectionLabel}
            </span>
            <AccountMenu userLabel={userLabel} onLogout={onLogout} />
          </div>
        </div>

        {modeError ? (
          <p className="rounded-lg border border-bear/40 bg-bear/10 px-3 py-2 text-xs text-bear">
            {modeError}
          </p>
        ) : null}

        <div className="flex min-w-0 items-center justify-center border-t border-white/[0.055]">
          {tabs}
        </div>
      </div>
    </header>
  );
}

/**
 * Menu da conta — é onde mora o "sair".
 *
 * Fica atrás de um clique de propósito: sair é ação rara, e um botão de sair
 * solto ao lado do que liga o robô é clique errado esperando acontecer. O
 * fundo invisível fecha o menu ao clicar fora, e Esc também — sem isso, um
 * menu aberto acompanha a pessoa pela tela inteira.
 */
function AccountMenu({ userLabel, onLogout }: { userLabel: string | null; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const primeiroItem = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    primeiroItem.current?.focus();
    const aoTeclar = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [open]);

  const inicial = (userLabel ?? '?').trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((atual) => !atual)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={userLabel ?? 'Conta'}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.035] text-[10px] font-semibold text-terminal-muted transition-all duration-200 hover:border-white/[0.15] hover:bg-white/[0.06] hover:text-white"
      >
        {inicial}
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            role="menu"
            className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-white/[0.08] bg-terminal-panel/95 shadow-[0_20px_60px_rgba(0,0,0,0.45)] backdrop-blur-xl"
          >
            <div className="border-b border-white/[0.07] px-4 py-3">
              <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-terminal-muted">Entrou como</div>
              <div className="mt-1 truncate text-xs font-medium text-white" title={userLabel ?? undefined}>
                {userLabel ?? '—'}
              </div>
            </div>
            <button
              ref={primeiroItem}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
              className="w-full px-4 py-3 text-left text-xs font-medium text-bear transition hover:bg-bear/10"
            >
              Sair do painel
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function AccountButton({
  label,
  active,
  danger = false,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  danger?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`min-w-14 rounded-md px-3 py-1.5 text-[9px] font-bold tracking-[0.14em] transition-all duration-200 disabled:opacity-50 ${
        active
          ? danger
            ? 'bg-bear/15 text-bear shadow-[inset_0_0_0_1px_rgba(234,57,67,0.12)]'
            : 'bg-white/[0.08] text-white shadow-[0_4px_12px_rgba(0,0,0,0.2)]'
          : 'text-terminal-muted hover:bg-white/[0.035] hover:text-terminal-text'
      }`}
    >
      {label}
    </button>
  );
}
