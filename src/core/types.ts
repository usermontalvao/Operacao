import type { MarketEvent } from './news/types.ts';
import type { PostMortem } from './journal/postMortem.ts';
/**
 * Tipos compartilhados entre o motor (core), o servidor e a interface.
 * O core é puro: nada aqui depende de rede, banco ou relógio do sistema.
 */

import type { GuardSettings } from './risk/governor.ts';
import type { MarketKind, Side } from './direction.ts';

export type { GuardSettings };
export type { MarketKind, Side } from './direction.ts';
import type { EntryDecision } from './decision/types.ts';
export type {
  DecisionCode,
  DecisionReason,
  DecisionRule,
  EntryDecision,
  FunnelStage,
} from './decision/types.ts';
export type { EntryDecisionRecord } from './decision/record.ts';
export type { PolicySnapshot } from './policy/snapshot.ts';
export type { RiskSizingResult, SizingLimit } from './risk/sizeByRisk.ts';
export type { FreshnessReport, FreshnessLevel } from './health/freshness.ts';

/**
 * Tempo gráfico que o MOTOR aceita.
 *
 * `1m` entrou por último e é diferente dos outros quatro em espécie, não em
 * grau. De 15m para cima o candle carrega informação suficiente para uma tese
 * direcional; em 1 minuto ele é majoritariamente ruído, e um alvo do tamanho
 * do ATR de 1m nem paga a corretagem. Por isso o 1m NÃO é gatilho dos
 * detectores de tendência: ele existe apenas para o módulo de micro scalp
 * (src/core/scalp), que opera outra pergunta — lateralidade com amplitude
 * suficiente para cobrir o custo — e que só roda quando ligado nas
 * Configurações.
 *
 * A separação abaixo é o que garante isso: `TIMEFRAMES` é o conjunto que o
 * scanner de sempre varre, e o 1m está FORA dele de propósito. Quem quiser o
 * 1m precisa pedir explicitamente por MICRO_TIMEFRAME.
 */
export type Timeframe = '1m' | '3m' | '5m' | '15m' | '1h' | '4h' | '1d';

/**
 * Os timeframes da varredura padrão. O 1m não está aqui.
 *
 * Este array alimenta a assinatura de WebSocket e a carga de histórico de
 * TODOS os pares. Acrescentar 1m aqui abriria um stream de 1 minuto por par
 * do universo inteiro sem que ninguém tivesse ligado nada — exatamente o
 * oposto de opt-in.
 */
export const TIMEFRAMES: Timeframe[] = ['3m', '5m', '15m', '1h', '4h', '1d'];

/** O timeframe do micro scalp, sempre nomeado, nunca inferido. */
export const MICRO_TIMEFRAME: Timeframe = '1m';

/** Minutos de cada timeframe. Fonte única — ninguém mais deriva isso à mão. */
export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
};

export function timeframeMinutes(timeframe: Timeframe): number {
  return TIMEFRAME_MINUTES[timeframe];
}

/**
 * Tempo gráfico da VISUALIZAÇÃO — mais largo que o do motor.
 *
 * Olhar um gráfico de 3m ou 30m é leitura humana e não custa nada; deixar o
 * motor varrer esses intervalos é outra conversa. Por isso são dois conjuntos.
 *
 * Não existe "2m" na Binance. Os intervalos dela são 1m, 3m, 5m, 15m, 30m,
 * 1h, 2h, 4h… — pedir 2m devolve erro, então a lista abaixo é a que a
 * corretora realmente serve.
 */
export type ChartInterval = Timeframe | '30m';

export const CHART_INTERVALS: ChartInterval[] = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
  '1d',
];

/**
 * Peso de cada timeframe na leitura de tendência. 4H e diário mandam.
 *
 * O 1m entra com peso quase nulo: ele nunca deve puxar a leitura de tendência
 * de nada. Quem opera 1m no micro scalp lê a tendência dos outros.
 */
export const TIMEFRAME_WEIGHT: Record<Timeframe, number> = {
  '1m': 0.1,
  '3m': 0.2,
  '5m': 0.3,
  '15m': 0.5,
  '1h': 1,
  '4h': 2.5,
  '1d': 3,
};

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  closeTime: number;
  /** false enquanto o candle ainda está se formando */
  closed: boolean;
}

export interface MacdPoint {
  macd: number;
  signal: number;
  histogram: number;
}

export interface BollingerPoint {
  upper: number;
  middle: number;
  lower: number;
  /** (upper - lower) / middle */
  width: number;
}

/** Fotografia dos indicadores no último candle fechado de um timeframe. */
export interface IndicatorSnapshot {
  timeframe: Timeframe;
  close: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  macd: MacdPoint | null;
  macdPrev: MacdPoint | null;
  atr14: number | null;
  /** ATR como percentual do preço */
  atrPercent: number | null;
  bollinger: BollingerPoint | null;
  volume: number;
  volumeAverage20: number | null;
  relativeVolume: number | null;
  /** variação percentual do candle atual */
  changePercent: number;
  candleCount: number;
}

export type TrendState = 'UP' | 'DOWN' | 'SIDEWAYS';

