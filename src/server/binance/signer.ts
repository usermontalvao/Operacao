import { createHmac } from 'node:crypto';

/**
 * Assinatura HMAC SHA256 exigida pelos endpoints SIGNED.
 * O segredo entra aqui e não sai: nada é logado, nada é devolvido.
 */
export function signQuery(query: string, apiSecret: string): string {
  return createHmac('sha256', apiSecret).update(query).digest('hex');
}

export function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  return search.toString();
}
