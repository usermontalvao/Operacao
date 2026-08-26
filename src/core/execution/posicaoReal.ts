import { roundDownToStep } from '../risk/filters.ts';

/**
 * A diferença entre a posição que o sistema ACHA que tem e a que existe na
 * carteira.
 *
 * Elas divergem por um motivo banal e inevitável: quando não há BNB para
 * pagar taxa, a Binance cobra a comissão da compra NA MOEDA COMPRADA. Comprar
 * 1158,1 JASMY deixa 1156,94 na carteira — os 0,1% ficaram com a corretora. O
 * sistema registrava o número bruto, e a partir daí toda ordem de venda pedia
 * mais do que existia.
 *
 * O estrago real disso, medido em 26/08/2026: a entrada preencheu, o painel
 * tentou armar alvo e stop com o número bruto, e a corretora recusou as três
 * ordens com "Account has insufficient balance". A venda de emergência, que é
 * a última rede, foi recusada pelo mesmo motivo. A posição ficou 23 minutos
 * SEM STOP na conta real, avisando a cada minuto, até ser encerrada à mão.
 *
 * Módulo puro de propósito: é aritmética de carteira, e aritmética de carteira
 * tem de poder ser provada sem corretora, sem rede e sem dinheiro no meio.
 */

export interface FiltrosDeLote {
  stepSize: number;
  minQty: number;
  minNotional: number;
}

/**
 * Quanto do ativo comprado REALMENTE entrou na carteira.
 *
 * A comissão só é descontada quando foi cobrada na própria moeda comprada.
 * Cobrada em BNB ou em USDT, ela sai de outro bolso e a quantidade em mãos é
 * a cheia — descontar ali seria inventar uma perda que não houve.
 */
export function quantidadeQueEntrou(params: {
  preenchida: number;
  comissao: number;
  moedaDaComissao: string | null;
  moedaBase: string;
}): number {
  const { preenchida, comissao, moedaDaComissao, moedaBase } = params;
  if (!moedaDaComissao || comissao <= 0) return preenchida;
  if (moedaDaComissao.toUpperCase() !== moedaBase.toUpperCase()) return preenchida;
  return Math.max(preenchida - comissao, 0);
}

/** Moedas de cotação que este painel encontra pela frente. */
const COTACOES = ['USDT', 'FDUSD', 'USDC', 'BUSD', 'TUSD', 'BTC', 'ETH', 'BNB'];

/**
 * A moeda comprada, deduzida do nome do par.
 *
 * Serve para saber se a comissão foi cobrada nela. Quando o sufixo não é
 * reconhecido devolve string vazia, e o efeito é não descontar nada — o
 * comportamento de antes. Errar para o lado de não mexer é de propósito:
 * descontar uma taxa que não foi cobrada ali encolheria a posição no papel e
 * deixaria moeda encalhada na conta.
 */
export function moedaBaseDoPar(symbol: string): string {
  const par = symbol.toUpperCase();
  for (const cotacao of COTACOES) {
    if (par.length > cotacao.length && par.endsWith(cotacao)) {
      return par.slice(0, par.length - cotacao.length);
    }
  }
  return '';
}

/**
 * Quanto dá para vender agora — nunca mais do que a carteira tem.
 *
 * Pedir mais do que existe não devolve uma venda menor: devolve recusa. E uma
 * recusa aqui é uma posição sem proteção, que é o pior estado em que uma
 * operação com dinheiro real pode ficar. Esta regra já existia no
 * encerramento manual (por isso o botão "Encerrar" funcionava enquanto o stop
 * automático falhava); mora aqui para valer nos dois lugares.
 */
export function quantidadeVendavel(
  desejada: number,
  livreNaCarteira: number,
  stepSize: number,
): number {
  return roundDownToStep(Math.max(Math.min(desejada, livreNaCarteira), 0), stepSize);
}

/**
 * O que sobrou é pó — resto que a corretora não aceita vender.
 *
 * Sem esta pergunta a operação nunca encerra: fica aberta para sempre
 * segurando uma fração que nenhuma ordem pode tocar, e a tela passa a dividir
 * o resultado por ela. Foi assim que um lucro de US$ 0,14 apareceu como
 * "+1400%": o denominador tinha virado o pó.
 */
export function restoEhPo(resto: number, preco: number, filtros: FiltrosDeLote): boolean {
  if (resto <= 0) return true;
  if (roundDownToStep(resto, filtros.stepSize) <= 0) return true;
  if (resto < filtros.minQty) return true;
  return preco > 0 && resto * preco < filtros.minNotional;
}
