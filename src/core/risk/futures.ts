/**
 * A conta que só existe em futuros: margem e liquidação.
 *
 * Em spot, o pior caso de uma posição é ela virar pó devagar, e o stop sempre
 * chega antes. Alavancado existe uma segunda saída, que não é sua: a
 * corretora fecha a posição quando a margem acaba, pelo preço dela. Se essa
 * linha estiver ANTES do stop, o stop nunca executa — e o prejuízo deixa de
 * ser o planejado para ser a margem inteira.
 *
 * Módulo puro: é o que permite provar essa distância sem abrir posição.
 */

import { type Side, directionOf, gainPerUnit } from '../direction.ts';
import type { MarginMode } from '../types.ts';

/**
 * Taxa de margem de manutenção da primeira faixa da Binance em USD-M. As
 * faixas sobem com o tamanho da posição; para o porte que este painel opera,
 * a primeira é a que vale. É uma ESTIMATIVA conservadora — a corretora é
 * quem tem a palavra final, e por isso a folga exigida nunca é zero.
 */
export const DEFAULT_MAINTENANCE_RATE = 0.005;

export interface LiquidationInput {
  side: Side;
  entryPrice: number;
  quantity: number;
  leverage: number;
  marginMode: MarginMode;
  /** patrimônio da carteira de futuros — só importa na margem cruzada */
  walletBalance?: number;
  maintenanceRate?: number;
}

/**
 * Preço estimado de liquidação.
 *
 * Isolada: a garantia é só a margem daquela posição. Cruzada: a garantia é a
 * carteira inteira, então a linha fica bem mais longe — e é por isso que a
 * cruzada, apesar de parecer mais segura por posição, arrisca tudo de uma vez
 * quando várias posições andam juntas.
 *
 * null quando não há dados suficientes para afirmar; nunca um palpite.
 */
export function liquidationPrice(input: LiquidationInput): number | null {
  const { side, entryPrice, quantity } = input;
  const leverage = input.leverage > 0 ? input.leverage : 1;
  const maintenanceRate = input.maintenanceRate ?? DEFAULT_MAINTENANCE_RATE;
  if (entryPrice <= 0 || quantity <= 0) return null;

  const notional = entryPrice * quantity;
  const margin =
    input.marginMode === 'CROSSED'
      ? input.walletBalance ?? notional / leverage
      : notional / leverage;
  if (margin <= 0) return null;

  const maintenanceMargin = notional * maintenanceRate;
  // quanto o preço pode andar contra antes de a garantia acabar
  const room = (margin - maintenanceMargin) / quantity;
  if (room <= 0) return entryPrice;

  const price = entryPrice - directionOf(side) * room;
  return price > 0 ? price : 0;
}

/** Margem que a posição prende. */
export function marginRequired(notional: number, leverage: number): number {
  if (leverage <= 0) return notional;
  return notional / leverage;
}

export interface LiquidationCheck {
  liquidationPrice: number | null;
  /** distância entre o stop e a liquidação, em % do preço de entrada */
  bufferPercent: number | null;
  /** a liquidação acontece ANTES do stop: a posição não é protegida pelo stop */
  stopBeyondLiquidation: boolean;
  /** motivo pronto para virar bloqueio na tela; null = está tudo bem */
  blockReason: string | null;
}

/**
 * O stop está do lado certo da linha de liquidação, com folga?
 *
 * A folga não é preciosismo: a liquidação real usa preço de marca, faixas de
 * manutenção que sobem com o tamanho e taxa de liquidação. Uma estimativa que
 * dá "por um fio" já é motivo para recusar a alavancagem pedida.
 */
export function checkLiquidation(
  input: LiquidationInput & { stopLoss: number; minBufferPercent: number },
): LiquidationCheck {
  const liquidation = liquidationPrice(input);
  if (liquidation === null || input.entryPrice <= 0) {
    return {
      liquidationPrice: null,
      bufferPercent: null,
      stopBeyondLiquidation: false,
      blockReason: null,
    };
  }

  // distância que o stop tem até a liquidação, sempre medida no sentido do prejuízo
  const distance = gainPerUnit(input.side, input.stopLoss, liquidation);
  const bufferPercent = (distance / input.entryPrice) * 100;
  const stopBeyondLiquidation = distance >= 0;

  if (stopBeyondLiquidation) {
    return {
      liquidationPrice: liquidation,
      bufferPercent,
      stopBeyondLiquidation: true,
      blockReason: `Com ${input.leverage}x a liquidação (${liquidation.toPrecision(6)}) acontece antes do stop (${input.stopLoss.toPrecision(6)}) — reduza a alavancagem`,
    };
  }

  const margin = Math.abs(bufferPercent);
  if (margin < input.minBufferPercent) {
    return {
      liquidationPrice: liquidation,
      bufferPercent,
      stopBeyondLiquidation: false,
      blockReason: `Liquidação a apenas ${margin.toFixed(2)}% depois do stop (mínimo ${input.minBufferPercent}%) — reduza a alavancagem`,
    };
  }

  return {
    liquidationPrice: liquidation,
    bufferPercent,
    stopBeyondLiquidation: false,
    blockReason: null,
  };
}

/**
 * Maior alavancagem que ainda deixa a liquidação atrás do stop, com a folga
 * pedida. Serve para o painel sugerir um número em vez de só recusar.
 */
export function maxSafeLeverage(input: {
  side: Side;
  entryPrice: number;
  stopLoss: number;
  minBufferPercent: number;
  ceiling: number;
  maintenanceRate?: number;
}): number {
  const { entryPrice, stopLoss, side } = input;
  if (entryPrice <= 0) return 1;
  const stopDistance = -gainPerUnit(side, entryPrice, stopLoss);
  if (stopDistance <= 0) return 1;

  const maintenanceRate = input.maintenanceRate ?? DEFAULT_MAINTENANCE_RATE;
  // a liquidação precisa ficar além do stop somado à folga
  const required = (stopDistance + entryPrice * (input.minBufferPercent / 100)) / entryPrice;
  const allowed = 1 / (required + maintenanceRate);
  const ceiling = Math.max(1, Math.floor(input.ceiling));
  return Math.max(1, Math.min(ceiling, Math.floor(allowed)));
}
