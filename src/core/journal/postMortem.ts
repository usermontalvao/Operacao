/**
 * A autópsia de uma operação encerrada.
 *
 * O diário já guardava o que aconteceu (score, componentes, resultado). O que
 * faltava era a frase que ninguém consegue montar de cabeça olhando quatro
 * números: POR QUE deu errado, e o que teria mudado o desfecho. Isto é puro de
 * propósito — é a mesma conta na tela, no relatório e no teste.
 *
 * Uma honestidade embutida: o contrafactual vale para ESTA operação. Aplicar a
 * mesma regra em todas as outras é uma pergunta diferente, e a resposta dela
 * está no laboratório (onde, com 4.146 sinais, nenhuma regra de proteção
 * melhorou a expectativa). Por isso o texto diz "nesta operação".
 */

export type PostMortemCode =
  | 'GANHOU'
  | 'LUCRO_DEVOLVIDO'
  | 'QUASE_NO_ALVO'
  | 'NUNCA_ANDOU'
  | 'MORREU_NA_LARGADA'
  | 'SAIU_NO_TEMPO'
  | 'ENCERRADA_A_MAO';

export interface PostMortemInput {
  entryPrice: number;
  stopLoss: number;
  target1: number;
  /** maior lucro aberto que a operação chegou a mostrar, em % */
  maxFavorablePercent: number;
  /** maior prejuízo aberto, em % */
  maxAdversePercent: number;
  realizedPnlPercent: number;
  outcome: string;
  durationMinutes: number;
}

export interface PostMortem {
  code: PostMortemCode;
  /** uma frase: o que aconteceu */
  headline: string;
  /** os fatos com números, na ordem em que aconteceram */
  facts: string[];
  /** o que teria mudado o desfecho DESTA operação (null quando nada mudaria) */
  couldHaveSaved: string[];
}

export function postMortemOf(input: PostMortemInput): PostMortem {
  const { entryPrice, stopLoss, target1 } = input;
  const riskPercent = entryPrice > 0 ? ((entryPrice - stopLoss) / entryPrice) * 100 : 0;
  const targetPercent = entryPrice > 0 ? ((target1 - entryPrice) / entryPrice) * 100 : 0;
  const mfe = input.maxFavorablePercent;
  const mae = input.maxAdversePercent;
  const result = input.realizedPnlPercent;
  const mfeR = riskPercent > 0 ? mfe / riskPercent : 0;
  const walked = targetPercent > 0 ? (mfe / targetPercent) * 100 : 0;

  const facts: string[] = [
    `Risco de ${riskPercent.toFixed(2)}% até o stop e ${targetPercent.toFixed(2)}% até o alvo 1 (${(targetPercent / (riskPercent || 1)).toFixed(1)}R)`,
    `Chegou a ${mfe.toFixed(2)}% de lucro aberto — ${walked.toFixed(0)}% do caminho até o alvo, ou ${mfeR.toFixed(1)}R`,
    `Caiu até ${mae.toFixed(2)}% no pior momento`,
    `Ficou aberta ${formatDuration(input.durationMinutes)} e terminou em ${result.toFixed(2)}%`,
  ];

  const couldHaveSaved: string[] = [];
  if (result <= 0 && mfeR >= 1) {
    couldHaveSaved.push(
      `Stop no empate assim que o lucro passou de 1R (${riskPercent.toFixed(2)}%): fecharia perto de 0% em vez de ${result.toFixed(2)}%`,
    );
  }
  if (result <= 0 && mfeR >= 1.5) {
    const kept = mfe * 0.6;
    couldHaveSaved.push(
      `Devolver no máximo 40% do pico: sairia por volta de +${kept.toFixed(2)}% (o pico foi ${mfe.toFixed(2)}%)`,
    );
  }
  if (couldHaveSaved.length > 0) {
    couldHaveSaved.push(
      'Vale para esta operação. Medido nas 4.146 do laboratório, nenhuma dessas regras melhorou a expectativa — elas trocam operações grandes por muitas pequenas.',
    );
  }

  if (result > 0) {
    return {
      code: 'GANHOU',
      headline: `Ganhou ${result.toFixed(2)}% — o preço andou ${walked.toFixed(0)}% do caminho até o alvo`,
      facts,
      couldHaveSaved,
    };
  }
  if (input.outcome === 'MANUAL') {
    return { code: 'ENCERRADA_A_MAO', headline: 'Encerrada por decisão manual', facts, couldHaveSaved };
  }
  if (mfeR >= 1.5) {
    return {
      code: 'LUCRO_DEVOLVIDO',
      headline: `Devolveu ${mfe.toFixed(2)}% de lucro aberto e ainda fechou em ${result.toFixed(2)}%`,
      facts,
      couldHaveSaved,
    };
  }
  if (walked >= 70) {
    return {
      code: 'QUASE_NO_ALVO',
      headline: `Chegou a ${walked.toFixed(0)}% do alvo e voltou — o alvo estava longe demais para o que a moeda andou`,
      facts,
      couldHaveSaved,
    };
  }
  if (mfeR < 0.3 && input.durationMinutes <= 180) {
    return {
      code: 'MORREU_NA_LARGADA',
      headline: 'Nunca saiu do lugar: virou contra logo depois da entrada',
      facts,
      couldHaveSaved,
    };
  }
  if (input.outcome === 'TIME_STOP') {
    return { code: 'SAIU_NO_TEMPO', headline: 'Saiu pelo tempo: a tese não andou no prazo', facts, couldHaveSaved };
  }
  return {
    code: 'NUNCA_ANDOU',
    headline: `A tese não andou: o melhor momento foi só ${mfe.toFixed(2)}% (${mfeR.toFixed(1)}R)`,
    facts,
    couldHaveSaved,
  };
}

function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'menos de um minuto';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)} dias`;
}
