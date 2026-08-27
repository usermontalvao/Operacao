import { z } from 'zod';
import type {
  AppSettings,
  MarketKind,
  MicroScalpSettings,
  ModeSettings,
  PersistedSettings,
  ScannerSettings,
  StoredSettings,
  TradingMode,
} from '../../core/types.ts';
import { DEFAULT_FUTURES_FEE_PERCENT } from '../../core/risk/costs.ts';
import { DEFAULT_GUARD } from '../../core/risk/governor.ts';
import { DEFAULT_MICRO_SCALP } from '../../core/scalp/config.ts';
import { config } from '../config.ts';
import type { Repository } from '../store/index.ts';

const riskSchema = z.object({
  paperCapital: z.number().positive().max(10_000_000),
  paperCapitalCurrency: z.enum(['USDT', 'BRL']),
  maxPositionPercent: z.number().min(1).max(100),
  riskPerTradePercent: z.number().min(0.1).max(20),
  maxOpenTrades: z.number().int().min(1).max(50),
  dailyLossLimitPercent: z.number().min(0.5).max(100),
  minimumRiskReward: z.number().min(1).max(10),
  minimumScoreToAlert: z.number().int().min(50).max(100),
  minimumScoreToShow: z.number().int().min(0).max(100),
});

/**
 * Micro scalp de 1 minuto.
 *
 * Cada limite aqui tem teto e piso por um motivo específico, não por
 * simetria com os outros campos — um módulo que opera dezenas de vezes por
 * hora amplifica qualquer número mal digitado.
 */
const microScalpSchema = z.object({
  enabled: z.boolean(),
  enforceFilters: z.boolean(),
  maxCandidates: z.number().int().min(5).max(200),
  maxUniverseSize: z.number().int().min(1).max(40),
  universeRefreshSeconds: z.number().int().min(60).max(3600),
  probeOrderUsd: z.number().min(5).max(100_000),
  filters: z.object({
    minQuoteVolume24h: z.number().min(0).max(1_000_000_000),
    minRecentQuoteVolume: z.number().min(0).max(1_000_000_000),
    maxSpreadPercent: z.number().min(0.001).max(2),
    minBookDepthUsd: z.number().min(0).max(10_000_000),
    maxSlippagePercent: z.number().min(0.001).max(2),
    /*
     * O piso de 0,02% não é preferência: com taxa de 0,05% por lado (futuros,
     * o mais barato que existe aqui), um ATR de 1m menor que isso não paga a
     * viagem por mais alto que seja o alvo. Deixar digitar 0 seria deixar
     * ligar um módulo que perde por construção.
     */
    minMicroAtrPercent: z.number().min(0.02).max(5),
    maxMicroAtrPercent: z.number().min(0.05).max(20),
    minScore: z.number().int().min(50).max(100),
  }),
  weights: z.object({
    liquidity: z.number().min(0).max(100),
    recentVolume: z.number().min(0).max(100),
    usableVolatility: z.number().min(0).max(100),
    bookDepth: z.number().min(0).max(100),
    spreadPenalty: z.number().min(0).max(100),
    slippagePenalty: z.number().min(0).max(100),
    costPenalty: z.number().min(0).max(100),
  }),
  regime: z.object({
    lookback: z.number().int().min(20).max(240),
    maxAdx: z.number().min(5).max(50),
    maxEmaDriftOfRange: z.number().min(0.05).max(1),
    maxEmaTravelOfRange: z.number().min(0.1).max(1),
    minTouchesPerSide: z.number().int().min(1).max(20),
    /*
     * Piso de 2: a faixa precisa valer pelo menos o dobro do custo. Com 1, a
     * ida e a volta inteiras pagariam exatamente a corretagem e o alvo — que
     * é uma fração da faixa — nasceria negativo.
     */
    minAmplitudeCostMultiple: z.number().min(2).max(20),
    maxVolatilityExpansion: z.number().min(1).max(10),
    entryZonePercent: z.number().min(5).max(45),
    /*
     * O guarda de oportunidade tem piso 1,5 e não 1. Em 1,0 o lucro esperado
     * apenas empata com o custo — e "empatar quando acerta" com um sistema
     * que erra parte das vezes é perder.
     */
    minCostMultiple: z.number().min(1.5).max(20),
  }),
  setupTtlMinutes: z.number().int().min(1).max(60),
  cooldownMinutes: z.number().int().min(1).max(240),
});

