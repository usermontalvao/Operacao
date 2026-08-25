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

/**
 * Esqueleto do Radar — a primeira tela, a única que não tem cache para pintar.
 *
 * Ele imita a mesa de trabalho: a faixa das posições, as linhas de setup com a
 * régua de preço e a tabela de acompanhamento. Imitar a forma importa mais
 * aqui do que nas outras abas, porque o Radar é a tela que abre: quando os
 * números chegam, eles ocupam o lugar que já estava reservado e nada salta.
 */
export function RadarSkeleton({ linhas = 3, ativos = 6 }: { linhas?: number; ativos?: number }) {
  return (
    <div className="space-y-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Carregando o radar</span>

      <section>
        <Barra className="mb-2 h-3 w-32" />
        <div className="overflow-hidden rounded-xl border border-terminal-border bg-terminal-panel">
          {Array.from({ length: linhas }, (_, indice) => (
            <div
              key={indice}
              className={`flex flex-col gap-2 px-3 py-2.5 ${indice === 0 ? '' : 'border-t border-terminal-border'}`}
            >
              <div className="flex items-center gap-2">
                <Barra className="h-3.5 w-14" atraso={indice * 90} />
                <Barra className="h-3.5 w-20" atraso={indice * 90} />
                <Barra className="ml-auto h-4 w-10" atraso={indice * 90} />
              </div>
              {/* a régua de preço: a faixa larga que dá o ritmo da linha */}
              <div className="flex items-center gap-3">
                <Barra className="h-2 w-14 shrink-0" atraso={indice * 90} />
                <Barra className="h-1.5 flex-1 rounded-full" atraso={indice * 90} />
                <Barra className="h-2 w-16 shrink-0" atraso={indice * 90} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <Barra className="mb-2 h-3 w-28" />
        <div className="overflow-hidden rounded-xl border border-terminal-border bg-terminal-panel">
          <div className="h-8 border-b border-terminal-border bg-terminal-panel-soft" />
          {Array.from({ length: ativos }, (_, indice) => (
            <div
              key={indice}
              className={`flex items-center gap-3 px-3 py-2.5 ${indice === 0 ? '' : 'border-t border-terminal-border'}`}
            >
              <Barra className="h-3 w-12" atraso={indice * 70} />
              <Barra className="ml-auto h-3 w-20" atraso={indice * 70} />
              <Barra className="h-3 w-12" atraso={indice * 70} />
              <Barra className="hidden h-3 w-16 sm:block" atraso={indice * 70} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * Um pedaço de conteúdo que ainda não chegou.
 *
 * A cor é a da borda, não a do painel: sobre fundo escuro, um cinza mais baixo
 * que isto some — e um esqueleto que não se vê é uma tela vazia com passos
 * extras. O atraso escalonado faz a lista respirar em onda em vez de piscar
 * tudo junto, que lê como travamento.
 */
function Barra({ className, atraso = 0 }: { className: string; atraso?: number }) {
  return (
    <div
      className={`rounded bg-terminal-border pulsando ${className}`}
      style={atraso ? { animationDelay: `${atraso}ms` } : undefined}
    />
  );
}
