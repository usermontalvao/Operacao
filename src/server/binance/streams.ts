import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { ConnectionState } from '../../core/types.ts';
import { getActiveEnvironment } from './rest.ts';
import { logger } from '../logger.ts';

export interface KlineEvent {
  symbol: string;
  interval: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  closed: boolean;
}

export interface TickerEvent {
  symbol: string;
  price: number;
  changePercent: number;
  quoteVolume: number;
}

const STALE_AFTER_MS = 90_000;
const HEALTH_CHECK_MS = 20_000;
/** A Binance derruba a conexão em 24h; reconectamos antes por conta própria. */
const RECYCLE_AFTER_MS = 23 * 60 * 60 * 1000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Uma única conexão para todos os símbolos e timeframes. Reconecta sozinha,
 * detecta conexão morta e reassina os streams — o dashboard nunca congela
 * em silêncio: o estado vira RECONNECTING ou OFFLINE na tela.
 */
export class BinanceStreamClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private streams: string[] = [];
  private status: ConnectionState = 'OFFLINE';
  private attempt = 0;
  private lastMessageAt = 0;
  private connectedAt = 0;
  private healthTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  getStatus(): ConnectionState {
    return this.status;
  }

  start(streams: string[]): void {
    this.stopped = false;
    this.streams = [...new Set(streams)];
    this.connect();
    if (!this.healthTimer) {
      this.healthTimer = setInterval(() => this.checkHealth(), HEALTH_CHECK_MS);
      this.healthTimer.unref?.();
    }
  }

  /** Watchlist mudou: assina o que falta e derruba o que sobrou. */
  updateStreams(streams: string[]): void {
    const next = [...new Set(streams)];
    const added = next.filter((stream) => !this.streams.includes(stream));
    const removed = this.streams.filter((stream) => !next.includes(stream));
    this.streams = next;

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.connect();
      return;
    }
    if (added.length > 0) {
      this.socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: added, id: Date.now() }));
    }
    if (removed.length > 0) {
      this.socket.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: removed, id: Date.now() + 1 }));
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.healthTimer = null;
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.setStatus('OFFLINE');
  }

  private connect(): void {
    if (this.stopped || this.streams.length === 0) return;
    this.socket?.removeAllListeners();
    this.socket?.terminate();

    const url = `${getActiveEnvironment().wsBase}/stream?streams=${this.streams.join('/')}`;
    this.setStatus(this.attempt === 0 ? 'RECONNECTING' : 'RECONNECTING');
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on('open', () => {
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.connectedAt = Date.now();
      this.setStatus('LIVE');
      logger.info('Stream da Binance conectado', { streams: this.streams.length });
    });
    socket.on('message', (raw) => {
      this.lastMessageAt = Date.now();
      this.handleMessage(raw.toString());
    });
    socket.on('ping', () => {
      this.lastMessageAt = Date.now();
    });
    socket.on('error', (error) => {
      logger.warn('Erro no stream da Binance', { error: (error as Error).message });
    });
    socket.on('close', () => {
      if (this.stopped) return;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempt += 1;
    const backoff = Math.min(1000 * 2 ** (this.attempt - 1), MAX_BACKOFF_MS);
    const jitter = Math.round(Math.random() * 500);
    this.setStatus(this.attempt > 4 ? 'OFFLINE' : 'RECONNECTING');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, backoff + jitter);
    this.reconnectTimer.unref?.();
  }

  private checkHealth(): void {
    if (this.stopped || !this.socket) return;
    const idle = Date.now() - this.lastMessageAt;
    if (idle > STALE_AFTER_MS) {
      logger.warn('Stream sem mensagens — derrubando para reconectar', { idleMs: idle });
      this.socket.terminate();
      return;
    }
    if (this.connectedAt > 0 && Date.now() - this.connectedAt > RECYCLE_AFTER_MS) {
      logger.info('Reciclando conexão de 24h da Binance');
      this.socket.close();
    }
  }

  private handleMessage(raw: string): void {
    let parsed: { stream?: string; data?: Record<string, unknown> };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return;
    }
    const data = parsed.data;
    if (!data) return;

    if (data.e === 'kline') {
      const kline = data.k as Record<string, unknown>;
      const event: KlineEvent = {
        symbol: String(data.s),
        interval: String(kline.i),
        openTime: Number(kline.t),
        closeTime: Number(kline.T),
        open: Number(kline.o),
        high: Number(kline.h),
        low: Number(kline.l),
        close: Number(kline.c),
        volume: Number(kline.v),
        quoteVolume: Number(kline.q),
        closed: Boolean(kline.x),
      };
      this.emit('kline', event);
      return;
    }

    if (data.e === '24hrMiniTicker' || data.e === '24hrTicker') {
      const open = Number(data.o);
      const close = Number(data.c);
      const event: TickerEvent = {
        symbol: String(data.s),
        price: close,
        changePercent:
          data.P !== undefined ? Number(data.P) : open > 0 ? ((close - open) / open) * 100 : 0,
        quoteVolume: Number(data.q ?? 0),
      };
      this.emit('ticker', event);
    }
  }

  private setStatus(status: ConnectionState): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }
}

export function klineStream(symbol: string, interval: string): string {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

export function miniTickerStream(symbol: string): string {
  return `${symbol.toLowerCase()}@miniTicker`;
}
