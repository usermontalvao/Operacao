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
}

export function automaticStrategyRejectionReason(setup: AutomaticStrategyCandidate): string | null {
  if (!validated.has(setup.setupType)) {
    return `${setup.setupType} está em observação: sem expectativa positiva no treino e no teste; o robô só opera MOMENTUM_BURST`;
  }
  if (setup.score < MIN_VALIDATED_AUTOMATIC_SCORE) {
    return `score ${setup.score} abaixo do piso validado de ${MIN_VALIDATED_AUTOMATIC_SCORE}`;
  }
  return null;
}
