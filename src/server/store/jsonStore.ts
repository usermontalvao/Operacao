import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AlertRecord,
  AuditEntry,
  DecisionRecord,
  EntryDecisionRecord,
  PersistedSettings,
  StoredSettings,
  Trade,
  TradeSetup,
} from '../../core/types.ts';
import { logger } from '../logger.ts';
import { LIMITS, type Repository } from './repository.ts';

interface Collections {
  /** pode estar no formato antigo até o SettingsService converter no boot */
  settings: PersistedSettings | null;
  setups: TradeSetup[];
  trades: Trade[];
  alerts: AlertRecord[];
  audit: AuditEntry[];
  decisions: DecisionRecord[];
  entryDecisions: EntryDecisionRecord[];
}

/**
 * Arquivo gravado antes de existirem direção e modalidade.
 *
 * Tudo o que está no disco de antes de futuros é compra em spot — mas o campo
 * simplesmente não está lá, e `undefined` não é `'BUY'`: a conta do resultado
 * multiplicaria por um sinal que não existe. Carimbar na leitura resolve num
 * lugar só, do jeito que a tabela do Supabase já fazia; o campo vira
 * definitivo na primeira regravação da linha.
 */
function comDirecao<T extends { side?: unknown; market?: unknown }>(registro: T): T {
  if (registro.side !== undefined && registro.market !== undefined) return registro;
  return { ...registro, side: registro.side ?? 'BUY', market: registro.market ?? 'SPOT' };
}

/**
 * Persistência local em arquivo. Escrita atômica (tmp + rename) e com atraso,
 * para não gravar o arquivo inteiro a cada tick de preço.
 */
export class JsonStore implements Repository {
  private readonly directory: string;
  private data: Collections = {
    settings: null,
    setups: [],
    trades: [],
    alerts: [],
    audit: [],
    decisions: [],
    entryDecisions: [],
  };
  private dirty = new Set<keyof Collections>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(directory: string) {
    this.directory = directory;
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    this.data.settings = await this.read<PersistedSettings | null>('settings', null);
    this.data.setups = (await this.read<TradeSetup[]>('setups', [])).map(comDirecao);
    this.data.trades = (await this.read<Trade[]>('trades', [])).map(comDirecao);
    this.data.alerts = await this.read<AlertRecord[]>('alerts', []);
    this.data.audit = await this.read<AuditEntry[]>('audit', []);
    this.data.decisions = await this.read<DecisionRecord[]>('decisions', []);
    this.data.entryDecisions = await this.read<EntryDecisionRecord[]>('entryDecisions', []);
  }

  async loadSettings(): Promise<PersistedSettings | null> {
    return this.data.settings;
  }

  async saveSettings(settings: StoredSettings): Promise<void> {
    this.data.settings = settings;
    this.markDirty('settings');
  }

  async listSetups(): Promise<TradeSetup[]> {
    return this.data.setups;
  }

  async saveSetup(setup: TradeSetup): Promise<void> {
    const index = this.data.setups.findIndex((item) => item.id === setup.id);
    if (index >= 0) this.data.setups[index] = setup;
    else this.data.setups.unshift(setup);
    if (this.data.setups.length > LIMITS.setups) this.data.setups.length = LIMITS.setups;
    this.markDirty('setups');
  }

  async listTrades(): Promise<Trade[]> {
    return this.data.trades;
  }

  async saveTrade(trade: Trade): Promise<void> {
    const index = this.data.trades.findIndex((item) => item.id === trade.id);
    if (index >= 0) this.data.trades[index] = trade;
    else this.data.trades.unshift(trade);
    if (this.data.trades.length > LIMITS.trades) this.data.trades.length = LIMITS.trades;
    this.markDirty('trades');
  }

  async listAlerts(): Promise<AlertRecord[]> {
    return this.data.alerts;
  }

  async saveAlert(alert: AlertRecord): Promise<void> {
    const index = this.data.alerts.findIndex((item) => item.id === alert.id);
    if (index >= 0) this.data.alerts[index] = alert;
    else this.data.alerts.unshift(alert);
    if (this.data.alerts.length > LIMITS.alerts) this.data.alerts.length = LIMITS.alerts;
    this.markDirty('alerts');
  }

  async saveDecision(decision: DecisionRecord): Promise<void> {
    const index = this.data.decisions.findIndex((item) => item.tradeId === decision.tradeId);
    if (index >= 0) this.data.decisions[index] = decision;
    else this.data.decisions.unshift(decision);
    if (this.data.decisions.length > LIMITS.decisions) this.data.decisions.length = LIMITS.decisions;
    this.markDirty('decisions');
  }

  async listDecisions(): Promise<DecisionRecord[]> {
    return this.data.decisions;
  }

  async saveEntryDecision(decision: EntryDecisionRecord): Promise<void> {
    // upsert pela assinatura: repetição atualiza a linha, não cria outra
    const index = this.data.entryDecisions.findIndex(
      (item) => item.fingerprint === decision.fingerprint,
    );
    if (index >= 0) this.data.entryDecisions[index] = decision;
    else this.data.entryDecisions.unshift(decision);
    if (this.data.entryDecisions.length > LIMITS.entryDecisions) {
      this.data.entryDecisions.length = LIMITS.entryDecisions;
    }
    this.markDirty('entryDecisions');
  }

  async listEntryDecisions(limit: number): Promise<EntryDecisionRecord[]> {
    return this.data.entryDecisions.slice(0, limit);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.data.audit.unshift(entry);
    if (this.data.audit.length > LIMITS.audit) this.data.audit.length = LIMITS.audit;
    this.markDirty('audit');
  }

  async listAudit(limit: number): Promise<AuditEntry[]> {
    return this.data.audit.slice(0, limit);
  }

  async flush(): Promise<void> {
    const pending = [...this.dirty];
    this.dirty.clear();
    await Promise.all(pending.map((key) => this.write(key, this.data[key])));
  }

  /** Sufixo único por gravação — ver o comentário em write(). */
  private writeCounter = 0;

  private markDirty(key: keyof Collections): void {
    this.dirty.add(key);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((error) => logger.error('Falha ao gravar dados locais', { error: String(error) }));
    }, 1500);
    this.flushTimer.unref?.();
  }

  private async read<T>(name: keyof Collections, fallback: T): Promise<T> {
    try {
      const raw = await readFile(join(this.directory, `${name}.json`), 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  /**
   * Gravação atômica: escreve ao lado e renomeia por cima.
   *
   * O nome do arquivo temporário precisa ser único. Com um nome fixo, duas
   * gravações da mesma coleção ao mesmo tempo disputam o mesmo `.tmp`: a
   * primeira renomeia, a segunda encontra o arquivo já movido e falha com
   * ENOENT — e o dado dela some sem ninguém perceber. Já aconteceu aqui com
   * `trades.json`, que é justamente onde mora o dinheiro.
   */
  private async write(name: keyof Collections, value: unknown): Promise<void> {
    const target = join(this.directory, `${name}.json`);
    this.writeCounter += 1;
    const temporary = `${target}.${process.pid}.${this.writeCounter}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
