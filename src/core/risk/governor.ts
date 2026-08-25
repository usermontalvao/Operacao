/**
 * Disjuntor de risco.
 *
 * O sistema erra — isso é dado. O que decide a sobrevivência da conta não é a
 * qualidade do acerto, é o tamanho do erro quando a sequência vira contra.
 * Este módulo é puro de propósito: as regras que desligam a operação precisam
 * ser lidas, testadas e conferidas sem subir servidor nenhum.
 */

import type { BtcContextState, Trade, TradingMode } from '../types.ts';
import type { SymbolVerdict } from '../news/types.ts';
import type { CostSettings } from './costs.ts';
import { round } from './riskReward.ts';

export interface GuardSettings extends CostSettings {
  /** perdas seguidas que desligam a operação do dia */
  maxConsecutiveLosses: number;
  /** queda máxima aceita a partir do topo da carteira, em % */
  maxDrawdownPercent: number;
  /** teto de operações abertas por dia — evita metralhar o mercado */
  maxDailyTrades: number;
  /** teto do capital exposto somando todas as posições, em % */
  maxTotalExposurePercent: number;
  /** teto do capital exposto em altcoins (tudo fora de BTC e ETH), em % */
  maxAltExposurePercent: number;
  /** não abre posição nova enquanto o BTC estiver vendedor */
  blockWhenBtcBearish: boolean;
  /** multiplicador do tamanho quando o BTC está volátil (1 = sem redução) */
  highVolatilitySizeFactor: number;
  /** silêncio obrigatório depois de uma perda, em minutos */
  lossCooldownMinutes: number;
  /** R/R mínimo já descontadas taxa e escorregamento */
  minNetRiskReward: number;
  /** volume mínimo em 24h para o ativo ser operável */
  minQuoteVolume24h: number;
  /** leva o stop para o empate assim que o alvo 1 preenche */
  breakevenAfterTarget1: boolean;
  /** stop que sobe atrás do preço, em % do topo alcançado (0 = desligado) */
  trailingStopPercent: number;
  /** alvo além desta distância da entrada é descartado por irreal, em % */
  maxTargetPercent: number;
  /** deixa o sistema remanejar o stop também nas ordens que estão na corretora */
  manageLiveStops: boolean;
  /**
   * Executa na corretora o mesmo 50/30/20 do papel, em ordens OCO separadas.
   * Desligado, a conta real manda a posição inteira para o alvo 1 — e aí o
   * desempenho medido no papel não diz nada sobre o da conta real.
   */
  liveScaleOut: boolean;
  /**
   * Segundos que uma entrada parcialmente preenchida pode ficar sem proteção
   * antes de o sistema agir. O OTOCO da Binance só arma alvo e stop quando a
   * entrada preenche por INTEIRO: até lá, o que já foi comprado está a
   * descoberto.
   */
  partialFillGuardSeconds: number;
  /**
   * Horas que uma posição pode ficar aberta sem ter tocado o alvo 1 antes de
   * sair a mercado. Capital parado numa tese que não andou é capital que não
   * está na próxima — e o laboratório mostrou a saída temporal como neutra ou
   * levemente melhor que deixar correr. 0 = desligada.
   */
  timeStopHours: number;
  /** reconhecimento do disjuntor: até esta hora ele não bloqueia */
  mutedUntil: string | null;
}

export const DEFAULT_GUARD: GuardSettings = {
  feePercent: 0.1,
  stopSlippagePercent: 0.15,
  exitSlippagePercent: 0.1,
  maxConsecutiveLosses: 3,
  maxDrawdownPercent: 10,
  maxDailyTrades: 6,
  maxTotalExposurePercent: 60,
  maxAltExposurePercent: 40,
  blockWhenBtcBearish: true,
  highVolatilitySizeFactor: 0.5,
  lossCooldownMinutes: 60,
  minNetRiskReward: 1.8,
  minQuoteVolume24h: 5_000_000,
  breakevenAfterTarget1: true,
  trailingStopPercent: 0,
  maxTargetPercent: 40,
  manageLiveStops: false,
  liveScaleOut: true,
  partialFillGuardSeconds: 90,
  timeStopHours: 48,
  mutedUntil: null,
};

/** Moedas que não entram na conta de exposição em altcoin. */
const MAJORS = new Set(['BTCUSDT', 'ETHUSDT']);

