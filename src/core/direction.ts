/**
 * Direção da operação — o eixo que faltava.
 *
 * Enquanto só existia spot, "a favor" era sempre "para cima": o alvo ficava
 * acima da entrada, o stop abaixo, e o lucro era `saída − entrada`. Em futuros
 * a mesma tese pode ser vendida, e aí cada uma dessas frases inverte. Espalhar
 * `side === 'BUY' ? a : b` pelo sistema seria pedir para esquecer um caso —
 * e o caso esquecido não dá erro, dá conta errada.
 *
 * Módulo puro e minúsculo de propósito: é a única definição de "a favor".
 */

export type Side = 'BUY' | 'SELL';

/** Onde a operação vive. SPOT compra a moeda; FUTURES negocia contrato. */
export type MarketKind = 'SPOT' | 'FUTURES';

/** +1 para comprado, −1 para vendido. Multiplica qualquer diferença de preço. */
export function directionOf(side: Side): 1 | -1 {
  return side === 'SELL' ? -1 : 1;
}

export function isShort(side: Side): boolean {
  return side === 'SELL';
}

/** Lado que ENCERRA a posição: comprado sai vendendo, vendido sai comprando. */
export function exitSide(side: Side): Side {
  return side === 'SELL' ? 'BUY' : 'SELL';
}

/** O preço andou a favor de quem está nesta direção. */
export function isFavorable(side: Side, price: number, reference: number): boolean {
  return (price - reference) * directionOf(side) > 0;
}

/** O alvo foi alcançado: para cima no comprado, para baixo no vendido. */
export function reachedTarget(side: Side, price: number, target: number): boolean {
  return (price - target) * directionOf(side) >= 0;
}

/** O stop foi violado. */
export function stopBreached(side: Side, price: number, stop: number): boolean {
  return (price - stop) * directionOf(side) <= 0;
}

/** O mais favorável dos dois preços — o "topo" do comprado, o fundo do vendido. */
export function bestOf(side: Side, a: number, b: number): number {
  return isFavorable(side, a, b) ? a : b;
}

/** O menos favorável dos dois — usado para nunca afrouxar um stop. */
export function worstOf(side: Side, a: number, b: number): number {
  return isFavorable(side, a, b) ? b : a;
}

/** Resultado bruto por unidade entre entrada e saída, já com o sinal certo. */
export function gainPerUnit(side: Side, entryPrice: number, exitPrice: number): number {
  return (exitPrice - entryPrice) * directionOf(side);
}

/**
 * Distância percentual percorrida a favor (negativa quando foi contra).
 * É a excursão que alimenta MFE/MAE.
 */
export function excursionPercent(side: Side, entryPrice: number, price: number): number {
  if (entryPrice <= 0) return 0;
  return (gainPerUnit(side, entryPrice, price) / entryPrice) * 100;
}

/** Rótulo curto para tela e auditoria. */
export function sideLabel(side: Side): string {
  return side === 'SELL' ? 'VENDIDO' : 'COMPRADO';
}