export type MarketStructure = 'HH_HL' | 'LH_LL' | 'RANGE' | 'UNDEFINED';

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  kind: 'HIGH' | 'LOW';
}

/** Zona de preço construída a partir de pivôs próximos entre si. */
export interface PriceLevel {
  kind: 'SUPPORT' | 'RESISTANCE';
  price: number;
  low: number;
  high: number;
  touches: number;
  lastTouchTime: number;
  /** 0..1 — quantidade de toques, idade e largura da zona */
  quality: number;
}

export interface BreakoutInfo {
  level: PriceLevel;
  breakoutIndex: number;
  breakoutClose: number;
  /** o preço voltou até a zona rompida depois do rompimento */
  retested: boolean;
  /** fechou de volta abaixo da zona: rompimento falso */
  failed: boolean;
  barsSinceBreakout: number;
  /** barra em que o preço encostou de volta no nível rompido */
  retestIndex: number | null;
  /**
   * O comprador apareceu DEPOIS do toque. Encostar no nível não é reteste
   * bem-sucedido: é só o preço passando por ali. Confirmação exige fechamento
   * de volta acima do nível, fundo mais alto que o do toque e volume presente.
   */
  confirmed: boolean;
  confirmationIndex: number | null;
  confirmationReasons: string[];
  barsSinceConfirmation: number | null;
}

export interface StructureSnapshot {
  timeframe: Timeframe;
  trend: TrendState;
  structure: MarketStructure;
  swings: SwingPoint[];
  supports: PriceLevel[];
  resistances: PriceLevel[];
  nearestSupport: PriceLevel | null;
  nearestResistance: PriceLevel | null;
  breakout: BreakoutInfo | null;
  /** perda de suporte confirmada — o espelho do rompimento, para as teses vendidas */
  breakdown: BreakoutInfo | null;
  /** true quando as últimas barras couberem numa faixa estreita em relação ao ATR */
  consolidating: boolean;
  /** distância percentual do topo recente (quanto o preço já corrigiu) */
  pullbackPercent: number | null;
  /** distância percentual do fundo recente (quanto o preço já repicou) */
  bouncePercent: number | null;
  recentHigh: number;
  recentLow: number;
}

export type BtcContextState =
  | 'BTC_BULLISH'
  | 'BTC_NEUTRAL'
  | 'BTC_BEARISH'
  | 'BTC_HIGH_VOLATILITY';

export interface MarketContext {
  state: BtcContextState;
  /** modificador de score aplicado às altcoins (-20 a +10) */
  scoreModifier: number;
  reasons: string[];
  btcPrice: number | null;
  btcChangePercent24h: number | null;
  btcTrend4h: TrendState;
  btcTrend1d: TrendState;
  highVolatility: boolean;
  /**
   * BTC acima da própria média de 200 dias — o regime que separa um mercado
   * comprador de um vendedor. É o único filtro que se mostrou consistente nas
   * duas janelas do laboratório, e é o que autoriza a entrada por explosão.
   * null = sem histórico diário suficiente para afirmar.
   */
  btcAboveDailyMean: boolean | null;
  updatedAt: string;
}

/**
 * RANGE_FADE é o único tipo que NÃO é direcional: os outros quatro compram
 * força ou defesa dentro de uma tendência, ele vende a extremidade de uma
 * faixa apostando na volta ao meio. É o setup do micro scalp de 1 minuto.
 *
 * Tipo novo aqui exige migration no CHECK de trade_setups.setup_type —
 * sem ela o Postgres recusa a gravação e a falha é silenciosa.
 */
export type SetupType =
  | 'PULLBACK'
  | 'BREAKOUT_RETEST'
  | 'SUPPORT_REVERSAL'
  | 'MOMENTUM_BURST'
  | 'RANGE_FADE';

export type SetupStatus =
  | 'WATCHING'
  | 'ACTIVE'
  | 'TRIGGERED'
  | 'BOUGHT'
  | 'INVALIDATED'
  | 'EXPIRED';

/** Estado visual mostrado no card — mais granular que o status persistido. */
export type SetupVisualState =
  | 'AGUARDANDO'
  | 'QUASE_LA'
  | 'SETUP_ATIVO'
  | 'ROMPENDO'
  | 'RETESTANDO'
  | 'COMPRAVEL'
  | 'ESTICADO'
  | 'INVALIDADO';

export type SetupClassification =
  | 'SEM_SETUP'
  | 'OBSERVAR'
  | 'SETUP_INTERESSANTE'
  | 'SETUP_FORTE'
  | 'SETUP_EXCEPCIONAL';

export interface ScoreComponent {
  key: string;
  label: string;
  points: number;
  maxPoints: number;
  detail: string;
}

export interface ScoreBreakdown {
  total: number;
  classification: SetupClassification;
  components: ScoreComponent[];
  penalties: ScoreComponent[];
}

export interface ExtensionCheck {
  extended: boolean;
  reasons: string[];
}

/**
 * Retrato numérico do momento em que o setup nasceu. É o que permite, depois
 * do resultado, perguntar "quais indicadores estavam certos?".
 */