export interface RiskSnapshotInput {
  trades: Trade[];
  mode: TradingMode;
  /** capital atual em USDT (carteira de papel ou saldo da corretora) */
  capital: number;
  dailyLossLimitPercent: number;
  guard: GuardSettings;
  /** preço corrente por símbolo, para medir a perda que ainda está aberta */
  prices: Record<string, number>;
  now: Date;
}

export interface RiskSnapshot {
  mode: TradingMode;
  capital: number;
  /** capital + resultado ainda não realizado das posições abertas */
  equity: number;
  peakEquity: number;
  drawdownPercent: number;
  dailyRealizedPnl: number;
  dailyUnrealizedPnl: number;
  dailyLossLimit: number;
  consecutiveLosses: number;
  tradesToday: number;
  openPositions: number;
  exposure: number;
  exposurePercent: number;
  altExposurePercent: number;
  lastLossAt: string | null;
  /** true quando alguma trava disparou e o robô não deve abrir posição */
  halted: boolean;
  haltReasons: string[];
  /** travas que dispararam mas estão reconhecidas pelo usuário */
  mutedReasons: string[];
  mutedUntil: string | null;
}

function startOfUtcDay(now: Date): number {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime();
}

function isOpen(trade: Trade): boolean {
  return trade.status === 'PENDING' || trade.status === 'OPEN';
}

/** Quanto ainda está parado em uma posição — o pendente conta pelo valor reservado. */
function investedIn(trade: Trade): number {
  if (trade.status === 'PENDING') return trade.notional;
  const entry = trade.averageFillPrice ?? trade.entryPrice;
  return entry * trade.remainingQuantity;
}

function unrealizedIn(trade: Trade, prices: Record<string, number>): number {
  if (trade.status !== 'OPEN') return 0;
  const price = prices[trade.symbol];
  if (price === undefined || price <= 0) return 0;
  const entry = trade.averageFillPrice ?? trade.entryPrice;
  return (price - entry) * trade.remainingQuantity;
}

/**
 * Retrato do risco agora. Tudo é derivado das operações gravadas — nada aqui
 * depende de estado em memória, então reiniciar o servidor não apaga um
 * disjuntor que estava acionado.
 */
