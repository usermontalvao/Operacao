import { price as formatPrice } from '../lib/format.ts';
import type { Timeframe } from '../lib/types.ts';
import { PriceChart, type ChartMarker, type ChartPlan } from './PriceChart.tsx';

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
  const plan = request.plan ?? null;
  const asset = request.symbol.replace('USDT', '');

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
          />
        </div>

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
