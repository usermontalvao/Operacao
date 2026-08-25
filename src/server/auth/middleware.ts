import type { NextFunction, Request, Response } from 'express';
import { logger } from '../logger.ts';
import { RequestLimiter } from './rateLimit.ts';
import { SESSION_COOKIE, readCookie, readSessionToken, type SessionPayload } from './session.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: SessionPayload;
    }
  }
}

/**
 * Quem está chamando. `request.ip` já respeita o proxy do Vite em
 * desenvolvimento; o IPv6 mapeado vira IPv4 para que 127.0.0.1 e ::ffff:127.0.0.1
 * não contem como duas origens diferentes na hora de travar.
 */
export function clientOrigin(request: Request): string {
  const raw = request.ip ?? request.socket.remoteAddress ?? 'desconhecido';
  return raw.replace(/^::ffff:/, '');
}

/** Teto de chamadas por origem — vale para toda a API. */
export function throttle(limiter: RequestLimiter, label: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const verdict = limiter.consume(clientOrigin(request));
    if (verdict.allowed) {
      response.setHeader('X-RateLimit-Remaining', String(verdict.remaining));
      next();
      return;
    }
    logger.warn('Chamada recusada por excesso', { label, origin: clientOrigin(request) });
    response.setHeader('Retry-After', String(verdict.retryAfterSeconds));
    response.status(429).json({
      error: 'Muitas chamadas seguidas — espere alguns segundos',
      retryAfterSeconds: verdict.retryAfterSeconds,
    });
  };
}

/**
 * Porta trancada. Tudo em /api passa por aqui, menos o punhado de rotas que
 * existem justamente para entrar (`/auth/*`) e o /health, que é usado pelo
 * atalho de inicialização para saber se o servidor subiu.
 */
export function requireSession(secret: string, isOpen: (path: string) => boolean) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (isOpen(request.path)) {
      next();
      return;
    }
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const session = readSessionToken(token, secret);
    if (!session) {
      response.status(401).json({ error: 'Sessão expirada — entre de novo', code: 'SEM_SESSAO' });
      return;
    }
    request.session = session;
    next();
  };
}

export { RequestLimiter };
