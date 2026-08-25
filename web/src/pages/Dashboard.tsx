import type { AssetView, EntryDecision, Trade, TradeSetup } from '../lib/types.ts';
import { DecisionBadge } from '../components/DecisionPanel.tsx';
import { PriceLadder } from '../components/PriceLadder.tsx';
import { SymbolButton } from '../components/SymbolButton.tsx';
import {
  SETUP_LABEL,
  STATE_LABEL,
  changeTone,
  percent,
  price,
  scoreTone,
  stateTone,
  usd,
} from '../lib/format.ts';

interface DashboardProps {
  assets: AssetView[];
  setups: TradeSetup[];
  /** decisão do robô por setup, calculada no servidor */
  decisions: Record<string, EntryDecision>;
  prices: Record<string, number>;
  openTrades: Trade[];
  /** ativos com posição em andamento */
  openSymbols: Set<string>;
  binanceAvailable: boolean;
  onOpenSetup: (setup: TradeSetup) => void;
  onGoToWallet: () => void;
}

const TREND_LABEL: Record<string, string> = {
  UP: 'ALTA',
  DOWN: 'BAIXA',
  SIDEWAYS: 'LATERAL',
};

/**
 * Radar: a mesa de trabalho.
 *
 * Três blocos e nada mais: o que está em operação (uma linha), o que dá para
 * comprar agora (uma linha por setup, com a régua de preço) e a lista de
 * acompanhamento (tabela densa). Antes eram cartões grandes repetindo a mesma
 * informação em três alturas diferentes — bonito de longe, impossível de
 * varrer com o olho.
 */
