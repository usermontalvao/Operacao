import type { Candle } from '../types.ts';
import { marketExitPrice, netPnl, stopFillPrice } from '../risk/costs.ts';
import { breakevenPrice } from '../risk/costs.ts';
import { averageEntry } from '../risk/index.ts';
import { sanitizeTargets } from '../risk/stops.ts';
import type { Outcome, OutcomeReason, SimulationInput } from './types.ts';

/**
 * Leva um sinal até o desfecho, barra a barra, com as mesmas regras de custo
 * e de saída que valem na conta.
 *
 * Três convenções, todas pessimistas de propósito — resultado de backtest que
 * se dá o benefício da dúvida é o que aprova no papel o sistema que perde ao
 * vivo:
 *  1. dentro de uma barra, o stop acontece ANTES do alvo (não dá para saber a
 *     ordem real, e supor o contrário infla todo o resultado);
 *  2. na barra da entrada só o stop é avaliado — a máxima dessa barra pode ter
 *     acontecido antes de a ordem preencher;
 *  3. a ordem limite preenche quando a mínima da barra alcança o preço, e o
 *     preenchimento sai no preço pedido, nunca melhor (salvo abertura em gap).
 */
export function simulateSignal(input: SimulationInput): Outcome {
  const { signal, candles, policy, costs, entryTtlBars } = input;
  const stopFirst = (input.intrabar ?? 'STOP_FIRST') === 'STOP_FIRST';
  const setup = signal.setup;
  const entryPrice = averageEntry(setup.entryLow, setup.entryHigh);

  // o mesmo corte de alvo irreal que a execução aplica ao criar a operação
  const targets = sanitizeTargets({
    entryPrice,
    target1: setup.target1,
    target2: setup.target2,
    target3: setup.target3,
    maxTargetPercent: 40,
  });

  const base = {
    symbol: signal.symbol,
    setupType: setup.setupType,
    score: setup.score,
    riskReward: setup.riskReward,
    openTime: signal.openTime,
  };
  const unfilled = (reason: OutcomeReason): Outcome => ({
    ...base,
    filled: false,
    reason,
    netReturnPercent: 0,
    rMultiple: 0,
    maxFavorablePercent: 0,
    maxAdversePercent: 0,
    barsHeld: 0,
    reachedTarget1: false,
  });

  // ---- espera pelo preenchimento ----------------------------------------
  let fillIndex = -1;
  let fillPrice = entryPrice;
  for (let i = 1; i < candles.length && i <= entryTtlBars; i += 1) {
    const bar = candles[i] as Candle;
    if (bar.low <= entryPrice) {
      fillIndex = i;
      // abertura abaixo da ordem preenche na abertura; caso contrário, no preço
      fillPrice = Math.min(entryPrice, bar.open);
      break;
    }
    if (bar.high >= targets.target1) return unfilled('MISSED_TARGET_BEFORE_ENTRY');
    if (bar.low <= setup.stopLoss) return unfilled('INVALIDATED_BEFORE_ENTRY');
  }
  if (fillIndex < 0) return unfilled('NO_FILL_EXPIRED');

  // ---- condução da posição ----------------------------------------------
  const risk = fillPrice - setup.stopLoss;
  if (risk <= 0) return unfilled('INVALIDATED_BEFORE_ENTRY');

  let remaining = 1;
  let realized = 0;
  let stop = setup.stopLoss;
  let highWater = fillPrice;
  let reachedTarget1 = false;
  let partialTaken = false;
  let maxFavorable = 0;
  let maxAdverse = 0;
  let reason: OutcomeReason = 'DATA_END';
  let lastIndex = fillIndex;

  const sell = (quantity: number, price: number): void => {
    const amount = Math.min(quantity, remaining);
    if (amount <= 1e-12) return;
    realized += netPnl({ entryPrice: fillPrice, exitPrice: price, quantity: amount, feePercent: costs.feePercent });
    remaining -= amount;
  };

  const targetPlan: Array<{ price: number | null; share: number }> = [
    { price: targets.target1, share: policy.scaleOut[0] },
    { price: targets.target2, share: policy.scaleOut[1] },
    { price: targets.target3, share: policy.scaleOut[2] },
  ];
  const targetHit = [false, false, false];

  for (let i = fillIndex; i < candles.length; i += 1) {
    const bar = candles[i] as Candle;
    lastIndex = i;
    const entryBar = i === fillIndex;

    if (!entryBar) {
      maxFavorable = Math.max(maxFavorable, ((bar.high - fillPrice) / fillPrice) * 100);
      highWater = Math.max(highWater, bar.high);
    }
    maxAdverse = Math.min(maxAdverse, ((bar.low - fillPrice) / fillPrice) * 100);

    // 1. stop primeiro: dentro da barra não se sabe a ordem, e supor o
    //    contrário é se dar o benefício da dúvida em toda operação perdedora
    const stopped = bar.low <= stop;
    if (stopped && stopFirst) {
      sell(remaining, stopFillPrice(stop, costs));
      reason = stop > setup.stopLoss ? 'TRAIL' : 'STOP';
      break;
    }
    if (entryBar) {
      if (stopped) {
        sell(remaining, stopFillPrice(stop, costs));
        reason = stop > setup.stopLoss ? 'TRAIL' : 'STOP';
        break;
      }
      continue;
    }

    // 2. alvos
    for (let t = 0; t < targetPlan.length; t += 1) {
      const plan = targetPlan[t] as { price: number | null; share: number };
      if (plan.price === null || targetHit[t]) continue;
      if (bar.high < plan.price) continue;
      targetHit[t] = true;
      if (t === 0) reachedTarget1 = true;
      const isLast =
        t === 2 || (t === 1 && targets.target3 === null) || (t === 0 && targets.target2 === null);
      sell(isLast ? remaining : plan.share, plan.price);
    }

    // 3. parcial antecipada em múltiplos do risco
    if (policy.partialAtR !== null && !partialTaken && remaining > 0) {
      const trigger = fillPrice + policy.partialAtR * risk;
      if (bar.high >= trigger) {
        partialTaken = true;
        sell(policy.partialShare, trigger);
      }
    }

    if (remaining <= 1e-12) {
      reason = 'TARGET_FINAL';
      break;
    }

    if (stopped) {
      sell(remaining, stopFillPrice(stop, costs));
      reason = stop > setup.stopLoss ? 'TRAIL' : 'STOP';
      break;
    }

    // 4. proteção: empate e trailing
    stop = nextStop({ stop, fillPrice, risk, highWater, close: bar.close, reachedTarget1, policy, costs, atr: signal.atr });

    // 5. saída temporal
    if (policy.timeStopBars !== null && !reachedTarget1 && i - fillIndex >= policy.timeStopBars) {
      sell(remaining, marketExitPrice(bar.close, costs));
      reason = 'TIME_STOP';
      break;
    }
  }

  if (remaining > 1e-12) {
    const last = candles[lastIndex] as Candle;
    sell(remaining, marketExitPrice(last.close, costs));
    if (reason !== 'TIME_STOP') reason = 'DATA_END';
  }

  return {
    ...base,
    filled: true,
    reason,
    netReturnPercent: (realized / fillPrice) * 100,
    rMultiple: realized / risk,
    maxFavorablePercent: maxFavorable,
    maxAdversePercent: maxAdverse,
    barsHeld: lastIndex - fillIndex,
    reachedTarget1,
  };
}

