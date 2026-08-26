import { useCallback, useState } from 'react';
import { api, type EquityResponse } from '../lib/api.ts';
import { useResource } from '../lib/resource.ts';
import { buscarOperacoes, chaveOperacoes } from '../lib/telas.ts';
import { PageSkeleton } from '../components/Skeleton.tsx';
import type { Trade, TradeSetup, TradingMode } from '../lib/types.ts';
import { PriceLadder } from '../components/PriceLadder.tsx';
import { SymbolButton } from '../components/SymbolButton.tsx';
import { useChartViewer } from '../lib/chartViewer.tsx';
import {
  MARKET_LABEL,
  SETUP_LABEL,
  SIDE_LABEL,
  leverageLabel,
  percent,
  price,
  sideTone,
  usd,
} from '../lib/format.ts';

type Position = EquityResponse['positions'][number];
const REFRESH_MS = 5_000;

const OUTCOME_LABEL: Record<string, string> = {
  TARGET1: 'Alvo 1',
  TARGET2: 'Alvo 2',
  TARGET3: 'Alvo 3',
  STOP: 'Stop',
  MANUAL: 'Encerrado na mão',
  OPEN: 'Em aberto',
};

const MODE_LABEL: Record<TradingMode, string> = {
  PAPER: 'conta demo',
  TESTNET: 'conta de teste da Binance',
  LIVE: 'conta real',
};

/**
 * Histórico e posições do modo ATIVO.
 *
 * Duas coisas que faltavam e que mudam o uso do sistema: a posição aberta
 * mostra o plano inteiro na mesma linha (por quanto comprou, quanto vale
 * agora, para onde vai sair) e existe um botão para encerrar. Ver o preço sem
 * ver o alvo não informa nada, e perceber que precisa sair sem ter como sair
 * é pior ainda.
 */
