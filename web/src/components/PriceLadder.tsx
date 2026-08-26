import type { Side } from '../lib/types.ts';
import { price as formatPrice } from '../lib/format.ts';

interface PriceLadderProps {
  /**
   * Direção da tese. Ela vira a régua ao contrário: no vendido o stop está
   * ACIMA da entrada e o alvo abaixo. Sem isto as faixas somem (largura
   * negativa) e a barra que enche nem desenha — `alvo − stop` fica negativo.
   * A figura é sempre a mesma: morre à esquerda, paga à direita.
   */
  side?: Side;
  stop: number;
  entryLow: number;
  /** ausente = entrada em preço único, não em zona */
  entryHigh?: number | null;
  target: number;
  current: number | null;
  /** rótulos abaixo da régua; desligue quando a linha já mostra os números */
  labels?: boolean;
  /**
   * 'ladder' desenha a régua de preço (radar: a ideia ainda não começou).
   * 'liquid' enche a barra do stop até onde o preço está — é para posição
   * aberta, onde a pergunta não é "onde fica o alvo" e sim "estou mais perto
   * de ganhar ou de perder".
   */
  mode?: 'ladder' | 'liquid';
}

/**
 * Régua de preço: stop à esquerda, alvo à direita, e onde o preço está agora.
 *
 * É a mesma peça no radar, na posição aberta e no desempenho — de propósito.
 * Um número solto ("0,0946") não diz nada; o que informa é a posição dele
 * entre o ponto em que a ideia morre e o ponto em que ela se paga. Quem olha
 * três telas diferentes precisa reconhecer a mesma figura em todas.
 */
export function PriceLadder({
  side = 'BUY',
  stop,
  entryLow,
  entryHigh,
  target,
  current,
  labels = false,
  mode = 'ladder',
}: PriceLadderProps) {
  if (mode === 'liquid') {
    return (
      <LiquidBar
        side={side}
        stop={stop}
        entry={entryLow}
        target={target}
        current={current}
        labels={labels}
      />
    );
  }

  const high = entryHigh ?? entryLow;
  const values = [stop, entryLow, high, target, current ?? entryLow].filter(
    (value) => Number.isFinite(value) && value > 0,
  );
  const low = Math.min(...values);
  const top = Math.max(...values);
  const span = top - low;
  if (!Number.isFinite(span) || span <= 0) return null;

  // folga nas pontas para o marcador do preço não encostar na borda
  const padding = span * 0.06;
  const from = low - padding;
  const to = top + padding;
  // no vendido a régua é espelhada: o preço continua sendo o eixo, mas ele
  // corre para a esquerda. Assim "andar para a direita" é sempre ganhar
  const short = side === 'SELL';
  const at = (value: number): number => {
    const position = ((value - from) / (to - from)) * 100;
    return short ? 100 - position : position;
  };

  const stopAt = at(stop);
  const entryLowAt = short ? at(high) : at(entryLow);
  const entryHighAt = short ? at(entryLow) : at(high);
  const targetAt = at(target);
  const currentAt = current === null ? null : at(current);
  const beyondTarget = current !== null && (short ? current <= target : current >= target);
  const beyondStop = current !== null && (short ? current >= stop : current <= stop);

  return (
    <div className="w-full">
      <div className="relative h-1.5 w-full rounded-full bg-terminal-panel-soft">
        {/* do stop até a entrada: o território onde a operação perde */}
        <span
          className="absolute top-0 h-full rounded-l-full bg-bear/35"
          style={{ left: `${stopAt}%`, width: `${Math.max(entryLowAt - stopAt, 0)}%` }}
        />
        {/* zona de entrada */}
        <span
          className="absolute top-0 h-full bg-info/50"
          style={{ left: `${entryLowAt}%`, width: `${Math.max(entryHighAt - entryLowAt, 0.6)}%` }}
        />
        {/* da entrada até o alvo: o território onde ela paga */}
        <span
          className="absolute top-0 h-full rounded-r-full bg-bull/35"
          style={{ left: `${entryHighAt}%`, width: `${Math.max(targetAt - entryHighAt, 0)}%` }}
        />

        <Tick position={stopAt} className="bg-bear" />
        <Tick position={targetAt} className="bg-bull" />

        {currentAt !== null ? (
          <span
            className={`absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-full ${
              beyondTarget ? 'bg-bull' : beyondStop ? 'bg-bear' : 'bg-terminal-text'
            }`}
            style={{ left: `${currentAt}%` }}
            title={`preço agora ${formatPrice(current)}`}
          />
        ) : null}
      </div>

      {labels ? (
        <div className="mt-1 flex items-center justify-between text-[10px] tabular">
          <span className="text-bear">{formatPrice(stop)}</span>
          <span className="text-terminal-muted">
            {current === null ? '—' : formatPrice(current)}
          </span>
          <span className="text-bull">{formatPrice(target)}</span>
        </div>
      ) : null}
    </div>
  );
}

