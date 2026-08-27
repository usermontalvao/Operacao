import { useEffect, useState } from 'react';
import { price as formatPrice } from '../lib/format.ts';
import { api } from '../lib/api.ts';
import { useAtalhosDeModal } from '../lib/atalhos.ts';
import type { Side, Timeframe, TradingMode } from '../lib/types.ts';
import {
  PriceChart,
  type ChartMarker,
  type ChartPlan,
  type EditableChartLevel,
} from './PriceChart.tsx';

export interface ChartRequest {
  symbol: string;
  /** o que a tela de origem sabe do plano: stop, entrada e alvos */
  plan?: ChartPlan | null;
  timeframe?: Timeframe;
  /** de onde veio o clique — "posição aberta", "operação encerrada"… */
  note?: string | null;
  /** entrada e saída desenhadas sobre os candles em que aconteceram */
  markers?: ChartMarker[] | null;
  /** momento que a tela enquadra ao abrir: o encerramento, e não "agora" */
  focusTime?: number | null;
  /** presente somente para uma posição aberta cujo plano pode ser rearmado */
  tradeId?: string;
  side?: Side;
  /** conta da posição — decide o aviso do encerramento */
  mode?: TradingMode;
  /** avisado depois de encerrar, para a tela de origem se atualizar */
  onClosed?: () => void;
}

/**
 * O gráfico de qualquer ativo, aberto de qualquer lugar.
 *
 * A ficha do setup (SetupSheet) responde "compro ou não"; esta responde
 * apenas "como está o preço". Por isso ela não tem score, nem botão de
 * compra: quem clica no nome de uma moeda numa lista quer ver o gráfico, não
 * tomar uma decisão de entrada.
 */
