import type { DecisionReason, EntryDecision } from '../lib/types.ts';
import { price } from '../lib/format.ts';

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
  TIMEFRAME_DISABLED: 'muted',
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
    case 'TIMEFRAME_DISABLED':
      return 'timeframe desligado';
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
      <p className="text-[12px] leading-snug text-terminal-muted">
        Sem decisão registrada para este setup — o robô ainda não o considerou nesta sessão.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-terminal-muted">
          {decision.allowed ? 'O robô entraria' : 'Por que o robô não entrou'}
        </h3>
        <span className="shrink-0 text-[11px] text-terminal-muted/70">
          {new Date(decision.evaluatedAt).toLocaleTimeString('pt-BR')}
        </span>
      </div>

      <ZonaRegua
        entryLow={entryLow}
        entryHigh={entryHigh}
        currentPrice={currentPrice}
        distance={decision.distanceToEntryPercent}
      />

      {/*
        O motivo é uma frase com um ponto colorido, não um retângulo pintado.
        Empilhados, os retângulos viravam um semáforo de três cores dentro de
        uma janela que já tem verde e vermelho com significado — e o código da
        regra, escrito em monoespaçado ao lado, roubava a linha inteira para
        dizer algo que só interessa a quem vai procurar a regra no código. Ele
        continua ali, no passar do mouse.
      */}
      {decision.blockers.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {decision.blockers.map((motivo) => (
            <li
              key={motivo.code + motivo.message}
              title={`${motivo.code} · ${motivo.rule}`}
              className="flex gap-2 text-[12px] leading-snug text-terminal-muted"
            >
              <span className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${pontoDe(motivo.code)}`} />
              <span className="min-w-0">{motivo.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {decision.warnings.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {decision.warnings.map((aviso) => (
            <li
              key={aviso.code + aviso.message}
              className="flex gap-2 text-[12px] leading-snug text-terminal-muted/80"
            >
              <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-white/15" />
              <span className="min-w-0">{aviso.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A cor do ponto — a mesma escala de gravidade das faixas de antes. */
function pontoDe(code: string): string {
  const tone = CODE_TONE[code] ?? 'warn';
  if (tone === 'bull') return 'bg-bull';
  if (tone === 'bear') return 'bg-bear';
  if (tone === 'muted') return 'bg-white/20';
  return 'bg-warn';
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
    <div>
      {/*
        Um trilho fino, não uma barra.

        A versão anterior era um retângulo de 24px cujo FUNDO tinha a mesma cor
        da folha: o trilho sumia e sobrava um tijolo verde flutuando no meio da
        coluna, sem começo nem fim visíveis. Aqui o trilho aparece, a zona é um
        trecho dele e o preço é uma bolinha — a leitura é imediata mesmo antes
        de ler os números embaixo.
      */}
      <div className="relative h-1.5 rounded-full bg-white/[0.07]">
        <div
          className="absolute inset-y-0 rounded-full bg-bull/40"
          style={{
            left: `${posicao(entryLow)}%`,
            width: `${Math.max(posicao(entryHigh) - posicao(entryLow), 1.5)}%`,
          }}
        />
        <span
          className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-terminal-panel ${
            dentro ? 'bg-bull' : 'bg-warn'
          }`}
          style={{ left: `${posicao(currentPrice)}%` }}
        />
      </div>
      <div className="mt-2 flex justify-between gap-3 text-[11px] tabular">
        <span className="text-terminal-muted">
          zona {price(entryLow)} – {price(entryHigh)}
        </span>
        <span className={dentro ? 'text-bull' : 'text-warn'}>
          {dentro
            ? 'preço dentro da zona'
            : `${distance > 0 ? '+' : ''}${distance.toFixed(2)}% da zona`}
        </span>
      </div>
    </div>
  );
}