export interface SetupEvidence {
  rsi14: number | null;
  atrPercent: number | null;
  relativeVolume: number | null;
  macdHistogram: number | null;
  distanceToEma20InAtr: number | null;
  triggerTrend: TrendState;
  anchorTrend: TrendState;
  anchorStructure: MarketStructure;
  levelQuality: number;
  volumeConfirmation: boolean;
  momentumTurning: boolean;
  btcScoreModifier: number;
  /**
   * Corpo da barra de explosão em ATRs — só a entrada por força preenche.
   *
   * Viaja com o setup porque é o ÚNICO grau de sinal que a medição sustenta.
   * O score não serve para isso: em 62 pares negociáveis e 9 anos, a faixa
   * 85-89 rendeu +0,369R e a 95-100 rendeu +0,296R — não há escada. O corpo
   * tem: abaixo de 2,5 ATR a expectativa é +0,016R, ou seja, nada.
   */
  burstBodyAtr?: number | null;
  /**
   * NORMAL (2,0 a 3,0 ATR) ou STRONG (3,0 ou mais).
   *
   * Classificação, não permissão: ela existe para telemetria, ordenação e
   * estudo. Não multiplica risco — ver strategyConfidenceSizeFactor.
   */
  burstStrength?: 'NORMAL' | 'STRONG' | null;
}

/* ==========================================================================
 * MICRO SCALP (1 minuto)
 * ========================================================================== */

/** Como o par se classifica para operar em 1 minuto. */
export type ScalpGrade = 'EXCELENTE' | 'BOM' | 'APTO' | 'BLOQUEADO';

/**
 * Uma parcela do scalpabilityScore. Guardar a conta inteira, e não só o
 * total, é o que permite responder "por que este par foi bloqueado?" sem
 * refazer a medição — e é o que a tela mostra quando diz o motivo.
 */
export interface ScalpScoreComponent {
  key: string;
  label: string;
  /** positivo soma, negativo desconta */
  points: number;
  detail: string;
}

/** Medição de liquidez de um par, tirada do book e do volume recente. */
export interface LiquiditySnapshot {
  symbol: string;
  /** melhor compra e melhor venda no momento da medição */
  bid: number;
  ask: number;
  /** (ask - bid) / meio, em % */
  spreadPercent: number;
  /**
   * Quanto o preço médio piora ao varrer o book com uma ordem a mercado do
   * tamanho que ESTA conta usa. É o escorregamento real, não o estimado.
   * null = o book não tem profundidade nem para essa ordem.
   */
  slippagePercent: number | null;
  /** valor em USDT disponível nos primeiros níveis de cada lado */
  bidDepthUsd: number;
  askDepthUsd: number;
  quoteVolume24h: number;
  /** volume negociado nos últimos 15 minutos, em USDT */
  recentQuoteVolume: number;
  measuredAt: number;
}

export interface ScalpabilityReport {
  symbol: string;
  score: number;
  grade: ScalpGrade;
  components: ScalpScoreComponent[];
  /**
   * O que há de errado com este par, em frases prontas para a tela.
   *
   * A lista existe SEMPRE, mesmo quando os filtros não estão vetando: ela é o
   * diagnóstico, não a sentença. Quem transforma diagnóstico em veto é
   * `blocked`, logo abaixo.
   */
  blockers: string[];
  /** o par está de fato barrado? falso quando os filtros só avisam */
  blocked: boolean;
  liquidity: LiquiditySnapshot;
  /** ATR de 1m em % — a amplitude que o par oferece por barra */
  microAtrPercent: number | null;
  /** custo de ida e volta com os números reais desta conta, em % */
  allInCostPercent: number;
  measuredAt: number;
}

export type RangeVerdict = 'RANGE' | 'TENDENCIA' | 'EXPANSAO' | 'INDEFINIDO';

/**
 * O laudo de lateralidade. O micro scalp só opera com verdict === 'RANGE';
 * os outros três valores existem para a tela poder dizer POR QUE não operou.
 */
export interface RangeRegimeReport {
  verdict: RangeVerdict;
  /** 0..1 — quão convincente é a faixa */
  confidence: number;
  support: number;
  resistance: number;
  /** (resistência - suporte) / preço, em % */
  amplitudePercent: number;
  /** onde o preço está dentro da faixa: 0 = no suporte, 1 = na resistência */
  position: number;
  adx: number | null;
  /** inclinação da EMA20 em % por barra — perto de zero é faixa */
  emaSlopePercent: number | null;
  bollingerWidthPercent: number | null;
  vwap: number | null;
  supportTouches: number;
  resistanceTouches: number;
  reasons: string[];
}

/**
 * A conta de custo de UMA operação, com os números da conta e da modalidade
 * ativas. Nada aqui é fixo: taxa de spot e de futuros são diferentes, e o
 * spread e o escorregamento vêm do book medido, não de uma estimativa.
 */
