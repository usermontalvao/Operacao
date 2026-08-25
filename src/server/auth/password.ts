import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Senha do painel guardada como scrypt. O arquivo .env fica no disco do
 * usuário — guardar a senha em texto ali significaria que quem lê o arquivo
 * entra no painel. Com scrypt, o que está no arquivo não serve para entrar em
 * lugar nenhum sem quebrar o hash primeiro.
 *
 * Formato: scrypt$N$r$p$<salt em base64>$<hash em base64>
 * Os parâmetros vão gravados junto para que hashes antigos continuem válidos
 * quando o custo subir no futuro.
 */

const PARAMS = { N: 16_384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, PARAMS.keylen, PARAMS);
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64');
    expected = Buffer.from(parts[5] as string, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: PARAMS.maxmem,
  });
  // comparação de tempo constante: comparar com === vazaria, pelo tempo de
  // resposta, quantos bytes iniciais o palpite acertou
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Regras mínimas de senha, usadas pelo script que grava o hash. */
export function describePasswordProblem(password: string): string | null {
  if (password.length < 10) return 'a senha precisa de pelo menos 10 caracteres';
  if (/^\d+$/.test(password)) return 'a senha não pode ser só números';
  if (/^(.)\1+$/.test(password)) return 'a senha não pode ser um caractere repetido';
  return null;
}
