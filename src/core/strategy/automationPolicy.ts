import { timeframeOperaExplosao } from '../setups/momentumBurst.ts';
import type { MarketKind, Side } from '../direction.ts';
import type { AutoTradeSettings, SetupType } from '../types.ts';

/**
 * Estratégias autorizadas a operar sem intervenção humana.
 *
 * O laboratório separa treino e teste. Até agora, somente MOMENTUM_BURST
 * manteve expectativa positiva nas duas janelas; pullback, reteste e reversão
 * seguem no scanner para observação e pesquisa, mas não podem movimentar o
 * robô só porque receberam uma nota alta de um score que não previu retorno.
 */
/*
 * RANGE_FADE (micro scalp de 1m) NÃO entra nesta lista, e isso é a decisão
 * central do módulo: ele nasce gerando sinal e medindo resultado, sem
 * permissão para movimentar dinheiro sozinho. A pergunta que autoriza um
 * automatismo — "há expectativa líquida positiva depois dos custos, em treino
 * e em teste?" — só pode ser respondida pelo backtest separado do micro scalp
 * (src/lab/microScalp.ts). Enquanto ela não tiver resposta, a entrada é manual.
 */
export const VALIDATED_AUTOMATIC_SETUP_TYPES: readonly SetupType[] = ['MOMENTUM_BURST'];
export const MIN_VALIDATED_AUTOMATIC_SCORE = 90;

const validated = new Set<SetupType>(VALIDATED_AUTOMATIC_SETUP_TYPES);

export interface AutomaticStrategyCandidate {
  setupType: SetupType;
  score: number;
  /** corpo da barra de explosão em ATRs; ausente = não classificado */
  burstBodyAtr?: number | null;
  /** gatilho em que a tese nasceu — a explosão só opera em 4h */
  timeframe?: string;
  /** ausente = comprado, que é o único lado medido */
  side?: Side;
  /** ausente = spot, que é o único mercado medido */
  market?: MarketKind;
}

/**
 * Por que uma tese não pode rodar sozinha — com código, para o funil contar.
 *
 * A frase é apresentação e muda quando a redação melhorar; o código é estável
 * e é por ele que o painel escolhe a cor e a auditoria agrupa. Antes o
 * chamador adivinhava o código lendo a frase (`includes('observação')`), o que
 * quebrava calado a cada texto novo.
 */
export interface AutomaticRejection {
  code:
    | 'SHORT_NOT_AUTOMATED'
    | 'MARKET_NOT_VALIDATED'
    | 'STRATEGY_NOT_VALIDATED'
    | 'STRATEGY_DISABLED'
    | 'TIMEFRAME_NOT_ENABLED'
    | 'SCORE_BELOW_VALIDATED_FLOOR';
  message: string;
}

export function automaticRejection(
  setup: AutomaticStrategyCandidate,
  autoTrade?: AutoTradeSettings,
): AutomaticRejection | null {
  /*
   * O lado vendido existe no radar e pode ser executado à mão em futuros, mas
   * NÃO pelo robô. Os números que autorizam a automação — treino e teste, duas
   * janelas, custos nas duas pontas — foram medidos só na compra. Espelhar o
   * código de um detector não espelha a expectativa dele: ligar o robô no lado
   * de baixo seria colocar em produção uma estratégia que ninguém mediu, e o
   * fato de a mecânica ser simétrica não é evidência de que o resultado é.
   */
  if (setup.side === 'SELL') {
    return {
      code: 'SHORT_NOT_AUTOMATED',
      message:
        'tese vendida: o laboratório só mediu o lado comprado, então a venda a descoberto é entrada manual',
    };
  }
  /*
   * E o COMPRADO em futuros também não foi medido.
   *
   * É o mesmo erro do parágrafo acima, por outro eixo, e mais fácil de
   * cometer porque a tese parece idêntica à do spot. Não é:
   *
   *  - o backtest que autoriza a automação rodou sobre histórico de SPOT, e o
   *    contrato perpétuo tem candle e volume próprios;
   *  - o preço do futuro se afasta do à vista (basis), então entrada, stop e
   *    alvo medidos num livro não são os mesmos no outro;
   *  - funding é um custo recorrente que o backtest de spot não tinha e que
   *    come justamente a expectativa das operações que duram mais;
   *  - a liquidação é uma saída que não existe em spot, e ela chega antes do
   *    stop quando a alavancagem sobe.
   *
   * Enquanto a coluna de futuros for alimentada por candle de spot, "positivo
   * no laboratório" é uma frase sobre outro mercado. Entrada manual continua
   * liberada — quem clica está olhando o gráfico e assumindo a diferença.
   */
  if (setup.market === 'FUTURES') {
    return {
      code: 'MARKET_NOT_VALIDATED',
      message:
        'futuros não foi medido: a expectativa positiva veio de histórico de spot, e o perpétuo tem candle próprio, basis, funding e liquidação. Em futuros o robô não entra — a operação é manual',
    };
  }
  /*
   * A explosão só vira ORDEM no 4h.
   *
   * No 1h as nove regras testadas em 62 pares negociáveis e 9 anos falharam
   * fora da amostra — todas com teste negativo, inclusive a que rodava
   * (+0,07 treino / -0,05 teste). Não é calibragem de piso: é o gatilho.
   *
   * A recusa mora aqui, e não no detector, de propósito: o setup continua
   * nascendo no 1h para o radar e para estudo futuro. O que ele não faz é
   * ficar elegível a dinheiro.
   */
  if (
    setup.setupType === 'MOMENTUM_BURST' &&
    setup.timeframe !== undefined &&
    !timeframeOperaExplosao(setup.timeframe)
  ) {
    return {
      code: 'TIMEFRAME_NOT_ENABLED',
      message: `explosão no ${setup.timeframe} fica só no radar: fora da amostra este gatilho foi negativo em todas as regras testadas. O robô opera explosão apenas no 4h`,
    };
  }

  const configured = autoTrade?.strategies?.[setup.setupType];
  if (configured !== undefined) {
    if (!configured.enabled) {
      return {
        code: 'STRATEGY_DISABLED',
        message: `${setup.setupType} está visível no radar, mas a entrada automática desta estratégia está desligada nos ajustes desta conta`,
      };
    }
    /*
     * O score NÃO barra a explosão — e isto é resultado de medição, não
     * preferência.
     *
     * Auditando 62 pares negociáveis e 9 anos com os pisos derrubados, o
     * cruzamento score x corpo mostrou que o score é um PROXY do corpo:
     * corpo pequeno vive em score baixo, corpo grande em score alto. Filtrado
     * o corpo, o score não acrescenta nada:
     *
     *   corpo >= 3,0 SEM score .. 384 operações · +0,402R
     *   corpo >= 3,0 COM score .. 377 operações · +0,397R
     *
     * Sete operações de diferença. E o score sozinho (sem piso de corpo) não
     * passa nas provas de robustez: 3/5 janelas. Quem decide é o corpo, que
     * o próprio detector já exigiu antes de o setup existir.
     *
     * O score continua sendo calculado, gravado, exibido e medido — deixou de
     * ser porteiro, não deixou de existir.
     */
    if (setup.setupType !== 'MOMENTUM_BURST' && setup.score < configured.minimumScore) {
      return {
        code: 'SCORE_BELOW_VALIDATED_FLOOR',
        message: `score ${setup.score} abaixo do piso de ${configured.minimumScore} configurado para ${setup.setupType}`,
      };
    }
    return null;
  }

  // Compatibilidade com snapshots e chamadas de laboratório anteriores à
  // política por setup: sem configuração explícita vale a régua validada.
  if (!validated.has(setup.setupType)) {
    return {
      code: 'STRATEGY_NOT_VALIDATED',
      message: `${setup.setupType} está em observação: sem expectativa positiva no treino e no teste; o robô só opera MOMENTUM_BURST`,
    };
  }
  if (setup.score < MIN_VALIDATED_AUTOMATIC_SCORE) {
    return {
      code: 'SCORE_BELOW_VALIDATED_FLOOR',
      message: `score ${setup.score} abaixo do piso validado de ${MIN_VALIDATED_AUTOMATIC_SCORE}`,
    };
  }
  return null;
}

