import type { Response } from 'express';
import type {
  AlertRecord,
  ConnectionState,
  MarketContext,
  Trade,
  TradeSetup,
} from '../core/types.ts';

export type ServerEvent =
  | { type: 'prices'; payload: Record<string, number> }
  | { type: 'setup'; payload: TradeSetup }
  | { type: 'setupRemoved'; payload: { id: string } }
  | { type: 'alert'; payload: AlertRecord }
  | { type: 'trade'; payload: Trade }
  | { type: 'context'; payload: MarketContext }
  | { type: 'status'; payload: { connection: ConnectionState; binanceAvailable: boolean } }
  | { type: 'settings'; payload: unknown };

/**
 * Canal servidor → navegador por SSE. Um cliente conectado recebe preço,
 * setup novo, alerta e mudança de operação sem nenhum polling.
 */
export class EventBus {
  private clients = new Set<Response>();
  private pendingPrices = new Map<string, number>();
  private priceTimer: NodeJS.Timeout | null = null;

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
