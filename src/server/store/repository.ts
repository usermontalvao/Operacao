import type {
  AlertRecord,
  PersistedSettings,
  StoredSettings,
  AuditEntry,
  DecisionRecord,
  EntryDecisionRecord,
  Trade,
  TradeSetup,
} from '../../core/types.ts';

/**
 * Contrato de persistência. O motor não sabe se por trás tem arquivo JSON
 * (padrão, roda sem infraestrutura) ou Postgres/Supabase.
 */
export interface Repository {
  init(): Promise<void>;
  loadSettings(): Promise<PersistedSettings | null>;
  saveSettings(settings: StoredSettings): Promise<void>;
  listSetups(): Promise<TradeSetup[]>;
  saveSetup(setup: TradeSetup): Promise<void>;
  listTrades(): Promise<Trade[]>;
  saveTrade(trade: Trade): Promise<void>;
  listAlerts(): Promise<AlertRecord[]>;
  saveAlert(alert: AlertRecord): Promise<void>;
  saveDecision(decision: DecisionRecord): Promise<void>;
  listDecisions(): Promise<DecisionRecord[]>;
  /**
   * Grava a decisão de entrada. Upsert por fingerprint: a mesma situação
   * repetida atualiza a linha existente em vez de criar outra.
   */
  saveEntryDecision(decision: EntryDecisionRecord): Promise<void>;
  listEntryDecisions(limit: number): Promise<EntryDecisionRecord[]>;
  appendAudit(entry: AuditEntry): Promise<void>;
  listAudit(limit: number): Promise<AuditEntry[]>;
}

export const LIMITS = {
  setups: 600,
  trades: 500,
  alerts: 200,
  audit: 2000,
  decisions: 1000,
  entryDecisions: 1500,
};
