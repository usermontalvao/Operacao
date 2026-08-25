/**
 * Conversa com o Supabase Auth por HTTP puro.
 *
 * Não usamos o cliente oficial aqui de propósito: ele é uma dependência
 * opcional do projeto (quem roda em arquivo JSON não o instala) e tudo que
 * precisamos são duas chamadas. A senha entra, o token do Supabase é
 * descartado na hora e só o uuid do usuário sai — quem manda no acesso ao
 * painel é a nossa sessão, não a do Supabase.
 */

export interface SupabaseIdentity {
  id: string;
  email: string;
}

export type PasswordCheck =
  | { outcome: 'ok'; identity: SupabaseIdentity }
  | { outcome: 'denied' }
  /** o Supabase respondeu 429 — devolvemos como está, sem chamar de senha errada */
  | { outcome: 'throttled'; retryAfterSeconds: number }
  | { outcome: 'unavailable'; detail: string };

const TIMEOUT_MS = 10_000;

export async function verifySupabasePassword(
  url: string,
  apiKey: string,
  email: string,
  password: string,
): Promise<PasswordCheck> {
  let response: Response;
  try {
    response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { outcome: 'unavailable', detail: (error as Error).message };
  }

  if (response.status === 429) {
    const retry = Number(response.headers.get('retry-after') ?? '60');
    return { outcome: 'throttled', retryAfterSeconds: Number.isFinite(retry) ? retry : 60 };
  }
  if (response.status === 400 || response.status === 401) return { outcome: 'denied' };
  if (!response.ok) {
    return { outcome: 'unavailable', detail: `Supabase respondeu ${response.status}` };
  }

  const body = (await response.json().catch(() => null)) as
    | { user?: { id?: string; email?: string } }
    | null;
  const id = body?.user?.id;
  if (!id) return { outcome: 'unavailable', detail: 'resposta sem usuário' };
  return { outcome: 'ok', identity: { id, email: body?.user?.email ?? email } };
}

/**
 * Descobre o uuid do dono dos dados a partir do e-mail. Serve para o
 * SUPABASE_OWNER_ID poder ficar em branco no .env: copiar uuid à mão é o tipo
 * de passo que se erra em silêncio e só aparece como "sumiu tudo".
 */
export async function findUserIdByEmail(
  url: string,
  serviceRoleKey: string,
  email: string,
): Promise<string | null> {
  const endpoint = `${url.replace(/\/+$/, '')}/auth/v1/admin/users?page=1&per_page=200`;
  const response = await fetch(endpoint, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`admin/users respondeu ${response.status}`);
  const body = (await response.json()) as { users?: Array<{ id: string; email?: string }> };
  const wanted = email.trim().toLowerCase();
  const found = (body.users ?? []).find((user) => (user.email ?? '').toLowerCase() === wanted);
  return found?.id ?? null;
}
