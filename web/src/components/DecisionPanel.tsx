import type { DecisionReason, EntryDecision } from '../lib/types.ts';

/**
 * "Por que o robô não entrou?"
 *
 * Todo o conteúdo vem da decisão calculada no servidor — nenhuma regra de
 * trading é reimplementada aqui. Este componente só escolhe cores e ordena
 * frases que o backend já escreveu; se ele começar a decidir alguma coisa,
 * passam a existir duas verdades e a do usuário é a errada.
 */

const CODE_TONE: Record<string, string> = {
  ALLOWED: 'bull',
  ROBOT_DISABLED: 'muted',
  PERSISTENCE_UNAVAILABLE: 'bear',
  MARKET_DATA_STALE: 'bear',
  PRICE_OUTSIDE_ENTRY_ZONE: 'warn',
  SETUP_STALE: 'warn',
  SETUP_EXPIRED: 'muted',
  // não é falha nem pendência: é o desenho do sistema. O lado vendido é
  // entrada manual até o laboratório medir o lado de baixo
  SHORT_NOT_AUTOMATED: 'muted',
  // idem: não é pendência, é o desenho. O laboratório mediu spot
  MARKET_NOT_VALIDATED: 'muted',
};

function toneFor(code: string): string {
  const tone = CODE_TONE[code] ?? 'warn';
  if (tone === 'bull') return 'border-bull/50 bg-bull/10 text-bull';
  if (tone === 'bear') return 'border-bear/50 bg-bear/10 text-bear';
  if (tone === 'muted') return 'border-terminal-border bg-terminal-panel-soft text-terminal-muted';
  return 'border-warn/50 bg-warn/10 text-warn';
}