const scannerSchema = z.object({
  watchlist: z.array(z.string().regex(/^[A-Z0-9]{4,20}$/)).min(1).max(40),
  /*
   * '1m' NÃO entra em triggerTimeframes, e a ausência é a regra.
   *
   * Esses são os gatilhos dos detectores de tendência. O 1 minuto tem motor
   * próprio, com detector, regime e conta de custo próprios, e é ligado pelo
   * bloco microScalp abaixo. Aceitá-lo aqui deixaria rodar pullback e
   * rompimento em candle de 1m — exatamente a ideia que a medição reprovou.
   */
  /*
   * Pode ficar VAZIO — e isso é o que permite operar só 1 minuto.
   *
   * O mínimo de 1 fazia sentido quando o 1m não existia: sem gatilho nenhum, o
   * scanner não teria o que fazer. Com o micro scalp, "nenhum gatilho de
   * tendência" passou a ser uma configuração legítima, e não um engano.
   *
   * O que continua sendo engano é desligar os dois ao mesmo tempo. Isso não é
   * validado aqui porque depende de outro campo — a checagem cruzada mora em
   * `rejeicaoDeVarreduraVazia`, logo abaixo.
   */
  triggerTimeframes: z.array(z.enum(['15m', '1h', '4h', '1d'])),
  anchorTimeframe: z.enum(['15m', '1h', '4h', '1d']),
  setupTtlMinutes: z.number().int().min(15).max(10_080),
  cooldownMinutes: z.number().int().min(5).max(1440),
  universe: z.enum(['WATCHLIST', 'ALL_USDT']),
  minQuoteVolume24h: z.number().min(0).max(1_000_000_000),
  microScalp: microScalpSchema,
});

const autoTradeSchema = z.object({
  enabled: z.boolean(),
  minimumScore: z.number().int().min(90).max(100),
  minimumRiskReward: z.number().min(1).max(10),
  percentOfCapital: z.number().min(1).max(100),
  maxConcurrentTrades: z.number().int().min(1).max(20),
  cooldownMinutes: z.number().int().min(5).max(1440),
  requireInsideEntryZone: z.boolean(),
  allowLive: z.boolean(),
  liveArmedUntil: z.string().datetime().nullable(),
  liveArmedIndefinitely: z.boolean(),
  maxNotionalPerTrade: z.number().min(5).max(1_000_000),
});

/**
 * Disjuntor. Os limites têm teto no próprio schema: mesmo digitando à mão no
 * painel não dá para pedir "sem limite de perda" ou "taxa zero" — a conta
 * ficaria bonita na tela e errada no extrato.
 */
const guardSchema = z.object({
  feePercent: z.number().min(0).max(1),
  stopSlippagePercent: z.number().min(0).max(5),
  exitSlippagePercent: z.number().min(0).max(5),
  // margem curta e manual: 0 desliga; acima de 2% já seria perseguir movimento
  manualEntryTolerancePercent: z.number().min(0).max(2),
  maxConsecutiveLosses: z.number().int().min(1).max(20),
  // teto de 12h: a partir daí não é intervalo, é parar o dia
  lossPauseMinutes: z.number().int().min(5).max(720),
  maxDrawdownPercent: z.number().min(1).max(50),
  maxDailyTrades: z.number().int().min(1).max(100),
  maxTotalExposurePercent: z.number().min(5).max(100),
  maxAltExposurePercent: z.number().min(5).max(100),
  blockWhenBtcBearish: z.boolean(),
  highVolatilitySizeFactor: z.number().min(0.1).max(1),
  lossCooldownMinutes: z.number().int().min(0).max(1440),
  minLossesForCooldown: z.number().int().min(1).max(10),
  minNetRiskReward: z.number().min(1).max(10),
  minQuoteVolume24h: z.number().min(0).max(1_000_000_000),
  breakevenAfterTarget1: z.boolean(),
  trailingStopPercent: z.number().min(0).max(30),
  maxTargetPercent: z.number().min(5).max(300),
  manageLiveStops: z.boolean(),
  liveScaleOut: z.boolean(),
  partialFillGuardSeconds: z.coerce.number().min(15).max(600),
  timeStopHours: z.coerce.number().min(0).max(720),
  mutedUntil: z.string().datetime().nullable(),
});