export function ChartSheet({
  request,
  livePrice,
  onClose,
}: {
  request: ChartRequest;
  livePrice: number | null;
  onClose: () => void;
}) {
  const initialPlan = completePlan(request.plan);
  const [savedPlan, setSavedPlan] = useState(initialPlan);
  const [draftPlan, setDraftPlan] = useState(initialPlan);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /*
    Encerrar em dois passos, dentro da própria janela.

    Não é `window.confirm`: o alerta do navegador tira o gráfico da frente
    justamente quando ele é a informação que sustenta a decisão, e não cabe o
    aviso do que vai acontecer na corretora. Aqui o segundo clique acontece
    olhando para o preço.
  */
  const [confirmandoSaida, setConfirmandoSaida] = useState(false);
  const [encerrando, setEncerrando] = useState(false);
  const [encerrada, setEncerrada] = useState(false);
  const editable = request.tradeId !== undefined && draftPlan !== null;
  const dirty = savedPlan !== null && draftPlan !== null && !samePlan(savedPlan, draftPlan);
  const plan = draftPlan ?? request.plan ?? null;
  const asset = request.symbol.replace('USDT', '');

  useEffect(() => {
    const next = completePlan(request.plan);
    setSavedPlan(next);
    setDraftPlan(next);
    setError(null);
    setMessage(null);
    setConfirmandoSaida(false);
    setEncerrada(false);
  }, [request.symbol, request.tradeId, request.plan]);

  const moveLevel = (level: EditableChartLevel, value: number): void => {
    setDraftPlan((current) => (current ? { ...current, [level]: value } : current));
    setError(null);
    setMessage(null);
  };

  const applyPlan = async (): Promise<void> => {
    if (!request.tradeId || !draftPlan || !dirty) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const trade = await api.updateTradePlan(request.tradeId, {
        stopLoss: draftPlan.stopLoss,
        target1: draftPlan.target1,
        target2: draftPlan.target2,
        target3: draftPlan.target3,
      });
      const applied = completePlan({
        entryLow: trade.averageFillPrice ?? trade.entryPrice,
        entryHigh: trade.averageFillPrice ?? trade.entryPrice,
        stopLoss: trade.stopLoss,
        target1: trade.target1,
        target2: trade.target2,
        target3: trade.target3,
      });
      setSavedPlan(applied);
      setDraftPlan(applied);
      setMessage(
        trade.mode === 'PAPER'
          ? 'Plano atualizado na simulação.'
          : 'Plano atualizado e proteção rearmada na Binance.',
      );
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const encerrar = async (): Promise<void> => {
    if (!request.tradeId) return;
    setEncerrando(true);
    setError(null);
    setMessage(null);
    try {
      const trade = await api.closeTrade(request.tradeId);
      setEncerrada(true);
      setConfirmandoSaida(false);
      setMessage(
        `Posição encerrada — resultado ${trade.realizedPnl >= 0 ? '+' : ''}${trade.realizedPnl.toFixed(2)} USDT.`,
      );
      request.onClosed?.();
    } catch (failure) {
      setError((failure as Error).message);
      setConfirmandoSaida(false);
    } finally {
      setEncerrando(false);
    }
  };

  // Esc fecha; Enter aplica o plano ajustado. Encerrar posição NÃO entra no
  // Enter: é dinheiro saindo, e já tem os seus dois cliques.
  useAtalhosDeModal({
    onClose,
    onConfirm: () => void applyPlan(),
    confirmHabilitado: editable && dirty && !saving,
  });

  const avisoDeSaida =
    request.mode === 'PAPER'
      ? 'Na conta DEMO a saída é simulada pelo preço atual.'
      : 'As proteções serão canceladas e a quantidade restante vendida a mercado. O preço final pode variar.';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      {/*
        Coluna, não bloco rolante.

        A janela inteira rolava: para chegar em "aplicar" — ou agora em
        "encerrar" — era preciso rolar para longe do gráfico, que é justamente
        o que sustenta a decisão. Aqui o cabeçalho e as ações ficam parados, o
        gráfico ocupa o que sobra, e a rolagem só existe se o conteúdo do meio
        realmente não couber.
      */}
      <div
        className="flex max-h-[95vh] w-full max-w-4xl flex-col rounded-t-2xl border border-terminal-border bg-terminal-panel p-5 sm:rounded-2xl sm:p-6 lg:max-w-5xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold">
              {asset}
              <span className="text-terminal-muted">/USDT</span>
            </h2>
            <p className="mt-0.5 text-sm text-terminal-muted">
              {livePrice === null ? 'sem preço agora' : formatPrice(livePrice)}
              {request.note ? ` · ${request.note}` : ''}
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

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <PriceChart
            symbol={request.symbol}
            timeframe={request.timeframe ?? '1h'}
            plan={plan}
            markers={request.markers ?? null}
            focusTime={request.focusTime ?? null}
            livePrice={livePrice}
            editableLevels={editable ? ['stopLoss', 'target1', 'target2', 'target3'] : []}
            onLevelChange={editable ? (level, value) => moveLevel(level, value) : undefined}
          />

        </div>

        <div className="shrink-0">
        {editable ? (
          <div className="mt-3 rounded-lg border border-terminal-border bg-terminal-panel-soft p-3">
            <p className="text-[11px] text-terminal-muted">
              Arraste uma linha e revise os preços. A corretora só muda depois de clicar em aplicar.
            </p>
            {error ? <p className="mt-2 text-xs text-bear">{error}</p> : null}
            {message ? <p className="mt-2 text-xs text-bull">{message}</p> : null}
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                disabled={!dirty || saving}
                onClick={() => {
                  setDraftPlan(savedPlan);
                  setError(null);
                }}
                className="rounded-lg border border-terminal-border px-3 py-2 text-xs text-terminal-muted disabled:opacity-40"
              >
                Desfazer
              </button>
              <button
                type="button"
                disabled={!dirty || saving}
                onClick={() => void applyPlan()}
                className="rounded-lg bg-warn px-3 py-2 text-xs font-bold text-black disabled:opacity-40"
              >
                {saving ? 'Rearmando…' : 'Aplicar stop e alvos'}
              </button>
            </div>
          </div>
        ) : null}

        {request.tradeId !== undefined && !encerrada ? (
          <div className="mt-3 rounded-lg border border-bear/30 bg-bear/[0.04] p-3">
            {confirmandoSaida ? (
              <>
                <p className="text-xs font-semibold text-bear">Encerrar {asset} agora?</p>
                <p className="mt-1 text-[11px] leading-relaxed text-terminal-muted">{avisoDeSaida}</p>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={encerrando}
                    onClick={() => setConfirmandoSaida(false)}
                    className="rounded-lg border border-terminal-border px-3 py-2 text-xs text-terminal-muted disabled:opacity-40"
                  >
                    Manter posição
                  </button>
                  <button
                    type="button"
                    disabled={encerrando}
                    onClick={() => void encerrar()}
                    className="rounded-lg bg-bear px-3 py-2 text-xs font-bold text-white disabled:opacity-40"
                  >
                    {encerrando ? 'Encerrando…' : 'Confirmar encerramento'}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] text-terminal-muted">
                  Sair agora, a mercado, em vez de esperar alvo ou stop.
                </p>
                <button
                  type="button"
                  onClick={() => setConfirmandoSaida(true)}
                  className="shrink-0 rounded-lg border border-bear/50 px-3 py-2 text-xs font-bold text-bear transition hover:bg-bear/10"
                >
                  Encerrar posição
                </button>
              </div>
            )}
          </div>
        ) : null}

        {plan ? (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[11px] tabular text-terminal-muted">
            {plan.stopLoss ? <span className="text-bear">stop {formatPrice(plan.stopLoss)}</span> : null}
            {plan.entryLow ? <span>entrada {formatPrice(plan.entryLow)}</span> : null}
            {plan.target1 ? <span className="text-bull">alvo {formatPrice(plan.target1)}</span> : null}
          </div>
        ) : null}

        <div className="mt-4 flex justify-end">
          <a
            href={`https://www.tradingview.com/chart/?symbol=BINANCE:${request.symbol}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-terminal-border px-3 py-2 text-xs text-terminal-muted hover:text-terminal-text"
          >
            Abrir no TradingView
          </a>
        </div>
        </div>
      </div>
    </div>
  );
}

interface CompletePlan extends ChartPlan {
  stopLoss: number;
  target1: number;
  target2: number | null;
  target3: number | null;
}

function completePlan(plan: ChartPlan | null | undefined): CompletePlan | null {
  if (!plan || !plan.stopLoss || !plan.target1) return null;
  return {
    ...plan,
    stopLoss: plan.stopLoss,
    target1: plan.target1,
    target2: plan.target2 ?? null,
    target3: plan.target3 ?? null,
  };
}

function samePlan(a: CompletePlan, b: CompletePlan): boolean {
  return (
    a.stopLoss === b.stopLoss &&
    a.target1 === b.target1 &&
    a.target2 === b.target2 &&
    a.target3 === b.target3
  );
}
