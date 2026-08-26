import { useState } from 'react';
import type { EntryDecision, TradeSetup } from '../lib/types.ts';
import {
  CLASSIFICATION_LABEL,
  MARKET_LABEL,
  SETUP_LABEL,
  SIDE_LABEL,
  SIDE_VERB,
  distanceToEntry,
  percent,
  price,
  scoreTone,
  sideButton,
  sideTone,
  stateLabel,
  stateTone,
} from '../lib/format.ts';
import { PriceChart } from './PriceChart.tsx';
import { DecisionPanel } from './DecisionPanel.tsx';

interface SetupSheetProps {
  setup: TradeSetup;
  livePrice: number | null;
  onClose: () => void;
  onBuy: (setup: TradeSetup) => void;
  onIgnore: (setup: TradeSetup) => void;
  /** já existe posição aberta neste ativo */
  inTrade: boolean;
  /** a decisão do robô, vinda do servidor */
  decision?: EntryDecision;
}

/**
 * Tela de decisão. A ordem da informação é proposital: em poucos segundos o
 * usuário vê ativo, preço, entrada, stop, alvos, R/R e score. No desktop o
 * gráfico ocupa a coluna maior; no celular ele vem depois dos números.
 */
export function SetupSheet({ setup, livePrice, onClose, onBuy, onIgnore, inTrade, decision }: SetupSheetProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const current = livePrice ?? setup.currentPrice;
  const distance = distanceToEntry(setup, current);
  const dead = setup.status === 'INVALIDATED' || setup.status === 'EXPIRED';
  const vendida = setup.side === 'SELL';

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/75 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        className="max-h-[95vh] w-full max-w-5xl overflow-y-auto rounded-t-2xl border border-terminal-border bg-terminal-panel p-5 sm:rounded-2xl sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
              <span>
                {setup.symbol.replace('USDT', '')}
                <span className="text-terminal-muted">/USDT</span>
              </span>
              {/* direção e modalidade no título: quem abre esta tela decide
                  aqui, e decidir sem saber o lado é decidir outra coisa */}
              <span
                className={`rounded border px-2 py-0.5 text-xs font-bold ${sideTone(setup.side)}`}
              >
                {SIDE_LABEL[setup.side]}
              </span>
              <span className="rounded border border-terminal-border px-2 py-0.5 text-[10px] font-semibold tracking-wide text-terminal-muted">
                {MARKET_LABEL[setup.market]}
              </span>
            </h2>
            <p className="mt-0.5 text-sm text-terminal-muted">
              {SETUP_LABEL[setup.setupType]} · gatilho {setup.timeframe} · viés {setup.anchorTimeframe}
              {vendida ? ' · ganha quando o preço cai' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-terminal-border px-3 py-1.5 text-xs text-terminal-muted hover:text-terminal-text"
          >
            Fechar
          </button>
        </header>

        <div className="mt-4">
          <DecisionPanel
            decision={decision}
            entryLow={setup.entryLow}
            entryHigh={setup.entryHigh}
            currentPrice={current}
          />
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <section className="order-2 space-y-5 lg:order-1">
            <PriceChart
              symbol={setup.symbol}
              timeframe={setup.timeframe}
              plan={setup}
              livePrice={livePrice}
            />

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-terminal-muted">
                Por que este setup existe
              </h3>
              <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {setup.reasons.map((reason) => (
                  <li key={reason} className="flex gap-2 text-sm">
                    <span className="text-bull">✓</span>
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowBreakdown((value) => !value)}
                className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-terminal-muted"
              >
                <span>Como o score foi montado</span>
                <span>{showBreakdown ? '−' : '+'}</span>
              </button>
              {showBreakdown ? (
                <div className="mt-2 space-y-1.5 rounded-xl border border-terminal-border bg-terminal-panel-soft p-3">
                  {setup.scoreBreakdown.components.map((component) => (
                    <ScoreRow
                      key={component.key}
                      label={component.label}
                      points={component.points}
                      detail={component.detail}
                      max={component.maxPoints}
                    />
                  ))}
                  {setup.scoreBreakdown.penalties.map((penalty) => (
                    <ScoreRow
                      key={penalty.key}
                      label={penalty.label}
                      points={penalty.points}
                      detail={penalty.detail}
                      max={0}
                    />
                  ))}
                  <div className="flex items-center justify-between border-t border-terminal-border pt-2 text-sm font-semibold">
                    <span>Total</span>
                    <span className={scoreTone(setup.score)}>{setup.score}/100</span>
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <aside className="order-1 space-y-4 lg:order-2">
            <div className="flex items-center justify-between rounded-xl border border-terminal-border bg-terminal-panel-soft p-4">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-terminal-muted">Preço agora</div>
                <div className="text-3xl font-semibold tabular">{price(current)}</div>
                <div className="mt-0.5 text-xs text-terminal-muted tabular">
                  {distance === 0 ? 'dentro da zona de entrada' : `${percent(distance)} da zona`}
                </div>
              </div>
              <div className="text-right">
                <div className={`text-4xl font-bold tabular ${scoreTone(setup.score)}`}>{setup.score}</div>
                <div className="text-[10px] text-terminal-muted">
                  {CLASSIFICATION_LABEL[setup.classification]}
                </div>
                <span
                  className={`mt-1.5 inline-block rounded border px-2 py-0.5 text-[10px] font-semibold ${stateTone(
                    setup.visualState,
                    setup.side,
                  )}`}
                >
                  {stateLabel(setup.visualState, setup.side)}
                </span>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-2.5 text-sm">
              <Field
                label="Entrada"
                value={`${price(setup.entryLow)} – ${price(setup.entryHigh)}`}
                tone="text-terminal-text"
                wide
              />
              <Field
                label={vendida ? 'Invalidação (acima)' : 'Invalidação'}
                value={price(setup.stopLoss)}
                tone="text-bear"
              />
              <Field label="Risco / retorno" value={`1:${setup.riskReward.toFixed(1)}`} tone="text-terminal-text" />
              <Field label="Alvo 1" value={price(setup.target1)} tone="text-bull" />
              <Field label="Alvo 2" value={setup.target2 ? price(setup.target2) : '—'} tone="text-bull" />
              <Field label="Alvo 3" value={setup.target3 ? price(setup.target3) : '—'} tone="text-bull" />
              <Field label="Contexto BTC" value={setup.btcContext.replace('BTC_', '')} tone="text-terminal-muted" />
            </dl>

            {setup.extended ? (
              <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
                <strong>Esticado — aguardar pullback.</strong>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {setup.extensionReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {setup.invalidationNote ? (
              <p className="rounded-xl border border-bear/40 bg-bear/10 p-3 text-xs text-bear">
                {setup.invalidationNote}
              </p>
            ) : null}

            <div className="space-y-2">
              {/*
                Entrar de novo no que já está aberto dobraria o risco no mesmo
                ativo. O servidor recusa — mas o botão precisa dizer isso ANTES
                do clique, não depois do erro.

                O verbo e a cor saem do LADO. Um botão verde escrito COMPRAR
                numa tese vendida é o pior erro possível desta tela: o usuário
                confirma lendo o botão.
              */}
              <button
                type="button"
                onClick={() => onBuy(setup)}
                disabled={dead || inTrade}
                className={`w-full rounded-xl px-4 py-4 text-base font-bold disabled:opacity-40 ${sideButton(
                  setup.side,
                )}`}
              >
                {inTrade
                  ? 'JÁ EM OPERAÇÃO'
                  : `${SIDE_VERB[setup.side].toUpperCase()} SETUP`}
              </button>
              {inTrade ? (
                <p className="text-center text-[11px] text-terminal-muted">
                  Você já tem posição aberta em {setup.symbol.replace('USDT', '')}. Acompanhe na aba
                  Operações.
                </p>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <a
                  href={`https://www.tradingview.com/chart/?symbol=BINANCE:${setup.symbol}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-xl border border-terminal-border px-3 py-3 text-center text-xs text-terminal-muted hover:text-terminal-text"
                >
                  Abrir no TradingView
                </a>
                <button
                  type="button"
                  onClick={() => onIgnore(setup)}
                  className="rounded-xl border border-terminal-border px-3 py-3 text-center text-xs text-terminal-muted hover:text-terminal-text"
                >
                  Ignorar
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  tone,
  wide,
}: {
  label: string;
  value: string;
  tone: string;
  wide?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border border-terminal-border bg-terminal-panel-soft p-3 ${
        wide ? 'col-span-2' : ''
      }`}
    >
      <dt className="text-[10px] uppercase tracking-wide text-terminal-muted">{label}</dt>
      <dd className={`mt-0.5 tabular text-base font-medium ${tone}`}>{value}</dd>
    </div>
  );
}

function ScoreRow({
  label,
  points,
  detail,
  max,
}: {
  label: string;
  points: number;
  detail: string;
  max: number;
}) {
  const positive = points >= 0;
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-terminal-muted">{detail}</div>
      </div>
      <div className={`shrink-0 tabular font-semibold ${positive ? 'text-bull' : 'text-bear'}`}>
        {positive ? '+' : ''}
        {points}
        {max > 0 ? <span className="text-terminal-muted">/{max}</span> : null}
      </div>
    </div>
  );
}
