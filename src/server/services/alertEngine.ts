import { randomUUID } from 'node:crypto';
import type { AlertRecord, AppSettings, TradeSetup } from '../../core/types.ts';
import type { EventBus } from '../events.ts';
import { logger } from '../logger.ts';
import type { Repository } from '../store/index.ts';

/**
 * Só vira alerta o que merece interromper o usuário: score acima do corte,
 * setup não esticado e nada repetido do mesmo nível dentro do cooldown.
 * Alerta demais é o mesmo que alerta nenhum.
 */
export class AlertEngine {
  private readonly repository: Repository;
  private readonly bus: EventBus;
  private readonly lastAlertByFingerprint = new Map<string, number>();

  constructor(repository: Repository, bus: EventBus) {
    this.repository = repository;
    this.bus = bus;
  }

  shouldAlert(setup: TradeSetup, settings: AppSettings): boolean {
    if (setup.score < settings.risk.minimumScoreToAlert) return false;
    if (setup.extended) return false;
    if (setup.status === 'INVALIDATED' || setup.status === 'EXPIRED') return false;
    const last = this.lastAlertByFingerprint.get(setup.fingerprint);
    if (last && Date.now() - last < settings.scanner.cooldownMinutes * 60_000) return false;
    return true;
  }

  async emit(setup: TradeSetup, settings: AppSettings): Promise<AlertRecord | null> {
    if (!this.shouldAlert(setup, settings)) return null;
    this.lastAlertByFingerprint.set(setup.fingerprint, Date.now());

    const alert: AlertRecord = {
      id: randomUUID(),
      setupId: setup.id,
      symbol: setup.symbol,
      score: setup.score,
      title: `${setup.symbol} — ${labelForType(setup.setupType)}`,
      body: buildBody(setup),
      createdAt: new Date().toISOString(),
      readAt: null,
    };

    try {
      await this.repository.saveAlert(alert);
    } catch (error) {
      logger.error('Falha ao gravar alerta', { error: (error as Error).message });
    }
    this.bus.broadcast({ type: 'alert', payload: alert });
    return alert;
  }
}

function labelForType(type: TradeSetup['setupType']): string {
  if (type === 'PULLBACK') return 'Pullback em tendência';
  if (type === 'BREAKOUT_RETEST') return 'Rompimento com reteste';
  return 'Reversão em suporte';
}

function buildBody(setup: TradeSetup): string {
  const lines = [
    `Entrada ${format(setup.entryLow)}–${format(setup.entryHigh)}`,
    `Invalidação ${format(setup.stopLoss)}`,
    `Alvo 1 ${format(setup.target1)} · R/R 1:${setup.riskReward.toFixed(1)}`,
    `Score ${setup.score}/100 · ${setup.timeframe}`,
  ];
  return lines.join(' · ');
}

function format(value: number): string {
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toPrecision(4);
}
