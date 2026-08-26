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

export type Timeframe = '15m' | '1h' | '4h' | '1d';

export const TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h', '1d'];

/** Peso de cada timeframe na leitura de tendência. 4H e diário mandam. */
export const TIMEFRAME_WEIGHT: Record<Timeframe, number> = {
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

export type SetupType = 'PULLBACK' | 'BREAKOUT_RETEST' | 'SUPPORT_REVERSAL' | 'MOMENTUM_BURST';

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
  /** corta pares ilíquidos da varredura do universo (volume 24h em USDT) */
  minQuoteVolume24h: number;
  triggerTimeframes: Timeframe[];
  anchorTimeframe: Timeframe;
  /** minutos até um setup não acionado expirar */
  setupTtlMinutes: number;
  /** minutos de silêncio antes de recriar o mesmo setup */
  cooldownMinutes: number;
}

/**
 * Compra automática.
 *
 * Em PAPER e TESTNET o robô opera livre. Em conta real ele só age com duas
 * chaves giradas ao mesmo tempo: a variável ALLOW_LIVE_AUTOTRADE no servidor
 * e o armar explícito no painel, que expira sozinho. Uma trava só na interface
 * seria uma trava que um clique errado desfaz.
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
  /** teto absoluto em USDT por ordem automática, independente do percentual */
  maxNotionalPerTrade: number;
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
