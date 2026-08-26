import { useState } from 'react';
import type {
  AssetView,
  EntryDecision,
  Timeframe,
  MarketKind,
  RobotState,
  Trade,
  TradeSetup,
} from '../lib/types.ts';
import { MICRO_TIMEFRAME } from '../../../src/core/types.ts';
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
  const filledCount = openTrades.filter((trade) => trade.status === 'OPEN').length;
  const pendingCount = openTrades.filter((trade) => trade.status === 'PENDING').length;
  const operationLabel =
    filledCount > 0
      ? `${filledCount} aberta${filledCount === 1 ? '' : 's'}${pendingCount > 0 ? ` · ${pendingCount} aguardando` : ''}`
      : `${pendingCount} ordem${pendingCount === 1 ? '' : 's'} aguardando`;

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
            <span className={`h-1.5 w-1.5 rounded-full ${filledCount > 0 ? 'bg-bull' : 'bg-warn'}`} />
            <span className="font-medium">
              {operationLabel}
            </span>
            <span className="text-terminal-muted">
              {openTrades.map((trade) => trade.symbol.replace('USDT', '')).join(' · ')}
            </span>
          </span>
          <span
            className={`text-xs font-semibold tabular ${
              filledCount === 0 ? 'text-warn' : openPnl >= 0 ? 'text-bull' : 'text-bear'
            }`}
          >
            {/* mesma regra da carteira: o espaço é do resultado, e ordem que
                não preencheu não tem resultado — tem espera */}
            {filledCount === 0 ? 'ainda não entrou' : usd(openPnl)}
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
            sozinha={markets.length === 1}
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
/**
 * Do mais curto para o mais longo — a ordem em que se lê um gráfico, não a
 * ordem em que os setups apareceram na varredura. `MICRO_TIMEFRAME` é
 * nomeado em vez de escrito para que o dia em que ele mudar não deixe um
 * '1m' solto aqui.
 */
const ORDEM_TIMEFRAME: Timeframe[] = [MICRO_TIMEFRAME, '15m', '1h', '4h', '1d'];