function Tick({ position, className }: { position: number; className: string }) {
  return (
    <span
      className={`absolute -top-0.5 h-2.5 w-px -translate-x-1/2 ${className}`}
      style={{ left: `${position}%` }}
    />
  );
}

/** A escala fixa: perto do stop é vermelho, perto do alvo é verde. */
const SCALE = 'linear-gradient(90deg, var(--color-bear) 0%, #d9822b 42%, var(--color-warn) 58%, var(--color-bull) 100%)';

/**
 * Barra que enche.
 *
 * O stop é o zero e o alvo é o cheio. A cor não é escolhida pelo lucro do
 * momento — ela é a posição na escala: quem está a um passo do stop vê
 * vermelho mesmo com o resultado ainda positivo, e é essa a informação que
 * importa para decidir se continua na operação.
 */
function LiquidBar({
  side,
  stop,
  entry,
  target,
  current,
  labels,
}: {
  side: Side;
  stop: number;
  entry: number;
  target: number;
  current: number | null;
  labels: boolean;
}) {
  // a distância percorrida A FAVOR, que nos dois lados vai de 0 no stop a
  // 100 no alvo. Medida crua, no vendido, o vão daria negativo e a barra
  // simplesmente não apareceria
  const direction = side === 'SELL' ? -1 : 1;
  const span = (target - stop) * direction;
  if (!Number.isFinite(span) || span <= 0) return null;

  const ratio = (value: number): number => (((value - stop) * direction) / span) * 100;
  const clamp = (value: number): number => Math.min(Math.max(value, 0), 100);

  const raw = current === null ? ratio(entry) : ratio(current);
  const fill = clamp(raw);
  const entryAt = clamp(ratio(entry));
  const beyondTarget = raw >= 100;
  const beyondStop = raw <= 0;
  // a barra é o líquido; o gradiente por trás dela não pode esticar junto,
  // senão a mesma cor apareceria em qualquer altura de preenchimento
  const scaleWidth = fill > 0 ? `${(100 / fill) * 100}%` : '100%';

  return (
    <div className="w-full">
      <div
        className="relative h-2 w-full"
        title={
          current === null
            ? 'sem preço agora'
            : `${Math.round(fill)}% do caminho entre o stop e o alvo · preço ${formatPrice(current)}`
        }
      >
        {/* o recorte arredondado guarda a escala e o líquido; a ponta fica
            fora dele, senão o próprio recorte a cortaria */}
        <span className="absolute inset-0 overflow-hidden rounded-full bg-terminal-panel-soft">
          {/* a escala apagada: mostra onde é vermelho e onde é verde mesmo vazia */}
          <span className="absolute inset-0 opacity-[0.12]" style={{ background: SCALE }} />

          <span
            className="absolute inset-y-0 left-0 overflow-hidden transition-[width] duration-500 ease-out"
            style={{ width: `${fill}%` }}
          >
            <span className="block h-full" style={{ width: scaleWidth, background: SCALE }} />
          </span>

          {/* a entrada: daqui para a direita a operação está ganhando */}
          <span
            className="absolute inset-y-0 w-px bg-terminal-text/45"
            style={{ left: `${entryAt}%` }}
          />
        </span>

        {/* a ponta do líquido, para o olho achar a altura sem medir */}
        {!beyondStop ? (
          <span
            className={`absolute -top-0.5 h-3 w-0.5 -translate-x-1/2 rounded-full ${
              beyondTarget ? 'bg-bull' : 'bg-terminal-text'
            }`}
            style={{ left: `${fill}%` }}
          />
        ) : null}
      </div>

      {labels ? (
        <div className="mt-1 flex items-center justify-between text-[10px] tabular">
          <span className="text-bear">{formatPrice(stop)}</span>
          <span className="text-terminal-muted">
            {current === null ? '—' : `${Math.round(fill)}%`}
          </span>
          <span className="text-bull">{formatPrice(target)}</span>
        </div>
      ) : null}
    </div>
  );
}
