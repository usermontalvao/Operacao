import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.ts';
import type { DecisionRecord, FactorPerformance } from '../lib/types.ts';
import { percent, price, usd } from '../lib/format.ts';
import { SymbolButton } from '../components/SymbolButton.tsx';
import { PeriodFilter, buildPeriod, periodQuery, type PeriodId } from '../components/PeriodFilter.tsx';

const REFRESH_MS = 15_000;
/** Abaixo disto um número de acerto é anedota, não evidência. */
const MIN_SAMPLE = 5;

/**
 * Diário: o que o sistema viu, o que decidiu e no que deu.
 *
 * A pergunta que esta tela responde não é "quanto ganhei" — essa é da
 * Carteira. É "o que estava errado quando perdi": qual condição estava
 * presente, com que frequência ela apareceu e qual foi o resultado depois.
 * Sem isso, ajustar o motor é chute.
 */
export function Journal() {
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [factors, setFactors] = useState<FactorPerformance[]>([]);
  const [periodId, setPeriodId] = useState<PeriodId>('MES');
  const [error, setError] = useState<string | null>(null);
  /** a autópsia aberta: uma por vez, para a tabela não virar parede de texto */
  const [openId, setOpenId] = useState<string | null>(null);

  const period = useMemo(() => buildPeriod(periodId), [periodId]);

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const query = periodQuery(period);
        const [decisionData, factorData] = await Promise.all([
          api.decisions(query),
          api.factors(query),
        ]);
        if (!active) return;
        setDecisions(decisionData);
        setFactors(factorData.factors);
        setError(null);
      } catch (failure) {
        if (active) setError((failure as Error).message);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [period]);

  /**
   * O que falhou: condições com amostra suficiente e resultado negativo,
   * da pior para a menos ruim. É a lista de suspeitos.
   */
  const failing = useMemo(
    () =>
      factors
        .filter((factor) => factor.trades >= MIN_SAMPLE && factor.totalPnl < 0)
        .sort((a, b) => a.totalPnl - b.totalPnl),
    [factors],
  );

  const working = useMemo(
    () =>
      factors
        .filter((factor) => factor.trades >= MIN_SAMPLE && factor.totalPnl > 0)
        .sort((a, b) => b.totalPnl - a.totalPnl),
    [factors],
  );

  const thin = factors.filter((factor) => factor.trades < MIN_SAMPLE).length;

  if (error) return <p className="text-sm text-bear">{error}</p>;

  return (
    <div className="space-y-5 pb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Diário de decisões</h2>
          <p className="text-[11px] text-terminal-muted">
            {decisions.length} operação(ões) encerrada(s) no recorte
          </p>
        </div>
        <PeriodFilter value={periodId} onChange={setPeriodId} />
      </div>

      {decisions.length === 0 ? (
        <p className="rounded-xl border border-terminal-border bg-terminal-panel px-4 py-8 text-center text-sm text-terminal-muted">
          Nenhuma operação encerrada neste período. O diário se enche sozinho conforme as operações
          fecham — é ele que depois diz qual indicador estava certo.
        </p>
      ) : (
        <>
          <section className="grid gap-3 lg:grid-cols-2">
            <FactorPanel
              title="O que falhou"
              subtitle="condições presentes quando o dinheiro saiu"
              rows={failing}
              tone="bear"
              empty="Nenhuma condição com amostra suficiente aparece no vermelho."
            />
            <FactorPanel
              title="O que funcionou"
              subtitle="condições presentes quando a operação pagou"
              rows={working}
              tone="bull"
              empty="Nenhuma condição com amostra suficiente aparece no verde."
            />
          </section>

          {thin > 0 ? (
            <p className="text-[11px] text-terminal-muted">
              {thin} condição(ões) ficaram de fora por terem menos de {MIN_SAMPLE} operações. Com
              amostra pequena, acerto é sorte — mostrar seria convidar a mexer no motor pelo motivo
              errado.
            </p>
          ) : null}

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-terminal-muted">
              Histórico das transações
            </h3>
            <div className="overflow-x-auto rounded-xl border border-terminal-border">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-terminal-panel-soft text-[10px] uppercase tracking-wide text-terminal-muted">
                  <tr>
                    <Th>Fechado</Th>
                    <Th>Ativo</Th>
                    <Th>Setup</Th>
                    <Th>Origem</Th>
                    <ThRight>Score</ThRight>
                    <ThRight>Entrada</ThRight>
                    <Th>Saída</Th>
                    <ThRight>Resultado</ThRight>
                    <ThRight>Durou</ThRight>
                    <ThRight>RSI</ThRight>
                    <ThRight>Vol</ThRight>
                    <Th>BTC</Th>
                    <Th>Por quê</Th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.slice(0, 100).map((decision) => (
                    <Fragment key={decision.id}>
                    <tr className="border-t border-terminal-border">
                      <Td className="text-[11px] text-terminal-muted">
                        {new Date(decision.closedAt).toLocaleString('pt-BR', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </Td>
                      <Td className="font-medium">
                        <SymbolButton symbol={decision.symbol} note="operação encerrada" />
                      </Td>
                      <Td className="text-[11px]">{decision.setupType}</Td>
                      <Td className="text-[11px] text-terminal-muted">
                        {decision.automatic ? 'robô' : 'manual'}
                      </Td>
                      <Td className="text-right">{decision.score}</Td>
                      <Td className="text-right">{price(decision.entryPrice)}</Td>
                      <Td className="text-[11px]">{decision.outcome}</Td>
                      <Td
                        className={`text-right ${decision.realizedPnl >= 0 ? 'text-bull' : 'text-bear'}`}
                      >
                        {usd(decision.realizedPnl)}
                        <span className="block text-[10px] opacity-70">
                          {percent(decision.realizedPnlPercent)}
                        </span>
                      </Td>
                      <Td className="text-right text-[11px] text-terminal-muted">
                        {formatDuration(decision.durationMinutes)}
                      </Td>
                      <Td className="text-right text-terminal-muted">
                        {decision.evidence?.rsi14?.toFixed(0) ?? '—'}
                      </Td>
                      <Td className="text-right text-terminal-muted">
                        {decision.evidence?.relativeVolume?.toFixed(1) ?? '—'}
                      </Td>
                      <Td className="text-[11px] text-terminal-muted">
                        {decision.btcContext.replace('BTC_', '')}
                      </Td>
                      <Td>
                        {decision.postMortem ? (
                          <button
                            type="button"
                            onClick={() => setOpenId(openId === decision.id ? null : decision.id)}
                            className="rounded border border-terminal-border px-1.5 py-0.5 text-[10px] text-terminal-muted hover:text-terminal-text"
                          >
                            {openId === decision.id ? 'fechar' : 'ver'}
                          </button>
                        ) : null}
                      </Td>
                    </tr>
                    {openId === decision.id && decision.postMortem ? (
                      <tr className="border-t border-terminal-border bg-terminal-panel-soft">
                        <td colSpan={13} className="px-3 py-3">
                          <p className="text-sm font-medium">{decision.postMortem.headline}</p>
                          <ul className="mt-2 grid gap-1 text-[11px] text-terminal-muted sm:grid-cols-2">
                            {decision.postMortem.facts.map((fact) => (
                              <li key={fact}>· {fact}</li>
                            ))}
                          </ul>
                          {decision.postMortem.couldHaveSaved.length > 0 ? (
                            <div className="mt-3 rounded-lg border border-warn/30 bg-warn/5 p-2">
                              <p className="text-[10px] font-semibold uppercase tracking-wide text-warn">
                                O que teria mudado o desfecho
                              </p>
                              <ul className="mt-1 grid gap-1 text-[11px] text-terminal-muted">
                                {decision.postMortem.couldHaveSaved.map((item) => (
                                  <li key={item}>· {item}</li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {decisions.length > 100 ? (
              <p className="mt-2 text-[11px] text-terminal-muted">
                Mostrando as 100 mais recentes de {decisions.length}.
              </p>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}

function FactorPanel({
  title,
  subtitle,
  rows,
  tone,
  empty,
}: {
  title: string;
  subtitle: string;
  rows: FactorPerformance[];
  tone: 'bull' | 'bear';
  empty: string;
}) {
  const accent = tone === 'bull' ? 'text-bull' : 'text-bear';
  return (
    <div className="overflow-hidden rounded-xl border border-terminal-border">
      <div className="bg-terminal-panel-soft px-3 py-2">
        <h3 className={`text-xs font-semibold ${accent}`}>{title}</h3>
        <p className="text-[10px] text-terminal-muted">{subtitle}</p>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-[11px] text-terminal-muted">{empty}</p>
      ) : (
        rows.slice(0, 8).map((row) => (
          <div
            key={`${row.key}-${row.bucket}`}
            className="flex items-center justify-between gap-3 border-t border-terminal-border px-3 py-2"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm">{row.bucket}</span>
              <span className="text-[10px] text-terminal-muted">{row.label}</span>
            </span>
            <span className="flex shrink-0 items-center gap-3 tabular text-xs">
              <span className="text-terminal-muted">{row.trades} op.</span>
              <span className={row.winRate >= 50 ? 'text-bull' : 'text-bear'}>
                {row.winRate.toFixed(0)}%
              </span>
              <span className={`w-16 text-right font-semibold ${accent}`}>{usd(row.totalPnl)}</span>
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  if (minutes < 60) return `${Math.round(minutes)}min`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
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
