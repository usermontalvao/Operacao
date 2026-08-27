import { useEffect, useRef } from 'react';

/**
 * Os atalhos que toda janela do painel entende.
 *
 * Cada modal tratava (ou não tratava) o teclado do seu jeito: a ficha do setup
 * fechava no Esc, a boleta não, o gráfico ampliado fechava a janela de trás
 * junto. Quem opera num terminal usa as duas mãos no teclado e espera o
 * contrato de sempre: Esc volta um passo, Enter confirma o que está em foco na
 * tela.
 *
 * Três cuidados que nasceram de errar:
 *
 *  1. Esc é do modal MAIS DE CIMA. O gráfico ampliado dentro da boleta tem de
 *     consumir o Esc e deixar a boleta aberta; por isso quem escuta na fase de
 *     captura para o evento, e quem está por baixo nunca chega a vê-lo.
 *  2. Enter dentro de um campo de texto é do campo, não da janela. Confirmar
 *     uma ordem porque alguém apertou Enter depois de digitar o valor é o pior
 *     acidente possível desta tela — e é o mais fácil de causar.
 *  3. Enter só confirma quando `onConfirm` existe E a ação está liberada.
 *     Um atalho que dispara um botão desabilitado é um atalho que fura a
 *     trava que o botão representa.
 */
export function useAtalhosDeModal({
  onClose,
  onConfirm,
  confirmHabilitado = false,
  ativo = true,
}: {
  onClose?: () => void;
  /** ação primária da janela; ausente quando não há uma ação óbvia */
  onConfirm?: () => void;
  /** espelha o `disabled` do botão principal — Enter não fura trava */
  confirmHabilitado?: boolean;
  /** false desliga os atalhos (janela coberta por outra, por exemplo) */
  ativo?: boolean;
}): void {
  /*
    O ouvinte é registrado UMA vez, e as funções chegam por referência.

    Com `onClose`/`onConfirm` nas dependências — e as duas nascem novas a cada
    render, porque são arrow inline na janela — o efeito rodava a cada tique de
    preço: remove e adiciona o ouvinte de novo. Numa fase de captura, quem
    adiciona por último passa a ser chamado por último, então a janela ia
    escorregando para o FIM da fila e o gráfico em tela cheia (registrado
    depois dela, uma vez só) passava a ser chamado ANTES. Era essa inversão que
    fazia um Esc fechar a janela junto com o gráfico.
  */
  const atual = useRef({ onClose, onConfirm, confirmHabilitado });
  atual.current = { onClose, onConfirm, confirmHabilitado };

  useEffect(() => {
    if (!ativo) return;

    const aoTeclar = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;

      /*
        O gráfico em tela cheia é dono do Esc enquanto estiver aberto.

        Os dois escutam na fase de captura, e nessa fase quem se registrou
        primeiro ganha — que é sempre o modal, porque ele já existia quando o
        gráfico foi ampliado. O resultado era o Esc fechar a janela INTEIRA em
        vez de só reduzir o gráfico, perdendo o valor digitado e o plano
        ajustado. A marca no `body` é a forma mais simples de o de baixo saber
        que há alguém por cima.
      */
      if (document.body.dataset.graficoAmpliado === 'sim') return;

      if (event.key === 'Escape' && atual.current.onClose) {
        event.preventDefault();
        event.stopPropagation();
        atual.current.onClose();
        return;
      }

      if (event.key !== 'Enter' || !atual.current.onConfirm || !atual.current.confirmHabilitado) {
        return;
      }
      // combinação de teclas é outro gesto: deixa passar
      if (event.shiftKey || event.altKey) return;
      if (digitando(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      atual.current.onConfirm();
    };

    window.addEventListener('keydown', aoTeclar, true);
    return () => window.removeEventListener('keydown', aoTeclar, true);
  }, [ativo]);
}

/**
 * O foco está num lugar onde Enter já significa alguma coisa.
 *
 * Campo de texto, área de texto, seletor e qualquer região editável. Botões
 * ficam de fora de propósito: Enter num botão focado já o aciona pelo próprio
 * navegador, e interceptar ali faria a janela confirmar em vez do botão.
 */
function digitando(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
