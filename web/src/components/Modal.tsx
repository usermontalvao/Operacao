import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A janela — uma só, para todas as telas que se abrem por cima do painel.
 *
 * Antes cada modal montava a própria caixa: um escolhia `bg-black/75`, outro
 * `bg-black/80`; um abria de estalo, outro também; um fechava num botão
 * escrito "Fechar", outro em nenhum. Três janelas com três gramáticas fazem o
 * painel parecer três programas, e nenhuma delas parecia um aplicativo.
 *
 * O que esta casca garante, sem o modal precisar lembrar:
 *
 *  - o fundo escurece E desfoca, para o conteúdo de trás sair do caminho do
 *    olho sem sumir do contexto;
 *  - a folha ENTRA: sobe do rodapé no celular, aproxima-se no monitor. É a
 *    diferença mais barata entre "uma div apareceu" e "uma tela abriu";
 *  - a página de trás para de rolar enquanto a janela está aberta;
 *  - o foco entra na janela e volta para onde estava quando ela fecha;
 *  - cabeçalho e rodapé ficam parados, só o miolo rola.
 */

/**
 * Quantas janelas estão abertas, e como a página estava antes da primeira.
 *
 * As duas coisas moram fora do componente de propósito. Uma janela pode abrir
 * por cima de outra — o gráfico sobre a ficha do setup — e, se cada uma
 * guardasse o próprio "como estava antes", a de cima leria `hidden` (posto
 * pela de baixo) e devolveria `hidden` ao fechar: a página ficaria travada
 * sem nenhuma janela aberta.
 */
let abertas = 0;
let rolagemOriginal = '';

const LARGURAS = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-2xl',
  lg: 'sm:max-w-3xl lg:max-w-5xl',
  xl: 'sm:max-w-3xl lg:max-w-5xl xl:max-w-6xl',
} as const;