export interface MicroEconomics {
  /** taxa de entrada, em % do valor negociado */
  entryFeePercent: number;
  exitFeePercent: number;
  /** metade do spread, que é o que se paga ao cruzar o book */
  spreadCostPercent: number;
  estimatedSlippagePercent: number;
  /** soma de tudo acima — o que a operação paga só por existir */
  allInCostPercent: number;
  /** movimento bruto esperado até o alvo, em % */
  grossExpectedProfitPercent: number;
  /** o que sobra depois de allInCost */
  netExpectedProfitPercent: number;
  /** grossExpectedProfit / allInCost — quantas vezes o alvo paga o custo */
  costMultiple: number;
  /** R/R já líquido, pelo mesmo cálculo do resto do sistema */
  netRiskReward: number;
  /**
   * Por que esta tese não deveria existir, quando os filtros estão apenas
   * avisando. null = a conta fecha pelos critérios configurados.
   */
  warning: string | null;
}

/** O que o micro scalp anexa ao setup — ausente em todos os outros tipos. */
export interface MicroScalpDetail {
  scalpability: ScalpabilityReport;
  regime: RangeRegimeReport;
  economics: MicroEconomics;
}

export interface TradeSetup {
  id: string;
  symbol: string;
  /**
   * Direção da tese. Em spot só existe compra; em futuros o mesmo detector
   * tem espelho vendido, e é este campo que diz qual dos dois está na tela.
   */
  side: Side;
  /** onde a tese pode ser executada: spot compra a moeda, futuros o contrato */
  market: MarketKind;
  timeframe: Timeframe;
  /** timeframe que define o viés (4h ou 1d) */
  anchorTimeframe: Timeframe;
  setupType: SetupType;
  currentPrice: number;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  target1: number;
  target2: number | null;
  target3: number | null;
  riskReward: number;
  score: number;
  classification: SetupClassification;
  scoreBreakdown: ScoreBreakdown;
  reasons: string[];
  btcContext: BtcContextState;
  status: SetupStatus;
  visualState: SetupVisualState;
  extended: boolean;
  extensionReasons: string[];
  evidence: SetupEvidence;
  /** assinatura estável usada para não recriar o mesmo setup a cada varredura */
  fingerprint: string;
  invalidationNote: string | null;
  /**
   * Só o RANGE_FADE preenche. Fica opcional porque toda tese gravada antes do
   * micro scalp existir não tem este campo — e ler `undefined` aqui é o
   * comportamento correto para elas, não um defeito a consertar na carga.
   */
  micro?: MicroScalpDetail;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ignoredAt: string | null;
}

/** Resultado bruto de um detector, antes do score e da persistência. */
export interface SetupCandidate {
  symbol: string;
  side: Side;
  timeframe: Timeframe;
  anchorTimeframe: Timeframe;
  setupType: SetupType;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  target1: number;
  target2: number | null;
  target3: number | null;
  reasons: string[];
  /** referência do nível que sustenta a tese — entra na fingerprint */
  levelPrice: number;
  /** laudo de lateralidade; só o detector de micro scalp preenche */
  regime?: RangeRegimeReport;
  qualityHints: {
    levelQuality: number;
    volumeConfirmation: boolean;
    momentumTurning: boolean;
    trendAligned: boolean;
    /** medidas da explosão — só a entrada por força as preenche */
    burst?: {
      bodyAtr: number;
      volumeMultiple: number;
      lookback: number;
      closePosition: number;
    };
  };
}

export interface SymbolFilters {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  maxQty: number;
  minNotional: number;
  /** o minNotional também vale para ordens a mercado */
  applyMinToMarket: boolean;
  baseAssetPrecision: number;
  quotePrecision: number;
  isSpotTradingAllowed: boolean;
  ocoAllowed: boolean;
  /** de qual mercado vieram estes filtros — os dois têm passos diferentes */
  market: MarketKind;
  /** teto de alavancagem que a corretora aceita no par (só futuros) */
  maxLeverage?: number;
}

export type TradingMode = 'PAPER' | 'TESTNET' | 'LIVE';

/** Margem isolada prende só o que a posição usa; cruzada usa a carteira toda. */
export type MarginMode = 'ISOLATED' | 'CROSSED';

/**
 * Ajustes que só existem em futuros.
 *
 * Ficam junto do risco de cada conta porque é isso que eles são: alavancagem
 * é quanta margem a mesma tese prende, não quanto ela arrisca. O tamanho
 * continua saindo do prejuízo no stop.
 */
export interface FuturesSettings {
  /** alavancagem enviada à corretora antes de cada entrada */
  leverage: number;
  /** teto que o painel aceita, independentemente do que a corretora permite */
  maxLeverage: number;
  marginMode: MarginMode;
  /** libera as teses vendidas — sem isto o painel opera futuros só comprado */
  allowShort: boolean;
  /**
   * Folga mínima entre o stop e o preço de liquidação, em % do preço de
   * entrada. Stop depois da liquidação é stop que nunca executa: quem fecha a
   * posição é a corretora, pelo preço dela, e o prejuízo deixa de ser o
   * planejado.
   */
  minLiquidationBufferPercent: number;
}

