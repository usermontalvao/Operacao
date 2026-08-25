/**
 * A marca do painel.
 *
 * O mesmo desenho da aba do navegador e da tela de entrada: o traço de um
 * gráfico subindo depois de um fundo. Ele é riscado uma vez, ao aparecer —
 * nunca em laço. Logotipo que pisca sem parar deixa de ser identidade e vira
 * indicador de carregamento, e este aqui fica na tela o dia inteiro.
 *
 * `estatica` desliga o risco para quando a marca aparece dentro de algo que
 * já está animando por conta própria.
 */
export function Marca({
  tamanho = 28,
  estatica = false,
  className = '',
}: {
  tamanho?: number;
  estatica?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={tamanho}
      height={tamanho}
      role="img"
      aria-label="Crypto Hunter"
      className={`shrink-0 ${className}`}
    >
      <rect width="32" height="32" rx="7" className="fill-terminal-panel" />
      <path
        d="M6 23 L13 15 L18 19 L26 9"
        fill="none"
        stroke="#16c784"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={estatica ? undefined : 'marca-traco'}
      />
    </svg>
  );
}