/**
 * Ajustes de futuros. O teto de alavancagem tem limite no schema: 10x é o
 * máximo que o painel aceita digitar, mesmo que a corretora permita 125x.
 * Alavancagem alta não aumenta o lucro esperado — encurta a distância até a
 * liquidação, e a liquidação chega antes do stop.
 */
const futuresSchema = z.object({
  leverage: z.number().int().min(1).max(10),
  maxLeverage: z.number().int().min(1).max(10),
  marginMode: z.enum(['ISOLATED', 'CROSSED']),
  allowShort: z.boolean(),
  minLiquidationBufferPercent: z.number().min(0).max(50),
});

export const settingsUpdateSchema = z.object({
  mode: z.enum(['PAPER', 'TESTNET', 'LIVE']).optional(),
  market: z.enum(['SPOT', 'FUTURES']).optional(),
  futuresEnabled: z.boolean().optional(),
  futures: futuresSchema.partial().optional(),
  risk: riskSchema.partial().optional(),
  /*
   * `.partial()` só afrouxa o primeiro nível: mandar
   * `{ microScalp: { enabled: true } }` ainda exigiria filters, weights e
   * regime inteiros. O toggle da tela manda exatamente isso, então o bloco do
   * micro scalp é redeclarado em profundidade — e o merge preenche o resto.
   */
  scanner: scannerSchema
    .partial()
    .extend({
      microScalp: microScalpSchema
        .partial()
        .extend({
          filters: microScalpSchema.shape.filters.partial().optional(),
          weights: microScalpSchema.shape.weights.partial().optional(),
          regime: microScalpSchema.shape.regime.partial().optional(),
        })
        .optional(),
    })
    .optional(),
  autoTrade: autoTradeSchema.partial().optional(),
  guard: guardSchema.partial().optional(),
});

/**
 * Nome de cada campo como ele aparece na tela.
 *
 * O Zod devolve "Too small: expected number to be >=90" — em inglês, sem dizer
 * qual campo. O formulário do robô salva seis números de uma vez, então essa
 * frase deixa o usuário procurando às cegas qual deles recusou. O caminho do
 * erro já vem no `path`; o que faltava era traduzi-lo.
 */