export function Modal({
  onClose,
  largura = 'md',
  cabecalho,
  rodape,
  children,
  rotulo,
  rolar = true,
  altura = 'conteudo',
}: {
  onClose: () => void;
  largura?: keyof typeof LARGURAS;
  /** normalmente um <ModalTitulo>; fica parado no topo */
  cabecalho: ReactNode;
  /** ações principais; ficam paradas embaixo */
  rodape?: ReactNode;
  children: ReactNode;
  /** nome da janela para leitores de tela */
  rotulo?: string;
  /**
   * Miolo com rolagem própria.
   *
   * `false` obriga o conteúdo a caber — é o que uma boleta e um gráfico
   * exigem: barra de rolagem dentro da janela de uma ordem significa que
   * parte da decisão está escondida no momento em que ela é tomada.
   *
   * `'ate-xl'` é o meio-termo honesto: no monitor a janela cabe inteira, no
   * celular ela rola. Uma tela de 6 polegadas não comporta um gráfico, um
   * tamanho, uma alavancagem e a conta da ordem ao mesmo tempo — insistir
   * nisso não deixa a informação caber, só a corta.
   */
  rolar?: boolean | 'ate-xl';
  /**
   * `cheia` faz a janela ocupar toda a altura que pode.
   *
   * Uma janela cujo conteúdo é um gráfico não deve encolher até o tamanho do
   * gráfico: ela vira uma tarja no meio da tela, e o preço — que é a única
   * coisa que ela mostra — fica pequeno à toa.
   */
  altura?: 'conteudo' | 'cheia';
}) {
  const folha = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const anterior = document.activeElement as HTMLElement | null;
    if (abertas === 0) rolagemOriginal = document.body.style.overflow;
    abertas += 1;
    document.body.style.overflow = 'hidden';
    folha.current?.focus({ preventScroll: true });
    return () => {
      abertas -= 1;
      if (abertas === 0) document.body.style.overflow = rolagemOriginal;
      anterior?.focus?.({ preventScroll: true });
    };
  }, []);

  return (
    <div
      className="modal-fundo fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6"
      onMouseDown={(event) => {
        // só fecha quando o gesto COMEÇA e TERMINA no fundo: arrastar uma
        // linha do gráfico e soltar fora da folha fechava a janela inteira
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={folha}
        role="dialog"
        aria-modal="true"
        aria-label={rotulo}
        tabIndex={-1}
        className={`modal-folha flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-white/[0.07] bg-terminal-panel text-terminal-text outline-none sm:max-h-[90dvh] sm:rounded-2xl ${
          altura === 'cheia' ? 'h-[92dvh] sm:h-[90dvh]' : ''
        } ${LARGURAS[largura]}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {/* pega-folha: no celular a janela é uma folha que subiu, e o traço é
            o que diz isso sem escrever nada */}
        <div className="flex justify-center pt-2.5 sm:hidden">
          <span className="h-1 w-9 rounded-full bg-white/15" />
        </div>

        <div className="shrink-0 px-4 pb-3 pt-3 sm:px-6 sm:pb-4 sm:pt-5">{cabecalho}</div>

        <div
          className={`min-h-0 flex-1 px-4 pb-1 sm:px-6 ${
            rolar === true
              ? 'modal-rolagem overflow-y-auto overscroll-contain'
              : rolar === 'ate-xl'
                ? 'modal-rolagem overflow-y-auto overscroll-contain xl:flex xl:flex-col xl:overflow-hidden'
                : 'flex flex-col overflow-hidden'
          }`}
        >
          {children}
        </div>

        {rodape ? (
          <div className="shrink-0 border-t border-white/[0.06] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-5 sm:pt-4">
            {rodape}
          </div>
        ) : (
          <div className="shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-4" />
        )}
      </div>
    </div>
  );
}

/**
 * O cabeçalho de toda janela: nome grande, contexto pequeno, fechar discreto.
 *
 * O botão de fechar é um X e não a palavra "Fechar" com moldura — a moldura
 * dava a ele o mesmo peso visual do botão que envia a ordem, e nenhuma tela
 * existe para ser fechada.
 */
export function ModalTitulo({
  titulo,
  subtitulo,
  etiquetas,
  onClose,
}: {
  titulo: ReactNode;
  subtitulo?: ReactNode;
  /** distintivos alinhados à direita, antes do X — no celular, embaixo */
  etiquetas?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-[1.1875rem] font-semibold leading-tight tracking-[-0.01em] sm:text-xl">
            {titulo}
          </h2>
          {subtitulo ? (
            <p className="mt-1 truncate text-[0.8125rem] leading-snug text-terminal-muted">{subtitulo}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/*
            Três distintivos ao lado do título comem a largura toda de um
            celular: sobrava "Comprar…" e um subtítulo cortado no meio. Da
            metade da tela para cima eles ficam na mesma linha; abaixo disso
            descem para uma linha própria, onde cabem inteiros.
          */}
          <span className="hidden items-center gap-2 sm:flex">{etiquetas}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="-mr-1 grid h-8 w-8 place-items-center rounded-full text-terminal-muted transition hover:bg-white/[0.06] hover:text-terminal-text"
          >
            <svg
              viewBox="0 0 20 20"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            >
              <path d="M5.5 5.5l9 9m0-9l-9 9" />
            </svg>
          </button>
        </div>
      </div>
      {etiquetas ? <div className="mt-2.5 flex flex-wrap items-center gap-2 sm:hidden">{etiquetas}</div> : null}
    </div>
  );
}

/** Distintivo silencioso: contexto que se lê, não que grita. */
export function Etiqueta({
  children,
  tom = 'neutro',
}: {
  children: ReactNode;
  tom?: 'neutro' | 'bull' | 'bear' | 'warn' | 'info';
}) {
  const tons = {
    neutro: 'text-terminal-muted bg-white/[0.05]',
    bull: 'text-bull bg-bull/12',
    bear: 'text-bear bg-bear/12',
    warn: 'text-warn bg-warn/12',
    info: 'text-info bg-info/12',
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-1 text-[10px] font-semibold uppercase leading-none tracking-[0.08em] ${tons[tom]}`}
    >
      {children}
    </span>
  );
}

/** Título de seção: uma linha fina, sem moldura em volta do que vem depois. */
export function Secao({
  titulo,
  acao,
  children,
  className = '',
}: {
  titulo?: string;
  acao?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      {titulo || acao ? (
        <div className="mb-2 flex items-center justify-between gap-3">
          {titulo ? (
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-terminal-muted">
              {titulo}
            </h3>
          ) : (
            <span />
          )}
          {acao}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * Lista de números.
 *
 * Cada linha era uma caixa com borda e fundo próprios; vinte caixas empilhadas
 * é o que faz uma tela de números parecer um formulário mal fechado. Aqui há
 * uma superfície só e fios de cabelo entre as linhas.
 */
export function Lista({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`divide-y divide-white/[0.05] rounded-xl bg-white/[0.025] ${className}`}>
      {children}
    </div>
  );
}

export function Linha({
  rotulo,
  valor,
  tom,
  nota,
  forte,
}: {
  rotulo: ReactNode;
  valor: ReactNode;
  tom?: string;
  /** segunda linha, menor, para o que o rótulo sozinho não explica */
  nota?: ReactNode;
  forte?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-3 py-2">
      <div className="min-w-0">
        <div className={`text-[0.8125rem] ${forte ? 'font-medium text-terminal-text' : 'text-terminal-muted'}`}>
          {rotulo}
        </div>
        {nota ? <div className="mt-0.5 text-[11px] text-terminal-muted/70">{nota}</div> : null}
      </div>
      <div className={`shrink-0 tabular text-[0.8125rem] ${forte ? 'font-semibold' : ''} ${tom ?? 'text-terminal-text'}`}>
        {valor}
      </div>
    </div>
  );
}

/** O número que a tela existe para mostrar: rótulo pequeno, valor grande. */
export function Numero({
  rotulo,
  valor,
  tom = '',
  nota,
}: {
  rotulo: string;
  valor: ReactNode;
  tom?: string;
  nota?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-terminal-muted">
        {rotulo}
      </div>
      <div className={`mt-1 truncate tabular text-[1.0625rem] font-semibold leading-none ${tom}`}>
        {valor}
      </div>
      {nota ? <div className="mt-1 text-[11px] text-terminal-muted">{nota}</div> : null}
    </div>
  );
}

/**
 * Aviso em linha. Uma faixa fina com um fio colorido na borda esquerda, em vez
 * do retângulo inteiro pintado — a cor continua dizendo a gravidade sem tomar
 * a tela de quem só quer o número ao lado.
 */
export function Aviso({
  tom,
  titulo,
  children,
  acao,
}: {
  tom: 'bear' | 'warn' | 'info' | 'bull';
  titulo?: ReactNode;
  children?: ReactNode;
  acao?: ReactNode;
}) {
  const tons = {
    bear: 'border-l-bear/70 bg-bear/[0.06] text-bear',
    warn: 'border-l-warn/70 bg-warn/[0.06] text-warn',
    info: 'border-l-info/70 bg-info/[0.06] text-info',
    bull: 'border-l-bull/70 bg-bull/[0.06] text-bull',
  } as const;
  return (
    <div className={`rounded-r-lg border-l-2 py-2 pl-3 pr-3 ${tons[tom]}`}>
      {titulo ? <p className="text-[0.75rem] font-semibold leading-snug">{titulo}</p> : null}
      {children ? (
        <div className="text-[0.75rem] leading-relaxed text-terminal-muted [&_strong]:text-current">
          {children}
        </div>
      ) : null}
      {acao ? <div className="mt-2">{acao}</div> : null}
    </div>
  );
}

/** Botões — três pesos, um formato. */
export function Botao({
  children,
  onClick,
  disabled,
  tipo = 'quieto',
  className = '',
  title,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** `forte` executa, `quieto` acompanha, `fantasma` é quase texto */
  tipo?: 'forte' | 'quieto' | 'fantasma' | 'perigo';
  className?: string;
  title?: string;
  type?: 'button' | 'submit';
}) {
  const tipos = {
    // travado não continua verde: verde é "pode ir", e um botão que não vai
    // não pode se parecer com um que vai
    forte:
      'bg-bull text-black hover:bg-bull/90 disabled:bg-white/[0.06] disabled:text-terminal-muted disabled:opacity-100',
    quieto: 'bg-white/[0.06] text-terminal-text hover:bg-white/[0.1]',
    fantasma: 'text-terminal-muted hover:bg-white/[0.06] hover:text-terminal-text',
    perigo: 'text-bear hover:bg-bear/10',
  } as const;
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-xl px-4 py-2.5 text-[0.8125rem] font-semibold transition disabled:cursor-not-allowed disabled:opacity-35 ${tipos[tipo]} ${className}`}
    >
      {children}
    </button>
  );
}