interface NextStopInput {
  stop: number;
  fillPrice: number;
  risk: number;
  highWater: number;
  close: number;
  reachedTarget1: boolean;
  policy: SimulationInput['policy'];
  costs: SimulationInput['costs'];
  atr: number;
}

/** Stop nunca desce e nunca é colocado acima do preço — as duas invariantes de stops.ts. */
function nextStop(input: NextStopInput): number {
  const { stop, fillPrice, risk, highWater, close, reachedTarget1, policy, costs, atr } = input;
  let candidate = stop;
  const breakeven = breakevenPrice(fillPrice, costs.feePercent);

  if (policy.breakevenAfterTarget1 && reachedTarget1) candidate = Math.max(candidate, breakeven);
  if (policy.breakevenAtR !== null && highWater >= fillPrice + policy.breakevenAtR * risk) {
    candidate = Math.max(candidate, breakeven);
  }
  if (policy.trailingStopPercent > 0 && highWater > fillPrice) {
    const trailing = highWater * (1 - policy.trailingStopPercent / 100);
    if (trailing > fillPrice) candidate = Math.max(candidate, trailing);
  }
  if (policy.giveBackFraction !== null && policy.giveBackFraction > 0 && highWater > fillPrice) {
    const advance = highWater - fillPrice;
    if (advance >= policy.giveBackArmAtR * risk) {
      const trailing = highWater - advance * policy.giveBackFraction;
      if (trailing > fillPrice) candidate = Math.max(candidate, trailing);
    }
  }
  if (policy.atrTrailMultiple !== null && atr > 0 && highWater > fillPrice) {
    const trailing = highWater - policy.atrTrailMultiple * atr;
    if (trailing > fillPrice) candidate = Math.max(candidate, trailing);
  }

  if (candidate >= close) return stop;
  return Math.max(stop, candidate);
}
