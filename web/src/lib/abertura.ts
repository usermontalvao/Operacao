/**
 * A abertura escrita no index.html e quem a apaga.
 *
 * Ela não é apagada assim que o React monta: montar não é ter o que mostrar.
 * Se fosse, a pessoa trocaria a abertura por um "Carregando…" solto no meio da
 * tela preta — que é exatamente o quadro que ela existe para evitar.
 *
 * Quem chama é a primeira tela com conteúdo de verdade: a porta de entrada, o
 * erro de servidor ou o painel já com o esqueleto no lugar. Chamar duas vezes
 * não faz mal.
 */
export function encerrarAbertura(): void {
  const abertura = document.getElementById('abertura');
  if (!abertura || abertura.dataset.saindo === 'sim') return;

  // um quadro pintado com o conteúdo novo ANTES de a abertura desaparecer:
  // sem isso, o esvaecimento revela um vazio de um quadro por baixo
  requestAnimationFrame(() => {
    abertura.dataset.saindo = 'sim';
    // 'transitionend' não chega quando a aba está em segundo plano; o tempo
    // aqui é o mesmo da transição declarada no index.html, com folga
    window.setTimeout(() => abertura.remove(), 400);
  });
}