/** Distintivo curto, para caber na lista sem empurrar o resto. */
export function DecisionBadge({ decision }: { decision: EntryDecision | undefined }) {
  if (!decision) return null;
  if (decision.allowed) {
    return (
      <span className="rounded border border-bull/50 bg-bull/10 px-1.5 py-0.5 text-[10px] font-semibold text-bull">
        robô entraria
      </span>
    );
  }
  /*
   * "Em observação" é propriedade da ESTRATÉGIA, não desta linha.
   *
   * Hoje só MOMENTUM_BURST é validada, então esse distintivo aparecia em
   * praticamente todas as linhas do radar — e um aviso que está em todo lugar
   * não avisa nada, só empurra o resto da linha para a direita. O nome da
   * estratégia já está escrito ao lado; quem quer o motivo inteiro abre o
   * setup. O que fica na linha é o que muda DE LINHA PARA LINHA: distância da
   * zona, R/R fraco, exposição no teto.
   */
  const especifico = decision.blockers.find((item) => item.code !== 'STRATEGY_NOT_VALIDATED');
  const principal = especifico ?? decision.blockers[0];
  if (!principal) return null;
  if (!especifico) {
    // sobrou só a estratégia não validada: um ponto discreto, com o texto
    // completo a um passar de mouse
    return (
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn/50"
        title={principal.message}
        aria-label={principal.message}
      />
    );
  }
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${toneFor(principal.code)}`}
      title={principal.message}
    >
      {rotuloCurto(principal, decision)}
    </span>
  );
}

/**
 * Rótulo de uma palavra para o card. O texto completo continua no title e no
 * painel — encurtar aqui é para caber, não para esconder.
 */
function rotuloCurto(motivo: DecisionReason, decision: EntryDecision): string {
  switch (motivo.code) {
    case 'PRICE_OUTSIDE_ENTRY_ZONE':
      return decision.distanceToEntryPercent > 0
        ? `${decision.distanceToEntryPercent.toFixed(1)}% acima da zona`
        : `${Math.abs(decision.distanceToEntryPercent).toFixed(1)}% abaixo da zona`;
    case 'ROBOT_DISABLED':
      return 'robô desligado';
    case 'STRATEGY_NOT_VALIDATED':
      return 'em observação';
    case 'SHORT_NOT_AUTOMATED':
      return 'venda: manual';
    case 'MARKET_NOT_VALIDATED':
      return 'futuros: manual';
    case 'SCORE_BELOW_VALIDATED_FLOOR':
    case 'SCORE_BELOW_CONFIGURED_MINIMUM':
      return 'score baixo';
    case 'SETUP_STALE':
      return 'sinal antigo';
    case 'SYMBOL_COOLDOWN':
      return 'em descanso';
    case 'MAX_CONCURRENT_TRADES':
      return 'limite de posições';
    case 'MARKET_DATA_STALE':
      return 'preço atrasado';
    case 'PERSISTENCE_UNAVAILABLE':
      return 'sem persistência';
    default:
      return 'bloqueado';
  }
}

interface DecisionPanelProps {
  decision: EntryDecision | undefined;
  /** preço e zona, para a régua visual */
  entryLow: number;
  entryHigh: number;
  currentPrice: number;
}

export function DecisionPanel({ decision, entryLow, entryHigh, currentPrice }: DecisionPanelProps) {
  if (!decision) {
    return (
      <div className="rounded-lg border border-terminal-border bg-terminal-panel-soft p-3 text-xs text-terminal-muted">
        Sem decisão registrada para este setup — o robô ainda não o considerou nesta sessão.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel-soft p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold">
          {decision.allowed ? 'O robô entraria neste setup' : 'Por que o robô não entrou'}
        </h3>
        <span className="text-[10px] text-terminal-muted">
          avaliado {new Date(decision.evaluatedAt).toLocaleTimeString('pt-BR')}
        </span>
      </div>

      <ZonaRegua
        entryLow={entryLow}
        entryHigh={entryHigh}
        currentPrice={currentPrice}
        distance={decision.distanceToEntryPercent}
      />

      {decision.blockers.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {decision.blockers.map((motivo) => (
            <li
              key={motivo.code + motivo.message}
              className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded border px-2 py-1 text-[11px] ${toneFor(motivo.code)}`}
            >
              {/* o código na MESMA linha do motivo: em segunda linha ele
                  custava três linhas de altura no modal para dizer algo que
                  só interessa a quem vai procurar a regra no código */}
              <span className="min-w-0">{motivo.message}</span>
              <span className="shrink-0 font-mono text-[9px] opacity-50">
                {motivo.code} · {motivo.rule}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {decision.warnings.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {decision.warnings.map((aviso) => (
            <li key={aviso.code + aviso.message} className="text-[11px] text-terminal-muted">
              ⚠ {aviso.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Régua da zona de entrada.
 *
 * O card mostrava stop e alvo como se fossem os dois números que importam. Para
 * saber por que a compra não aconteceu, o número que falta é este: onde o preço
 * está em relação à zona.
 */
function ZonaRegua({
  entryLow,
  entryHigh,
  currentPrice,
  distance,
}: {
  entryLow: number;
  entryHigh: number;
  currentPrice: number;
  distance: number;
}) {
  // a régua abre 6% para cada lado da zona, para o preço fora ainda aparecer
  const margem = (entryHigh - entryLow) * 3 || entryHigh * 0.06;
  const min = entryLow - margem;
  const max = entryHigh + margem;
  const posicao = (valor: number): number =>
    Math.min(Math.max(((valor - min) / (max - min)) * 100, 0), 100);

  const dentro = distance === 0;
  return (
    <div className="mt-3">
      <div className="relative h-6 rounded bg-terminal-panel">
        <div
          className="absolute inset-y-0 rounded bg-bull/20 ring-1 ring-inset ring-bull/40"
          style={{ left: `${posicao(entryLow)}%`, width: `${posicao(entryHigh) - posicao(entryLow)}%` }}
        />
        <div
          className={`absolute inset-y-0 w-0.5 ${dentro ? 'bg-bull' : 'bg-warn'}`}
          style={{ left: `${posicao(currentPrice)}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-terminal-muted">
        <span>zona {entryLow} – {entryHigh}</span>
        <span className={dentro ? 'text-bull' : 'text-warn'}>
          {dentro
            ? 'preço dentro da zona'
            : `${distance > 0 ? '+' : ''}${distance.toFixed(2)}% da zona`}
        </span>
      </div>
    </div>
  );
}
