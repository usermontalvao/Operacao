import { Router } from 'express';
import { config } from '../config.ts';
import type { AuthService } from '../auth/authService.ts';
import { clientOrigin, throttle } from '../auth/middleware.ts';
import { RequestLimiter } from '../auth/rateLimit.ts';
import {
  SESSION_COOKIE,
  buildCookie,
  expiredCookie,
  readCookie,
  readSessionToken,
} from '../auth/session.ts';
import { asyncHandler } from './context.ts';

/**
 * Entrada e saída do painel.
 *
 * Três limites empilhados, porque cada um cobre o que o outro deixa passar:
 *   1. o teto geral da API, aplicado antes daqui;
 *   2. um teto só do /auth/login, que segura enxurrada mesmo que cada palpite
 *      chegue de um usuário diferente;
 *   3. a trava por origem+usuário do AuthService, que é a que dobra o castigo.
 */
export function authRoutes(auth: AuthService): Router {
  const router = Router();
  const loginFlood = new RequestLimiter({ max: 20, windowMs: 60_000 });
  const sweeper = setInterval(() => loginFlood.sweep(), 5 * 60_000);
  sweeper.unref?.();

  router.get('/auth/session', (request, response) => {
    const session = readSessionToken(
      readCookie(request.headers.cookie, SESSION_COOKIE),
      config.appSecret,
    );
    response.json({
      authenticated: session !== null,
      configured: auth.configured,
      backend: auth.backend,
      user: session?.label ?? null,
      expiresAt: session ? new Date(session.exp).toISOString() : null,
    });
  });

  router.post(
    '/auth/login',
    throttle(loginFlood, 'login'),
    asyncHandler(async (request, response) => {
      const body = request.body as { user?: unknown; password?: unknown } | undefined;
      const user = typeof body?.user === 'string' ? body.user : '';
      const password = typeof body?.password === 'string' ? body.password : '';

      if (!user || !password) {
        response.status(400).json({ error: 'Informe usuário e senha' });
        return;
      }
      // senha absurdamente longa é tentativa de fazer o scrypt trabalhar de
      // graça; cortar antes é mais barato que negar depois
      if (password.length > 200) {
        response.status(400).json({ error: 'Senha inválida' });
        return;
      }

      const result = await auth.login(clientOrigin(request), user, password, config.appSecret);

      if (result.outcome === 'ok') {
        response.setHeader(
          'Set-Cookie',
          buildCookie(result.token, {
            maxAgeSeconds: Math.floor(config.auth.sessionMs / 1000),
            secure: config.auth.secureCookie,
          }),
        );
        response.json({ authenticated: true, ...result.session });
        return;
      }
      if (result.outcome === 'locked') {
        response.setHeader('Retry-After', String(result.retryAfterSeconds));
        response.status(429).json({
          error: `Muitas tentativas — tente de novo em ${formatWait(result.retryAfterSeconds)}`,
          retryAfterSeconds: result.retryAfterSeconds,
        });
        return;
      }
      if (result.outcome === 'unconfigured') {
        response.status(503).json({
          error: 'Login ainda não configurado neste computador — rode: npm run senha',
          code: 'LOGIN_NAO_CONFIGURADO',
        });
        return;
      }
      if (result.outcome === 'unavailable') {
        response.status(503).json({ error: `Não deu para conferir a senha: ${result.detail}` });
        return;
      }

      response.status(401).json({
        error: 'Usuário ou senha incorretos',
        remainingAttempts: result.remainingAttempts,
      });
    }),
  );

  router.post('/auth/logout', (_request, response) => {
    response.setHeader('Set-Cookie', expiredCookie(config.auth.secureCookie));
    response.json({ authenticated: false });
  });

  return router;
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} min`;
}
