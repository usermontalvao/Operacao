import { gainPerUnit, type Side } from '../direction.ts';

/**
 * A pergunta que faltava antes de mandar alvo e stop para a corretora:
 * este par de preços ainda descreve o mercado de agora?
 *
 * O OCO de venda tem duas exigências geométricas, e as duas são sobre o preço
 * ATUAL: o alvo é um `LIMIT_MAKER` e precisa estar ACIMA dele (senão casaria
 * na hora e deixaria de ser maker), e o gatilho do stop precisa estar ABAIXO
 * dele (senão dispararia no mesmo instante). Quando o preço já passou por um
 * dos dois, a Binance devolve "The relationship of the prices for the orders
 * is not correct" — e o sistema lia isso como falha de saldo, tentava de novo
 * na volta seguinte e repetia o alarme para sempre.
 *
 * O caso não é erro: é a posição pedindo para SAIR. Preço no alvo é lucro a
 * realizar; preço no stop é prejuízo a cortar. Nos dois, o que resolve é uma
 * venda a mercado, não uma ordem que a corretora não pode aceitar.
 *
 * Módulo puro porque é geometria de preço: tem de poder ser provado sem
 * corretora e sem dinheiro no meio.
 */

export type MotivoDeSaidaImediata = 'ALVO_ALCANCADO' | 'STOP_ALCANCADO';

export interface PrecosDaProtecao {
  /** preço de mercado agora; `null` quando o feed não respondeu */
  preco: number | null;
  /** gatilho do stop que seria enviado */
  stop: number;
  /** primeiro alvo — o mais próximo, e por isso o que decide */
  alvo: number;
  side: Side;
}

/**
 * `null` quando o OCO é possível. Caso contrário, por que a posição precisa
 * sair a mercado agora.
 *
 * Sem preço não há veredito: chutar aqui seria vender uma posição saudável
 * porque o feed piscou. O caminho antigo (tentar o OCO) continua valendo, e
 * a recusa da corretora ainda é tratada.
 */
export function saidaImediataNecessaria(params: PrecosDaProtecao): MotivoDeSaidaImediata | null {
  const { preco, stop, alvo, side } = params;
  if (preco === null || !Number.isFinite(preco) || preco <= 0) return null;
  // `gainPerUnit` já inverte para a posição vendida: >= 0 é "o preço andou
  // até lá ou passou", nos dois lados
  if (Number.isFinite(alvo) && alvo > 0 && gainPerUnit(side, alvo, preco) >= 0) {
    return 'ALVO_ALCANCADO';
  }
  if (Number.isFinite(stop) && stop > 0 && gainPerUnit(side, preco, stop) >= 0) {
    return 'STOP_ALCANCADO';
  }
  return null;
}

/** A frase que vai para o log e para a auditoria. */
export function explicarSaidaImediata(motivo: MotivoDeSaidaImediata): string {
  return motivo === 'ALVO_ALCANCADO'
    ? 'o preço já está no alvo ou acima dele — o alvo não cabe mais no livro como ordem maker'
    : 'o preço já está no stop ou além dele — o gatilho dispararia no mesmo instante';
}