const FIELD_LABELS: Record<string, string> = {
  'risk.paperCapital': 'Capital da carteira de teste',
  'risk.maxPositionPercent': 'Máximo por operação (%)',
  'risk.riskPerTradePercent': 'Risco por operação (%)',
  'risk.maxOpenTrades': 'Operações abertas ao mesmo tempo',
  'risk.dailyLossLimitPercent': 'Limite de perda diária (%)',
  'risk.minimumRiskReward': 'R/R mínimo',
  'risk.minimumScoreToAlert': 'Score mínimo para alertar',
  'risk.minimumScoreToShow': 'Score mínimo para exibir',
  'autoTrade.minimumScore': 'Score mínimo para comprar',
  'autoTrade.minimumRiskReward': 'R/R mínimo do robô',
  'autoTrade.percentOfCapital': 'Percentual do capital por compra',
  'autoTrade.maxConcurrentTrades': 'Posições automáticas simultâneas',
  'autoTrade.cooldownMinutes': 'Descanso por ativo (min)',
  'autoTrade.maxNotionalPerTrade': 'Teto por ordem (USDT)',
  'guard.feePercent': 'Taxa por lado (%)',
  'guard.stopSlippagePercent': 'Escorregamento do stop (%)',
  'guard.exitSlippagePercent': 'Escorregamento a mercado (%)',
  'guard.manualEntryTolerancePercent': 'Tolerância da entrada manual (%)',
  'guard.minNetRiskReward': 'R/R líquido mínimo',
  'guard.maxConsecutiveLosses': 'Perdas seguidas até pausar',
  'guard.lossPauseMinutes': 'Duração da pausa (min)',
  'guard.maxDrawdownPercent': 'Queda máxima do topo (%)',
  'guard.maxDailyTrades': 'Operações por dia',
  'guard.maxTotalExposurePercent': 'Exposição total máxima (%)',
  'guard.maxAltExposurePercent': 'Exposição em altcoins (%)',
  'guard.lossCooldownMinutes': 'Descanso após perda (min)',
  'guard.minLossesForCooldown': 'Perdas seguidas para o descanso armar',
  'guard.trailingStopPercent': 'Stop que sobe (%)',
  'guard.maxTargetPercent': 'Alvo máximo aceito (%)',
  'guard.minQuoteVolume24h': 'Volume mínimo para operar',
  'scanner.watchlist': 'Watchlist',
  'scanner.setupTtlMinutes': 'Validade do setup (min)',
  'scanner.cooldownMinutes': 'Silêncio antes de recriar (min)',
  'scanner.minQuoteVolume24h': 'Volume mínimo do universo',
  'scanner.microScalp.maxUniverseSize': 'Pares no universo de scalp',
  'scanner.microScalp.maxCandidates': 'Pares medidos por volta',
  'scanner.microScalp.universeRefreshSeconds': 'Remedir liquidez a cada (s)',
  'scanner.microScalp.probeOrderUsd': 'Ordem de referência para medir o book (USDT)',
  'scanner.microScalp.setupTtlMinutes': 'Validade do sinal de 1m (min)',
  'scanner.microScalp.cooldownMinutes': 'Silêncio antes de repetir a tese de 1m (min)',
  'scanner.microScalp.filters.minQuoteVolume24h': 'Volume mínimo em 24h (scalp)',
  'scanner.microScalp.filters.minRecentQuoteVolume': 'Volume mínimo nos últimos 15 min',
  'scanner.microScalp.filters.maxSpreadPercent': 'Spread máximo (%)',
  'scanner.microScalp.filters.minBookDepthUsd': 'Profundidade mínima do book (USDT)',
  'scanner.microScalp.filters.maxSlippagePercent': 'Escorregamento máximo (%)',
  'scanner.microScalp.filters.minMicroAtrPercent': 'Amplitude mínima em 1m (%)',
  'scanner.microScalp.filters.maxMicroAtrPercent': 'Amplitude máxima em 1m (%)',
  'scanner.microScalp.filters.minScore': 'Nota mínima de scalpabilidade',
  'scanner.microScalp.regime.maxAdx': 'ADX máximo para considerar lateral',
  'scanner.microScalp.regime.maxEmaDriftOfRange': 'Deriva máxima do eixo (fração da faixa)',
  'scanner.microScalp.regime.maxEmaTravelOfRange': 'Quanto o eixo pode atravessar a faixa',
  'scanner.microScalp.regime.lookback': 'Barras de 1m que formam a faixa',
  'scanner.microScalp.regime.minCostMultiple': 'Quantas vezes o alvo paga o custo',
  'scanner.microScalp.regime.minAmplitudeCostMultiple': 'Amplitude mínima da faixa (x custo)',
  'scanner.microScalp.regime.entryZonePercent': 'Zona de entrada na borda (%)',
  'futures.leverage': 'Alavancagem',
  'futures.maxLeverage': 'Teto de alavancagem',
  'futures.minLiquidationBufferPercent': 'Folga mínima até a liquidação (%)',
};

/**
 * Limites que não são preferência, e sim resultado de medição. Quando um
 * destes recusa, dizer só "o mínimo é 90" convida a pensar que é um número
 * arbitrário que alguém escolheu — e o passo seguinte é querer baixá-lo.
 */
const FIELD_RATIONALE: Record<string, string> = {
  'scanner.microScalp.filters.minMicroAtrPercent':
    'O piso vem da aritmética, não de gosto: com a taxa desta conta, um par que anda menos que isso por barra não gera alvo capaz de pagar a ida e a volta — a operação nasceria no prejuízo mesmo acertando.',
  'scanner.microScalp.regime.minCostMultiple':
    'Em 1,0 o lucro esperado apenas empata com o custo. Como o sistema erra parte das vezes, empatar quando acerta significa perder no agregado.',
  'autoTrade.minimumScore':
    'O piso de 90 vem do laboratório: abaixo dele a estratégia automática não manteve expectativa positiva fora da amostra. Para operar sinais de score menor, use a compra manual.',
};

/** Traduz o primeiro problema de validação para uma frase que diz o que fazer. */
export function describeSettingsIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'Dados inválidos';

  const path = issue.path.join('.');
  const label = FIELD_LABELS[path] ?? path;
  const rationale = FIELD_RATIONALE[path];

  let frase: string;
  if (issue.code === 'too_small') {
    const minimum = (issue as { minimum?: unknown }).minimum;
    frase = `${label}: o menor valor aceito é ${String(minimum)}`;
  } else if (issue.code === 'too_big') {
    const maximum = (issue as { maximum?: unknown }).maximum;
    frase = `${label}: o maior valor aceito é ${String(maximum)}`;
  } else if (issue.code === 'invalid_type') {
    frase = `${label}: informe um número válido`;
  } else {
    frase = `${label}: ${issue.message}`;
  }

  return rationale ? `${frase}. ${rationale}` : frase;
}