export interface RiskSettings {
  /** capital de referência usado no modo PAPER */
  paperCapital: number;
  /** moeda em que o capital acima foi informado (o motor opera sempre em USDT) */
  paperCapitalCurrency: 'USDT' | 'BRL';
  /** percentual máximo do capital em uma única operação */
  maxPositionPercent: number;
  /** percentual do capital arriscado por trade (distância até o stop) */
  riskPerTradePercent: number;
  maxOpenTrades: number;
  dailyLossLimitPercent: number;
  minimumRiskReward: number;
  minimumScoreToAlert: number;
  minimumScoreToShow: number;
}

export type UniverseMode = 'WATCHLIST' | 'ALL_USDT';

export interface ScannerSettings {
  watchlist: string[];
  /** WATCHLIST varre só os favoritos; ALL_USDT varre todo o spot USDT da Binance */
  universe: UniverseMode;
  /** legado de configurações anteriores; liquidez para operar vive no guard */
  minQuoteVolume24h: number;
  triggerTimeframes: Timeframe[];
  anchorTimeframe: Timeframe;
  /** minutos até um setup não acionado expirar */
  setupTtlMinutes: number;
  /** minutos de silêncio antes de recriar o mesmo setup */
  cooldownMinutes: number;
  /**
   * A explosão só nasce com o BTC acima da média de 200 dias.
   *
   * Nasce LIGADO, que é o comportamento histórico. Desligar dobra o número de
   * entradas — o filtro bloqueia 48% dos dias — e, na medição de 9 anos, o
   * lado bloqueado rende MAIS que o liberado. O número está no cabeçalho de
   * momentumBurst.ts, junto com a ressalva de viés de sobrevivência que
   * recomenda tratá-lo como teto, não como promessa.
   */
  burstRequireBtcRegime: boolean;
  /**
   * Micro scalp de 1 minuto. Desligado, absolutamente nada muda: nenhum
   * stream de 1m é assinado, nenhum par é medido e nenhum detector roda.
   */
  microScalp: MicroScalpSettings;
}

/**
 * O que liga, limita e calibra o micro scalp.
 *
 * Todo número que decide alguma coisa está aqui — nenhum limiar mora solto
 * dentro de um detector. É proposital: os pesos do scalpabilityScore e os
 * cortes de regime são hipóteses a serem medidas, e hipótese que só existe
 * dentro do código é hipótese que ninguém revisa.
 */
export interface MicroScalpSettings {
  enabled: boolean;
  /**
   * Os filtros VETAM ou apenas AVISAM.
   *
   * Ligado (padrão), um par reprovado não entra e uma tese sem margem não
   * nasce. Desligado, tudo é medido e mostrado do mesmo jeito — os motivos
   * viram avisos em vez de portas fechadas, e quem decide é quem está olhando.
   *
   * O que NÃO muda com este interruptor: os números. Lucro bruto, custo e
   * líquido continuam sendo os reais, e um líquido negativo aparece em
   * vermelho na tese. Deixar de bloquear é devolver a decisão ao operador,
   * não maquiar a conta que sustenta a decisão. E o robô continua sem operar
   * este tipo em nenhum dos dois modos.
   */
  enforceFilters: boolean;
  /** quantos pares são medidos no book a cada volta */
  maxCandidates: number;
  /** teto de pares que o universo de scalp acompanha em tempo real */
  maxUniverseSize: number;
  /** de quantos em quantos segundos o universo é remedido */
  universeRefreshSeconds: number;
  /** tamanho de ordem usado para medir escorregamento no book, em USDT */
  probeOrderUsd: number;
  filters: ScalpLiquidityFilters;
  weights: ScalpScoreWeights;
  regime: RangeRegimeSettings;
  /** minutos até um setup de 1m não acionado expirar */
  setupTtlMinutes: number;
  /** minutos de silêncio antes de recriar a mesma tese de 1m */
  cooldownMinutes: number;
}

/** Cortes eliminatórios: reprovado em qualquer um, o par nem é pontuado. */
export interface ScalpLiquidityFilters {
  minQuoteVolume24h: number;
  /** volume em USDT nos últimos 15 minutos */
  minRecentQuoteVolume: number;
  maxSpreadPercent: number;
  /** profundidade mínima em USDT de cada lado do book */
  minBookDepthUsd: number;
  maxSlippagePercent: number;
  /** ATR de 1m mínimo, em % — abaixo disso não há o que capturar */
  minMicroAtrPercent: number;
  /** ATR de 1m máximo: acima disso não é oscilação, é notícia */
  maxMicroAtrPercent: number;
  /** nota mínima para o par entrar no scanner de 1m */
  minScore: number;
}

/** Pesos do scalpabilityScore. Somam o teto de 100 quando tudo é perfeito. */
export interface ScalpScoreWeights {
  liquidity: number;
  recentVolume: number;
  usableVolatility: number;
  bookDepth: number;
  /** descontos — declarados positivos e subtraídos no cálculo */
  spreadPenalty: number;
  slippagePenalty: number;
  costPenalty: number;
}

