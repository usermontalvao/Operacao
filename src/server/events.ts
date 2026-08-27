import type { Response } from 'express';
import type {
  AlertRecord,
  ConnectionState,
  MarketContext,
  MarketKind,
  Trade,
  TradeSetup,
  TradingMode,
} from '../core/types.ts';
import type { MicroBlock } from '../core/engines/microScalpEngine.ts';

/** O saldo como a tela o desenha — o mesmo corpo de `GET /account/balance`. */
export interface BalanceEventPayload {
  capital: number;
  available: number;
  holdingsValue: number;
  idleAssets?: Array<{ asset: string; free: number; locked?: number }>;
  source: string;
  currency: 'USDT';
  brlRate: number | null;
  mode: TradingMode;
  market: MarketKind;
}

export type ServerEvent =
  | { type: 'prices'; payload: Record<string, number> }
  | { type: 'setup'; payload: TradeSetup }
  | { type: 'setupRemoved'; payload: { id: string } }
  | { type: 'alert'; payload: AlertRecord }
  | { type: 'trade'; payload: Trade }
  | { type: 'context'; payload: MarketContext }
  | { type: 'status'; payload: { connection: ConnectionState; binanceAvailable: boolean } }
  | { type: 'balance'; payload: BalanceEventPayload }
  /**
   * Estado do micro scalp: quem está no universo e, para quem não gerou tese,
   * POR QUÊ. O motivo viaja junto porque a alternativa é a tela mostrar um
   * espaço vazio — e vazio, em um painel de oportunidades, é ambíguo entre
   * "não há" e "quebrou".
   */
  | { type: 'microScalp'; payload: { active: string[]; blocks: MicroBlock[] } }
  | { type: 'settings'; payload: unknown };

/**
 * Canal servidor → navegador por SSE. Um cliente conectado recebe preço,
 * setup novo, alerta e mudança de operação sem nenhum polling.
 */
export class EventBus {
  private clients = new Set<Response>();
  private pendingPrices = new Map<string, number>();
  private priceTimer: NodeJS.Timeout | null = null;
  private observers = new Set<(event: ServerEvent) => void>();

  /**
   * Quem quiser reagir a um evento sem ser o navegador.
   *
   * Serve a uma regra só, mas ela vale a existência disto: TODA mudança de
   * operação mexe no dinheiro. Ordem enviada prende saldo, preenchimento
   * gasta, encerramento devolve. Como o barramento é o funil por onde passam
   * o motor de papel, a execução, o monitor e o encerramento, escutar aqui
   * cobre os quatro de uma vez — em vez de lembrar de pedir o saldo de novo
   * em cada um deles, e esquecer em um.
   */
  observe(listener: (event: ServerEvent) => void): void {
    this.observers.add(listener);
  }

  subscribe(response: Response): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write(': conectado\n\n');
    this.clients.add(response);
    response.on('close', () => this.clients.delete(response));
  }

  clientCount(): number {
    return this.clients.size;
  }

  broadcast(event: ServerEvent): void {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
    for (const observer of this.observers) observer(event);
  }

  /** Preços são agrupados em uma janela de 1s para não inundar o navegador. */
  queuePrice(symbol: string, price: number): void {
    this.pendingPrices.set(symbol, price);
    if (this.priceTimer) return;
    this.priceTimer = setTimeout(() => {
      this.priceTimer = null;
      if (this.pendingPrices.size === 0) return;
      const payload = Object.fromEntries(this.pendingPrices);
      this.pendingPrices.clear();
      this.broadcast({ type: 'prices', payload });
    }, 1000);
    this.priceTimer.unref?.();
  }

  heartbeat(): void {
    for (const client of this.clients) client.write(': ping\n\n');
  }
}