/** Só a frase, para quem não precisa do código. */
export function automaticStrategyRejectionReason(
  setup: AutomaticStrategyCandidate,
  autoTrade?: AutoTradeSettings,
): string | null {
  return automaticRejection(setup, autoTrade)?.message ?? null;
}

/**
 * Fator de tamanho por confiança no sinal — hoje NEUTRO para a explosão.
 *
 * Este multiplicador já teve duas versões, e as duas foram desfeitas pela
 * medição:
 *
 *  - por margem de score: o score não prevê retorno (faixa 85-89 rendeu
 *    +0,369R e 95-100 rendeu +0,296R);
 *  - por tamanho do corpo: a explosão maior não rende mais (3,5-4,0 deu
 *    +0,166R contra +0,256R de 2,5-2,75).
 *
 * Sem evidência de que algum grau mereça mais dinheiro, o multiplicador sai
 * do caminho: quem dimensiona é o orçamento de risco e o teto de exposição,
 * que são regras de sobrevivência e não apostas sobre qualidade de sinal.
 * A classificação NORMAL/STRONG continua existindo para telemetria, estudo e
 * ordenação — ela simplesmente não move capital.
 *
 * As estratégias sem vantagem medida seguem com meio tamanho: elas nunca
 * foram validadas, e reduzir é o único ajuste defensável na ausência de dado.
 */
export function strategyConfidenceSizeFactor(
  setup: AutomaticStrategyCandidate,
  _autoTrade: AutoTradeSettings,
): number {
  return setup.setupType === 'MOMENTUM_BURST' ? 1 : 0.5;
}

/**
 * Até quando um sinal ainda representa o que foi medido.
 *
 * O TTL do setup (12h por padrão) serve para o radar: um pullback continua
 * sendo um pullback horas depois. Não serve para o robô. MOMENTUM_BURST mede
 * uma explosão — o backtest entrou logo depois dela, e comprar a mesma
 * explosão três horas mais tarde é outra operação, com outra expectativa, que
 * ninguém mediu.
 *
 * ATENÇÃO: este número é POLÍTICA, não resultado de backtest. Foi escolhido de
 * forma conservadora para que ligar o robô não ressuscite sinais antigos, e
 * está isolado aqui justamente para ser calibrado quando houver amostra.
 */
export const MAX_SIGNAL_AGE_MS: Record<SetupType, number> = {
  MOMENTUM_BURST: 3 * 60 * 60_000,
  PULLBACK: 12 * 60 * 60_000,
  BREAKOUT_RETEST: 12 * 60 * 60_000,
  SUPPORT_REVERSAL: 12 * 60 * 60_000,
  /*
   * Três minutos, e não é conservadorismo: é o tempo em que a tese existe.
   *
   * O RANGE_FADE mede uma faixa de 60 barras de 1 minuto e compra a borda
   * dela. Passados dez minutos, um sexto das barras que definiram a faixa já
   * saiu da janela — a faixa medida não é mais a faixa atual. Reaproveitar o
   * sinal seria operar um retrato de um mercado que já mudou.
   */
  RANGE_FADE: 3 * 60_000,
};

export function maxSignalAgeMs(setupType: SetupType): number {
  return MAX_SIGNAL_AGE_MS[setupType] ?? 12 * 60 * 60_000;
}
