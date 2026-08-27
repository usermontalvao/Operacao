import { useEffect, useState } from 'react';
import { api, type FunnelResponse, type SystemHealth, type DecisionsResponse } from '../lib/api.ts';
import { PageSkeleton } from '../components/Skeleton.tsx';

/**
 * A aba que responde as perguntas que antes só o log respondia.
 *
 * Três blocos, na ordem em que a dúvida aparece: o sistema está de pé? onde os
 * sinais estão parando? e, para este sinal específico, qual regra bloqueou?
 */
export function Diagnostico() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [funnel, setFunnel] = useState<FunnelResponse | null>(null);
  const [decisions, setDecisions] = useState<DecisionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    const carregar = async (): Promise<void> => {
      try {
        const [h, f, d] = await Promise.all([
          api.systemHealth(),
          api.funnel().catch(() => null),
          api.entryDecisions().catch(() => null),
        ]);
        if (!vivo) return;
        setHealth(h);
        setFunnel(f);
        setDecisions(d);
        setError(null);
      } catch (failure) {
        if (vivo) setError((failure as Error).message);
      }
    };
    void carregar();
    const timer = setInterval(() => void carregar(), 20_000);
    return () => {
      vivo = false;
      clearInterval(timer);
    };
  }, []);

  if (error) {
    return <p className="rounded-lg border border-bear/40 bg-bear/10 p-3 text-sm text-bear">{error}</p>;
  }
  if (!health) return <PageSkeleton />;

  return (
    <div className="space-y-5 pb-6">
      <Saude health={health} />
      {funnel ? <Funil funnel={funnel} /> : null}
      {decisions ? <Oportunidades decisions={decisions} /> : null}
      {decisions ? <PorQueNaoEntrou decisions={decisions} /> : null}
    </div>
  );
}