/**
 * A única combinação que não pode existir: nada sendo varrido.
 *
 * Cada um dos dois lados pode ser desligado sozinho — só tendência, ou só
 * micro scalp. Os dois juntos deixam o painel de pé, conectado, com preço
 * atualizando e sem NENHUM detector rodando: uma tela que parece viva e não
 * procura mais nada. Quem quer pausar tudo tem o disjuntor e o interruptor do
 * robô; apagar os dois gatilhos por engano não pode ser um caminho silencioso
 * para o mesmo lugar.
 *
 * Fica fora do schema do Zod porque depende de dois campos ao mesmo tempo, e
 * um deles pode não vir no PUT — a checagem precisa ver o estado FINAL.
 */
export function rejeicaoDeVarreduraVazia(scanner: ScannerSettings): string | null {
  if (scanner.triggerTimeframes.length > 0) return null;
  if (scanner.microScalp.enabled) return null;
  return (
    'Sem nenhum timeframe ligado o radar para de procurar oportunidades. ' +
    'Deixe pelo menos um gatilho de tendência (15m, 1h, 4h ou 1d) OU ligue o micro scalp de 1 minuto.'
  );
}

const MODES: readonly TradingMode[] = ['PAPER', 'TESTNET', 'LIVE'];
const MARKETS: readonly MarketKind[] = ['SPOT', 'FUTURES'];

/**
 * Configurações de uma conta, já com a diferença que importa: em conta real o
 * robô nasce desligado e sem liberação. Antes o padrão era o mesmo para os
 * três modos — o robô nascia ligado inclusive no LIVE, e só as travas do
 * servidor seguravam. Uma trava a menos é uma trava a menos.
 */
export function defaultModeSettings(mode: TradingMode, market: MarketKind = 'SPOT'): ModeSettings {
  const live = mode === 'LIVE';
  const futuresMarket = market === 'FUTURES';
  return {
    risk: {
      // o usuário pensa em reais; o motor converte para USDT pelo par USDTBRL
      paperCapital: 5000,
      paperCapitalCurrency: 'BRL',
      maxPositionPercent: 25,
      riskPerTradePercent: 1,
      maxOpenTrades: 3,
      dailyLossLimitPercent: 5,
      minimumRiskReward: 2,
      minimumScoreToAlert: 75,
      minimumScoreToShow: 60,
    },
    autoTrade: {
      // ligado nas contas de teste: ali o robô é a forma de acumular decisões
      // reais para análise. Na conta real ele nasce desarmado.
      enabled: !live,
      minimumScore: 90,
      minimumRiskReward: 2.5,
      percentOfCapital: 10,
      // explosões em altcoins costumam vir juntas; até existir backtest de
      // carteira/correlação, uma posição automática por vez evita contar o
      // mesmo risco de mercado como se fossem apostas independentes.
      maxConcurrentTrades: 1,
      cooldownMinutes: 180,
      requireInsideEntryZone: true,
      allowLive: false,
      liveArmedUntil: null,
      liveArmedIndefinitely: false,
      maxNotionalPerTrade: 50,
    },
    guard: {
      ...DEFAULT_GUARD,
      // futuros cobra taxa de contrato, não de spot; usar a do spot faria o
      // R/R líquido recusar operação que na prática paga menos
      feePercent: futuresMarket ? DEFAULT_FUTURES_FEE_PERCENT : DEFAULT_GUARD.feePercent,
    },
    futures: {
      leverage: 3,
      maxLeverage: 10,
      marginMode: 'ISOLATED',
      // a venda a descoberto nasce ligada nas contas de teste e DESARMADA na
      // conta real: o lado vendido nunca passou pelo laboratório, então em
      // dinheiro de verdade ele começa como decisão consciente
      allowShort: futuresMarket && !live,
      minLiquidationBufferPercent: 1.5,
    },
  };
}

function defaultBuckets(market: MarketKind): Record<TradingMode, ModeSettings> {
  return {
    PAPER: defaultModeSettings('PAPER', market),
    TESTNET: defaultModeSettings('TESTNET', market),
    LIVE: defaultModeSettings('LIVE', market),
  };
}

