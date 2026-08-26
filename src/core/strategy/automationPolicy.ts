import type { Side } from '../direction.ts';
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
}

export function automaticStrategyRejectionReason(setup: AutomaticStrategyCandidate): string | null {
  /*
   * O lado vendido existe no radar e pode ser executado à mão em futuros, mas
   * NÃO pelo robô. Os números que autorizam a automação — treino e teste, duas
   * janelas, custos nas duas pontas — foram medidos só na compra. Espelhar o
   * código de um detector não espelha a expectativa dele: ligar o robô no lado
   * de baixo seria colocar em produção uma estratégia que ninguém mediu, e o
   * fato de a mecânica ser simétrica não é evidência de que o resultado é.
   */
  if (setup.side === 'SELL') {
    return 'tese vendida: o laboratório só mediu o lado comprado, então a venda a descoberto é entrada manual';
  }
  if (!validated.has(setup.setupType)) {
    return `${setup.setupType} está em observação: sem expectativa positiva no treino e no teste; o robô só opera MOMENTUM_BURST`;
  }
  if (setup.score < MIN_VALIDATED_AUTOMATIC_SCORE) {
    return `score ${setup.score} abaixo do piso validado de ${MIN_VALIDATED_AUTOMATIC_SCORE}`;
  }
  return null;
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