function MarketColumn({
  market,
  setups,
  sozinha,
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
  /** é a única modalidade na tela — então não há o que distinguir */
  sozinha: boolean;
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

  /*
   * Filtro por tempo gráfico.
   *
   * As teses da mesa não são comparáveis entre si: uma de 1 minuto dura três
   * minutos e exige olhar agora; uma de 1 dia pode esperar a semana. Numa
   * lista única ordenada por nota, a mais urgente aparece no meio das que não
   * são — e é o tempo gráfico, não o tipo de setup, que separa as duas coisas.
   *
   * Seleção MÚLTIPLA, com tudo ligado por padrão: o filtro serve para tirar
   * ruído da vista, e um seletor único obrigaria a escolher entre 1m e 15m
   * quando a resposta natural é "esses dois, sem o resto".
   */
  const [ocultos, setOcultos] = useState<Set<Timeframe>>(new Set());
  const contagem = new Map<Timeframe, number>();
  for (const setup of setups) {
    contagem.set(setup.timeframe, (contagem.get(setup.timeframe) ?? 0) + 1);
  }
  /* na ordem do mais curto para o mais longo, não na ordem em que apareceram */
  const presentes = ORDEM_TIMEFRAME.filter((tf) => contagem.has(tf));
  const visiveis = setups.filter((setup) => !ocultos.has(setup.timeframe));
  const alternar = (tf: Timeframe): void =>
    setOcultos((atual) => {
      const proximo = new Set(atual);
      if (proximo.has(tf)) proximo.delete(tf);
      else proximo.add(tf);
      return proximo;
    });

  return (
    <div className="flex flex-col">
      {/*
        Com futuros barrado o carimbo da modalidade não informa nada.

        Escrever "SPOT" sobre a única lista da tela é responder a uma pergunta
        que ninguém fez — e era assim que a tela funcionava antes de os futuros
        existirem: uma seção chamada "Setups na mesa", ocupando a largura
        inteira. O interruptor do robô continua, porque ele não é rótulo: é
        controle, e some com ele seria perder função para ganhar limpeza.
      */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide">
          <span className={sozinha ? 'text-terminal-muted' : futuros ? 'text-info' : 'text-terminal-text'}>
            {sozinha ? 'Setups na mesa' : MARKET_LABEL[market]}
          </span>
          <span className="text-terminal-text">{visiveis.length}</span>
          {/* com filtro ativo, o total continua visível: sumir com ele faria a
              lista encolhida parecer o mercado inteiro */}
          {visiveis.length !== setups.length ? (
            <span className="text-[10px] font-normal normal-case text-terminal-muted">
              de {setups.length}
            </span>
          ) : null}
          {vendidas > 0 ? (
            <span className="text-[10px] font-normal normal-case text-bear">
              {vendidas} vendida{vendidas > 1 ? 's' : ''}
            </span>
          ) : null}

          {/*
            Os tempos gráficos ficam ao LADO do título, não numa linha própria:
            eles são a legenda da contagem que está logo antes deles. Só
            aparecem com mais de um tempo na mesa — com um só, seriam um
            controle que não controla nada.
          */}
          {presentes.length > 1 ? (
            <span className="flex flex-wrap items-center gap-1">
              {presentes.map((tf) => {
                const oculto = ocultos.has(tf);
                const micro = tf === MICRO_TIMEFRAME;
                return (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => alternar(tf)}
                    title={oculto ? `Mostrar as teses de ${tf}` : `Ocultar as teses de ${tf}`}
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold normal-case tabular ${
                      oculto
                        ? 'border-terminal-border text-terminal-muted opacity-50'
                        : micro
                          ? 'border-bull/60 bg-bull/10 text-bull'
                          : 'border-terminal-border bg-terminal-panel-soft text-terminal-text'
                    }`}
                  >
                    {tf} ({contagem.get(tf) ?? 0})
                  </button>
                );
              })}
              {ocultos.size > 0 ? (
                <button
                  type="button"
                  onClick={() => setOcultos(new Set())}
                  className="rounded px-1 text-[10px] font-normal normal-case text-terminal-muted underline"
                >
                  limpar
                </button>
              ) : null}
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

      {visiveis.length === 0 ? (
        <Empty
          text={
            ocultos.size > 0
              ? 'Nenhuma tese nos tempos gráficos que estão à vista. Reative um deles acima.'
              : futuros
                ? 'Nenhuma tese em futuros agora. O sistema segue varrendo as duas modalidades.'
                : 'Nenhum setup válido agora. O sistema segue varrendo o mercado.'
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-terminal-border">
          {visiveis.map((setup, index) => (
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
  /*
    Em futuros o robô não entra — e dizer "ROBÔ LIGADO" ali seria mentira.

    A expectativa positiva foi medida em histórico de spot; enquanto a coluna
    for alimentada por candle de spot, nenhuma entrada automática sai daqui.
    Um interruptor verde e pulsando sobre uma coluna em que nada acontece é
    pior que um interruptor apagado: ele promete vigilância que não existe.
  */
  if (market === 'FUTURES') {
    return (
      <span
        title="A automação foi medida em histórico de spot. Futuros tem candle próprio, basis, funding e liquidação — até o laboratório medir esse mercado, a entrada aqui é manual."
        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-terminal-border px-2 py-1 text-[10px] font-bold tracking-wide text-terminal-muted"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-terminal-muted" />
        SÓ MANUAL
      </span>
    );
  }

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

        {/*
          A direção só aparece quando é VENDA.
          
          Compra é a esmagadora maioria das linhas, e um distintivo que se
          repete em todas não distingue nada — vira ruído que empurra o resto
          para a direita. A venda é a exceção e é ela que precisa saltar: é a
          única em que "quase lá" significa preço SUBINDO.
        */}
        {setup.side === 'SELL' ? (
          <span
            className={`rounded border px-1 py-0.5 text-[9px] font-bold ${sideTone(setup.side)}`}
            title="tese vendida — ganha na queda"
          >
            {SIDE_LABEL[setup.side]}
          </span>
        ) : null}

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

        <span className="hidden min-w-0 truncate text-[11px] text-terminal-muted sm:inline">
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
