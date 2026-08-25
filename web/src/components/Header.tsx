import { useEffect, useRef, useState } from 'react';
import type { ConnectionState, MarketContext, TradingMode } from '../lib/types.ts';
import type { AccountBalanceResponse } from '../lib/api.ts';
import { brl, quantity, usd } from '../lib/format.ts';
import type { LiveEquity } from '../lib/equity.ts';

const CONTEXT_LABEL: Record<string, string> = {
  BTC_BULLISH: 'BTC comprador',
  BTC_NEUTRAL: 'BTC neutro',
  BTC_BEARISH: 'BTC vendedor',
  BTC_HIGH_VOLATILITY: 'BTC volátil',
};

const CONTEXT_TONE: Record<string, string> = {
  BTC_BULLISH: 'text-bull border-bull/40 bg-bull/10',
  BTC_NEUTRAL: 'text-terminal-muted border-terminal-border bg-terminal-panel-soft',
  BTC_BEARISH: 'text-bear border-bear/40 bg-bear/10',
  BTC_HIGH_VOLATILITY: 'text-warn border-warn/40 bg-warn/10',
};

interface HeaderProps {
  mode: TradingMode;
  balance: AccountBalanceResponse | null;
  /** patrimônio recalculado a cada tique de preço */
  liveEquity: LiveEquity;
  switchingMode: boolean;
  modeError: string | null;
  onModeChange: (mode: 'PAPER' | 'LIVE') => void;
  connection: ConnectionState;
  streamConnected: boolean;
  context: MarketContext | null;
  activeSetups: number;
  autoTradeOn: boolean;
  robotBusy: boolean;
  onToggleRobot: () => void;
  halted: boolean;
  /** as abas de navegação, renderizadas dentro do cabeçalho no monitor */
  tabs: React.ReactNode;
  watchedSymbols: number;
  universe: { enabled: boolean; liquid: number; cursor: number } | null;
  /** quem está logado; null enquanto a sessão não foi lida */
  userLabel: string | null;
  onLogout: () => void;
}

