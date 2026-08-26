import { useMemo, useState } from 'react';
import type { EquityResponse } from '../lib/api.ts';
import { useResource } from '../lib/resource.ts';
import { buscarDesempenho, chaveDesempenho } from '../lib/telas.ts';
import { PageSkeleton } from '../components/Skeleton.tsx';
import type { PerformanceStats } from '../lib/types.ts';
import { percent, price, usd, usdWithBrl } from '../lib/format.ts';
import { SymbolButton } from '../components/SymbolButton.tsx';
import { EquityChart } from '../components/EquityChart.tsx';
import { PeriodFilter, buildPeriod, periodQuery, type PeriodId } from '../components/PeriodFilter.tsx';

const REFRESH_MS = 5_000;

/**
 * Carteira: quanto se tem, quanto disso está exposto e como foi o período.
 *
 * O recorte de tempo é o que separa "o sistema funciona" de "o sistema
 * funcionou". Um acerto acumulado desde sempre esconde as últimas semanas —
 * e são as últimas semanas que dizem se dá para continuar.
 */
export function Performance() {
  const [periodId, setPeriodId] = useState<PeriodId>('MES');
  const period = useMemo(() => buildPeriod(periodId), [periodId]);

  // a chave inclui o período: trocar de período mostra na hora o que já foi
  // visto daquele período, em vez de esvaziar a tela e recomeçar
  const { dados, erro: error, primeiraVez } = useResource(
    chaveDesempenho(periodId),
    () => buscarDesempenho(periodQuery(period)),
    { intervaloMs: REFRESH_MS },
  );

  const stats: PerformanceStats | null = dados?.stats ?? null;
  const equity: EquityResponse | null = dados?.equity ?? null;

  if (primeiraVez) return <PageSkeleton blocos={2} />;
  if (error && !stats) return <p className="text-sm text-bear">{error}</p>;
  if (!stats || !equity) return <PageSkeleton blocos={2} />;

  const growth =
    equity.startingCapital > 0
      ? ((equity.currentEquity - equity.startingCapital) / equity.startingCapital) * 100
      : 0;
  const livePnl = equity.realizedPnl + equity.unrealizedPnl;

  // a curva vem inteira do servidor; o recorte é aplicado aqui
  const points = period.from
    ? equity.points.filter((point) => {
        const time = Date.parse(point.time);
        if (Number.isNaN(time)) return false;
        if (time < (period.from as Date).getTime()) return false;
        if (period.to && time > period.to.getTime()) return false;
        return true;
      })
    : equity.points;

  return (
    <div className="space-y-5 pb-6">
      <section className="rounded-xl border border-terminal-border bg-terminal-panel p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-terminal-muted">
              Carteira {equity.mode === 'PAPER' ? 'demo' : equity.mode === 'TESTNET' ? 'testnet' : 'real'}
            </h2>
            <p className="mt-1 text-3xl font-semibold tabular">
              {usdWithBrl(equity.currentEquity, equity.brlRate)}
            </p>
            <p className={`text-xs tabular ${growth >= 0 ? 'text-bull' : 'text-bear'}`}>
              {percent(growth)} desde o início
            </p>
          </div>
          <PeriodFilter value={periodId} onChange={setPeriodId} />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Figure label="Disponível" value={usd(equity.available)} />
          <Figure label="Em posição" value={usd(equity.invested)} />
          <Figure
            label="Resultado aberto"
            value={usd(equity.unrealizedPnl)}
            tone={equity.unrealizedPnl >= 0 ? 'text-bull' : 'text-bear'}
          />
          <Figure
            label="Resultado total"
            value={usd(livePnl)}
            tone={livePnl >= 0 ? 'text-bull' : 'text-bear'}
          />
        </dl>

        <div className="mt-4">
          {points.length > 1 ? (
            <EquityChart points={points} />
          ) : (
            <p className="rounded-lg border border-dashed border-terminal-border py-10 text-center text-xs text-terminal-muted">
              {equity.points.length > 1
                ? 'Nenhuma operação encerrada neste período.'
                : 'A curva aparece depois da primeira operação encerrada.'}
            </p>
          )}
        </div>
      </section>

      <section>
        <SectionTitle title={`Desempenho · ${period.label.toLowerCase()}`} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric
            label="Operações"
            value={`${stats.closedTrades} fechadas · ${stats.openTrades} abertas`}
          />
          <Metric label="Acerto" value={stats.closedTrades > 0 ? `${stats.winRate.toFixed(1)}%` : '—'} />
          <Metric
            label="Fator de lucro"
            value={stats.profitFactor > 0 ? stats.profitFactor.toFixed(2) : '—'}
            hint="quanto ganha para cada 1 que perde"
          />
          <Metric
            label="Expectativa"
            value={usd(stats.expectancy)}
            hint="resultado médio por operação"
            tone={stats.expectancy >= 0 ? 'text-bull' : 'text-bear'}
          />
          <Metric label="Ganho médio" value={usd(stats.averageWin)} tone="text-bull" />
          <Metric label="Perda média" value={usd(stats.averageLoss)} tone="text-bear" />
          <Metric label="Ganhos" value={String(stats.wins)} tone="text-bull" />
          <Metric label="Perdas" value={String(stats.losses)} tone="text-bear" />
        </div>
        {stats.closedTrades === 0 ? (
          <p className="mt-2 text-[11px] text-terminal-muted">
            Nenhuma operação encerrada neste recorte — os números acima só ganham sentido com
            amostra. Uma dúzia de operações ainda é ruído.
          </p>
        ) : null}
      </section>

      {equity.positions.length > 0 ? (
        <section>
          <SectionTitle title="Em andamento" count={equity.positions.length} />
          {/*
            Só o resumo aqui. O acompanhamento com régua de preço e o botão de
            encerrar vivem na aba Operações — repetir o cartão inteiro nas duas
            telas era o que enchia esta página.
          */}
          <div className="overflow-x-auto rounded-xl border border-terminal-border">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="bg-terminal-panel-soft text-[10px] uppercase tracking-wide text-terminal-muted">
                <tr>
                  <Th>Ativo</Th>
                  <ThRight>Investido</ThRight>
                  <ThRight>Entrada</ThRight>
                  <ThRight>Agora</ThRight>
                  <ThRight>Resultado</ThRight>
                </tr>
              </thead>
              <tbody>
                {equity.positions.map((position) => {
                  const pnl = position.totalPnl;
                  const tone = pnl === null ? 'text-terminal-muted' : pnl >= 0 ? 'text-bull' : 'text-bear';
                  return (
                    <tr key={position.id} className="border-t border-terminal-border">
                      <Td>
                        <SymbolButton
                          symbol={position.symbol}
                          plan={{
                            entryLow: position.entryPrice,
                            entryHigh: position.entryPrice,
                            stopLoss: position.stopLoss,
                            target1: position.target1,
                          }}
                          note="posição aberta"
                          className="font-medium"
                        />
                        {position.side === 'SELL' ? (
                          <span className="ml-1.5 rounded border border-bear/40 bg-bear/10 px-1 py-px text-[9px] font-bold text-bear">
                            VENDA
                          </span>
                        ) : null}
                        {position.market === 'FUTURES' && position.leverage > 1 ? (
                          <span className="ml-1 text-[10px] text-info">{position.leverage}x</span>
                        ) : null}
                        {position.status === 'PENDING' ? (
                          <span className="ml-1.5 text-[10px] text-warn">aguardando</span>
                        ) : null}
                      </Td>
                      <Td className="text-right">{usd(position.invested)}</Td>
                      <Td className="text-right">{price(position.entryPrice)}</Td>
                      <Td className="text-right">
                        {position.currentPrice === null ? '—' : price(position.currentPrice)}
                      </Td>
                      <Td className={`text-right ${tone}`}>
                        {pnl === null ? '—' : `${usd(pnl)} (${percent(position.pnlPercent ?? 0)})`}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <Bucket title="Por ativo" rows={stats.bySymbol} />
      <Bucket title="Por tipo de setup" rows={stats.bySetupType} />
      <Bucket title="Por timeframe" rows={stats.byTimeframe} />
    </div>
  );
}

function SectionTitle({ title, count }: { title: string; count?: number }) {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-terminal-muted">
      {title}
      {count !== undefined ? <span className="ml-1 text-terminal-text">{count}</span> : null}
    </h3>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel-soft px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wide text-terminal-muted">{label}</dt>
      <dd className={`mt-0.5 text-sm font-semibold tabular ${tone ?? ''}`}>{value}</dd>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-terminal-border bg-terminal-panel p-3">
      <div className="text-[10px] uppercase tracking-wide text-terminal-muted">{label}</div>
      <div className={`mt-1 font-semibold tabular ${tone ?? ''}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[10px] text-terminal-muted">{hint}</div> : null}
    </div>
  );
}

function Bucket({ title, rows }: { title: string; rows: PerformanceStats['bySymbol'] }) {
  if (rows.length === 0) return null;
  return (
    <section>
      <SectionTitle title={title} />
      <div className="overflow-hidden rounded-xl border border-terminal-border">
        {rows.map((row) => (
          <div
            key={row.key}
            className="flex items-center justify-between border-b border-terminal-border px-3 py-2 text-sm last:border-b-0"
          >
            <span>{row.key}</span>
            <span className="flex gap-4 tabular text-xs text-terminal-muted">
              <span>{row.trades} op.</span>
              <span>{percent(row.winRate, 1)} acerto</span>
              <span className={row.pnl >= 0 ? 'text-bull' : 'text-bear'}>{usd(row.pnl)}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left font-medium">{children}</th>;
}

function ThRight({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-right font-medium">{children}</th>;
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 tabular ${className ?? ''}`}>{children}</td>;
}