export function defaultStoredSettings(): StoredSettings {
  return {
    mode: config.mode,
    // futuros barrado até alguém liberar: quem só quer spot nunca esbarra
    // numa tela de alavancagem, e quem quer futuros gira UM interruptor
    market: config.futuresEnabled ? config.market : 'SPOT',
    futuresEnabled: config.futuresEnabled,
    scanner: {
      watchlist: config.watchlist,
      triggerTimeframes: ['1h', '4h'],
      anchorTimeframe: '1d',
      setupTtlMinutes: 720,
      cooldownMinutes: 120,
      universe: 'ALL_USDT',
      // mantido no formato persistido por compatibilidade; a cobertura ALL_USDT
      // não corta mais pares por volume. A trava para operar fica no guard.
      minQuoteVolume24h: 0,
      // nasce DESLIGADO: nenhuma atualização de versão liga um módulo que opera
      microScalp: DEFAULT_MICRO_SCALP,
    },
    byMarket: {
      SPOT: defaultBuckets('SPOT'),
      FUTURES: defaultBuckets('FUTURES'),
    },
    updatedAt: new Date().toISOString(),
  };
}

/** Achata a modalidade e o modo pedidos — é assim que o resto do sistema enxerga tudo. */
export function resolveSettings(stored: StoredSettings): AppSettings {
  // com o interruptor desligado a modalidade ativa é spot, aconteça o que
  // acontecer com o que está gravado: é o que faz o barramento valer também
  // para um arquivo antigo que ficou parado em FUTURES
  const market = stored.futuresEnabled ? stored.market : 'SPOT';
  const bucket = stored.byMarket[market][stored.mode];
  return {
    mode: stored.mode,
    market,
    futuresEnabled: stored.futuresEnabled,
    scanner: stored.scanner,
    risk: bucket.risk,
    autoTrade: bucket.autoTrade,
    guard: bucket.guard,
    futures: bucket.futures,
    updatedAt: stored.updatedAt,
  };
}

function hasMarketBuckets(value: PersistedSettings): value is StoredSettings {
  return 'byMarket' in value && value.byMarket !== undefined;
}

function hasModeBuckets(
  value: PersistedSettings,
): value is Extract<PersistedSettings, { byMode: unknown }> {
  return 'byMode' in value && value.byMode !== undefined;
}

/**
 * Traz o que está no disco para o formato de hoje.
 *
 * São três gerações de arquivo: o conjunto único de todas as contas, o
 * conjunto por conta (`byMode`) e o atual, por modalidade e conta
 * (`byMarket`). As duas primeiras viram SPOT — que era a única modalidade que
 * existia quando foram gravadas — e futuros começa do padrão. Herdar em
 * futuros os números pensados para spot seria dar a uma posição alavancada os
 * limites de uma posição à vista.
 */
/**
 * Funde o bloco do micro scalp preservando o que não foi enviado.
 *
 * O espalhamento raso (`{...base, ...patch}`) não serve aqui porque
 * `microScalp` tem três objetos aninhados. Girar o interruptor manda
 * `{ enabled: true }` — e o espalhamento raso apagaria filters, weights e
 * regime inteiros, deixando o módulo ligado e sem nenhum limite. É também o
 * que traz uma configuração gravada antes deste módulo existir para o formato
 * de hoje, sem precisar de migração de arquivo.
 */
export function mergeMicroScalp(
  base: MicroScalpSettings,
  patch: DeepPartial<MicroScalpSettings> | undefined,
): MicroScalpSettings {
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    filters: { ...base.filters, ...patch.filters },
    weights: { ...base.weights, ...patch.weights },
    regime: { ...base.regime, ...patch.regime },
  } as MicroScalpSettings;
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K];
};

