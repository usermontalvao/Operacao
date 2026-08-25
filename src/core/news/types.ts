/**
 * Um fato de mercado que muda o risco de operar um ativo — deslistagem,
 * negociação suspensa, manutenção de rede, incidente.
 *
 * A regra que dá forma a este módulo inteiro: notícia NÃO gera compra. Ela só
 * bloqueia ou reduz. Por isso não existe severidade "positiva" no tipo — não é
 * uma decisão de configuração que alguém possa inverter depois, é uma coisa
 * que o sistema não sabe expressar.
 */
export type EventSeverity = 'BLOCK' | 'REDUCE' | 'INFORM';

export type MarketEventKind =
  | 'DELISTING'
  | 'TRADING_HALTED'
  | 'MAINTENANCE'
  | 'MONITORING_TAG'
  | 'NETWORK_ISSUE'
  | 'EXPLOIT'
  | 'LISTING'
  | 'RULES_CHANGED'
  | 'OTHER';

export interface MarketEvent {
  /** chave estável de deduplicação: a mesma notícia por duas fontes é uma só */
  id: string;
  source: string;
  kind: MarketEventKind;
  symbols: string[];
  severity: EventSeverity;
  /** 0 a 1 — fonte oficial e explícita vale 1; leitura indireta vale menos */
  confidence: number;
  title: string;
  detail: string;
  observedAt: string;
  /** quando o efeito caduca sozinho; null = vale até alguém retirar */
  expiresAt: string | null;
}

export interface SymbolVerdict {
  symbol: string;
  blocked: boolean;
  /** multiplicador do tamanho da posição (1 = cheio, 0 = não entra) */
  sizeFactor: number;
  reasons: string[];
  /** os eventos que produziram este veredito, para gravar junto do setup */
  events: MarketEvent[];
}
