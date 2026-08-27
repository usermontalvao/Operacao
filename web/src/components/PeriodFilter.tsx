export type PeriodId = 'HOJE' | 'ONTEM' | 'SEMANA' | 'MES' | 'TRIMESTRE' | 'ANO' | 'TUDO';

export interface Period {
  id: PeriodId;
  label: string;
  from: Date | null;
  to: Date | null;
}

function startOfDay(offsetDays = 0): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - offsetDays);
  return date;
}

/**
 * Recortes de tempo do painel.
 *
 * "Ontem" é o dia fechado inteiro, não as últimas 24 horas — é assim que a
 * pessoa pensa quando pergunta como foi ontem. Os demais são janelas móveis
 * a partir de agora.
 */
export function buildPeriod(id: PeriodId): Period {
  switch (id) {
    case 'HOJE':
      return { id, label: 'Hoje', from: startOfDay(), to: null };
    case 'ONTEM':
      return { id, label: 'Ontem', from: startOfDay(1), to: startOfDay() };
    case 'SEMANA':
      return { id, label: '7 dias', from: startOfDay(6), to: null };
    case 'MES':
      return { id, label: '30 dias', from: startOfDay(29), to: null };
    case 'TRIMESTRE':
      return { id, label: '90 dias', from: startOfDay(89), to: null };
    case 'ANO': {
      const from = new Date();
      from.setMonth(0, 1);
      from.setHours(0, 0, 0, 0);
      return { id, label: 'Este ano', from, to: null };
    }
    default:
      return { id: 'TUDO', label: 'Tudo', from: null, to: null };
  }
}

export const PERIOD_IDS: PeriodId[] = ['HOJE', 'ONTEM', 'SEMANA', 'MES', 'TRIMESTRE', 'ANO', 'TUDO'];

/** Vira query string para as rotas de análise. */
export function periodQuery(period: Period): string {
  const parts: string[] = [];
  if (period.from) parts.push(`from=${encodeURIComponent(period.from.toISOString())}`);
  if (period.to) parts.push(`to=${encodeURIComponent(period.to.toISOString())}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

export function PeriodFilter({
  value,
  onChange,
}: {
  value: PeriodId;
  onChange: (id: PeriodId) => void;
}) {
  /*
    Sete recortes não cabem lado a lado num celular. Antes eles quebravam em
    duas fileiras dentro da moldura, e a segunda ficava com dois botões soltos
    à esquerda — parecia defeito. Agora a faixa rola na horizontal: uma linha
    só em qualquer largura, e o dedo empurra para ver o resto.
  */
  return (
    <div className="-mx-0.5 flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-terminal-border bg-terminal-panel p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {PERIOD_IDS.map((id) => {
        const selected = id === value;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(id)}
            className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
              selected
                ? 'bg-terminal-panel-soft text-terminal-text'
                : 'text-terminal-muted hover:text-terminal-text'
            }`}
          >
            {buildPeriod(id).label}
          </button>
        );
      })}
    </div>
  );
}
