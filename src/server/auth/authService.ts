import type { AuthConfig } from '../config.ts';
import { logger } from '../logger.ts';
import { verifyPassword } from './password.ts';
import { verifySupabasePassword } from './supabaseAuth.ts';
import {
  AttemptLimiter,
  DEFAULT_LOGIN_LIMITS,
  type AttemptVerdict,
} from './rateLimit.ts';
import { createSessionToken, type SessionPayload } from './session.ts';

export type LoginResult =
  | { outcome: 'ok'; token: string; session: { sub: string; label: string; expiresAt: string } }
  | { outcome: 'denied'; remainingAttempts: number }
  | { outcome: 'locked'; retryAfterSeconds: number }
  | { outcome: 'unconfigured' }
  | { outcome: 'unavailable'; detail: string };

/**
 * Porteiro do painel.
 *
 * A trava por tentativas é contada por ORIGEM + USUÁRIO. Só por usuário
 * deixaria qualquer um travar o dono de fora de propósito; só por origem
 * deixaria uma máquina varrer vários usuários. Somados, quem erra é quem
 * paga, e o castigo dobra a cada trava.
 *
 * Senha errada e usuário inexistente devolvem exatamente a mesma resposta, e
 * o caminho do usuário desconhecido também gasta um hash falso: sem isso, o
 * tempo de resposta contaria quais usuários existem.
 */
export class AuthService {
  private readonly config: AuthConfig;
  private readonly limiter: AttemptLimiter;
  /** hash descartável usado para o palpite de usuário inexistente custar o mesmo */
  private static readonly DUMMY_HASH =
    'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
    'ZGVzY2FydGF2ZWwtcGFyYS1nYXN0YXItbyBtZXNtby10ZW1wby1zZW0tdmFsZXItbmFkYS4=';

  constructor(config: AuthConfig, limiter = new AttemptLimiter(DEFAULT_LOGIN_LIMITS)) {
    this.config = config;
    this.limiter = limiter;
    const timer = setInterval(() => this.limiter.sweep(), 5 * 60_000);
    timer.unref?.();
  }

  get backend(): AuthConfig['backend'] {
    return this.config.backend;
  }

  get configured(): boolean {
    return this.config.backend !== 'none';
  }

  /** Estado da trava sem consumir tentativa — a tela usa para avisar antes. */
  inspect(origin: string, user: string): AttemptVerdict {
    return this.limiter.check(this.key(origin, user));
  }

  async login(
    origin: string,
    user: string,
    password: string,
    secret: string,
  ): Promise<LoginResult> {
    if (this.config.backend === 'none') return { outcome: 'unconfigured' };

    const key = this.key(origin, user);
    const gate = this.limiter.check(key);
    if (!gate.allowed) {
      return { outcome: 'locked', retryAfterSeconds: gate.retryAfterSeconds };
    }

    const verdict = await this.check(user, password);

    if (verdict.kind === 'unavailable') {
      // problema nosso, não palpite de invasor: não conta como tentativa
      return { outcome: 'unavailable', detail: verdict.detail };
    }
    if (verdict.kind === 'throttled') {
      return { outcome: 'locked', retryAfterSeconds: verdict.retryAfterSeconds };
    }
    if (verdict.kind === 'denied') {
      const after = this.limiter.registerFailure(key);
      logger.warn('Tentativa de login recusada', {
        origin,
        user,
        remaining: after.remainingAttempts,
        lockedFor: after.retryAfterSeconds,
      });
      if (!after.allowed) {
        return { outcome: 'locked', retryAfterSeconds: after.retryAfterSeconds };
      }
      return { outcome: 'denied', remainingAttempts: after.remainingAttempts };
    }

    this.limiter.registerSuccess(key);
    const now = Date.now();
    const token = createSessionToken(
      { sub: verdict.sub, label: verdict.label },
      secret,
      now,
      this.config.sessionMs,
    );
    logger.info('Login aceito', { user: verdict.label, backend: this.config.backend });
    return {
      outcome: 'ok',
      token,
      session: {
        sub: verdict.sub,
        label: verdict.label,
        expiresAt: new Date(now + this.config.sessionMs).toISOString(),
      },
    };
  }

  private async check(
    user: string,
    password: string,
  ): Promise<
    | { kind: 'ok'; sub: string; label: string }
    | { kind: 'denied' }
    | { kind: 'throttled'; retryAfterSeconds: number }
    | { kind: 'unavailable'; detail: string }
  > {
    const expected = (this.config.user ?? '').trim().toLowerCase();
    const offered = user.trim().toLowerCase();

    if (this.config.backend === 'local') {
      if (!this.config.passwordHash) return { kind: 'unavailable', detail: 'senha não gravada' };
      // o hash falso roda mesmo quando o usuário não bate: o custo do palpite
      // tem de ser o mesmo nos dois casos
      const hash = offered === expected ? this.config.passwordHash : AuthService.DUMMY_HASH;
      const ok = await verifyPassword(password, hash);
      if (!ok || offered !== expected) return { kind: 'denied' };
      return { kind: 'ok', sub: expected, label: expected };
    }

    if (!this.config.supabaseAuth) {
      return { kind: 'unavailable', detail: 'Supabase Auth não configurado' };
    }
    if (offered !== expected) {
      // não perguntamos ao Supabase por um e-mail que não é o do painel: isso
      // gastaria a cota de lá com palpite e vazaria a existência da conta
      return { kind: 'denied' };
    }
    const result = await verifySupabasePassword(
      this.config.supabaseAuth.url,
      this.config.supabaseAuth.apiKey,
      user.trim(),
      password,
    );
    if (result.outcome === 'ok') {
      return { kind: 'ok', sub: result.identity.id, label: result.identity.email };
    }
    if (result.outcome === 'throttled') {
      return { kind: 'throttled', retryAfterSeconds: result.retryAfterSeconds };
    }
    if (result.outcome === 'unavailable') {
      logger.error('Supabase Auth indisponível no login', { detail: result.detail });
      return { kind: 'unavailable', detail: 'não foi possível falar com o Supabase' };
    }
    return { kind: 'denied' };
  }

  private key(origin: string, user: string): string {
    return `${origin}|${user.trim().toLowerCase()}`;
  }
}

export type { SessionPayload };