export function computeRiskSnapshot(input: RiskSnapshotInput): RiskSnapshot {
  const { mode, capital, guard, prices, now } = input;
  const trades = input.trades.filter((trade) => trade.mode === mode);
  const dayStart = startOfUtcDay(now);

  const closed = trades
    .filter((trade) => trade.status === 'CLOSED' && trade.closedAt !== null)
    .sort((a, b) => new Date(a.closedAt as string).getTime() - new Date(b.closedAt as string).getTime());

  const open = trades.filter(isOpen);

  const dailyRealizedPnl = round(
    closed
      .filter((trade) => new Date(trade.closedAt as string).getTime() >= dayStart)
      .reduce((total, trade) => total + trade.realizedPnl, 0),
    2,
  );
  // só o que abriu HOJE: o que abriu antes entra no patrimônio por
  // unrealizedOutsideToday. Somar as duas coisas sem este filtro contava a
  // mesma posição aberta duas vezes e falseava o drawdown que aciona o disjuntor.
  const dailyUnrealizedPnl = round(
    open
      .filter((trade) => new Date(trade.openedAt).getTime() >= dayStart)
      .reduce((total, trade) => total + unrealizedIn(trade, prices), 0),
    2,
  );

  // perdas seguidas: conta do fim para o começo e para na primeira que ganhou
  let consecutiveLosses = 0;
  for (let index = closed.length - 1; index >= 0; index -= 1) {
    const trade = closed[index] as Trade;
    if (trade.realizedPnl >= 0) break;
    consecutiveLosses += 1;
  }

  const lastLoss = [...closed].reverse().find((trade) => trade.realizedPnl < 0) ?? null;

  const totalRealized = closed.reduce((total, trade) => total + trade.realizedPnl, 0);
  // o capital informado já embute o realizado; voltando por ele chega-se ao ponto de partida
  const startingCapital = round(capital - totalRealized, 2);

  // topo da carteira ao longo do histórico realizado, incluindo o momento atual
  let running = startingCapital;
  let peakEquity = startingCapital;
  for (const trade of closed) {
    running += trade.realizedPnl;
    if (running > peakEquity) peakEquity = running;
  }
  const equity = round(capital + dailyUnrealizedPnl + unrealizedOutsideToday(open, prices, dayStart), 2);
  if (equity > peakEquity) peakEquity = equity;

  const drawdownPercent =
    peakEquity > 0 ? round(Math.max(((peakEquity - equity) / peakEquity) * 100, 0), 2) : 0;

  const exposure = round(open.reduce((total, trade) => total + investedIn(trade), 0), 2);
  const altExposure = round(
    open
      .filter((trade) => !MAJORS.has(trade.symbol))
      .reduce((total, trade) => total + investedIn(trade), 0),
    2,
  );

  const tradesToday = trades.filter((trade) => new Date(trade.openedAt).getTime() >= dayStart).length;
  const dailyLossLimit = round(Math.abs(capital * (input.dailyLossLimitPercent / 100)), 2);

  const reasons: string[] = [];
  if (dailyLossLimit > 0 && dailyRealizedPnl <= -dailyLossLimit) {
    reasons.push(
      `perda do dia (${dailyRealizedPnl.toFixed(2)} USDT) atingiu o limite de ${dailyLossLimit.toFixed(2)}`,
    );
  }
  if (guard.maxConsecutiveLosses > 0 && consecutiveLosses >= guard.maxConsecutiveLosses) {
    reasons.push(`${consecutiveLosses} perdas seguidas`);
  }
  if (guard.maxDrawdownPercent > 0 && drawdownPercent >= guard.maxDrawdownPercent) {
    reasons.push(
      `queda de ${drawdownPercent.toFixed(2)}% desde o topo da carteira (limite ${guard.maxDrawdownPercent}%)`,
    );
  }
  if (guard.maxDailyTrades > 0 && tradesToday >= guard.maxDailyTrades) {
    reasons.push(`${tradesToday} operações abertas hoje (teto ${guard.maxDailyTrades})`);
  }

  const muted =
    guard.mutedUntil !== null && new Date(guard.mutedUntil).getTime() > now.getTime();

  return {
    mode,
    capital: round(capital, 2),
    equity,
    peakEquity: round(peakEquity, 2),
    drawdownPercent,
    dailyRealizedPnl,
    dailyUnrealizedPnl,
    dailyLossLimit,
    consecutiveLosses,
    tradesToday,
    openPositions: open.length,
    exposure,
    exposurePercent: capital > 0 ? round((exposure / capital) * 100, 2) : 0,
    altExposurePercent: capital > 0 ? round((altExposure / capital) * 100, 2) : 0,
    lastLossAt: lastLoss?.closedAt ?? null,
    halted: !muted && reasons.length > 0,
    haltReasons: muted ? [] : reasons,
    mutedReasons: muted ? reasons : [],
    mutedUntil: guard.mutedUntil,
  };
}

/** Resultado aberto das posições que não nasceram hoje. */
function unrealizedOutsideToday(
  open: Trade[],
  prices: Record<string, number>,
  dayStart: number,
): number {
  return open
    .filter((trade) => new Date(trade.openedAt).getTime() < dayStart)
    .reduce((total, trade) => total + unrealizedIn(trade, prices), 0);
}

export interface EntryGateInput {
  snapshot: RiskSnapshot;
  guard: GuardSettings;
  symbol: string;
  /** valor financeiro que a nova posição vai ocupar */
  quoteAmount: number;
  /** R/R já líquido de taxa e escorregamento */
  netRiskReward: number;
  openTrades: Trade[];
  btcContext: BtcContextState | null;
  quoteVolume24h: number | null;
  /**
   * O que se sabe sobre o ativo fora do gráfico: deslistagem, negociação
   * suspensa, incidente de rede. Ausente (null) quer dizer "nada sabido" — e
   * não saber nunca é motivo para bloquear.
   */
  newsVerdict?: SymbolVerdict | null;
  now: Date;
}

export interface EntryGateResult {
  allowed: boolean;
  blockers: string[];
  warnings: string[];
  /** multiplicador do tamanho da posição (1 = tamanho cheio) */
  sizeFactor: number;
}

/**
 * Porteiro de toda entrada nova — automática ou manual. Devolve os motivos em
 * texto porque eles vão para a tela e para a auditoria: uma compra recusada
 * sem motivo legível é uma compra que o usuário vai forçar no escuro.
 */
