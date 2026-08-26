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
  /** entradas esperando gravação, na ordem em que aconteceram */
  private readonly fila: AuditEntry[] = [];
  private drenando: Promise<void> | null = null;

  constructor(repository: Repository) {
    this.repository = repository;
  }

  private montar(input: AuditInput): AuditEntry {
    return {
      id: randomUUID(),
      action: input.action,
      mode: input.mode,
      symbol: input.symbol ?? null,
      setupId: input.setupId ?? null,
      tradeId: input.tradeId ?? null,
      detail: (redact(input.detail ?? {}) as Record<string, unknown>) ?? {},
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Registro que NÃO faz ninguém esperar.
   *
   * Cada gravação custa ~283 ms no Supabase, e o caminho de uma ordem fazia
   * três ou quatro delas em sequência — mais de um segundo de espera para
   * escrever histórico, com a ordem já aceita pela corretora do outro lado.
   *
   * A entrada entra numa fila que drena em ordem, então o histórico continua
   * na sequência em que os fatos aconteceram. O `createdAt` é carimbado aqui,
   * no instante do fato, não na hora da gravação — o atraso da fila não
   * desloca o relógio do registro.
   *
   * Isto NÃO enfraquece a garantia: `record` já engolia falha de gravação e
   * seguia em frente. O que muda é quem espera.
   */
  record(input: AuditInput): AuditEntry {
    const entry = this.montar(input);
    this.fila.push(entry);
    void this.drenar();
    return entry;
  }

  /**
   * Registro que precede uma ação irreversível — este espera.
   *
   * Para "aprovei esta ordem" e "desarmei estas travas", o registro tem de
   * estar gravado ANTES de o dinheiro sair. Uma ordem na corretora sem o
   * registro da aprovação é o buraco que a auditoria existe para não ter.
   */
  async recordNow(input: AuditInput): Promise<AuditEntry> {
    const entry = this.montar(input);
    try {
      await this.repository.appendAudit(entry);
    } catch (error) {
      logger.error('Falha ao gravar auditoria', { error: (error as Error).message });
    }
    return entry;
  }

  private drenar(): Promise<void> {
    if (this.drenando) return this.drenando;
    this.drenando = (async () => {
      while (this.fila.length > 0) {
        const entry = this.fila.shift() as AuditEntry;
        try {
          await this.repository.appendAudit(entry);
        } catch (error) {
          logger.error('Falha ao gravar auditoria', { error: (error as Error).message });
        }
      }
      this.drenando = null;
    })();
    return this.drenando;
  }

  /** Esvazia a fila — chamado no encerramento, para não perder a cauda. */
  async flush(): Promise<void> {
    await this.drenar();
  }

  list(limit = 200): Promise<AuditEntry[]> {
    return this.repository.listAudit(limit);
  }
}
