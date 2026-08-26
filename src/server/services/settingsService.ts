import { z } from 'zod';
import type {
  AppSettings,
  MarketKind,
  ModeSettings,
  PersistedSettings,
  StoredSettings,
  TradingMode,
} from '../../core/types.ts';
import { DEFAULT_FUTURES_FEE_PERCENT } from '../../core/risk/costs.ts';
import { DEFAULT_GUARD } from '../../core/risk/governor.ts';
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

const scannerSchema = z.object({
  watchlist: z.array(z.string().regex(/^[A-Z0-9]{4,20}$/)).min(1).max(40),
  triggerTimeframes: z.array(z.enum(['15m', '1h', '4h', '1d'])).min(1),
  anchorTimeframe: z.enum(['15m', '1h', '4h', '1d']),
  setupTtlMinutes: z.number().int().min(15).max(10_080),
  cooldownMinutes: z.number().int().min(5).max(1440),
  universe: z.enum(['WATCHLIST', 'ALL_USDT']),
  minQuoteVolume24h: z.number().min(0).max(1_000_000_000),
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
  futures: futuresSchema.partial().optional(),
  risk: riskSchema.partial().optional(),
  scanner: scannerSchema.partial().optional(),
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
  'guard.minNetRiskReward': 'R/R líquido mínimo',
  'guard.maxConsecutiveLosses': 'Perdas seguidas até pausar',
  'guard.lossPauseMinutes': 'Duração da pausa (min)',
  'guard.maxDrawdownPercent': 'Queda máxima do topo (%)',
  'guard.maxDailyTrades': 'Operações por dia',
  'guard.maxTotalExposurePercent': 'Exposição total máxima (%)',
  'guard.maxAltExposurePercent': 'Exposição em altcoins (%)',
  'guard.lossCooldownMinutes': 'Descanso após perda (min)',
  'guard.trailingStopPercent': 'Stop que sobe (%)',
  'guard.maxTargetPercent': 'Alvo máximo aceito (%)',
  'guard.minQuoteVolume24h': 'Volume mínimo para operar',
  'scanner.watchlist': 'Watchlist',
  'scanner.setupTtlMinutes': 'Validade do setup (min)',
  'scanner.cooldownMinutes': 'Silêncio antes de recriar (min)',
  'scanner.minQuoteVolume24h': 'Volume mínimo do universo',
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
    market: config.market,
    scanner: {
      watchlist: config.watchlist,
      triggerTimeframes: ['1h', '4h'],
      anchorTimeframe: '1d',
      setupTtlMinutes: 720,
      cooldownMinutes: 120,
      universe: 'ALL_USDT',
      minQuoteVolume24h: 3_000_000,
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
  const bucket = stored.byMarket[stored.market][stored.mode];
  return {
    mode: stored.mode,
    market: stored.market,
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
export function normalizeStoredSettings(value: PersistedSettings): StoredSettings {
  const base = defaultStoredSettings();
  const scanner = { ...base.scanner, ...value.scanner };
  const mode = value.mode ?? base.mode;
  const updatedAt = value.updatedAt ?? base.updatedAt;

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
    const displayedMarket = patch.market ?? this.stored.market;
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
    // desligar o robô desarma a conta real junto: religar não pode herdar
    // um "armado" de antes, senão o robô voltaria já operando dinheiro real
    if (bucket.autoTrade.enabled === false || bucket.autoTrade.allowLive === false) {
      bucket.autoTrade.liveArmedUntil = null;
    }

    const next: StoredSettings = {
      mode: displayed,
      market: displayedMarket,
      scanner: { ...this.stored.scanner, ...patch.scanner },
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