function Saude({ health }: { health: SystemHealth }) {
  const persistenciaOk = health.persistencia.disponivel;
  // Compatibilidade durante uma atualização: a API antiga não enviava este
  // bloco. A tela deve avisar, não derrubar o React inteiro com `.map`.
  const coberturaTimeframes = health.timeframes?.cobertura ?? [];
  return (
    <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
      <h2 className="text-sm font-semibold">Saúde do sistema</h2>

      {!persistenciaOk ? (
        <p className="mt-3 rounded-lg border border-bear/50 bg-bear/10 p-3 text-sm text-bear">
          <strong>Persistência principal indisponível.</strong> O scanner, o robô e a execução estão
          desligados de propósito — nada é gravado no arquivo local para não criar um segundo
          histórico. {health.persistencia.erro}
        </p>
      ) : null}

      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <Info
          label="Persistência"
          value={persistenciaOk ? health.persistencia.tipo : 'INDISPONÍVEL'}
          tone={persistenciaOk ? 'text-bull' : 'text-bear'}
        />
        <Info
          label="Binance pública"
          value={health.binance.publicaDisponivel ? 'conectada' : 'inacessível'}
          tone={health.binance.publicaDisponivel ? 'text-bull' : 'text-bear'}
        />
        <Info label="Stream de preços" value={health.binance.streamPrecos} />
        <Info label="Ambiente" value={health.binance.ambienteAtivo} />
        <Info
          label="Idade do preço"
          value={idade(health.dados.tick.ageMs, health.dados.tick.level)}
          tone={health.dados.tick.blocksTrading ? 'text-bear' : 'text-bull'}
        />
        <Info
          label="Última varredura"
          value={idade(health.dados.scan.ageMs, health.dados.scan.level)}
          tone={health.dados.scan.blocksTrading ? 'text-warn' : 'text-bull'}
        />
        <Info label="Estratégia" value={health.versoes.estrategia} />
        <Info label="Política de risco" value={health.versoes.risco} />
      </dl>

      <h3 className="mt-5 text-xs font-semibold">Cobertura dos timeframes</h3>
      <p className="mt-0.5 text-[11px] text-terminal-muted">
        “Ativo” significa que o scanner procura teses nesse candle. A automação é mais estreita:
        a autorização é definida por setup e por conta. Todos os sinais continuam passando por
        zona, risco, liquidez, saldo e filtros da corretora.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {coberturaTimeframes.map((item) => {
          const automatico = item.automacao === 'CONFIGURADA_POR_SETUP';
          return (
            <div
              key={item.timeframe}
              className="rounded-lg border border-terminal-border bg-terminal-panel-soft px-3 py-2"
            >
              <span className="text-xs font-bold tabular">{item.timeframe}</span>
              <span className="ml-2 text-[10px] text-bull">scanner ligado</span>
              <span className={`ml-2 text-[10px] ${automatico ? 'text-info' : 'text-terminal-muted'}`}>
                {automatico ? `auto: ${item.estrategias.length} setup(s)` : 'somente manual'}
              </span>
            </div>
          );
        })}
        {coberturaTimeframes.length === 0 ? (
          <p className="text-[11px] text-warn">
            O servidor ainda não informou a cobertura. Reinicie a API para carregar esta versão.
          </p>
        ) : null}
      </div>

      <h3 className="mt-5 text-xs font-semibold">Shortlist HOT</h3>
      <p className="mt-0.5 text-[11px] text-terminal-muted">
        Faixa dinâmica dos pares com maior volume na volta atual; eles entram primeiro na rotação do
        universo amplo. A watchlist continua em tempo real por WebSocket.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {(health.universo?.hot ?? []).map((symbol) => (
          <span key={symbol} className="rounded border border-info/30 bg-info/5 px-2 py-1 text-[10px] text-info">
            {symbol.replace('USDT', '')}
          </span>
        ))}
        {(health.universo?.hot?.length ?? 0) === 0 ? (
          <span className="text-[10px] text-terminal-muted">Aguardando a primeira leitura do universo.</span>
        ) : null}
      </div>

      <h3 className="mt-5 text-xs font-semibold">Sessões operando agora</h3>
      <p className="mt-0.5 text-[11px] text-terminal-muted">
        O modo é a janela que você está olhando, não o que o sistema está fazendo. Cada sessão tem o
        seu robô, o seu capital e o seu descanso por ativo.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {health.sessoes.map((sessao) => (
          <div
            key={sessao.mode}
            className={`rounded-lg border p-3 ${
              sessao.emExibicao ? 'border-info/50 bg-info/5' : 'border-terminal-border bg-terminal-panel-soft'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold">
                {sessao.mode}
                {sessao.emExibicao ? (
                  <span className="ml-1.5 text-[10px] font-normal text-info">em exibição</span>
                ) : null}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                  sessao.robo === 'LIGADO' ? 'bg-bull/15 text-bull' : 'bg-terminal-panel text-terminal-muted'
                }`}
              >
                robô {sessao.robo.toLowerCase()}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-terminal-muted">
              {sessao.posicoesAbertas}{' '}
              {sessao.posicoesAbertas === 1 ? 'posição aberta' : 'posições abertas'}
              {sessao.ordensPendentes > 0
                ? ` · ${sessao.ordensPendentes} ${
                    sessao.ordensPendentes === 1
                      ? 'ordem limite aguardando'
                      : 'ordens limite aguardando'
                  }`
                : ''}
              {sessao.armadoSemPrazo
                ? ' · armado sem prazo'
                : sessao.armadoAte
                  ? ` · armado até ${new Date(sessao.armadoAte).toLocaleTimeString('pt-BR')}`
                  : ''}
            </p>
            {sessao.descansos.length > 0 ? (
              <p className="mt-1 text-[11px] text-warn">
                Em descanso:{' '}
                {sessao.descansos
                  .map((d) => `${d.symbol.replace('USDT', '')} (${d.remainingMinutes} min)`)
                  .join(', ')}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function Funil({ funnel }: { funnel: FunnelResponse }) {
  const maior = Math.max(...funnel.steps.map((s) => s.reached), 1);
  return (
    <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
      <h2 className="text-sm font-semibold">Funil do robô</h2>
      <p className="mt-0.5 text-[11px] text-terminal-muted">
        De {funnel.total} sinais considerados, onde cada um parou. Um funil em que tudo morre na
        mesma porta é um sistema mal calibrado; um em que nada chega ao fim é um robô que nunca vai
        operar.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Info label="Ativos analisados (24h)" value={String(funnel.scanner.assetsAnalyzed)} />
        <Info label="Detecções brutas (24h)" value={String(funnel.scanner.setupsGenerated)} />
        <Info label="Detectadas / dia" value={funnel.detectedPerDay.toFixed(2)} />
        <Info label="Aprovadas / dia" value={funnel.approvedPerDay.toFixed(2)} />
        <Info label="Recusadas / dia" value={funnel.rejectedPerDay.toFixed(2)} />
        <Info
          label="Frequência"
          value={funnel.opportunityStatus}
          tone={funnel.opportunityStatus === 'ON_TARGET' ? 'text-bull' : 'text-warn'}
        />
      </div>

      {funnel.opportunityStatus === 'LOW_OPPORTUNITY_RATE' ? (
        <p className="mt-3 rounded-lg border border-warn/40 bg-warn/10 p-2 text-[11px] text-warn">
          LOW_OPPORTUNITY_RATE — menos de 2 oportunidades aprovadas por dia na amostra registrada.
          Aumente a cobertura ou calibre a principal porta do funil; não conte operações artificiais.
        </p>
      ) : null}

      <div className="mt-4 space-y-2">
        {funnel.steps.map((step) => (
          <div key={step.stage}>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="w-40 shrink-0 text-terminal-muted">{step.label}</span>
              <div className="h-5 flex-1 overflow-hidden rounded bg-terminal-panel-soft">
                <div
                  className="h-full bg-info/30"
                  style={{ width: `${(step.reached / maior) * 100}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right tabular">{step.reached}</span>
              {step.stopped > 0 ? (
                <span className="w-20 shrink-0 text-right text-bear tabular">−{step.stopped}</span>
              ) : (
                <span className="w-20 shrink-0" />
              )}
            </div>
            {step.reasons.length > 0 ? (
              <p className="ml-40 pl-2 text-[10px] text-terminal-muted">
                {step.reasons.map((r) => `${r.code} (${r.count})`).join(' · ')}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function Oportunidades({ decisions }: { decisions: DecisionsResponse }) {
  const latest = new Map<string, DecisionsResponse['decisions'][number]>();
  for (const decision of decisions.decisions) {
    const previous = latest.get(decision.setupId);
    if (!previous || decision.lastSeenAt > previous.lastSeenAt) latest.set(decision.setupId, decision);
  }
  const rows = [...latest.values()]
    .sort((a, b) => Number(b.allowed) - Number(a.allowed) || b.score - a.score)
    .slice(0, 20);
  return (
    <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
      <h2 className="text-sm font-semibold">Oportunidades recentes</h2>
      <p className="mt-0.5 text-[11px] text-terminal-muted">
        Uma linha por setup: pronto, em observação ou rejeitado, com a regra que decidiu.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-[11px]">
          <thead className="text-terminal-muted">
            <tr>
              <th className="pb-2">Ativo</th><th className="pb-2">Setup</th>
              <th className="pb-2">TF</th><th className="pb-2">Score</th>
              <th className="pb-2">Estado</th><th className="pb-2">Motivo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const state = row.allowed
                ? 'PRONTA'
                : row.stage === 'DENTRO_DA_ZONA' || row.stage === 'APROVADO_PELO_RISCO'
                  ? 'QUASE'
                  : 'REJEITADA';
              return (
                <tr key={row.setupId} className="border-t border-terminal-border">
                  <td className="py-2 font-semibold">{row.symbol.replace('USDT', '')}</td>
                  <td className="py-2">{row.setupType}</td><td className="py-2">{row.timeframe}</td>
                  <td className="py-2 tabular">{row.score}</td>
                  <td className={`py-2 font-semibold ${row.allowed ? 'text-bull' : state === 'QUASE' ? 'text-warn' : 'text-terminal-muted'}`}>{state}</td>
                  <td className="max-w-[320px] truncate py-2" title={row.blockers[0]?.message}>
                    {row.allowed ? 'Passou por todas as portas' : row.blockers[0]?.message ?? row.code}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 ? <p className="py-3 text-xs text-terminal-muted">Nenhum setup avaliado ainda.</p> : null}
      </div>
    </section>
  );
}

function PorQueNaoEntrou({ decisions }: { decisions: DecisionsResponse }) {
  return (
    <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
      <h2 className="text-sm font-semibold">Por que não entrou</h2>
      <p className="mt-0.5 text-[11px] text-terminal-muted">
        Motivos agrupados. O número entre parênteses é quantas situações distintas pararam ali — a
        mesma recusa repetida a cada varredura conta uma vez só.
      </p>

      <div className="mt-3 space-y-2">
        {decisions.reasons.length === 0 ? (
          <p className="text-xs text-terminal-muted">Nenhuma recusa registrada ainda.</p>
        ) : (
          decisions.reasons.map((motivo) => (
            <div
              key={motivo.code}
              className="rounded-lg border border-terminal-border bg-terminal-panel-soft p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] font-semibold text-warn">{motivo.code}</span>
                <span className="text-[11px] tabular text-terminal-muted">{motivo.count}×</span>
              </div>
              <p className="mt-1 text-[11px]">{motivo.message}</p>
              <p className="mt-1 text-[10px] text-terminal-muted">
                {motivo.symbols
                  .slice(0, 12)
                  .map((s) => s.replace('USDT', ''))
                  .join(', ')}
                {motivo.symbols.length > 12 ? ` +${motivo.symbols.length - 12}` : ''}
              </p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function idade(ageMs: number | null, level: string): string {
  if (ageMs === null) return `sem dado (${level.toLowerCase()})`;
  if (ageMs < 1000) return 'agora';
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
  return `${Math.round(ageMs / 60_000)} min`;
}

function Info({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel-soft px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wide text-terminal-muted">{label}</dt>
      <dd className={`truncate text-xs font-medium ${tone ?? ''}`} title={value}>
        {value}
      </dd>
    </div>
  );
}
