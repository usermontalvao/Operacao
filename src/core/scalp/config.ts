import type { MicroScalpSettings } from '../types.ts';

/**
 * Os números que decidem o micro scalp, todos em um lugar só.
 *
 * Cada um é uma HIPÓTESE, não uma verdade — foram calibrados sobre a medição
 * que originou o módulo (30 pares da watchlist, 17h de candles de 1m, book
 * real da Binance) e a expectativa é que mudem depois do primeiro backtest.
 * É por isso que estão nas Configurações e não espalhados pelo código: um
 * limiar escondido dentro de um `if` é um limiar que ninguém revisa.
 *
 * O padrão é DESLIGADO. Um módulo que opera dezenas de vezes por hora não
 * deve nascer ligado por atualização de versão.
 */
export const DEFAULT_MICRO_SCALP: MicroScalpSettings = {
  enabled: false,

  /*
   * Os filtros vetam por padrão.
   *
   * O padrão precisa ser o conservador porque ele é o que vale para quem não
   * leu nada: ligar o módulo e receber uma lista de teses cujo lucro líquido é
   * negativo seria pior que não ter o módulo. Quem desliga isto está pedindo
   * para ver o mercado inteiro e decidir sozinho — e a tela continua dizendo,
   * em cada tese, quanto sobra depois dos custos.
   */
  enforceFilters: true,
  /*
   * Cada candidato custa uma chamada de candles (peso 2) e uma de book
   * (peso 5). Sessenta por volta são 420 de peso a cada três minutos —
   * desprezível perto do teto de 6000/min da Binance, e o suficiente para
   * cobrir tudo que tem volume relevante.
   */
  maxCandidates: 60,

  /*
   * Vinte pares é o que cabe em tempo real sem estragar o resto.
   *
   * Cada par do universo de scalp acrescenta um stream de kline de 1m à MESMA
   * conexão que já carrega os quatro timeframes de toda a watchlist. Vinte
   * pares são vinte streams a mais — barato. Duzentos entupiriam a conexão
   * que o painel inteiro usa para receber preço.
   */
  maxUniverseSize: 20,
  // o book muda o tempo todo, mas a LIQUIDEZ de um par não muda a cada minuto
  universeRefreshSeconds: 180,
  /*
   * O escorregamento é medido com o tamanho de ordem que a conta realmente
   * usa. Medir com US$ 1 daria um número lindo e falso: o que importa é
   * quanto o preço médio piora quando ESTA ordem varre o book.
   */
  probeOrderUsd: 50,

  filters: {
    minQuoteVolume24h: 20_000_000,
    // 15 minutos de volume: um par pode ter feito 50 M ontem e estar parado agora
    minRecentQuoteVolume: 150_000,
    maxSpreadPercent: 0.06,
    minBookDepthUsd: 5_000,
    maxSlippagePercent: 0.05,
    /*
     * Piso de amplitude: 0,08% de ATR por barra.
     *
     * Vem direto da aritmética que originou o módulo. Com taxa de 0,1% por
     * lado, o custo de ida e volta é ~0,2%; um par cujo ATR de 1m é 0,056%
     * (o do BTC) precisaria de um alvo de 17 ATR para pagar a conta, e isso
     * não é mais um trade de 1 minuto. Abaixo deste piso não há o que capturar.
     */
    minMicroAtrPercent: 0.08,
    /*
     * Teto de amplitude. ATR de 1m acima de 0,9% não é oscilação lateral: é
     * notícia, listagem nova ou liquidação em cascata. O micro scalp compra a
     * borda de uma faixa — numa vela dessas, a borda não existe.
     */
    maxMicroAtrPercent: 0.9,
    minScore: 70,
  },

  /*
   * Pesos do scalpabilityScore. Os quatro positivos somam 100; os descontos
   * podem levar a nota a zero, e é isso que se quer: spread alto sozinho
   * deve conseguir reprovar um par com volume excelente.
   */
  weights: {
    liquidity: 25,
    recentVolume: 20,
    usableVolatility: 35,
    bookDepth: 20,
    spreadPenalty: 30,
    slippagePenalty: 25,
    costPenalty: 25,
  },

  regime: {
    // 60 barras = a última hora. Menos que isso e qualquer par parece lateral
    lookback: 60,
    maxAdx: 22,
    /*
     * Um terço da amplitude em dez barras. Acima disso a "faixa" é um canal
     * inclinado: a borda de baixo de hoje é o meio da faixa de dez barras
     * atrás, e comprá-la é comprar um degrau de uma escada em movimento.
     */
    maxEmaDriftOfRange: 0.33,
    /*
     * 0,35 — e este número foi MEDIDO, não escolhido.
     *
     * Em 1.092 janelas de 60 barras de 1m sobre 12 pares líquidos, a
     * distribuição da travessia do eixo ficou assim:
     *
     *   p25 0,17 · p50 0,32 · p75 0,45 · p90 0,55
     *
     * Um limite de 0,5 aceitaria 83% das janelas — filtro que não filtra.
     * 0,25 aceitaria 38% e recusaria faixa boa. 0,35 corta a metade
     * visivelmente inclinada e deixa passar a metade em que o eixo ficou
     * parado, que é exatamente o que a palavra "lateral" quer dizer.
     */
    maxEmaTravelOfRange: 0.35,
    minTouchesPerSide: 2,
    /*
     * A faixa inteira precisa valer 3x o custo. Não é o alvo: é a distância
     * entre suporte e resistência. Um alvo é ~60% dela, então isso deixa o
     * alvo em ~1,8x o custo antes ainda de o guarda de oportunidade olhar.
     */
    minAmplitudeCostMultiple: 3,
    maxVolatilityExpansion: 1.8,
    // comprar nos 25% de baixo da faixa; vender nos 25% de cima
    entryZonePercent: 25,
    /*
     * O guarda de oportunidade. O lucro bruto esperado precisa ser pelo menos
     * o dobro de tudo que a operação paga. Abaixo disso, acertar rende quase
     * nada e errar custa o de sempre — e a assimetria trabalha contra.
     */
    minCostMultiple: 2,
  },

  setupTtlMinutes: 3,
  cooldownMinutes: 10,
};