/** O que faz um mercado ser considerado lateral. */
export interface RangeRegimeSettings {
  /** quantas barras de 1m formam a faixa analisada */
  lookback: number;
  /** ADX acima disto é tendência, e o micro scalp não opera tendência */
  maxAdx: number;
  /**
   * Quanto o eixo da faixa (EMA20) pode andar em 10 barras, como FRAÇÃO da
   * amplitude. Relativo e não absoluto porque um mesmo número em % não
   * significa a mesma coisa num par que anda 2% e noutro que anda 0,1%.
   */
  maxEmaDriftOfRange: number;
  /**
   * Quanto o eixo pode ter percorrido da amplitude entre a PRIMEIRA e a
   * ÚLTIMA barra da janela. É o que separa faixa de canal: num canal lento a
   * amplitude medida incha junto com o movimento e a deriva de curto prazo
   * fica pequena, mas o eixo atravessa a faixa de ponta a ponta.
   */
  maxEmaTravelOfRange: number;
  /** quantos toques cada extremidade precisa ter para a faixa valer */
  minTouchesPerSide: number;
  /** amplitude mínima da faixa em múltiplos do custo total da operação */
  minAmplitudeCostMultiple: number;
  /** expansão de volatilidade: ATR atual sobre a média, acima disto trava */
  maxVolatilityExpansion: number;
  /** o preço precisa estar nos X% inferiores da faixa para comprar */
  entryZonePercent: number;
  /** lucro bruto precisa ser este múltiplo do custo total para liberar */
  minCostMultiple: number;
}

/**
 * Compra automática.
 *
 * Em PAPER e TESTNET o robô opera livre. Em conta real ele só age com duas
 * chaves giradas ao mesmo tempo: a variável ALLOW_LIVE_AUTOTRADE no servidor
 * e o armar explícito no painel. O usuário escolhe um prazo ou assume de forma
 * explícita o modo sem prazo; uma trava só na interface seria uma trava que um
 * clique errado desfaz.
 */
export interface AutoTradeSettings {
  enabled: boolean;
  /** score mínimo para o robô comprar sozinho */
  minimumScore: number;
  /** R/R mínimo para a compra automática (pode ser mais exigente que o do scanner) */
  minimumRiskReward: number;
  /** percentual do capital disponível por operação automática */
  percentOfCapital: number;
  maxConcurrentTrades: number;
  /** não compra o mesmo ativo de novo dentro desta janela */
  cooldownMinutes: number;
  /** compra apenas quando o preço estiver dentro da zona de entrada */
  requireInsideEntryZone: boolean;
  /** libera o robô na conta real — sozinho não basta, ainda precisa estar armado */
  allowLive: boolean;
  /** até quando o robô está armado para conta real (ISO); null = desarmado */
  liveArmedUntil: string | null;
  /** armado até o usuário desarmar; distingue esse estado do null = desarmado */
  liveArmedIndefinitely: boolean;
  /** teto absoluto em USDT por ordem automática, independente do percentual */
  maxNotionalPerTrade: number;
  /** autorização e régua próprias de cada família de setup */
  strategies: Record<SetupType, AutomaticSetupSettings>;
}

export interface AutomaticSetupSettings {
  /** desligada = continua no radar, mas nunca cria ordem sozinha */
  enabled: boolean;
  /** piso duro desta estratégia; acima dele a confiança também calibra o tamanho */
  minimumScore: number;
  /** R/R bruto mínimo específico da estratégia */
  minimumRiskReward: number;
}

/**
 * O que pertence a UMA conta.
 *
 * Demo e conta real não compartilham nada que decida quanto se arrisca: o
 * capital, o robô e o disjuntor são de cada modo. Trocar de PAPER para LIVE
 * costumava carregar junto o robô ligado do modo anterior — a conta real
 * herdava um interruptor que ninguém tinha girado ali.
 */
export interface ModeSettings {
  risk: RiskSettings;
  autoTrade: AutoTradeSettings;
  /** custos reais de execução e disjuntor de risco */
  guard: GuardSettings;
  /** só usado quando o mercado é FUTURES; em spot fica parado e inofensivo */
  futures: FuturesSettings;
}

/**
 * Visão resolvida: o modo ativo já achatado. É o que o motor e a tela leem —
 * ninguém além do SettingsService precisa saber que existem três conjuntos.
 */
export interface AppSettings extends ModeSettings {
  mode: TradingMode;
  /** modalidade ativa: spot ou futuros USD-M */
  market: MarketKind;
  /**
   * Interruptor geral dos futuros — o de fora de tudo.
   *
   * Barrado, a modalidade não pode ser escolhida, nenhuma tese vendida nasce
   * e nenhuma ordem alavancada sai, em conta nenhuma. Não é preferência de
   * conta como o resto: é a decisão de que esta casa opera futuros ou não, e
   * por isso mora fora dos baldes, ao lado da watchlist.
   */
  futuresEnabled: boolean;
  scanner: ScannerSettings;
  updatedAt: string;
}

/**
 * O que vai para o disco: um conjunto por modo, mais o scanner, que é comum.
 *
 * A varredura fica de fora de propósito. Quais moedas olhar e em que
 * timeframe não move dinheiro nenhum, e refazer a watchlist a cada troca de
 * conta seria trabalho repetido sem ganho de segurança.
 */
