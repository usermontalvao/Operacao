import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sessão em cookie assinado — sem tabela de sessões e sem estado no servidor.
 *
 * O cookie carrega apenas quem é e até quando vale, e vem com uma assinatura
 * HMAC feita com o APP_SECRET. Trocar qualquer letra do conteúdo invalida a
 * assinatura, então o navegador não consegue se promover a outro usuário nem
 * esticar o próprio prazo. Reiniciar o servidor não derruba quem estava
 * dentro; trocar o APP_SECRET derruba todo mundo, que é o botão de pânico.
 */

export interface SessionPayload {
  /** identidade do operador (uuid do Supabase ou o usuário local) */
  sub: string;
  /** rótulo mostrado na tela */
  label: string;
  /** emitido em (epoch ms) */
  iat: number;
  /** expira em (epoch ms) */
  exp: number;
}

export const SESSION_COOKIE = 'operacao_sessao';
export const DEFAULT_SESSION_MS = 12 * 60 * 60_000;

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function createSessionToken(
  payload: Omit<SessionPayload, 'iat' | 'exp'>,
  secret: string,
  now: number = Date.now(),
  durationMs: number = DEFAULT_SESSION_MS,
): string {
  const full: SessionPayload = { ...payload, iat: now, exp: now + durationMs };
  const body = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url');
  return `v1.${body}.${sign(body, secret)}`;
}

export function readSessionToken(
  token: string | undefined,
  secret: string,
  now: number = Date.now(),
): SessionPayload | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, body, signature] = parts as [string, string, string];

  const expected = sign(body, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload?.sub !== 'string' || typeof payload?.exp !== 'number') return null;
  if (payload.exp <= now) return null;
  return payload;
}

/** Lê um cookie do cabeçalho cru — evita mais uma dependência só para isto. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const piece of header.split(';')) {
    const index = piece.indexOf('=');
    if (index < 0) continue;
    if (piece.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(piece.slice(index + 1).trim());
    } catch {
      return piece.slice(index + 1).trim();
    }
  }
  return undefined;
}

export function buildCookie(
  value: string,
  options: { maxAgeSeconds: number; secure: boolean },
): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    // Lax barra o cookie em POST vindo de outro site — é a trava de CSRF
    // desta API, que é a API que envia ordem
    'SameSite=Lax',
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function expiredCookie(secure: boolean): string {
  return buildCookie('', { maxAgeSeconds: 0, secure });
}