export function Header(props: HeaderProps) {
  const {
    mode,
    balance,
    liveEquity,
    switchingMode,
    modeError,
    onModeChange,
    connection,
    streamConnected,
    context,
    activeSetups,
    autoTradeOn,
    robotBusy,
    onToggleRobot,
    halted,
    tabs,
    watchedSymbols,
    universe,
    userLabel,
    onLogout,
  } = props;
  const connectionLabel =
    !streamConnected ? 'OFFLINE' : connection === 'LIVE' ? 'LIVE' : connection === 'RECONNECTING' ? 'RECONECTANDO' : 'OFFLINE';
  const connectionTone =
    connectionLabel === 'LIVE'
      ? 'text-bull border-bull/40 bg-bull/10 ring-live'
      : connectionLabel === 'RECONECTANDO'
        ? 'text-warn border-warn/40 bg-warn/10'
        : 'text-bear border-bear/40 bg-bear/10';
  const demoSelected = mode !== 'LIVE';

  // o saldo do topo é o patrimônio AGORA, com as posições marcadas a mercado —
  // não o caixa parado, que só se mexe quando uma operação encerra
  const balanceReady = balance !== null && !switchingMode;
  const balanceLabel = balanceReady ? `${quantity(liveEquity.equity)} USDT` : '—';
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
  const openTone =
    liveEquity.unrealized > 0 ? 'text-bull' : liveEquity.unrealized < 0 ? 'text-bear' : 'text-terminal-muted';

  return (
    <header className="sticky top-0 z-30 border-b border-terminal-border bg-terminal-bg/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold tracking-tight">Crypto Hunter</span>
          </div>

          <div className="order-3 flex w-full items-center justify-between gap-2 rounded-xl border border-terminal-border bg-terminal-panel p-1.5 sm:order-none sm:w-auto sm:justify-start">
            <div className="flex rounded-lg bg-terminal-bg p-0.5">
              <AccountButton
                label="DEMO"
                active={demoSelected}
                disabled={switchingMode}
                onClick={() => onModeChange('PAPER')}
              />
              <AccountButton
                label="REAL"
                active={mode === 'LIVE'}
                danger
                disabled={switchingMode}
                onClick={() => onModeChange('LIVE')}
              />
            </div>
            <div className="flex items-center gap-2 border-l border-terminal-border pl-2.5 pr-1">
              <div className="text-right tabular leading-tight">
                <div className="text-sm font-bold">{balanceLabel}</div>
                <div className="text-[10px] text-terminal-muted">
                  {balanceInBrl ?? (mode === 'LIVE' ? 'conta real' : 'conta demo')}
                </div>
              </div>

              {openState !== 'nenhuma' ? (
                <div
                  className={`shrink-0 rounded-md border px-1.5 py-1 text-right leading-tight tabular ${
                    openState === 'carregando'
                      ? 'border-terminal-border bg-terminal-bg text-terminal-muted'
                      : liveEquity.unrealized > 0
                        ? 'border-bull/30 bg-bull/10'
                        : liveEquity.unrealized < 0
                          ? 'border-bear/30 bg-bear/10'
                          : 'border-terminal-border bg-terminal-bg'
                  }`}
                  title={`${liveEquity.positions} posição(ões) em aberto`}
                >
                  <div className={`text-xs font-bold ${openState === 'pronto' ? openTone : ''}`}>
                    {openState === 'carregando'
                      ? '···'
                      : `${liveEquity.unrealized > 0 ? '+' : ''}${usd(liveEquity.unrealized)}`}
                  </div>
                  <div className="text-[9px] uppercase tracking-wide text-terminal-muted">aberto</div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/*
              O distintivo do robô é um botão, não um enfeite. Quem percebe que
              algo está errado precisa de um clique até parar — não de uma
              viagem até a aba de ajustes.
            */}
            <button
              type="button"
              disabled={robotBusy}
              onClick={onToggleRobot}
              aria-pressed={autoTradeOn}
              title={autoTradeOn ? 'Clique para desligar o robô' : 'Clique para ligar o robô'}
              className={`rounded border px-2 py-0.5 text-[10px] font-bold tracking-wider transition disabled:opacity-50 ${
                halted
                  ? 'border-warn/50 bg-warn/10 text-warn'
                  : autoTradeOn
                    ? 'border-bull/50 bg-bull/10 text-bull hover:bg-bull/20'
                    : 'border-terminal-border bg-terminal-panel-soft text-terminal-muted hover:text-terminal-text'
              }`}
            >
              {robotBusy ? 'ROBÔ …' : halted ? 'ROBÔ PARADO' : autoTradeOn ? 'ROBÔ ON' : 'ROBÔ OFF'}
            </button>
            <span className={`rounded border px-2 py-0.5 text-[10px] font-bold tracking-wider ${connectionTone}`}>
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

        <div className="flex min-w-0 items-center justify-between gap-3">
          {tabs}
          {/*
            min-w-0 é obrigatório: sem ele um filho com overflow-x recusa-se a
            encolher dentro do flex e empurra a página inteira para o lado.
          */}
          <div className="flex min-w-0 flex-1 items-center justify-end gap-3 overflow-x-auto text-xs tabular [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {context ? (
            <span
              className={`shrink-0 rounded border px-2 py-0.5 text-[10px] font-semibold ${
                CONTEXT_TONE[context.state] ?? CONTEXT_TONE.BTC_NEUTRAL
              }`}
              title={context.reasons.join(' · ')}
            >
              {CONTEXT_LABEL[context.state] ?? context.state}
              <span className="ml-1 opacity-70">
                {context.scoreModifier > 0 ? '+' : ''}
                {context.scoreModifier}
              </span>
            </span>
          ) : null}
          <span className="hidden shrink-0 rounded border border-terminal-border bg-terminal-panel-soft px-2 py-0.5 text-[10px] text-terminal-muted lg:inline">
            {activeSetups} setup{activeSetups === 1 ? '' : 's'} na tela
          </span>
          <span
            className="hidden shrink-0 rounded border border-terminal-border bg-terminal-panel-soft px-2 py-0.5 text-[10px] text-terminal-muted xl:inline"
            title="pares acompanhados ao vivo · varredura do mercado"
          >
            {watchedSymbols} ao vivo
            {universe?.enabled ? ` · ${universe.cursor}/${universe.liquid} varridos` : ''}
          </span>
          </div>
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
        className="flex h-6 w-6 items-center justify-center rounded-full border border-terminal-border bg-terminal-panel-soft text-[10px] font-bold text-terminal-muted transition hover:border-terminal-muted hover:text-terminal-text"
      >
        {inicial}
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            role="menu"
            className="absolute right-0 z-50 mt-1.5 w-56 overflow-hidden rounded-lg border border-terminal-border bg-terminal-panel shadow-xl"
          >
            <div className="border-b border-terminal-border px-3 py-2">
              <div className="text-[9px] uppercase tracking-wide text-terminal-muted">Entrou como</div>
              <div className="truncate text-xs font-medium" title={userLabel ?? undefined}>
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
              className="w-full px-3 py-2 text-left text-xs text-bear transition hover:bg-bear/10"
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
      className={`rounded-md px-3 py-1 text-[10px] font-bold tracking-wider transition disabled:opacity-50 ${
        active
          ? danger
            ? 'bg-bear/15 text-bear'
            : 'bg-bull/15 text-bull'
          : 'text-terminal-muted hover:text-terminal-text'
      }`}
    >
      {label}
    </button>
  );
}
