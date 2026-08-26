import type { AssetView, TradeSetup } from '../lib/types.ts';
import {
  SETUP_LABEL,
  SIDE_LABEL,
  changeTone,
  percent,
  price,
  scoreTone,
  stateLabel,
  stateTone,
  sideTone,
} from '../lib/format.ts';

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
          ? setup.side === 'SELL'
            ? 'border-bear/50 shadow-[0_0_0_1px_rgba(234,57,67,0.15)]'
            : 'border-bull/50 shadow-[0_0_0_1px_rgba(22,199,132,0.15)]'
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
          <span
            className={`rounded border px-1.5 py-0.5 font-semibold ${stateTone(
              setup.visualState,
              setup.side,
            )}`}
          >
            {stateLabel(setup.visualState, setup.side)}
          </span>
        ) : null}
      </div>

      {setup ? (
        <div className="mt-3 border-t border-terminal-border pt-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-terminal-muted">
              {/* a direção antes do nome do setup: é o que muda o significado
                  de todos os números que vêm depois dela */}
              <span
                className={`rounded border px-1 py-px text-[9px] font-bold ${sideTone(setup.side)}`}
              >
                {SIDE_LABEL[setup.side]}
              </span>
              {SETUP_LABEL[setup.setupType]} · {setup.timeframe}
            </span>
            <span className="tabular text-terminal-muted">R/R 1:{setup.riskReward.toFixed(1)}</span>
          </div>
          <div className="mt-1 tabular">
            Entrada <span className="font-medium">{price(setup.entryLow)}–{price(setup.entryHigh)}</span>
          </div>
          {/*
            No micro scalp o custo NÃO é ruído perto do alvo — ele é metade da
            conta. Mostrar só entrada e R/R aqui repetiria, no cartão, o erro
            que o módulo inteiro existe para evitar: um número que parece bom
            porque a taxa ficou de fora dele.
          */}
          {setup.micro ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
              <span className="rounded bg-bull/10 px-1 py-px font-bold text-bull">MICRO SCALP · 1M</span>
              <span className="text-terminal-muted">
                faixa {setup.micro.regime.amplitudePercent.toFixed(2)}%
              </span>
              <span className="text-terminal-muted">
                custo {setup.micro.economics.allInCostPercent.toFixed(2)}%
              </span>
              <span
                className={
                  setup.micro.economics.netExpectedProfitPercent > 0 ? 'text-bull' : 'text-bear'
                }
              >
                líquido {setup.micro.economics.netExpectedProfitPercent >= 0 ? '+' : ''}
                {setup.micro.economics.netExpectedProfitPercent.toFixed(2)}%
              </span>
              {/* a ressalva viaja com o cartão, não só com a tese aberta:
                  quem decide olhando a lista precisa ver o mesmo alerta */}
              {setup.micro.economics.warning ? (
                <span className="rounded bg-bear/15 px-1 py-px font-bold text-bear">⚠ sem margem</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 border-t border-terminal-border pt-2 text-xs text-terminal-muted">
          {asset.dataAvailable ? 'Nenhuma entrada agora' : 'Sem dados da Binance'}
        </div>
      )}
    </article>
  );
}
