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
import type { Repository } from './repository.ts';

/**
 * Quanto tempo uma lista lida vale antes de ser perguntada de novo.
 *
 * Curto de propósito. Isto não existe para guardar dado por muito tempo —
 * existe para não perguntar TRÊS VEZES a mesma coisa dentro do mesmo clique.
 * Medido em 26/08/2026, o caminho de uma ordem chamava `listTrades()` em três
 * lugares independentes (o porteiro de risco, o retrato do disjuntor e a
 * perda do dia), cada um custando ~240 ms no Supabase: 720 ms de espera para
 * ler o mesmo conteúdo, antes mesmo de falar com a corretora.
 *
 * Gravação invalida na hora, então o número nunca fica velho por escrita
 * nossa. O prazo cobre só a hipótese de alguém escrever no banco por fora.
 */
const VALIDADE_MS: Record<'trades' | 'setups' | 'alerts', number> = {
  trades: 3_000,
  // a varredura relê a lista inteira de setups e ela é a leitura mais cara do
  // painel (~890 ms); aqui o prazo pode ser mais folgado porque quem escreve
  // setup é o próprio scanner, e escrever invalida
  setups: 10_000,
  alerts: 5_000,
};

interface Guardado<T> {
  em: number;
  valor: Promise<T>;
}

/**
 * Uma camada fina de memória sobre a persistência.
 *
 * Não muda o contrato nem o comportamento: quem chama continua vendo um
 * `Repository`. O que muda é que a mesma pergunta feita duas vezes seguidas
 * custa uma viagem, não duas.
 *
 * Promessa recusada NÃO fica guardada: erro de persistência precisa voltar a
 * ser tentado, senão uma falha momentânea de rede viraria três segundos de
 * painel quebrado — e, no modo degradado, mascararia o fail-closed.
 */
export class CachedRepository implements Repository {
  private readonly inner: Repository;
  private trades: Guardado<Trade[]> | null = null;
  private setups: Guardado<TradeSetup[]> | null = null;
  private alerts: Guardado<AlertRecord[]> | null = null;

  constructor(inner: Repository) {
    this.inner = inner;
  }

  private async ler<T>(
    atual: Guardado<T> | null,
    validadeMs: number,
    buscar: () => Promise<T>,
    guardar: (novo: Guardado<T> | null) => void,
  ): Promise<T> {
    if (atual && Date.now() - atual.em < validadeMs) return atual.valor;
    const valor = buscar();
    const registro: Guardado<T> = { em: Date.now(), valor };
    guardar(registro);
    try {
      return await valor;
    } catch (error) {
      guardar(null);
      throw error;
    }
  }

  /** Descarta tudo — usado quando o dono do dado muda por fora. */
  invalidate(): void {
    this.trades = null;
    this.setups = null;
    this.alerts = null;
  }

  init(): Promise<void> {
    return this.inner.init();
  }

  loadSettings(): Promise<PersistedSettings | null> {
    return this.inner.loadSettings();
  }

  saveSettings(settings: StoredSettings): Promise<void> {
    return this.inner.saveSettings(settings);
  }

  listSetups(): Promise<TradeSetup[]> {
    return this.ler(
      this.setups,
      VALIDADE_MS.setups,
      () => this.inner.listSetups(),
      (novo) => {
        this.setups = novo;
      },
    );
  }

  async saveSetup(setup: TradeSetup): Promise<void> {
    await this.inner.saveSetup(setup);
    this.setups = null;
  }

  listTrades(): Promise<Trade[]> {
    return this.ler(
      this.trades,
      VALIDADE_MS.trades,
      () => this.inner.listTrades(),
      (novo) => {
        this.trades = novo;
      },
    );
  }

  async saveTrade(trade: Trade): Promise<void> {
    await this.inner.saveTrade(trade);
    // uma operação que mudou de estado muda risco, exposição e saldo: a lista
    // velha aqui seria a diferença entre recusar e aceitar a próxima ordem
    this.trades = null;
  }

  listAlerts(): Promise<AlertRecord[]> {
    return this.ler(
      this.alerts,
      VALIDADE_MS.alerts,
      () => this.inner.listAlerts(),
      (novo) => {
        this.alerts = novo;
      },
    );
  }

  async saveAlert(alert: AlertRecord): Promise<void> {
    await this.inner.saveAlert(alert);
    this.alerts = null;
  }

  saveDecision(decision: DecisionRecord): Promise<void> {
    return this.inner.saveDecision(decision);
  }

  listDecisions(): Promise<DecisionRecord[]> {
    return this.inner.listDecisions();
  }

  saveEntryDecision(decision: EntryDecisionRecord): Promise<void> {
    return this.inner.saveEntryDecision(decision);
  }

  listEntryDecisions(limit: number): Promise<EntryDecisionRecord[]> {
    return this.inner.listEntryDecisions(limit);
  }

  appendAudit(entry: AuditEntry): Promise<void> {
    return this.inner.appendAudit(entry);
  }

  listAudit(limit: number): Promise<AuditEntry[]> {
    return this.inner.listAudit(limit);
  }
}
