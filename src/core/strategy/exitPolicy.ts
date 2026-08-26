import type { GuardSettings } from '../risk/governor.ts';
import type { SetupType } from '../types.ts';

/**
 * Plano de saída declarado por estratégia.
 *
 * O problema que este módulo resolve não é de código, é de silêncio. Existe um
 * `maxTargetPercent` global que se apresenta como "teto de alvo", mas ele só
 * descarta alvo 2 e alvo 3 — o alvo 1 passa sempre, de propósito, porque
 * descartá-lo deixaria a posição sem plano nenhum de saída. Duas coisas
 * verdadeiras e contraditórias, e nenhuma delas escrita em lugar algum.
 *
 * MOMENTUM_BURST é o caso em que isso importa: o alvo único de 3R fica
 * naturalmente distante quando o stop é largo, e foi COM esse alvo que a
 * estratégia mostrou expectativa positiva no treino e no teste. Apertar o teto
 * global mudaria a estratégia medida sem que ninguém percebesse — e o
 * resultado do laboratório deixaria de valer para o que o robô faz.
 *
 * Aqui a política vira dado explícito, e o sistema passa a saber avisar quando
 * uma configuração global contradiz a estratégia. Nada abaixo altera execução:
 * este módulo descreve e denuncia, não decide.
 */

export interface ExitPolicy {
  /** quantos alvos a estratégia usa de fato */
  targets: 1 | 3;
  /** true quando a posição sai em partes (50/30/20) */
  scaleOut: boolean;
  /** distância do alvo principal, em múltiplos de R */
  primaryTargetR: number;
  /** de onde sai o stop, em palavras — é isto que o backtest mediu */
  stopSource: string;
  /** o alvo principal pode ficar além do teto global de alvo? */
  primaryTargetExemptFromCeiling: boolean;
  notes: string;
}

export const EXIT_POLICIES: Record<SetupType, ExitPolicy> = {
  MOMENTUM_BURST: {
    targets: 1,
    scaleOut: false,
    primaryTargetR: 3,
    stopSource: 'mínima da explosão',
    primaryTargetExemptFromCeiling: true,
    notes:
      'Alvo único em 3R. Com stop largo, 3R passa do teto global com facilidade — e foi assim que a estratégia foi medida. Saída em 50/30/20 NÃO se aplica.',
  },
  PULLBACK: {
    targets: 3,
    scaleOut: true,
    primaryTargetR: 1,
    stopSource: 'abaixo do suporte do pullback',
    primaryTargetExemptFromCeiling: true,
    notes: 'Observacional: expectativa negativa em treino e teste. Não opera automático.',
  },
  BREAKOUT_RETEST: {
    targets: 3,
    scaleOut: true,
    primaryTargetR: 1,
    stopSource: 'abaixo do nível rompido',
    primaryTargetExemptFromCeiling: true,
    notes: 'Observacional: expectativa negativa em treino e teste. Não opera automático.',
  },
  SUPPORT_REVERSAL: {
    targets: 3,
    scaleOut: true,
    primaryTargetR: 1,
    stopSource: 'abaixo do suporte testado',
    primaryTargetExemptFromCeiling: true,
    notes: 'Observacional: expectativa negativa em treino e teste. Não opera automático.',
  },
  /*
   * O micro scalp sai INTEIRO no primeiro alvo, e essa é a diferença que mais
   * importa entre ele e o resto.
   *
   * Sair em 50/30/20 dilui o custo fixo sobre três vendas: a operação paga
   * corretagem três vezes para capturar um movimento que já é pequeno. Numa
   * tese cujo alvo inteiro vale ~2x o custo, a segunda e a terceira parcelas
   * saem no zero a zero. Um alvo, uma saída.
   */
  RANGE_FADE: {
    targets: 1,
    scaleOut: false,
    primaryTargetR: 1,
    stopSource: 'além da borda da faixa, com folga de ATR de 1m',
    // o alvo é a borda oposta da faixa: por construção ele é curto, nunca
    // esbarra num teto pensado para alvo de tendência
    primaryTargetExemptFromCeiling: false,
    notes:
      'Micro scalp de 1 minuto: alvo único na borda oposta da faixa, saída integral. Sem validação de laboratório — não opera automático.',
  },
};

export interface PolicyConflict {
  setupType: SetupType;
  setting: string;
  message: string;
}

/**
 * Configurações globais que contradizem a estratégia medida.
 *
 * Devolve avisos, não bloqueios. Bloquear seria pior: o usuário ficaria sem
 * poder ajustar nada. O que não pode acontecer é a contradição ser silenciosa,
 * porque aí o robô opera uma estratégia diferente da que o laboratório
 * aprovou, e os dois números continuam parecendo comparáveis.
 */
export function detectPolicyConflicts(input: {
  setupType: SetupType;
  guard: GuardSettings;
  entryPrice: number;
  stopLoss: number;
  target1: number;
}): PolicyConflict[] {
  const policy = EXIT_POLICIES[input.setupType];
  const conflicts: PolicyConflict[] = [];
  if (input.entryPrice <= 0 || input.stopLoss >= input.entryPrice) return conflicts;

  const alvoPercent = ((input.target1 - input.entryPrice) / input.entryPrice) * 100;
  if (input.guard.maxTargetPercent > 0 && alvoPercent > input.guard.maxTargetPercent) {
    conflicts.push({
      setupType: input.setupType,
      setting: 'maxTargetPercent',
      message: policy.primaryTargetExemptFromCeiling
        ? `O alvo principal está a ${alvoPercent.toFixed(0)}% da entrada, acima do teto configurado de ${input.guard.maxTargetPercent}%. Ele NÃO é descartado — o teto vale apenas para os alvos 2 e 3 — e foi com este alvo que ${input.setupType} foi medido.`
        : `Alvo principal a ${alvoPercent.toFixed(0)}%, acima do teto de ${input.guard.maxTargetPercent}%.`,
    });
  }

  if (!policy.scaleOut && policy.targets === 1 && input.guard.liveScaleOut) {
    conflicts.push({
      setupType: input.setupType,
      setting: 'liveScaleOut',
      message: `${input.setupType} tem alvo único: a saída em partes está ligada nas configurações, mas não existe alvo 2 nem alvo 3 para ela usar.`,
    });
  }

  return conflicts;
}
