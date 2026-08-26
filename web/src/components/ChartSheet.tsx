import { useEffect, useState } from 'react';
import { price as formatPrice } from '../lib/format.ts';
import { api } from '../lib/api.ts';
import type { Side, Timeframe } from '../lib/types.ts';
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        className="max-h-[95vh] w-full max-w-4xl overflow-y-auto rounded-t-2xl border border-terminal-border bg-terminal-panel p-5 sm:rounded-2xl sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4">
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

        <div className="mt-4">
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