export function Dashboard(props: DashboardProps) {
  const { assets, setups, decisions, prices, openTrades, openSymbols, binanceAvailable, onOpenSetup, onGoToWallet } =
    props;
  const visible = setups.filter((setup) => setup.ignoredAt === null);

  const openPnl = openTrades.reduce((total, trade) => {
    if (trade.status !== 'OPEN') return total;
    const current = prices[trade.symbol] ?? trade.averageFillPrice ?? trade.entryPrice;
    const entry = trade.averageFillPrice ?? trade.entryPrice;
    return total + (current - entry) * trade.remainingQuantity;
  }, 0);

  return (
    <div className="space-y-5">
      {!binanceAvailable ? (
        <p className="rounded-lg border border-bear/40 bg-bear/10 p-3 text-sm text-bear">
          DADOS INDISPONÍVEIS — sem resposta da Binance. Nenhum número desta tela é estimado.
        </p>
      ) : null}

      {openTrades.length > 0 ? (
        <button
          type="button"
          onClick={onGoToWallet}
          className="flex w-full items-center justify-between rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2 text-left transition hover:border-terminal-muted/60"
        >
          <span className="flex items-center gap-2 text-xs">
            <span className="h-1.5 w-1.5 rounded-full bg-bull" />
            <span className="font-medium">
              {openTrades.length} em operação
            </span>
            <span className="text-terminal-muted">
              {openTrades.map((trade) => trade.symbol.replace('USDT', '')).join(' · ')}
            </span>
          </span>
          <span className={`text-xs font-semibold tabular ${openPnl >= 0 ? 'text-bull' : 'text-bear'}`}>
            {usd(openPnl)}
          </span>
        </button>
      ) : null}

      <section>
        <SectionTitle
          title="Setups na mesa"
          count={visible.length}
          hint="ordenados por score"
        />
        {visible.length === 0 ? (
          <Empty text="Nenhum setup válido agora. O sistema segue varrendo o mercado." />
        ) : (
          <div className="overflow-hidden rounded-xl border border-terminal-border">
            {visible.map((setup, index) => (
              <SetupRow
                key={setup.id}
                setup={setup}
                current={prices[setup.symbol] ?? setup.currentPrice}
                inTrade={openSymbols.has(setup.symbol)}
                decision={decisions[setup.id]}
                first={index === 0}
                onOpen={onOpenSetup}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle title="Acompanhando" count={assets.length} hint="tempo real" />
        <div className="overflow-x-auto rounded-xl border border-terminal-border">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="bg-terminal-panel-soft text-[10px] uppercase tracking-wide text-terminal-muted">
              <tr>
                <Th className="text-left">Ativo</Th>
                <Th className="text-right">Preço</Th>
                <Th className="text-right">24h</Th>
                <Th className="text-left">4H</Th>
                <Th className="text-right">RSI 1H</Th>
                <Th className="text-right">Vol</Th>
                <Th className="text-left">Situação</Th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <AssetRow
                  key={asset.symbol}
                  asset={asset}
                  livePrice={prices[asset.symbol] ?? null}
                  inTrade={openSymbols.has(asset.symbol)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/**
 * Uma linha por setup. A régua mostra, sem ler número nenhum, se o preço está
 * perto do stop ou perto do alvo — que é a única pergunta que importa antes de
 * abrir a tela de decisão.
 */
function SetupRow({
  setup,
  current,
  inTrade,
  decision,
  first,
  onOpen,
}: {
  setup: TradeSetup;
  current: number;
  inTrade: boolean;
  decision: EntryDecision | undefined;
  first: boolean;
  onOpen: (setup: TradeSetup) => void;
}) {
  const bought = setup.status === 'BOUGHT';
  return (
    <button
      type="button"
      onClick={() => onOpen(setup)}
      className={`flex w-full flex-col gap-2 px-3 py-2.5 text-left transition hover:bg-terminal-panel-soft ${
        first ? '' : 'border-t border-terminal-border'
      } ${inTrade || bought ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 font-semibold">{setup.symbol.replace('USDT', '')}</span>

        {inTrade || bought ? (
          <span className="rounded border border-info/50 bg-info/10 px-1.5 py-0.5 text-[10px] font-semibold text-info">
            EM OPERAÇÃO
          </span>
        ) : (
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${stateTone(setup.visualState)}`}
          >
            {STATE_LABEL[setup.visualState]}
          </span>
        )}

        <span className="hidden text-[11px] text-terminal-muted sm:inline">
          {SETUP_LABEL[setup.setupType]} · {setup.timeframe}
        </span>

        {/*
          Por que o robô não entrou, na própria linha. Antes o card mostrava
          score e R/R altos e nenhuma pista de que a compra fora recusada —
          o usuário via "95" e concluía que o sistema estava quebrado.
        */}
        {!inTrade && !bought ? <DecisionBadge decision={decision} /> : null}

        <span className="ml-auto flex items-center gap-3 text-[11px] tabular text-terminal-muted">
          <span>R/R 1:{setup.riskReward.toFixed(1)}</span>
          <span className={`text-base font-bold ${scoreTone(setup.score)}`}>{setup.score}</span>
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span className="w-14 shrink-0 text-[10px] text-bear tabular">{price(setup.stopLoss)}</span>
        <PriceLadder
          stop={setup.stopLoss}
          entryLow={setup.entryLow}
          entryHigh={setup.entryHigh}
          target={setup.target1}
          current={current}
        />
        <span className="w-16 shrink-0 text-right text-[10px] text-bull tabular">
          {price(setup.target1)}
        </span>
      </div>
    </button>
  );
}

function AssetRow({
  asset,
  livePrice,
  inTrade,
}: {
  asset: AssetView;
  livePrice: number | null;
  inTrade: boolean;
}) {
  const current = livePrice ?? asset.price;
  return (
    <tr className="border-t border-terminal-border">
      <Td className="text-left font-medium">
        <SymbolButton symbol={asset.symbol}>{asset.baseAsset}</SymbolButton>
      </Td>
      <Td className="text-right">{asset.dataAvailable ? price(current) : '—'}</Td>
      <Td className={`text-right ${changeTone(asset.changePercent24h)}`}>
        {asset.dataAvailable ? percent(asset.changePercent24h) : '—'}
      </Td>
      <Td className="text-left text-[11px] text-terminal-muted">
        {TREND_LABEL[asset.trend4h] ?? asset.trend4h}
      </Td>
      <Td className="text-right text-terminal-muted">{asset.rsi1h?.toFixed(0) ?? '—'}</Td>
      <Td className="text-right text-terminal-muted">
        {asset.relativeVolume1h === null ? '—' : `${asset.relativeVolume1h.toFixed(1)}x`}
      </Td>
      <Td className="text-left">
        {!asset.dataAvailable ? (
          <span className="text-[11px] text-terminal-muted">sem dados</span>
        ) : inTrade ? (
          <span className="text-[11px] font-medium text-info">em operação</span>
        ) : asset.visualState ? (
          <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${stateTone(asset.visualState)}`}>
            {STATE_LABEL[asset.visualState]}
          </span>
        ) : (
          <span className="text-[11px] text-terminal-muted">—</span>
        )}
      </Td>
    </tr>
  );
}

function SectionTitle({ title, count, hint }: { title: string; count: number; hint: string }) {
  return (
    <div className="mb-2 flex items-baseline justify-between">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-terminal-muted">
        {title} <span className="text-terminal-text">{count}</span>
      </h2>
      <span className="text-[10px] text-terminal-muted">{hint}</span>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-medium ${className ?? ''}`}>{children}</th>;
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 tabular ${className ?? ''}`}>{children}</td>;
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-xl border border-terminal-border bg-terminal-panel px-4 py-6 text-center text-sm text-terminal-muted">
      {text}
    </p>
  );
}