export function History() {
  const [tab, setTab] = useState<'ABERTAS' | 'ENCERRADAS' | 'SETUPS'>('ABERTAS');
  // erro de AÇÃO (encerrar, cancelar) é separado do erro de LEITURA: um
  // encerramento que falhou não pode sumir da tela só porque a próxima
  // atualização automática deu certo
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);

  const {
    dados,
    erro: loadError,
    primeiraVez,
    recarregar: load,
  } = useResource(chaveOperacoes, buscarOperacoes, { intervaloMs: REFRESH_MS });

  const equity = dados?.equity ?? null;
  const trades: Trade[] = dados?.trades ?? [];
  const setups: TradeSetup[] = dados?.setups ?? [];
  const error = actionError ?? loadError;
  const setError = setActionError;

  const closePosition = useCallback(
    async (position: Position): Promise<void> => {
      const asset = position.symbol.replace('USDT', '');
      const resultado =
        position.totalPnl === null ? 'resultado ainda desconhecido' : `resultado ${usd(position.totalPnl)}`;
      const action = position.status === 'PENDING' ? 'Cancelar a ordem pendente' : 'Encerrar a posição';
      const warning =
        equity?.mode === 'LIVE'
          ? 'Na conta REAL, as proteções serão canceladas e a quantidade restante será vendida a mercado. O preço final pode variar.'
          : equity?.mode === 'TESTNET'
            ? 'Na TESTNET, a saída será enviada a mercado.'
            : 'Na conta DEMO, a saída será simulada pelo preço atual.';
      if (!window.confirm(`${action} em ${asset}?\n\n${resultado}\n\n${warning}`)) return;

      setClosing(position.id);
      setMessage(null);
      setActionError(null);
      try {
        const trade = await api.closeTrade(position.id);
        setMessage(
          `${asset} encerrado — resultado ${usd(trade.realizedPnl)} (${percent(trade.realizedPnlPercent)})`,
        );
        await load();
      } catch (failure) {
        setError((failure as Error).message);
      } finally {
        setClosing(null);
        setTimeout(() => setMessage(null), 6000);
      }
    },
    [equity?.mode, load],
  );

  const closeAll = useCallback(async (): Promise<void> => {
    if (!window.confirm('Encerrar TODAS as posições agora e desligar o robô?')) return;
    setClosing('all');
    try {
      const result = await api.closeAll();
      setMessage(
        `${result.closed.length} posição(ões) encerrada(s) e robô desligado${
          result.failed.length > 0 ? ` — ${result.failed.length} falharam` : ''
        }`,
      );
      if (result.failed.length > 0) setError(result.failed.map((item) => item.error).join(' · '));
      await load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setClosing(null);
    }
  }, [load]);

  const positions = equity?.positions ?? [];
  const closed = trades.filter((trade) => trade.status === 'CLOSED' || trade.status === 'CANCELLED');
  const openPositions = positions.filter((position) => position.status === 'OPEN');
  const totalInvested = openPositions.reduce((total, position) => total + position.invested, 0);
  const totalCurrentValue = openPositions.reduce(
    (total, position) => total + (position.currentValue ?? 0),
    0,
  );
  const totalPnl = openPositions.reduce((total, position) => total + (position.totalPnl ?? 0), 0);
  const totalPnlPercent = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
  const totalReserved = positions
    .filter((position) => position.status === 'PENDING')
    .reduce((total, position) => total + position.invested, 0);

  if (primeiraVez) return <PageSkeleton blocos={3} />;

  return (
    <div className="space-y-4">
      {error ? (
        <p className="rounded-lg border border-bear/40 bg-bear/10 p-3 text-sm text-bear">{error}</p>
      ) : null}
      {message ? (
        <p className="rounded-lg border border-bull/40 bg-bull/10 p-3 text-sm text-bull">{message}</p>
      ) : null}

      {equity ? (
        <p className="text-[11px] text-terminal-muted">
          Mostrando apenas a {MODE_LABEL[equity.mode]}. Trocar de conta no topo troca todo o
          histórico, o desempenho e as métricas junto. As posições ABERTAS e os totais acima
          somam as duas modalidades — spot e futuros —, cada uma marcada na própria linha, porque
          dinheiro exposto agora não depende de qual aba está selecionada. Já o histórico
          encerrado e o desempenho são da modalidade em exibição ({MARKET_LABEL[equity.market]}).
        </p>
      ) : null}

      {positions.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <SummaryCard label={`Investido · ${openPositions.length} abertas`} value={usd(totalInvested)} />
          <SummaryCard label="Valor atual total" value={usd(totalCurrentValue)} />
          <SummaryCard
            label={totalPnl >= 0 ? 'Retorno total' : 'Prejuízo total'}
            value={`${usd(totalPnl)} (${percent(totalPnlPercent)})`}
            tone={totalPnl >= 0 ? 'text-bull' : 'text-bear'}
          />
          <SummaryCard label="Reservado · pendentes" value={usd(totalReserved)} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <TabButton active={tab === 'ABERTAS'} onClick={() => setTab('ABERTAS')} label={`Abertas (${positions.length})`} />
        <TabButton active={tab === 'ENCERRADAS'} onClick={() => setTab('ENCERRADAS')} label={`Encerradas (${closed.length})`} />
        <TabButton active={tab === 'SETUPS'} onClick={() => setTab('SETUPS')} label={`Setups (${setups.length})`} />
        {positions.length > 0 ? (
          <button
            type="button"
            disabled={closing !== null}
            onClick={() => void closeAll()}
            className="ml-auto rounded-lg border border-bear/50 bg-bear/10 px-3 py-1.5 text-xs font-semibold text-bear disabled:opacity-40"
          >
            {closing === 'all' ? 'Encerrando…' : 'Encerrar tudo'}
          </button>
        ) : null}
      </div>

      {tab === 'ABERTAS' ? (
        positions.length === 0 ? (
          <Empty text="Nenhuma posição aberta nesta conta." />
        ) : (
          <div className="overflow-hidden rounded-xl border border-terminal-border bg-terminal-panel">
            {positions.map((position) => (
              <PositionCard
                key={position.id}
                position={position}
                busy={closing === position.id}
                disabled={closing !== null}
                onClose={() => void closePosition(position)}
              />
            ))}
          </div>
        )
      ) : null}

      {tab === 'ENCERRADAS' ? (
        closed.length === 0 ? (
          <Empty text="Nenhuma operação encerrada nesta conta ainda." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-terminal-border">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-terminal-panel-soft text-[10px] uppercase tracking-wide text-terminal-muted">
                <tr>
                  <Th>Ativo</Th>
                  <Th>Saída</Th>
                  <Th>Resultado</Th>
                  <Th>Taxa</Th>
                  <Th>Chegou a</Th>
                  <Th>Caiu até</Th>
                  <Th>Quando</Th>
                </tr>
              </thead>
              <tbody>
                {closed.map((trade) => (
                  <tr key={trade.id} className="border-t border-terminal-border">
                    <Td>
                      <SymbolButton
                        symbol={trade.symbol}
                        plan={planOf(trade)}
                        note={`encerrada · ${OUTCOME_LABEL[trade.outcome] ?? trade.outcome}`}
                        markers={marksOf(trade)}
                        focusTime={trade.closedAt ? Date.parse(trade.closedAt) : null}
                        className="font-semibold"
                      />
                      <span className="ml-1 text-[10px] text-terminal-muted">
                        {SIDE_LABEL[trade.side]} · {SETUP_LABEL[trade.setupType]} ·{' '}
                        {trade.automatic ? 'robô' : 'manual'}
                        {leverageLabel(trade.leverage) ? ` · ${leverageLabel(trade.leverage)}` : ''}
                      </span>
                    </Td>
                    <Td>
                      {OUTCOME_LABEL[trade.outcome] ?? trade.outcome}
                      {trade.closeReason ? (
                        <span className="block text-[10px] text-terminal-muted">{trade.closeReason}</span>
                      ) : null}
                    </Td>
                    <Td className={trade.realizedPnl >= 0 ? 'text-bull' : 'text-bear'}>
                      {usd(trade.realizedPnl)}
                      <span className="block text-[10px] opacity-70">{percent(trade.realizedPnlPercent)}</span>
                    </Td>
                    <Td className="text-terminal-muted">{usd(trade.feesPaid)}</Td>
                    <Td className="text-bull">{percent(trade.maxFavorablePercent)}</Td>
                    <Td className="text-bear">{percent(trade.maxAdversePercent)}</Td>
                    <Td className="text-[11px] text-terminal-muted">
                      {trade.closedAt
                        ? new Date(trade.closedAt).toLocaleString('pt-BR', {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })
                        : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {tab === 'SETUPS' ? (
        setups.length === 0 ? (
          <Empty text="Nenhum setup registrado até agora." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-terminal-border">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-terminal-panel-soft text-[10px] uppercase tracking-wide text-terminal-muted">
                <tr>
                  <Th>Quando</Th>
                  <Th>Ativo</Th>
                  <Th>Setup</Th>
                  <Th>Score</Th>
                  <Th>Entrada</Th>
                  <Th>Stop</Th>
                  <Th>Alvo 1</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {setups.map((setup) => (
                  <tr key={setup.id} className="border-t border-terminal-border">
                    <Td className="text-[11px] text-terminal-muted">
                      {new Date(setup.createdAt).toLocaleString('pt-BR', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </Td>
                    <Td className="font-semibold">
                      <SymbolButton symbol={setup.symbol} plan={setup} timeframe={setup.timeframe} />
                    </Td>
                    <Td>
                      {SETUP_LABEL[setup.setupType]}
                      <span className="ml-1 text-[10px] text-terminal-muted">{setup.timeframe}</span>
                    </Td>
                    <Td>{setup.score}</Td>
                    <Td>
                      {price(setup.entryLow)}–{price(setup.entryHigh)}
                    </Td>
                    <Td>{price(setup.stopLoss)}</Td>
                    <Td>{price(setup.target1)}</Td>
                    <Td className="text-[11px]">{setup.status}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  );
}

/**
 * Onde a operação entrou e onde saiu, para o gráfico abrir exatamente ali.
 *
 * Ver o gráfico de uma operação encerrada mostrando o preço de agora não
 * ensina nada: o que se quer rever é o momento em que ela morreu.
 */
function marksOf(trade: {
  fills: Array<{ kind: string; price: number; time: string }>;
  openedAt: string;
  closedAt: string | null;
}) {
  const marks = [];
  const entry = trade.fills.find((item) => item.kind === 'ENTRY');
  if (entry) {
    marks.push({ time: Date.parse(entry.time), kind: 'ENTRY' as const, label: `entrada ${price(entry.price)}` });
  }
  const exits = trade.fills.filter((item) => item.kind !== 'ENTRY');
  const last = exits[exits.length - 1];
  if (last) {
    marks.push({ time: Date.parse(last.time), kind: 'EXIT' as const, label: `saída ${price(last.price)}` });
  }
  return marks;
}

/** O plano de uma operação vira as linhas do gráfico: a entrada é um preço
 * único, não a zona que o setup tinha antes de a ordem ser preenchida. */
function planOf(trade: {
  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2?: number | null;
  target3?: number | null;
}) {
  return {
    entryLow: trade.entryPrice,
    entryHigh: trade.entryPrice,
    stopLoss: trade.stopLoss,
    target1: trade.target1,
    target2: trade.target2 ?? null,
    target3: trade.target3 ?? null,
  };
}

/**
 * Uma posição em uma linha.
 *
 * Antes era um cartão com quatro caixas empilhadas: ocupava meia tela para
 * dizer quatro números. Agora o preço vira posição na régua — o olho vê onde
 * está entre o stop e o alvo antes de ler qualquer dígito — e os números
 * ficam na mesma linha, alinhados entre uma posição e outra.
 */
function PositionCard({
  position,
  busy,
  disabled,
  onClose,
}: {
  position: Position;
  busy: boolean;
  disabled: boolean;
  onClose: () => void;
}) {
  const chart = useChartViewer();
  const pnlTone = (position.totalPnl ?? 0) >= 0 ? 'text-bull' : 'text-bear';
  const pending = position.status === 'PENDING';
  const alavancagem = leverageLabel(position.leverage);

  return (
    <article className="border-t border-terminal-border px-3 py-2.5 first:border-t-0">
      <div className="flex items-center gap-2">
        <SymbolButton
          symbol={position.symbol}
          plan={planOf(position)}
          note="posição aberta"
          className="w-14 shrink-0 font-semibold"
        />

        {/*
          Lado, modalidade e alavancagem na frente de tudo.

          Esta lista mostra as DUAS modalidades ao mesmo tempo, de propósito:
          posição aberta é dinheiro exposto agora, e escondê-la porque a tela
          está em outra aba é como o usuário esquece que ela existe. O preço
          disso é que cada linha tem de dizer de onde é.
        */}
        <span
          className={`rounded border px-1 py-0.5 text-[9px] font-bold ${sideTone(position.side)}`}
        >
          {SIDE_LABEL[position.side]}
        </span>
        {position.market === 'FUTURES' ? (
          <span className="rounded border border-info/40 bg-info/10 px-1 py-0.5 text-[9px] font-bold text-info">
            {MARKET_LABEL.FUTURES}
            {alavancagem ? ` ${alavancagem}` : ''}
          </span>
        ) : null}

        {pending ? (
          <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] font-semibold text-warn">
            AGUARDANDO
          </span>
        ) : position.protectiveStop != null ? (
          <span className="rounded border border-bull/40 bg-bull/10 px-1.5 py-0.5 text-[10px] font-semibold text-bull">
            STOP PROTEGIDO
          </span>
        ) : null}

        <span className="hidden text-[11px] text-terminal-muted sm:inline">
          {position.automatic ? 'robô' : 'manual'} · {usd(position.invested)}
        </span>

        <span className="ml-auto flex items-center gap-3">
          <span className={`text-sm font-semibold tabular ${pnlTone}`}>
            {position.totalPnl === null ? '—' : usd(position.totalPnl)}
          </span>
          <span className={`w-14 text-right text-[11px] tabular ${pnlTone}`}>
            {position.pnlPercent === null ? '' : percent(position.pnlPercent)}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={onClose}
            className="rounded border border-bear/50 px-2 py-1 text-[10px] font-bold text-bear transition hover:bg-bear/10 disabled:opacity-40"
          >
            {busy ? '…' : pending ? 'Cancelar' : 'Encerrar'}
          </button>
        </span>
      </div>

      <button
        type="button"
        onClick={() => chart.open({ symbol: position.symbol, plan: planOf(position), note: 'posição aberta' })}
        title={`Ver o gráfico de ${position.symbol}`}
        className="mt-2 flex w-full cursor-pointer items-center gap-3"
      >
        <span className="w-14 shrink-0 text-[10px] text-bear tabular">{price(position.stopLoss)}</span>
        <PriceLadder
          mode="liquid"
          side={position.side}
          stop={position.stopLoss}
          entryLow={position.entryPrice}
          target={position.target1}
          current={position.currentPrice}
        />
        <span className="w-16 shrink-0 text-right text-[10px] text-bull tabular">
          {price(position.target1)}
        </span>
      </button>

      <div className="mt-1 flex flex-wrap gap-x-4 text-[10px] text-terminal-muted tabular">
        <span>entrada {price(position.entryPrice)}</span>
        <span>agora {position.currentPrice === null ? '—' : price(position.currentPrice)}</span>
        {position.distanceToTargetPercent !== null ? (
          <span className="text-bull/80">alvo {percent(position.distanceToTargetPercent)}</span>
        ) : null}
        {position.distanceToStopPercent !== null ? (
          <span className="text-bear/80">stop {percent(position.distanceToStopPercent)}</span>
        ) : null}
        {/* a linha da corretora, quando existe: é a saída que não é sua, e
            a distância até ela é o que decide se dá para respirar */}
        {position.liquidationPrice !== null ? (
          <span
            className="font-semibold text-bear"
            title={`a corretora liquida a posição em ${price(position.liquidationPrice)}`}
          >
            liquidação {price(position.liquidationPrice)}
            {position.distanceToLiquidationPercent !== null
              ? ` (${percent(position.distanceToLiquidationPercent)})`
              : ''}
          </span>
        ) : null}
        {position.market === 'FUTURES' && position.initialMargin > 0 ? (
          <span title="saldo que a posição prende; o prejuízo continua sendo o do stop">
            margem {usd(position.initialMargin)}
          </span>
        ) : null}
      </div>
    </article>
  );
}

/** Tira do topo: os totais da carteira antes de descer para posição a posição. */
function SummaryCard({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-terminal-muted">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular ${tone ?? ''}`}>{value}</div>
    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-xs ${
        active ? 'border-terminal-muted bg-terminal-panel-soft' : 'border-terminal-border text-terminal-muted'
      }`}
    >
      {label}
    </button>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left font-medium">{children}</th>;
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 tabular ${className ?? ''}`}>{children}</td>;
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-xl border border-terminal-border bg-terminal-panel p-6 text-center text-sm text-terminal-muted">
      {text}
    </p>
  );
}