export function normalizeStoredSettings(value: PersistedSettings): StoredSettings {
  const base = defaultStoredSettings();
  const scanner: ScannerSettings = {
    ...base.scanner,
    ...value.scanner,
    // arquivo gravado antes do micro scalp não tem o bloco: recebe o padrão,
    // que é DESLIGADO — atualizar de versão nunca liga um módulo que opera
    microScalp: mergeMicroScalp(base.scanner.microScalp, value.scanner?.microScalp),
  };
  const mode = value.mode ?? base.mode;
  const updatedAt = value.updatedAt ?? base.updatedAt;
  /*
   * Arquivo gravado antes do interruptor.
   *
   * Ele não tem o campo — e "não tem" não pode virar "barrado" para quem já
   * estava em futuros: o painel voltaria sozinho para spot e a pessoa acharia
   * que a modalidade sumiu. Quem estava lá continua liberado; quem estava em
   * spot recebe barrado, que é o padrão novo.
   */
  const futuresEnabled =
    (value as Partial<StoredSettings>).futuresEnabled ??
    ((value as Partial<StoredSettings>).market === 'FUTURES' || base.futuresEnabled);

  const merge = (
    market: MarketKind,
    stored: Partial<Record<TradingMode, Partial<ModeSettings>>> | undefined,
  ): Record<TradingMode, ModeSettings> => {
    const result = { ...base.byMarket[market] };
    for (const each of MODES) {
      const fallback = base.byMarket[market][each];
      const saved = stored?.[each];
      result[each] = {
        risk: { ...fallback.risk, ...saved?.risk },
        autoTrade: { ...fallback.autoTrade, ...saved?.autoTrade },
        guard: { ...fallback.guard, ...saved?.guard },
        futures: { ...fallback.futures, ...saved?.futures },
      };
    }
    return result;
  };

  if (hasMarketBuckets(value)) {
    const byMarket = { ...base.byMarket };
    for (const market of MARKETS) byMarket[market] = merge(market, value.byMarket?.[market]);
    return {
      mode,
      market: value.market ?? base.market,
      futuresEnabled,
      scanner,
      byMarket,
      updatedAt,
    };
  }

  if (hasModeBuckets(value)) {
    return {
      mode,
      // arquivo sem modalidade é arquivo de antes dos futuros: era spot
      market: 'SPOT',
      futuresEnabled,
      scanner,
      byMarket: { SPOT: merge('SPOT', value.byMode), FUTURES: merge('FUTURES', undefined) },
      updatedAt,
    };
  }

  // formato mais antigo: um conjunto só, que volta para o modo que estava na tela
  const legacy = value as Extract<PersistedSettings, { risk: unknown }>;
  const spot = merge('SPOT', {
    [mode]: { risk: legacy.risk, autoTrade: legacy.autoTrade, guard: legacy.guard },
  });
  return {
    mode,
    market: 'SPOT',
    futuresEnabled,
    scanner,
    byMarket: { SPOT: spot, FUTURES: merge('FUTURES', undefined) },
    updatedAt,
  };
}

/** Guarda as configurações em memória e persiste cada alteração. */
export class SettingsService {
  private stored: StoredSettings = defaultStoredSettings();
  /** visão achatada do modo ativo, recalculada a cada gravação */
  private view: AppSettings = resolveSettings(this.stored);
  private readonly repository: Repository;
  /** true quando não havia nada salvo — permite semear a watchlist curada */
  firstRun = false;

  constructor(repository: Repository) {
    this.repository = repository;
  }

  async load(): Promise<AppSettings> {
    const persisted = await this.repository.loadSettings();
    if (persisted) {
      this.stored = normalizeStoredSettings(persisted);
      this.view = resolveSettings(this.stored);
      // grava de volta já no formato novo: assim a conversão do formato antigo
      // acontece uma vez só, e não a cada boot
      await this.repository.saveSettings(this.stored);
    } else {
      this.firstRun = true;
      await this.repository.saveSettings(this.stored);
    }
    return this.view;
  }

  get(): AppSettings {
    return this.view;
  }

  /**
   * A visão achatada de OUTRA modalidade, sem trocar a que está em exibição.
   *
   * O radar varre spot e futuros ao mesmo tempo — são duas colunas na tela, e
   * cada uma tem o seu robô. Para isso o motor precisa das configurações da
   * modalidade que está gerando a tese, não da que está selecionada.
   */
  viewFor(market: MarketKind, mode: TradingMode = this.stored.mode): AppSettings {
    return {
      ...this.view,
      mode,
      market,
      ...this.stored.byMarket[market][mode],
    };
  }

  /**
   * As modalidades que o painel opera AGORA.
   *
   * Spot sempre; futuros só com o interruptor geral ligado. É esta lista que
   * decide quantas colunas o radar produz — e barrar futuros faz a coluna
   * inteira desaparecer, junto com as teses que só existiam nela.
   */
  activeMarkets(): MarketKind[] {
    return this.stored.futuresEnabled ? ['SPOT', 'FUTURES'] : ['SPOT'];
  }