export function evaluateEntryGate(input: EntryGateInput): EntryGateResult {
  const { snapshot, guard, symbol, quoteAmount, netRiskReward, openTrades, now } = input;
  const blockers: string[] = [];
  const warnings: string[] = [];
  let sizeFactor = 1;

  if (snapshot.halted) {
    blockers.push(`Disjuntor acionado: ${snapshot.haltReasons.join('; ')}`);
  }
  if (snapshot.mutedReasons.length > 0) {
    warnings.push(
      `Disjuntor reconhecido até ${snapshot.mutedUntil}: ${snapshot.mutedReasons.join('; ')}`,
    );
  }

  if (guard.minNetRiskReward > 0 && netRiskReward < guard.minNetRiskReward) {
    blockers.push(
      `R/R líquido de ${netRiskReward.toFixed(2)} abaixo do mínimo de ${guard.minNetRiskReward} (já descontadas taxa e escorregamento)`,
    );
  }

  const samePair = openTrades.filter((trade) => trade.symbol === symbol && isOpen(trade));
  if (samePair.length > 0) {
    blockers.push(`Já existe posição aberta em ${symbol}`);
  }

  const capital = snapshot.capital;
  if (capital > 0 && guard.maxTotalExposurePercent > 0) {
    const nextExposure = snapshot.exposure + quoteAmount;
    const limit = capital * (guard.maxTotalExposurePercent / 100);
    if (nextExposure > limit) {
      blockers.push(
        `Exposição total chegaria a ${nextExposure.toFixed(2)} USDT, acima do teto de ${guard.maxTotalExposurePercent}% do capital (${limit.toFixed(2)})`,
      );
    }
  }

  if (capital > 0 && guard.maxAltExposurePercent > 0 && !MAJORS.has(symbol)) {
    const altExposure = openTrades
      .filter((trade) => isOpen(trade) && !MAJORS.has(trade.symbol))
      .reduce((total, trade) => total + investedIn(trade), 0);
    const limit = capital * (guard.maxAltExposurePercent / 100);
    if (altExposure + quoteAmount > limit) {
      blockers.push(
        `Exposição em altcoins chegaria a ${(altExposure + quoteAmount).toFixed(2)} USDT, acima do teto de ${guard.maxAltExposurePercent}% (${limit.toFixed(2)}) — altcoin cai junto quando o BTC cai`,
      );
    }
  }

  if (guard.lossCooldownMinutes > 0 && snapshot.lastLossAt !== null) {
    const elapsed = now.getTime() - new Date(snapshot.lastLossAt).getTime();
    const window = guard.lossCooldownMinutes * 60_000;
    if (elapsed >= 0 && elapsed < window) {
      const left = Math.ceil((window - elapsed) / 60_000);
      blockers.push(`Descanso pós-perda: faltam ${left} min`);
    }
  }

  if (input.quoteVolume24h !== null && guard.minQuoteVolume24h > 0) {
    if (input.quoteVolume24h < guard.minQuoteVolume24h) {
      blockers.push(
        `Volume de ${(input.quoteVolume24h / 1_000_000).toFixed(1)}M em 24h abaixo do mínimo de ${(guard.minQuoteVolume24h / 1_000_000).toFixed(1)}M — sair de uma posição ilíquida custa caro`,
      );
    }
  }

  if (input.btcContext === 'BTC_BEARISH') {
    if (guard.blockWhenBtcBearish) {
      blockers.push('BTC vendedor: compra nova bloqueada enquanto o mercado estiver contra');
    } else {
      warnings.push('BTC vendedor — a probabilidade da compra piora com o mercado contra');
    }
  }
  if (input.btcContext === 'BTC_HIGH_VOLATILITY' && guard.highVolatilitySizeFactor < 1) {
    sizeFactor = Math.max(guard.highVolatilitySizeFactor, 0);
    warnings.push(
      `BTC volátil: tamanho reduzido para ${Math.round(sizeFactor * 100)}% do normal`,
    );
  }

  // O que se sabe fora do gráfico entra por último e só num sentido: notícia
  // bloqueia ou encolhe, jamais aumenta. A redução é multiplicativa com a do
  // BTC porque dois motivos independentes para desconfiar valem mais que um.
  const verdict = input.newsVerdict ?? null;
  if (verdict !== null && verdict.reasons.length > 0) {
    if (verdict.blocked) {
      blockers.push(`Ativo bloqueado por evento de mercado: ${verdict.reasons.join('; ')}`);
      sizeFactor = 0;
    } else if (verdict.sizeFactor < 1) {
      sizeFactor *= Math.max(verdict.sizeFactor, 0);
      warnings.push(
        `Evento de mercado reduz o tamanho para ${Math.round(sizeFactor * 100)}%: ${verdict.reasons.join('; ')}`,
      );
    }
  }

  return { allowed: blockers.length === 0, blockers, warnings, sizeFactor };
}
