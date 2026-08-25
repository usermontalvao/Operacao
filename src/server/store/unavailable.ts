import type { Repository } from './repository.ts';

/**
 * Erro de persistência principal fora do ar. Tipado de propósito: quem trata
 * precisa poder distinguir "o banco caiu" de "os dados estão errados".
 */
export class PersistenceUnavailableError extends Error {
  override readonly cause: string;

  constructor(cause: string) {
    super(`Persistência principal indisponível: ${cause}`);
    this.name = 'PersistenceUnavailableError';
    this.cause = cause;
  }
}

/**
 * O repositório que se recusa a fingir.
 *
 * Quando STORE=supabase e o Supabase não responde, a tentação é cair para o
 * arquivo local e "continuar funcionando". Num sistema financeiro isso não é
 * resiliência, é criar um segundo histórico: o usuário encerra posições de um
 * lado enquanto o outro continua achando que elas estão abertas — e o próximo
 * reinício escolhe um dos dois sem avisar qual.
 *
 * Este repositório falha em TODA operação, inclusive nas leituras. Devolver
 * lista vazia seria pior que o erro: o painel mostraria patrimônio zero,
 * nenhuma posição aberta e nenhum disjuntor acionado — um estado tranquilo e
 * inteiramente falso, que convida a operar.
 */
export class UnavailableRepository implements Repository {
  private readonly cause: string;

  constructor(cause: string) {
    this.cause = cause;
  }

  private fail(): never {
    throw new PersistenceUnavailableError(this.cause);
  }

  async init(): Promise<void> {
    // não falha: o objeto precisa existir para o painel subir e EXPLICAR o erro
  }

  async loadSettings(): ReturnType<Repository['loadSettings']> {
    return this.fail();
  }
  async saveSettings(_settings: Parameters<Repository['saveSettings']>[0]): Promise<void> {
    return this.fail();
  }
  async listSetups(): ReturnType<Repository['listSetups']> {
    return this.fail();
  }
  async saveSetup(_setup: Parameters<Repository['saveSetup']>[0]): Promise<void> {
    return this.fail();
  }
  async listTrades(): ReturnType<Repository['listTrades']> {
    return this.fail();
  }
  async saveTrade(_trade: Parameters<Repository['saveTrade']>[0]): Promise<void> {
    return this.fail();
  }
  async listAlerts(): ReturnType<Repository['listAlerts']> {
    return this.fail();
  }
  async saveAlert(_alert: Parameters<Repository['saveAlert']>[0]): Promise<void> {
    return this.fail();
  }
  async saveDecision(_decision: Parameters<Repository['saveDecision']>[0]): Promise<void> {
    return this.fail();
  }
  async listDecisions(): ReturnType<Repository['listDecisions']> {
    return this.fail();
  }
  async saveEntryDecision(_decision: Parameters<Repository['saveEntryDecision']>[0]): Promise<void> {
    return this.fail();
  }
  async listEntryDecisions(_limit: number): ReturnType<Repository['listEntryDecisions']> {
    return this.fail();
  }
  async appendAudit(_entry: Parameters<Repository['appendAudit']>[0]): Promise<void> {
    return this.fail();
  }
  async listAudit(_limit: number): ReturnType<Repository['listAudit']> {
    return this.fail();
  }
}