export interface StoredSettings {
  mode: TradingMode;
  market: MarketKind;
  /** interruptor geral dos futuros; nasce desligado */
  futuresEnabled: boolean;
  scanner: ScannerSettings;
  /**
   * Um conjunto por MODALIDADE e por conta. Spot e futuros não podem
   * compartilhar risco: a mesma frase "1% por operação" tem consequência
   * diferente quando a posição é alavancada, e herdar o robô ligado do spot
   * ao entrar em futuros repetiria, de outro jeito, o problema que a
   * separação por conta já resolveu.
   */
  byMarket: Record<MarketKind, Record<TradingMode, ModeSettings>>;
  updatedAt: string;
}

/**
 * Formato gravado entre a separação por conta e a chegada dos futuros: um
 * conjunto por conta, sem modalidade. Vira o balde do SPOT na conversão.
 */
export interface LegacyByModeSettings {
  mode: TradingMode;
  scanner: ScannerSettings;
  byMode: Record<TradingMode, Partial<ModeSettings>>;
  updatedAt: string;
}

/**
 * Formato gravado antes da separação por modo: um conjunto só para as três
 * contas. Ainda é lido no boot para converter o que já está no disco.
 */
export interface LegacySettings {
  mode: TradingMode;
  market?: MarketKind;
  risk: RiskSettings;
  scanner: ScannerSettings;
  autoTrade: AutoTradeSettings;
  guard?: GuardSettings;
  updatedAt: string;
}

/** o que o repositório devolve: pode ser qualquer um dos dois formatos */
export type PersistedSettings = StoredSettings | LegacyByModeSettings | LegacySettings;

export interface PositionSizing {
  quantity: number;
  entryPrice: number;
  notional: number;
  riskAmount: number;
  riskPercentOfCapital: number;
  potentialProfitTarget1: number;
  potentialProfitTarget2: number | null;
  potentialProfitTarget3: number | null;
  riskReward: number;
}

export type TradeStatus = 'PENDING' | 'OPEN' | 'CLOSED' | 'CANCELLED';

export type TradeOutcome = 'TARGET1' | 'TARGET2' | 'TARGET3' | 'STOP' | 'MANUAL' | 'OPEN';

export interface Trade {
  id: string;
  setupId: string;
  /** true quando a compra veio do robô (só contas de teste) */
  automatic?: boolean;
  symbol: string;
  mode: TradingMode;
  /** spot ou futuros — decide para qual corretora a ordem foi e como ela fecha */
  market: MarketKind;
  side: Side;
  setupType: SetupType;
  timeframe: Timeframe;
  score: number;
  status: TradeStatus;
  outcome: TradeOutcome;
  requestedQuantity: number;
  filledQuantity: number;
  entryPrice: number;
  averageFillPrice: number | null;
  stopLoss: number;
  target1: number;
  target2: number | null;
  target3: number | null;
  notional: number;
  riskAmount: number;
  realizedPnl: number;
  realizedPnlPercent: number;
  /** maior excursão favorável / adversa, em percentual sobre a entrada */
  maxFavorablePercent: number;
  maxAdversePercent: number;
  remainingQuantity: number;
  /** corretagem já paga nas duas pontas — realizedPnl sai líquido dela */
  feesPaid: number;
  /** maior preço visto desde a entrada; é o que alimenta o stop que sobe */
  highWaterPrice: number | null;
  /** stop em vigor depois da proteção automática, quando houve */
  protectiveStop: number | null;
  /** alavancagem usada; 1 em spot */
  leverage: number;
  /** margem prendida pela posição (notional ÷ alavancagem) */
  initialMargin: number;
  marginMode?: MarginMode;
  /**
   * Preço em que a corretora liquida a posição, estimado na abertura. Só
   * futuros. Serve para a tela mostrar a distância até ele e para a auditoria
   * saber, depois, se o stop estava do lado certo dessa linha.
   */
  liquidationPrice: number | null;
  /** por que a operação encerrou, quando não foi alvo nem stop */
  closeReason: string | null;
  fills: TradeFill[];
  exchangeOrderIds: string[];
  clientOrderId: string;
  /**
   * Listas OCO que protegem a posição na corretora AGORA. Sem esta lista não
   * há como cancelar a proteção certa para recriá-la mais acima, e sobras de
   * ordem antiga ficariam vendendo a posição duas vezes.
   */
  protectionListIds?: string[];
  /**
   * Plano de saída em vigor. Era aqui que papel e conta real divergiam sem
   * ninguém ver: o papel saía em 50/30/20 e a conta real mandava tudo para o
   * alvo 1. Gravado na operação, a divergência fica visível na comparação.
   */
  exitPlanKind?: 'SCALE_OUT' | 'SINGLE';
  openedAt: string;
  closedAt: string | null;
  updatedAt: string;
}

export interface TradeFill {
  kind: 'ENTRY' | 'TARGET1' | 'TARGET2' | 'TARGET3' | 'STOP' | 'MANUAL';
  price: number;
  quantity: number;
  time: string;
  /**
   * Ordem da corretora que originou este preenchimento. É o que impede o
   * monitor de contar a mesma execução duas vezes a cada consulta — e como
   * fica gravado junto da operação, a proteção sobrevive a um reinício.
   */
  orderId?: string;
  /** corretagem desta perna, quando conhecida */
  commission?: number;
}

