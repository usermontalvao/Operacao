/**
 * Vocabulário das decisões de entrada.
 *
 * Antes, cada regra devolvia uma frase solta. Frase serve para ler, não para
 * contar: não dá para agrupar "por que o robô não entrou hoje" nem para saber
 * se a recusa de agora é a mesma de cinco minutos atrás. O código é estável e
 * a frase é apresentação — quando a redação melhorar, o histórico continua
 * somando.
 */
export type DecisionCode =
  // estado do robô e da plataforma
  | 'ROBOT_DISABLED'
  | 'LIVE_NOT_ARMED'
  | 'PERSISTENCE_UNAVAILABLE'
  | 'MARKET_DATA_STALE'
  /** o setup pertence a um gatilho que foi desligado depois que ele nasceu */
  | 'TIMEFRAME_DISABLED'
  // estratégia e evidência
  | 'STRATEGY_NOT_VALIDATED'
  | 'STRATEGY_DISABLED'
  | 'TIMEFRAME_NOT_ENABLED'
  /** tese vendida: o robô não opera o lado de baixo, só entrada manual */
  | 'SHORT_NOT_AUTOMATED'
  /** futuros: a expectativa positiva foi medida em spot, então o robô não entra */
  | 'MARKET_NOT_VALIDATED'
  | 'SCORE_BELOW_VALIDATED_FLOOR'
  | 'SCORE_BELOW_CONFIGURED_MINIMUM'
  | 'RISK_REWARD_BELOW_MINIMUM'
  | 'NET_RISK_REWARD_BELOW_MINIMUM'
  // estado do próprio setup
  | 'SETUP_EXPIRED'
  | 'SETUP_STALE'
  | 'SETUP_INVALIDATED'
  | 'SETUP_IGNORED'
  | 'SETUP_ALREADY_BOUGHT'
  | 'PRICE_OUTSIDE_ENTRY_ZONE'
  | 'PRICE_EXTENDED'
  // concorrência e carteira
  | 'SYMBOL_ALREADY_OPEN'
  | 'MAX_CONCURRENT_TRADES'
  | 'MAX_OPEN_TRADES'
  | 'SYMBOL_COOLDOWN'
  | 'LOSS_COOLDOWN'
  | 'DAILY_TRADE_LIMIT'
  | 'DAILY_LOSS_LIMIT'
  | 'CIRCUIT_BREAKER'
  // risco monetário
  | 'RISK_BUDGET_EXCEEDED'
  | 'TOTAL_EXPOSURE_EXCEEDED'
  | 'ALT_EXPOSURE_EXCEEDED'
  | 'INSUFFICIENT_BALANCE'
  | 'POSITION_SIZE_TOO_SMALL'
  // mercado e corretora
  | 'BTC_BEARISH'
  | 'BTC_HIGH_VOLATILITY'
  | 'QUOTE_VOLUME_TOO_LOW'
  | 'MARKET_EVENT_BLOCK'
  | 'EXCHANGE_FILTER_FAILED'
  | 'EXCHANGE_ENVIRONMENT_SWITCHING'
  | 'CREDENTIALS_MISSING'
  // resultado positivo
  | 'ALLOWED';

/** De onde a regra veio — para saber onde mexer quando a decisão surpreender. */
export type DecisionRule =
  | 'autoTrader'
  | 'automationPolicy'
  | 'governor'
  | 'sizing'
  | 'execution'
  | 'persistence'
  | 'marketData';

export interface DecisionReason {
  code: DecisionCode;
  /** frase pronta para a tela, em português, sem jargão de código */
  message: string;
  /** os números que sustentam a frase, para o painel formatar como quiser */
  data?: Record<string, unknown>;
  rule: DecisionRule;
}

/**
 * Onde o sinal parou no funil. A ordem é a ordem em que as regras rodam, e é
 * ela que o painel usa para desenhar as etapas.
 */
export type FunnelStage =
  | 'DETECTADO'
  | 'ESTRATEGIA_VALIDADA'
  | 'SCORE_SUFICIENTE'
  | 'DENTRO_DA_ZONA'
  | 'APROVADO_PELO_RISCO'
  | 'ORDEM_CRIADA'
  | 'ORDEM_PREENCHIDA'
  | 'RESULTADO';

export interface EntryDecision {
  allowed: boolean;
  /** o motivo que MANDA: o primeiro bloqueio, ou ALLOWED */
  code: DecisionCode;
  blockers: DecisionReason[];
  warnings: DecisionReason[];
  /** multiplicador de tamanho vindo do regime (1 = tamanho cheio) */
  sizeFactor: number;
  /** até onde o sinal chegou antes de parar */
  stage: FunnelStage;
  evaluatedAt: string;
  setupId: string;
  symbol: string;
  currentPrice: number;
  entryLow: number;
  entryHigh: number;
  /**
   * Distância até a zona, em %. Negativa = abaixo da zona (ainda não chegou),
   * positiva = acima (o movimento já foi), zero = dentro.
   */
  distanceToEntryPercent: number;
}

export function reason(
  code: DecisionCode,
  rule: DecisionRule,
  message: string,
  data?: Record<string, unknown>,
): DecisionReason {
  return data === undefined ? { code, rule, message } : { code, rule, message, data };
}

/**
 * Quanto o preço está longe da zona de entrada, em percentual.
 *
 * Dentro da zona é exatamente zero — e é isso que separa "pode comprar" de
 * "quase". Acima da zona devolve positivo porque perseguir o movimento e
 * esperar o preço voltar são erros opostos, e o painel precisa distinguir.
 */
export function distanceToEntryPercent(
  price: number,
  entryLow: number,
  entryHigh: number,
): number {
  if (price <= 0 || entryLow <= 0 || entryHigh <= 0) return 0;
  if (price >= entryLow && price <= entryHigh) return 0;
  const reference = price > entryHigh ? entryHigh : entryLow;
  return Math.round(((price - reference) / reference) * 10_000) / 100;
}

/** A etapa do funil que corresponde a um bloqueio. */
export function stageForCode(code: DecisionCode): FunnelStage {
  switch (code) {
    case 'ALLOWED':
      return 'APROVADO_PELO_RISCO';
    case 'STRATEGY_NOT_VALIDATED':
    case 'STRATEGY_DISABLED':
    case 'TIMEFRAME_NOT_ENABLED':
    case 'SHORT_NOT_AUTOMATED':
    case 'MARKET_NOT_VALIDATED':
      return 'DETECTADO';
    case 'SCORE_BELOW_VALIDATED_FLOOR':
    case 'SCORE_BELOW_CONFIGURED_MINIMUM':
    case 'RISK_REWARD_BELOW_MINIMUM':
      return 'ESTRATEGIA_VALIDADA';
    case 'PRICE_OUTSIDE_ENTRY_ZONE':
    case 'PRICE_EXTENDED':
    case 'SETUP_EXPIRED':
    case 'SETUP_STALE':
    case 'SETUP_INVALIDATED':
    case 'SETUP_IGNORED':
    case 'SETUP_ALREADY_BOUGHT':
    case 'TIMEFRAME_DISABLED':
      return 'SCORE_SUFICIENTE';
    default:
      return 'DENTRO_DA_ZONA';
  }
}
