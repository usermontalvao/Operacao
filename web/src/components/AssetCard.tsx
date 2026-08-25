import type { AssetView, TradeSetup } from '../lib/types.ts';
import { SETUP_LABEL, STATE_LABEL, changeTone, percent, price, scoreTone, stateTone } from '../lib/format.ts';

interface AssetCardProps {
  asset: AssetView;
  livePrice: number | null;
  setup: TradeSetup | null;
  onOpen: (setup: TradeSetup) => void;
}

const TREND_LABEL: Record<string, string> = {
  UP: 'ALTISTA',
  DOWN: 'BAIXISTA',
  SIDEWAYS: 'LATERAL',
};

export function AssetCard({ asset, livePrice, setup, onOpen }: AssetCardProps) {
  const current = livePrice ?? asset.price;
  const clickable = setup !== null;

  return (
    <article
      className={`rounded-xl border bg-terminal-panel p-3 transition ${
        setup && setup.visualState === 'COMPRAVEL'
          ? 'border-bull/50 shadow-[0_0_0_1px_rgba(22,199,132,0.15)]'
          : 'border-terminal-border'
      } ${clickable ? 'cursor-pointer hover:border-terminal-muted/60' : ''}`}
      onClick={() => (setup ? onOpen(setup) : undefined)}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-baseline gap-2">
            <h3 className="font-semibold">{asset.baseAsset}</h3>
            <span className="text-[10px] text-terminal-muted">/USDT</span>
          </div>
          <div className="mt-0.5 flex items-baseline gap-2 tabular">
            <span className="text-lg font-semibold">
              {asset.dataAvailable ? price(current) : 'DADOS INDISPONÍVEIS'}
            </span>
            {asset.dataAvailable ? (
              <span className={`text-xs ${changeTone(asset.changePercent24h)}`}>
                {percent(asset.changePercent24h)}
              </span>
            ) : null}
          </div>
        </div>
        {setup ? (
          <div className="text-right">
            <div className={`text-xl font-bold tabular ${scoreTone(setup.score)}`}>{setup.score}</div>
            <div className="text-[10px] text-terminal-muted">score</div>
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="rounded border border-terminal-border bg-terminal-panel-soft px-1.5 py-0.5 text-terminal-muted">
          4H {TREND_LABEL[asset.trend4h] ?? asset.trend4h}
        </span>
        {asset.rsi1h !== null ? (
          <span className="rounded border border-terminal-border bg-terminal-panel-soft px-1.5 py-0.5 text-terminal-muted tabular">
            RSI 1H {asset.rsi1h.toFixed(0)}
          </span>
        ) : null}
        {asset.relativeVolume1h !== null ? (
          <span className="rounded border border-terminal-border bg-terminal-panel-soft px-1.5 py-0.5 text-terminal-muted tabular">
            Vol {asset.relativeVolume1h.toFixed(1)}x
          </span>
        ) : null}
        {setup ? (
          <span className={`rounded border px-1.5 py-0.5 font-semibold ${stateTone(setup.visualState)}`}>
            {STATE_LABEL[setup.visualState]}
          </span>
        ) : null}
      </div>

      {setup ? (
        <div className="mt-3 border-t border-terminal-border pt-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-terminal-muted">{SETUP_LABEL[setup.setupType]} · {setup.timeframe}</span>
            <span className="tabular text-terminal-muted">R/R 1:{setup.riskReward.toFixed(1)}</span>
          </div>
          <div className="mt-1 tabular">
            Entrada <span className="font-medium">{price(setup.entryLow)}–{price(setup.entryHigh)}</span>
          </div>
        </div>
      ) : (
        <div className="mt-3 border-t border-terminal-border pt-2 text-xs text-terminal-muted">
          {asset.dataAvailable ? 'Nenhuma entrada agora' : 'Sem dados da Binance'}
        </div>
      )}
    </article>
  );
}
