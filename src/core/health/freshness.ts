/**
 * Frescor dos dados.
 *
 * Preço velho não parece velho: o número continua na tela, bonito e redondo.
 * É por isso que a idade precisa ser um valor de primeira classe e não uma
 * impressão — a diferença entre "o mercado está parado" e "a conexão morreu"
 * não se enxerga olhando o preço.
 */

export type FreshnessLevel = 'FRESCO' | 'ATRASADO' | 'PARADO' | 'SEM_DADO';

export interface FreshnessThresholds {
  /** acima disto o dado é ATRASADO */
  staleMs: number;
  /** acima disto o dado é PARADO e a operação deve ser bloqueada */
  deadMs: number;
}

/**
 * O fluxo agregado de tickers da Binance entrega algo a cada poucos segundos
 * quando está vivo. Meio minuto sem nenhum tick em nenhum par não é mercado
 * calmo, é conexão caída.
 */
export const TICK_THRESHOLDS: FreshnessThresholds = { staleMs: 30_000, deadMs: 120_000 };

/** A varredura roda em intervalo fixo; dois intervalos perdidos é sintoma. */
export const SCAN_THRESHOLDS: FreshnessThresholds = { staleMs: 180_000, deadMs: 600_000 };

export interface FreshnessReport {
  level: FreshnessLevel;
  ageMs: number | null;
  at: string | null;
  /** true quando o dado está velho demais para sustentar uma decisão de compra */
  blocksTrading: boolean;
}

export function evaluateFreshness(
  timestamp: number | null,
  thresholds: FreshnessThresholds,
  now = Date.now(),
): FreshnessReport {
  if (timestamp === null) {
    return { level: 'SEM_DADO', ageMs: null, at: null, blocksTrading: true };
  }
  // relógio para trás (NTP, suspensão do computador) não vira "dado do futuro":
  // idade negativa é tratada como zero, senão um ajuste de relógio faria o
  // sistema confiar em dado velho
  const ageMs = Math.max(now - timestamp, 0);
  const at = new Date(timestamp).toISOString();

  if (ageMs >= thresholds.deadMs) return { level: 'PARADO', ageMs, at, blocksTrading: true };
  if (ageMs >= thresholds.staleMs) return { level: 'ATRASADO', ageMs, at, blocksTrading: true };
  return { level: 'FRESCO', ageMs, at, blocksTrading: false };
}
