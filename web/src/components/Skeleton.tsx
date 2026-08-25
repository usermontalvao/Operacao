/**
 * Esqueleto de carregamento.
 *
 * Só aparece na PRIMEIRA visita a uma aba — depois disso o conteúdo guardado
 * entra na hora e a busca por dados novos acontece por baixo. Ele imita a
 * forma do que vai chegar em vez de escrever "Carregando…": a tela não muda
 * de altura quando o conteúdo entra, então nada salta debaixo do cursor.
 */
export function PageSkeleton({ blocos = 4 }: { blocos?: number }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Carregando</span>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, indice) => (
          <div key={indice} className="h-14 rounded-lg border border-terminal-border bg-terminal-panel-soft pulsando" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: blocos }, (_, indice) => (
          <div
            key={indice}
            className="h-16 rounded-lg border border-terminal-border bg-terminal-panel pulsando"
            // o atraso escalonado faz a lista respirar em onda em vez de
            // piscar tudo junto, que lê como travamento
            style={{ animationDelay: `${indice * 90}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
