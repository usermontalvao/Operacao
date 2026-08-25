import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { ConnectionState } from '../../core/types.ts';
import { logger } from '../logger.ts';
import { closeListenKey, createListenKey, getActiveEnvironment, keepAliveListenKey } from './rest.ts';
import { parseExecutionReport, type OrderExecutionEvent } from './userEvents.ts';

/** A chave expira em 60 min; renovar a cada 30 dá margem para uma falha. */
const KEEPALIVE_MS = 30 * 60 * 1000;
/** A Binance manda ping a cada 3 min. Dois silêncios seguidos = conexão morta. */
const SILENCE_LIMIT_MS = 7 * 60 * 1000;
const HEALTH_CHECK_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Fluxo da conta em tempo real.
 *
 * Enquanto a execução era descoberta só por consulta a cada 20 segundos, uma
 * ordem podia preencher e passar até 20 segundos sem que o sistema soubesse —
 * tempo em que o stop de proteção não sobe e a posição fica sem dono. Aqui a
 * corretora avisa no instante do negócio; a consulta continua existindo, mas
 * como reconciliação, não como fonte principal.
 */
export class UserDataStream extends EventEmitter {
  private socket: WebSocket | null = null;
  private listenKey: string | null = null;
  private status: ConnectionState = 'OFFLINE';
  private attempt = 0;
  private lastSignalAt = 0;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  getStatus(): ConnectionState {
    return this.status;
  }

  isLive(): boolean {
    return this.status === 'LIVE';
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
    if (!this.healthTimer) {
      this.healthTimer = setInterval(() => this.checkHealth(), HEALTH_CHECK_MS);
      this.healthTimer.unref?.();
    }
    if (!this.keepAliveTimer) {
      this.keepAliveTimer = setInterval(() => void this.keepAlive(), KEEPALIVE_MS);
      this.keepAliveTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.healthTimer = null;
    this.keepAliveTimer = null;
    this.reconnectTimer = null;

    const socket = this.socket;
    this.socket = null;
    socket?.removeAllListeners();
    socket?.close();

    const key = this.listenKey;
    this.listenKey = null;
    if (key) {
      try {
        await closeListenKey(key);
      } catch (error) {
        logger.debug('Falha ao encerrar listenKey', { error: (error as Error).message });
      }
    }
    this.setStatus('OFFLINE');
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus('RECONNECTING');

    let key: string;
    try {
      // chave nova a cada conexão: reaproveitar chave de sessão morta é a
      // forma mais silenciosa de ficar com um socket que nunca recebe nada
      key = await createListenKey();
    } catch (error) {
      logger.warn('Não foi possível abrir o fluxo da conta', { error: (error as Error).message });
      this.scheduleReconnect();
      return;
    }
    this.listenKey = key;

    const url = `${getActiveEnvironment().userWsBase}/ws/${key}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on('open', () => {
      this.attempt = 0;
      this.lastSignalAt = Date.now();
      this.setStatus('LIVE');
      logger.info('Fluxo da conta conectado');
    });
    socket.on('ping', () => {
      this.lastSignalAt = Date.now();
    });
    socket.on('message', (data: WebSocket.RawData) => {
      this.lastSignalAt = Date.now();
      this.handle(data);
    });
    socket.on('error', (error: Error) => {
      logger.warn('Erro no fluxo da conta', { error: error.message });
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    });
  }

  private handle(data: WebSocket.RawData): void {
    let payload: unknown;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return;
    }
    const execution = parseExecutionReport(payload);
    if (execution) {
      this.emit('execution', execution satisfies OrderExecutionEvent);
      return;
    }
    const type = (payload as { e?: unknown }).e;
    if (type === 'outboundAccountPosition' || type === 'balanceUpdate') {
      this.emit('balance', payload);
    }
  }

  private async keepAlive(): Promise<void> {
    const key = this.listenKey;
    if (!key || this.stopped) return;
    try {
      await keepAliveListenKey(key);
    } catch (error) {
      logger.warn('Renovação do listenKey falhou — reconectando', {
        error: (error as Error).message,
      });
      this.socket?.close();
    }
  }

  private checkHealth(): void {
    if (this.stopped || !this.socket) return;
    if (Date.now() - this.lastSignalAt <= SILENCE_LIMIT_MS) return;
    logger.warn('Fluxo da conta silencioso — derrubando para reconectar');
    this.socket.close();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.setStatus('RECONNECTING');
    this.attempt += 1;
    const delay = Math.min(1_000 * 2 ** this.attempt, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private setStatus(status: ConnectionState): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }
}
