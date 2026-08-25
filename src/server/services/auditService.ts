import { randomUUID } from 'node:crypto';
import type { AuditEntry, TradingMode } from '../../core/types.ts';
import { logger, redact } from '../logger.ts';
import type { Repository } from '../store/index.ts';

export interface AuditInput {
  action: string;
  mode: TradingMode;
  symbol?: string | null;
  setupId?: string | null;
  tradeId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Trilha de auditoria de tudo que muda estado. O `redact` garante que nem por
 * acidente uma chave de API entre no registro.
 */
export class AuditService {
  private readonly repository: Repository;

  constructor(repository: Repository) {
    this.repository = repository;
  }

  async record(input: AuditInput): Promise<AuditEntry> {
    const entry: AuditEntry = {
      id: randomUUID(),
      action: input.action,
      mode: input.mode,
      symbol: input.symbol ?? null,
      setupId: input.setupId ?? null,
      tradeId: input.tradeId ?? null,
      detail: (redact(input.detail ?? {}) as Record<string, unknown>) ?? {},
      createdAt: new Date().toISOString(),
    };
    try {
      await this.repository.appendAudit(entry);
    } catch (error) {
      logger.error('Falha ao gravar auditoria', { error: (error as Error).message });
    }
    return entry;
  }

  list(limit = 200): Promise<AuditEntry[]> {
    return this.repository.listAudit(limit);
  }
}
