import { z } from 'zod';
import type { AppSettings } from '../../core/types.ts';
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
  minimumScore: z.number().int().min(60).max(100),
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

export function defaultSettings(): AppSettings {
  return {
    mode: config.mode,
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
    scanner: {
      watchlist: config.watchlist,
      triggerTimeframes: ['1h', '4h'],
      anchorTimeframe: '1d',
      setupTtlMinutes: 720,
      cooldownMinutes: 120,
      universe: 'ALL_USDT',
      minQuoteVolume24h: 3_000_000,
    },
    autoTrade: {
      // ligado por padrão: nas contas de teste o robô é a forma de acumular
      // decisões reais para análise. Na conta real ele nasce desarmado.
      enabled: true,
      minimumScore: 80,
      minimumRiskReward: 2.5,
      percentOfCapital: 10,
      maxConcurrentTrades: 3,
      cooldownMinutes: 180,
      requireInsideEntryZone: true,
      allowLive: false,
      liveArmedUntil: null,
      maxNotionalPerTrade: 50,
    },
    guard: { ...DEFAULT_GUARD },
    updatedAt: new Date().toISOString(),
  };
}

/** Guarda as configurações em memória e persiste cada alteração. */
export class SettingsService {
  private settings: AppSettings = defaultSettings();
  private readonly repository: Repository;
  /** true quando não havia nada salvo — permite semear a watchlist curada */
  firstRun = false;

  constructor(repository: Repository) {
    this.repository = repository;
  }

  async load(): Promise<AppSettings> {
    const stored = await this.repository.loadSettings();
    if (stored) {
      const base = defaultSettings();
      this.settings = {
        mode: stored.mode,
        risk: { ...base.risk, ...stored.risk },
        scanner: { ...base.scanner, ...stored.scanner },
        autoTrade: { ...base.autoTrade, ...stored.autoTrade },
        guard: { ...base.guard, ...stored.guard },
        updatedAt: stored.updatedAt,
      };
    } else {
      this.firstRun = true;
      await this.repository.saveSettings(this.settings);
    }
    return this.settings;
  }

  get(): AppSettings {
    return this.settings;
  }

  async update(patch: z.infer<typeof settingsUpdateSchema>): Promise<AppSettings> {
    const next: AppSettings = {
      mode: patch.mode ?? this.settings.mode,
      risk: { ...this.settings.risk, ...patch.risk },
      scanner: { ...this.settings.scanner, ...patch.scanner },
      autoTrade: { ...this.settings.autoTrade, ...patch.autoTrade },
      guard: { ...this.settings.guard, ...patch.guard },
      updatedAt: new Date().toISOString(),
    };
    if (next.risk.minimumScoreToShow > next.risk.minimumScoreToAlert) {
      next.risk.minimumScoreToShow = next.risk.minimumScoreToAlert;
    }
    // desligar o robô desarma a conta real junto: religar não pode herdar
    // um "armado" de antes, senão o robô voltaria já operando dinheiro real
    if (next.autoTrade.enabled === false || next.autoTrade.allowLive === false) {
      next.autoTrade.liveArmedUntil = null;
    }
    // trocar de modo apaga o reconhecimento do disjuntor do modo anterior
    if (next.mode !== this.settings.mode) next.guard.mutedUntil = null;
    this.settings = next;
    await this.repository.saveSettings(next);
    return next;
  }
}
