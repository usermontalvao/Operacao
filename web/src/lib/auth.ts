export interface SessionState {
  authenticated: boolean;
  /** false quando ninguém configurou login neste computador ainda */
  configured: boolean;
  backend: 'supabase' | 'local' | 'none';
  user: string | null;
  expiresAt: string | null;
}

export class LoginError extends Error {
  readonly retryAfterSeconds: number | null;
  readonly remainingAttempts: number | null;
  readonly code: string | null;

  constructor(
    message: string,
    extra: { retryAfterSeconds?: number; remainingAttempts?: number; code?: string } = {},
  ) {
    super(message);
    this.name = 'LoginError';
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
    this.remainingAttempts = extra.remainingAttempts ?? null;
    this.code = extra.code ?? null;
  }
}

/**
 * Evento avisando que a sessão caiu no meio do uso. Quem escuta é a raiz da
 * árvore: assim a tela volta para o login de qualquer lugar, sem cada
 * componente precisar saber disso.
 */
export const SESSION_LOST = 'operacao:sessao-perdida';

export function announceSessionLost(): void {
  window.dispatchEvent(new CustomEvent(SESSION_LOST));
}

export async function readSession(): Promise<SessionState> {
  const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Não foi possível falar com o servidor');
  return (await response.json()) as SessionState;
}

export async function login(user: string, password: string): Promise<void> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, password }),
  });
  if (response.ok) return;

  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    retryAfterSeconds?: number;
    remainingAttempts?: number;
    code?: string;
  } | null;
  throw new LoginError(payload?.error ?? `Falha ao entrar (${response.status})`, {
    retryAfterSeconds: payload?.retryAfterSeconds,
    remainingAttempts: payload?.remainingAttempts,
    code: payload?.code,
  });
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
}
