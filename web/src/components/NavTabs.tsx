export type Tab = 'RADAR' | 'HISTORICO' | 'DESEMPENHO' | 'AJUSTES' | 'DIARIO' | 'DIAGNOSTICO';

interface TabDefinition {
  id: Tab;
  label: string;
  icon: (props: { className: string }) => React.ReactElement;
}

/** Ícones em traço, desenhados aqui: nada de fonte de ícone externa. */
const RadarIcon = ({ className }: { className: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4" />
    <path d="M12 12 18 6" strokeLinecap="round" />
  </svg>
);

const HistoryIcon = ({ className }: { className: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className}>
    <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
  </svg>
);

const ChartIcon = ({ className }: { className: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className}>
    <path d="M4 19V5" strokeLinecap="round" />
    <path d="M4 15.5 9.5 10l4 3.5L20 7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const JournalIcon = ({ className }: { className: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className}>
    <path d="M5 4.5h11a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2z" strokeLinejoin="round" />
    <path d="M9 9h6M9 13h4" strokeLinecap="round" />
  </svg>
);

const PulseIcon = ({ className }: { className: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className}>
    <path d="M3 12h4l2.5-6 4 12 2.5-6h5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const GearIcon = ({ className }: { className: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className={className}>
    <circle cx="12" cy="12" r="3.2" />
    <path
      d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18"
      strokeLinecap="round"
    />
  </svg>
);

export const TABS: TabDefinition[] = [
  { id: 'RADAR', label: 'Radar', icon: RadarIcon },
  { id: 'HISTORICO', label: 'Operações', icon: HistoryIcon },
  { id: 'DESEMPENHO', label: 'Carteira', icon: ChartIcon },
  { id: 'AJUSTES', label: 'Ajustes', icon: GearIcon },
  { id: 'DIARIO', label: 'Diário', icon: JournalIcon },
  { id: 'DIAGNOSTICO', label: 'Diagnóstico', icon: PulseIcon },
];

/**
 * Navegação em dois formatos, a mesma lista nos dois.
 *
 * No monitor as abas ficam junto ao cabeçalho, onde a mão já está; no celular
 * continuam embaixo, ao alcance do polegar. A barra de baixo antiga era só
 * texto cinza, sem marca de onde se está — dava para ficar perdido dentro do
 * próprio painel.
 */
export function NavTabs({
  active,
  onChange,
  variant,
  counts,
  onPrefetch,
}: {
  active: Tab;
  onChange: (tab: Tab) => void;
  variant: 'top' | 'bottom';
  /** número mostrado entre parênteses na aba — hoje as posições em andamento */
  counts?: Partial<Record<Tab, number>>;
  /**
   * Avisado quando o ponteiro encosta na aba, antes do clique. Os ~200 ms
   * entre encostar e clicar são de graça: se a busca começar aí, a aba abre
   * com o conteúdo já pronto. No toque vale o instante do dedo descendo.
   */
  onPrefetch?: (tab: Tab) => void;
}) {
  const adiantar = (tab: Tab) => ({
    onPointerEnter: () => onPrefetch?.(tab),
    onPointerDown: () => onPrefetch?.(tab),
  });

  if (variant === 'top') {
    return (
      <div className="hidden shrink-0 items-center gap-0.5 rounded-lg border border-terminal-border bg-terminal-panel p-0.5 sm:flex">
        {TABS.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              aria-current={selected ? 'page' : undefined}
              onClick={() => onChange(tab.id)}
              {...adiantar(tab.id)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                selected
                  ? 'bg-terminal-panel-soft text-terminal-text'
                  : 'text-terminal-muted hover:text-terminal-text'
              }`}
            >
              <tab.icon className={`h-3.5 w-3.5 ${selected ? 'text-bull' : ''}`} />
              {tab.label}
              {counts?.[tab.id] !== undefined ? (
                <span className={selected ? 'text-terminal-muted' : ''}>({counts[tab.id]})</span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-terminal-border bg-terminal-bg/95 backdrop-blur sm:hidden">
      <div className="mx-auto flex max-w-6xl">
        {TABS.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              aria-current={selected ? 'page' : undefined}
              onClick={() => onChange(tab.id)}
              {...adiantar(tab.id)}
              className="relative flex flex-1 flex-col items-center gap-1 py-2.5"
            >
              {selected ? (
                <span className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-bull" />
              ) : null}
              <tab.icon className={`h-5 w-5 ${selected ? 'text-bull' : 'text-terminal-muted'}`} />
              <span className={`text-[10px] ${selected ? 'text-terminal-text' : 'text-terminal-muted'}`}>
                {tab.label}
                {counts?.[tab.id] !== undefined ? ` (${counts[tab.id]})` : ''}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