  /**
   * Configurações de um modo que não é o ativo — para a tela mostrar as três.
   * Sem modalidade informada vale a que está em exibição: quem pergunta pelo
   * robô do demo quer o robô do demo DA modalidade aberta, não o do spot.
   */
  forMode(mode: TradingMode, market: MarketKind = this.stored.market): ModeSettings {
    return this.stored.byMarket[market][mode];
  }

  /** As três contas da modalidade pedida — é o que a tela de ajustes desenha. */
  buckets(market: MarketKind = this.stored.market): Record<TradingMode, ModeSettings> {
    return this.stored.byMarket[market];
  }

  all(): StoredSettings {
    return this.stored;
  }

  /**
   * Aplica o ajuste.
   *
   * Duas coisas diferentes que costumavam ser a mesma: `patch.mode` troca a
   * janela EM EXIBIÇÃO; `options.targetMode` escolhe de qual SESSÃO são os
   * ajustes. Ligar o robô do demo enquanto se olha a conta real precisa das
   * duas separadas — senão o clique no distintivo trocaria a tela junto.
   */
  async update(
    patch: z.infer<typeof settingsUpdateSchema>,
    options: { targetMode?: TradingMode; targetMarket?: MarketKind } = {},
  ): Promise<AppSettings> {
    const displayed = patch.mode ?? this.stored.mode;
    const futuresEnabled = patch.futuresEnabled ?? this.stored.futuresEnabled;
    /*
     * Barrar futuros também TIRA de futuros.
     *
     * Deixar o interruptor desligado com a tela em FUTURES seria o pior dos
     * dois mundos: a modalidade barrada continuaria sendo a ativa, e o
     * usuário veria uma tela alavancada que nenhuma ordem obedece. O
     * `resolveSettings` já protege a leitura; aqui o que está gravado também
     * volta para spot, senão o arquivo guardaria um estado impossível.
     */
    const pedido = patch.market ?? this.stored.market;
    const displayedMarket: MarketKind = futuresEnabled ? pedido : 'SPOT';
    const target = options.targetMode ?? displayed;
    const targetMarket = options.targetMarket ?? displayedMarket;
    const current = this.stored.byMarket[targetMarket][target];
    const bucket: ModeSettings = {
      risk: { ...current.risk, ...patch.risk },
      autoTrade: { ...current.autoTrade, ...patch.autoTrade },
      guard: { ...current.guard, ...patch.guard },
      futures: { ...current.futures, ...patch.futures },
    };
    // alavancagem nunca passa do teto configurado, mesmo que o pedido venha
    // com os dois campos de uma vez e em ordem inconveniente
    if (bucket.futures.leverage > bucket.futures.maxLeverage) {
      bucket.futures.leverage = bucket.futures.maxLeverage;
    }
    if (bucket.risk.minimumScoreToShow > bucket.risk.minimumScoreToAlert) {
      bucket.risk.minimumScoreToShow = bucket.risk.minimumScoreToAlert;
    }
    // Armamento com prazo e sem prazo são estados mutuamente exclusivos.
    if (patch.autoTrade?.liveArmedIndefinitely === true) {
      bucket.autoTrade.liveArmedUntil = null;
    } else if (patch.autoTrade?.liveArmedUntil) {
      bucket.autoTrade.liveArmedIndefinitely = false;
    }
    // desligar o robô desarma a conta real junto: religar não pode herdar
    // um "armado" de antes, senão o robô voltaria já operando dinheiro real
    if (bucket.autoTrade.enabled === false || bucket.autoTrade.allowLive === false) {
      bucket.autoTrade.liveArmedUntil = null;
      bucket.autoTrade.liveArmedIndefinitely = false;
    }

    const next: StoredSettings = {
      mode: displayed,
      market: displayedMarket,
      futuresEnabled,
      scanner: {
        ...this.stored.scanner,
        ...patch.scanner,
        microScalp: mergeMicroScalp(
          this.stored.scanner.microScalp ?? DEFAULT_MICRO_SCALP,
          patch.scanner?.microScalp,
        ),
      },
      byMarket: {
        ...this.stored.byMarket,
        [targetMarket]: { ...this.stored.byMarket[targetMarket], [target]: bucket },
      },
      updatedAt: new Date().toISOString(),
    };
    this.stored = next;
    this.view = resolveSettings(next);
    await this.repository.saveSettings(next);
    return this.view;
  }
}
