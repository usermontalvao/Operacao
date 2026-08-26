import type {
  AssetView,
  EntryDecision,
  MarketKind,
  RobotState,
  Trade,
  TradeSetup,
} from '../lib/types.ts';
import { DecisionBadge } from '../components/DecisionPanel.tsx';
import { PriceLadder } from '../components/PriceLadder.tsx';
import { SymbolButton } from '../components/SymbolButton.tsx';
import { RadarSkeleton } from '../components/Skeleton.tsx';
import {
  MARKET_LABEL,
  SETUP_LABEL,
  SIDE_LABEL,
  STATE_LABEL,
  changeTone,
  percent,
  price,
  scoreTone,
  sideTone,
  stateLabel,
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
  /** ativos com posição em andamento, POR modalidade — a trava é de cada uma */
  openSymbols: Record<MarketKind, Set<string>>;
  /** com posição em qualquer modalidade; a tabela "Acompanhando" não tem coluna */
  anyOpenSymbols: Set<string>;
  binanceAvailable: boolean;
  /** a primeira leitura ainda não voltou — nada nesta tela foi respondido */
  carregando: boolean;
  /** modalidades que o painel opera agora — uma coluna para cada */
  markets: MarketKind[];
  /** o interruptor de cada robô, por modalidade */
  robots: Record<MarketKind, RobotState>;
  /** null enquanto nenhum robô está sendo ligado ou desligado */
  robotBusy: MarketKind | null;
  onToggleRobot: (market: MarketKind, enabled: boolean) => void;
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
  const {
    assets,
    setups,
    decisions,
    prices,
    openTrades,
    openSymbols,
    binanceAvailable,
    carregando,
    anyOpenSymbols,
    markets,
    robots,
    robotBusy,
    onToggleRobot,
    onOpenSetup,
    onGoToWallet,
  } = props;

  /*
    Enquanto a primeira resposta não chega, o Radar mostra a forma do que vem —
    e nenhuma afirmação. Antes ele abria dizendo "DADOS INDISPONÍVEIS — sem
    resposta da Binance" e "Nenhum setup válido agora": duas frases categóricas
    sobre um servidor a quem ainda não se tinha perguntado nada.
  */
  if (carregando) return <RadarSkeleton />;

  const visible = setups.filter((setup) => setup.ignoredAt === null);

  const openPnl = openTrades.reduce((total, trade) => {
    if (trade.status !== 'OPEN') return total;
    const current = prices[trade.symbol] ?? trade.averageFillPrice ?? trade.entryPrice;
    const entry = trade.averageFillPrice ?? trade.entryPrice;
    // o vendido ganha na queda: sem o sinal da direção, a tira do topo
    // mostraria prejuízo na hora em que a posição está indo bem
    const direction = trade.side === 'SELL' ? -1 : 1;
    return total + (current - entry) * direction * trade.remainingQuantity;
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

      {/*
        Uma coluna por modalidade.

        A mesma tese comprada aparece nas duas quando as duas estão ligadas —
        e isso não é repetição: em spot ela compra a moeda, em futuros ela
        prende margem, aceita alavancagem e tem um robô diferente decidindo.
        Juntar tudo numa lista só obrigaria a ler o carimbo de cada linha para
        saber onde a ordem cairia. Com futuros barrado sobra uma coluna, que
        ocupa a largura inteira e volta a ser exatamente a tela de antes.
      */}
      <section
        className={`grid gap-4 ${markets.length > 1 ? 'lg:grid-cols-2' : 'grid-cols-1'}`}
      >
        {markets.map((market) => (
          <MarketColumn
            key={market}
            market={market}
            setups={visible.filter((setup) => setup.market === market)}
            robot={robots[market]}
            robotBusy={robotBusy === market}
            onToggleRobot={onToggleRobot}
            prices={prices}
            decisions={decisions}
            openSymbols={openSymbols[market]}
            onOpenSetup={onOpenSetup}
          />
        ))}
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
                  inTrade={anyOpenSymbols.has(asset.symbol)}
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
 * A coluna de uma modalidade: cabeçalho com o robô dela e as suas teses.
 *
 * O interruptor mora aqui, e não num lugar só da tela, porque são dois robôs
 * de verdade — baldes de configuração separados, capital separado, e um pode
 * estar ligado enquanto o outro dorme. Um interruptor central obrigaria a
 * lembrar qual modalidade ele estava comandando, e essa é a lembrança que
 * falha justamente no dia em que o mercado se mexe.
 */
function MarketColumn({
  market,
  setups,
  robot,
  robotBusy,
  onToggleRobot,
  prices,
  decisions,
  openSymbols,
  onOpenSetup,
}: {
  market: MarketKind;
  setups: TradeSetup[];
  robot: RobotState;
  robotBusy: boolean;
  onToggleRobot: (market: MarketKind, enabled: boolean) => void;
  prices: Record<string, number>;
  decisions: Record<string, EntryDecision>;
  openSymbols: Set<string>;
  onOpenSetup: (setup: TradeSetup) => void;
}) {
  const futuros = market === 'FUTURES';
  const vendidas = setups.filter((setup) => setup.side === 'SELL').length;

  return (
    <div className="flex flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide">
          <span className={futuros ? 'text-info' : 'text-terminal-text'}>
            {MARKET_LABEL[market]}
          </span>
          <span className="text-terminal-text">{setups.length}</span>
          {vendidas > 0 ? (
            <span className="text-[10px] font-normal normal-case text-bear">
              {vendidas} vendida{vendidas > 1 ? 's' : ''}
            </span>
          ) : null}
        </h2>
        <RobotSwitch
          market={market}
          robot={robot}
          busy={robotBusy}
          onToggle={onToggleRobot}
        />
      </div>

      {setups.length === 0 ? (
        <Empty
          text={
            futuros
              ? 'Nenhuma tese em futuros agora. O sistema segue varrendo as duas modalidades.'
              : 'Nenhum setup válido agora. O sistema segue varrendo o mercado.'
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-terminal-border">
          {setups.map((setup, index) => (
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
    </div>
  );
}

/**
 * O sinal do robô daquela coluna.
 *
 * Verde pulsando é "ele age sozinho aqui". Apagado é "só entrada manual". Na
 * conta real existe um terceiro estado que nenhum dos dois cobre: ligado mas
 * desarmado — e é o mais perigoso de confundir, porque o robô parece de
 * plantão e não vai entrar. Por isso ele tem cor própria e diz o motivo.
 */
function RobotSwitch({
  market,
  robot,
  busy,
  onToggle,
}: {
  market: MarketKind;
  robot: RobotState;
  busy: boolean;
  onToggle: (market: MarketKind, enabled: boolean) => void;
}) {
  const travado = robot.enabled && robot.liveDenial !== null;
  const tom = travado
    ? 'border-warn/50 bg-warn/10 text-warn'
    : robot.enabled
      ? 'border-bull/50 bg-bull/10 text-bull'
      : 'border-terminal-border text-terminal-muted';

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onToggle(market, !robot.enabled)}
      title={
        robot.liveDenial
          ? `Robô ligado, mas sem agir na conta real: ${robot.liveDenial}`
          : robot.enabled
            ? `O robô opera sozinho em ${MARKET_LABEL[market]}`
            : `O robô está desligado em ${MARKET_LABEL[market]} — só entrada manual`
      }
      className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] font-bold tracking-wide transition disabled:opacity-40 ${tom}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          travado
            ? 'bg-warn'
            : robot.enabled
              ? 'animate-pulse bg-bull shadow-[0_0_8px_rgba(22,199,132,0.8)]'
              : 'bg-terminal-muted'
        }`}
      />
      {busy ? '···' : travado ? 'ROBÔ DESARMADO' : robot.enabled ? 'ROBÔ LIGADO' : 'ROBÔ DESLIGADO'}
    </button>
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

        {/* a direção fica ANTES do estado: ela é o que decide se "quase lá"
            quer dizer preço subindo ou preço caindo */}
        <span
          className={`rounded border px-1 py-0.5 text-[9px] font-bold ${sideTone(setup.side)}`}
          title={setup.side === 'SELL' ? 'tese vendida — ganha na queda' : 'tese comprada'}
        >
          {SIDE_LABEL[setup.side]}
        </span>

        {inTrade || bought ? (
          <span className="rounded border border-info/50 bg-info/10 px-1.5 py-0.5 text-[10px] font-semibold text-info">
            EM OPERAÇÃO
          </span>
        ) : (
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${stateTone(
              setup.visualState,
              setup.side,
            )}`}
          >
            {stateLabel(setup.visualState, setup.side)}
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
          side={setup.side}
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
