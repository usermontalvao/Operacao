import type { Candle, SetupType, TradeSetup } from '../types.ts';
import type { CostSettings } from '../risk/costs.ts';

/**
 * Um sinal como ele existiu no momento em que nasceu: o setup e o índice da
 * barra que o gerou. Tudo depois desse índice é futuro — e futuro não pode
 * ser consultado para decidir nada.
 */
export interface Signal {
  symbol: string;
  setup: TradeSetup;
  /** índice, na série do gatilho, da última barra FECHADA quando o sinal nasceu */
  barIndex: number;
  openTime: number;
  /** ATR do gatilho no nascimento — usado por políticas de saída por ATR */
  atr: number;
}

export type OutcomeReason =
  | 'STOP'
  | 'TARGET_FINAL'
  | 'TRAIL'
  | 'TIME_STOP'
  | 'DATA_END'
  | 'NO_FILL_EXPIRED'
  | 'INVALIDATED_BEFORE_ENTRY'
  | 'MISSED_TARGET_BEFORE_ENTRY';

export interface Outcome {
  symbol: string;
  setupType: SetupType;
  score: number;
  riskReward: number;
  openTime: number;
  /** o preço chegou a entrar na zona e a ordem preencheu */
  filled: boolean;
  reason: OutcomeReason;
  /** resultado líquido em % do valor investido na entrada */
  netReturnPercent: number;
  /** resultado líquido em múltiplos do risco inicial */
  rMultiple: number;
  /** maior lucro não realizado que a operação chegou a mostrar, em % */
  maxFavorablePercent: number;
  /** maior prejuízo não realizado, em % */
  maxAdversePercent: number;
  barsHeld: number;
  reachedTarget1: boolean;
}

/**
 * Como a operação é conduzida depois de aberta. É o objeto que o item 4 da
 * auditoria manda comparar em walk-forward em vez de arbitrar no escuro.
 */
export interface ExitPolicy {
  name: string;
  /** fração da posição vendida em cada alvo */
  scaleOut: [number, number, number];
  breakevenAfterTarget1: boolean;
  trailingStopPercent: number;
  /** venda parcial ao atingir N vezes o risco, antes do alvo 1 (null = desligado) */
  partialAtR: number | null;
  /** fração vendida nessa parcial */
  partialShare: number;
  /** leva o stop ao empate ao atingir N vezes o risco (null = desligado) */
  breakevenAtR: number | null;
  /** stop que segue o topo a N ATRs de distância (null = desligado) */
  atrTrailMultiple: number | null;
  /** fecha a mercado depois de N barras se o alvo 1 não veio (null = desligado) */
  timeStopBars: number | null;
  /**
   * Devolução máxima do avanço já conquistado (0..1; null = desligado).
   *
   * Diferente do trailing por % ou por ATR, este acompanha o TAMANHO do lucro
   * aberto: quanto mais a operação anda, mais alto o stop sobe, sempre deixando
   * passar no máximo esta fração do que já se ganhou. É a regra que responde a
   * "chegou a +6% e voltou para o stop".
   */
  giveBackFraction: number | null;
  /** avanço mínimo, em múltiplos do risco, para a devolução passar a valer */
  giveBackArmAtR: number;
}

export interface SimulationInput {
  signal: Signal;
  /** barras do gatilho a partir do nascimento do sinal (a barra 0 é a do sinal) */
  candles: Candle[];
  policy: ExitPolicy;
  costs: CostSettings;
  /** barras de validade da ordem de entrada */
  entryTtlBars: number;
  /**
   * O que acontece primeiro dentro de uma barra que tocou alvo E stop.
   * STOP_FIRST é a convenção honesta; TARGET_FIRST existe só para medir o
   * tamanho da dúvida — se a conclusão inverte entre as duas, não há conclusão.
   */
  intrabar?: 'STOP_FIRST' | 'TARGET_FIRST';
}