export interface PerformanceStats {
  totalSetups: number;
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
  expectancy: number;
  totalPnl: number;
  /** separa o que mede o robô do que foi decidido pelo usuário */
  byOrigin: PerformanceBucket[];
  bySymbol: PerformanceBucket[];
  bySetupType: PerformanceBucket[];
  byTimeframe: PerformanceBucket[];
}

export interface PerformanceBucket {
  key: string;
  trades: number;
  wins: number;
  winRate: number;
  pnl: number;
}

/**
 * Diário de decisões: liga o que o sistema viu ao que aconteceu depois.
 * Uma linha por operação encerrada — é a matéria-prima da análise de acerto
 * por indicador.
 */
export interface DecisionRecord {
  id: string;
  tradeId: string;
  setupId: string;
  symbol: string;
  mode: TradingMode;
  /** direção e modalidade da operação; ausentes em registro anterior a futuros */
  side?: Side;
  market?: MarketKind;
  setupType: SetupType;
  timeframe: Timeframe;
  anchorTimeframe: Timeframe;
  score: number;
  classification: SetupClassification;
  riskReward: number;
  automatic: boolean;
  components: ScoreComponent[];
  penalties: ScoreComponent[];
  reasons: string[];
  evidence: SetupEvidence;
  btcContext: BtcContextState;
  extended: boolean;
  entryPrice: number;
  stopLoss: number;
  target1: number;
  outcome: TradeOutcome;
  realizedPnl: number;
  realizedPnlPercent: number;
  maxFavorablePercent: number;
  maxAdversePercent: number;
  durationMinutes: number;
  openedAt: string;
  closedAt: string;
  /** por que deu certo ou errado, com números — pode faltar em registro antigo */
  postMortem?: PostMortem;
}

/** Uma linha da curva de patrimônio. */
export interface EquityPoint {
  time: string;
  equity: number;
  realizedPnl: number;
  tradeId: string | null;
}

/** Acerto histórico de um fator do score ou de um indicador. */
export interface FactorPerformance {
  key: string;
  label: string;
  bucket: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  averagePnl: number;
}

export interface AlertRecord {
  id: string;
  setupId: string;
  symbol: string;
  score: number;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

export interface AuditEntry {
  id: string;
  action: string;
  mode: TradingMode;
  symbol: string | null;
  setupId: string | null;
  tradeId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type ConnectionState = 'LIVE' | 'RECONNECTING' | 'OFFLINE';

/** Linha do dashboard: um ativo da watchlist com tudo que a UI precisa. */
export interface AssetView {
  symbol: string;
  baseAsset: string;
  price: number | null;
  changePercent24h: number | null;
  volumeQuote24h: number | null;
  trend4h: TrendState;
  structure4h: MarketStructure;
  rsi1h: number | null;
  relativeVolume1h: number | null;
  bestSetupId: string | null;
  bestScore: number | null;
  setupType: SetupType | null;
  visualState: SetupVisualState | null;
  extended: boolean;
  dataAvailable: boolean;
  updatedAt: string | null;
}

/**
 * O robô de UMA modalidade.
 *
 * São dois, não um: o de spot e o de futuros vivem em baldes separados de
 * configuração e podem estar ligados em estados diferentes ao mesmo tempo. A
 * tela mostra as duas colunas lado a lado, e cada uma precisa do interruptor
 * do seu próprio robô — ligar o de futuros não pode mexer no de spot.
 */
export interface RobotState {
  enabled: boolean;
  /** por que ele não age na conta real; null quando age ou o modo não é LIVE */
  liveDenial: string | null;
}

export interface DashboardSnapshot {
  /** decisão do robô por setup, na sessão em exibição; vazio em modo degradado */
  decisions?: Record<string, EntryDecision>;
  mode: TradingMode;
  /** o interruptor de cada modalidade, na conta em exibição */
  robots: Record<MarketKind, RobotState>;
  /** modalidades que o painel opera agora — futuros só com o interruptor geral */
  markets: MarketKind[];
  connection: ConnectionState;
  marketContext: MarketContext | null;
  assets: AssetView[];
  setups: TradeSetup[];
  alerts: AlertRecord[];
  openTrades: Trade[];
  settings: AppSettings;
  serverTime: string;
  binanceAvailable: boolean;
  tradingCredentialsConfigured: boolean;
  /** cotação USDT→BRL para exibir valores em reais (null se indisponível) */
  brlRate: number | null;
  universe: {
    enabled: boolean;
    total: number;
    liquid: number;
    cursor: number;
    scannedThisCycle: number;
    lastCycleSeconds: number | null;
    lastError: string | null;
    updatedAt: string | null;
  };
  /** o que se sabe sobre os ativos fora do gráfico */
  news: {
    events: MarketEvent[];
    blockedSymbols: string[];
    lastRefreshAt: string | null;
    lastError: string | null;
  };
}
