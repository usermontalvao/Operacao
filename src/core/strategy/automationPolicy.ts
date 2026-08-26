import type { MarketKind, Side } from '../direction.ts';
import type { SetupType } from '../types.ts';

/**
 * Estratégias autorizadas a operar sem intervenção humana.
 *
 * O laboratório separa treino e teste. Até agora, somente MOMENTUM_BURST
 * manteve expectativa positiva nas duas janelas; pullback, reteste e reversão
 * seguem no scanner para observação e pesquisa, mas não podem movimentar o
 * robô só porque receberam uma nota alta de um score que não previu retorno.
 */
export const VALIDATED_AUTOMATIC_SETUP_TYPES: readonly SetupType[] = ['MOMENTUM_BURST'];
export const MIN_VALIDATED_AUTOMATIC_SCORE = 90;

const validated = new Set<SetupType>(VALIDATED_AUTOMATIC_SETUP_TYPES);

export interface AutomaticStrategyCandidate {
  setupType: SetupType;
  score: number;
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
    | 'SCORE_BELOW_VALIDATED_FLOOR';
  message: string;
}

export function automaticRejection(setup: AutomaticStrategyCandidate): AutomaticRejection | null {
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
export function automaticStrategyRejectionReason(setup: AutomaticStrategyCandidate): string | null {
  return automaticRejection(setup)?.message ?? null;
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
};

export function maxSignalAgeMs(setupType: SetupType): number {
  return MAX_SIGNAL_AGE_MS[setupType] ?? 12 * 60 * 60_000;
}
