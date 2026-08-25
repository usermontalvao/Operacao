import { z } from 'zod';
import type {
  AppSettings,
  ModeSettings,
  PersistedSettings,
  StoredSettings,
  TradingMode,
} from '../../core/types.ts';
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

export const settingsUpdateSchema = z.object({
  mode: z.enum(['PAPER', 'TESTNET', 'LIVE']).optional(),
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
  'guard.maxConsecutiveLosses': 'Perdas seguidas até parar',
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

/**
 * Configurações de uma conta, já com a diferença que importa: em conta real o
 * robô nasce desligado e sem liberação. Antes o padrão era o mesmo para os
 * três modos — o robô nascia ligado inclusive no LIVE, e só as travas do
 * servidor seguravam. Uma trava a menos é uma trava a menos.
 */
export function defaultModeSettings(mode: TradingMode): ModeSettings {
  const live = mode === 'LIVE';
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
    guard: { ...DEFAULT_GUARD },
  };
}

export function defaultStoredSettings(): StoredSettings {
  return {
    mode: config.mode,
    scanner: {
      watchlist: config.watchlist,
      triggerTimeframes: ['1h', '4h'],
      anchorTimeframe: '1d',
      setupTtlMinutes: 720,
      cooldownMinutes: 120,
      universe: 'ALL_USDT',
      minQuoteVolume24h: 3_000_000,
    },
    byMode: {
      PAPER: defaultModeSettings('PAPER'),
      TESTNET: defaultModeSettings('TESTNET'),
      LIVE: defaultModeSettings('LIVE'),
    },
    updatedAt: new Date().toISOString(),
  };
}

/** Achata o modo pedido — é assim que o resto do sistema enxerga tudo. */
export function resolveSettings(stored: StoredSettings): AppSettings {
  const bucket = stored.byMode[stored.mode];
  return {
    mode: stored.mode,
    scanner: stored.scanner,
    risk: bucket.risk,
    autoTrade: bucket.autoTrade,
    guard: bucket.guard,
    updatedAt: stored.updatedAt,
  };
}

function isLegacy(value: PersistedSettings): value is Exclude<PersistedSettings, StoredSettings> {
  return !('byMode' in value) || value.byMode === undefined;
}

/**
 * Traz o que está no disco para o formato de hoje.
 *
 * O conjunto antigo era de todo mundo, mas quem o ajustou tinha um modo na
 * tela — é a esse modo que ele volta. Os outros começam do padrão em vez de
 * herdar números pensados para outra conta; herdar seria repetir, de outro
 * jeito, exatamente o problema que a separação existe para resolver.
 */
export function normalizeStoredSettings(value: PersistedSettings): StoredSettings {
  const base = defaultStoredSettings();
  if (!isLegacy(value)) {
    const byMode = { ...base.byMode };
    for (const mode of MODES) {
      const stored = value.byMode?.[mode];
      const fallback = base.byMode[mode];
      byMode[mode] = {
        risk: { ...fallback.risk, ...stored?.risk },
        autoTrade: { ...fallback.autoTrade, ...stored?.autoTrade },
        guard: { ...fallback.guard, ...stored?.guard },
      };
    }
    return {
      mode: value.mode ?? base.mode,
      scanner: { ...base.scanner, ...value.scanner },
      byMode,
      updatedAt: value.updatedAt ?? base.updatedAt,
    };
  }

  const mode = value.mode ?? base.mode;
  const byMode = { ...base.byMode };
  byMode[mode] = {
    risk: { ...base.byMode[mode].risk, ...value.risk },
    autoTrade: { ...base.byMode[mode].autoTrade, ...value.autoTrade },
    guard: { ...base.byMode[mode].guard, ...value.guard },
  };
  return {
    mode,
    scanner: { ...base.scanner, ...value.scanner },
    byMode,
    updatedAt: value.updatedAt ?? base.updatedAt,
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

  /** Configurações de um modo que não é o ativo — para a tela mostrar as três. */
  forMode(mode: TradingMode): ModeSettings {
    return this.stored.byMode[mode];
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
    options: { targetMode?: TradingMode } = {},
  ): Promise<AppSettings> {
    const displayed = patch.mode ?? this.stored.mode;
    const target = options.targetMode ?? displayed;
    const current = this.stored.byMode[target];
    const bucket: ModeSettings = {
      risk: { ...current.risk, ...patch.risk },
      autoTrade: { ...current.autoTrade, ...patch.autoTrade },
      guard: { ...current.guard, ...patch.guard },
    };
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
      scanner: { ...this.stored.scanner, ...patch.scanner },
      byMode: { ...this.stored.byMode, [target]: bucket },
      updatedAt: new Date().toISOString(),
    };
    this.stored = next;
    this.view = resolveSettings(next);
    await this.repository.saveSettings(next);
    return this.view;
  }
}
