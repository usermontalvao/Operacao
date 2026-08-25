import assert from 'node:assert/strict';
import test from 'node:test';
import { AttemptLimiter, RequestLimiter } from './rateLimit.ts';
import { hashPassword, verifyPassword, describePasswordProblem } from './password.ts';
import {
  buildCookie,
  createSessionToken,
  readCookie,
  readSessionToken,
} from './session.ts';

const LIMITS = {
  maxAttempts: 3,
  windowMs: 60_000,
  baseLockMs: 1_000,
  maxLockMs: 8_000,
};

test('trava depois do limite de falhas e libera quando o castigo vence', () => {
  const limiter = new AttemptLimiter(LIMITS);
  const t0 = 1_000_000;

  assert.equal(limiter.registerFailure('ip|joao', t0).remainingAttempts, 2);
  assert.equal(limiter.registerFailure('ip|joao', t0 + 10).remainingAttempts, 1);

  const third = limiter.registerFailure('ip|joao', t0 + 20);
  assert.equal(third.allowed, false, 'a terceira falha fecha a porta');
  assert.equal(third.retryAfterSeconds, 1);

  assert.equal(limiter.check('ip|joao', t0 + 500).allowed, false);
  assert.equal(limiter.check('ip|joao', t0 + 1_100).allowed, true, 'volta sozinho');
});

test('o castigo dobra a cada trava, com teto', () => {
  const limiter = new AttemptLimiter(LIMITS);
  let now = 0;
  const lockOnce = (): number => {
    for (let i = 0; i < LIMITS.maxAttempts - 1; i += 1) limiter.registerFailure('x', now++);
    const verdict = limiter.registerFailure('x', now++);
    now += verdict.retryAfterSeconds * 1000 + 1;
    return verdict.retryAfterSeconds;
  };

  assert.equal(lockOnce(), 1);
  assert.equal(lockOnce(), 2);
  assert.equal(lockOnce(), 4);
  assert.equal(lockOnce(), 8);
  assert.equal(lockOnce(), 8, 'não passa do teto');
});

test('acerto apaga o histórico de falhas', () => {
  const limiter = new AttemptLimiter(LIMITS);
  limiter.registerFailure('ip|maria', 0);
  limiter.registerFailure('ip|maria', 1);
  limiter.registerSuccess('ip|maria');
  assert.equal(limiter.check('ip|maria', 2).remainingAttempts, LIMITS.maxAttempts);
});

test('falha velha sai da janela e não conta mais', () => {
  const limiter = new AttemptLimiter(LIMITS);
  limiter.registerFailure('ip|ana', 0);
  limiter.registerFailure('ip|ana', 1);
  // as duas primeiras já saíram da janela quando a terceira chega
  const late = limiter.registerFailure('ip|ana', LIMITS.windowMs + 2);
  assert.equal(late.allowed, true);
  assert.equal(late.remainingAttempts, LIMITS.maxAttempts - 1);
});

test('chaves de origens diferentes não se contaminam', () => {
  const limiter = new AttemptLimiter(LIMITS);
  for (let i = 0; i < LIMITS.maxAttempts; i += 1) limiter.registerFailure('ip-a|joao', i);
  assert.equal(limiter.check('ip-a|joao', 10).allowed, false);
  assert.equal(limiter.check('ip-b|joao', 10).allowed, true);
});

test('sweep descarta chave fria e preserva a travada', () => {
  const limiter = new AttemptLimiter(LIMITS);
  limiter.registerFailure('fria', 0);
  // esta trava só vence depois do instante da limpeza
  const late = LIMITS.windowMs;
  for (let i = 0; i < LIMITS.maxAttempts; i += 1) limiter.registerFailure('travada', late + i);

  limiter.sweep(late + 10);
  assert.equal(limiter.size(), 1, 'a fria sai, a travada fica');
  assert.equal(limiter.check('travada', late + 10).allowed, false);

  limiter.sweep(late + LIMITS.baseLockMs + 10);
  assert.equal(limiter.size(), 0, 'depois que a trava vence, a chave também sai');
});

test('teto de chamadas por janela conta e reabre', () => {
  const limiter = new RequestLimiter({ max: 2, windowMs: 1_000 });
  assert.equal(limiter.consume('ip', 0).allowed, true);
  assert.equal(limiter.consume('ip', 10).allowed, true);
  const blocked = limiter.consume('ip', 20);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 1);
  assert.equal(limiter.consume('ip', 1_001).allowed, true, 'janela nova, contador zerado');
});

test('senha só confere contra o próprio hash', async () => {
  const hash = await hashPassword('cavalo-bateria-grampo');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(await verifyPassword('cavalo-bateria-grampo', hash), true);
  assert.equal(await verifyPassword('cavalo-bateria-grampa', hash), false);
  assert.equal(await verifyPassword('cavalo-bateria-grampo', 'lixo'), false);
  assert.equal(await verifyPassword('cavalo-bateria-grampo', 'scrypt$a$b$c$d$e'), false);
});

test('duas gravações da mesma senha geram hashes diferentes', async () => {
  const [a, b] = await Promise.all([hashPassword('mesma-senha-1234'), hashPassword('mesma-senha-1234')]);
  assert.notEqual(a, b, 'sal aleatório: hashes iguais entregariam senhas iguais');
});

test('senha fraca é recusada com motivo', () => {
  assert.match(describePasswordProblem('curta') ?? '', /10 caracteres/);
  assert.match(describePasswordProblem('12345678901') ?? '', /só números/);
  assert.match(describePasswordProblem('aaaaaaaaaaaa') ?? '', /repetido/);
  assert.equal(describePasswordProblem('trocar-esta-senha-9'), null);
});

test('sessão assinada sobrevive à ida e volta', () => {
  const token = createSessionToken({ sub: 'uuid-1', label: 'pedro@exemplo.com' }, 'segredo', 1_000, 60_000);
  const session = readSessionToken(token, 'segredo', 2_000);
  assert.equal(session?.sub, 'uuid-1');
  assert.equal(session?.label, 'pedro@exemplo.com');
});

test('sessão morre no prazo, com outro segredo e se mexerem no conteúdo', () => {
  const token = createSessionToken({ sub: 'uuid-1', label: 'pedro' }, 'segredo', 0, 60_000);
  assert.equal(readSessionToken(token, 'segredo', 60_001), null, 'vencida');
  assert.equal(readSessionToken(token, 'outro-segredo', 10), null, 'segredo trocado derruba');

  const [prefix, body, signature] = token.split('.') as [string, string, string];
  const forged = Buffer.from(JSON.stringify({ sub: 'invasor', label: 'x', iat: 0, exp: 9e12 }), 'utf8')
    .toString('base64url');
  assert.equal(readSessionToken(`${prefix}.${forged}.${signature}`, 'segredo', 10), null);
  assert.notEqual(body, forged);
  assert.equal(readSessionToken(undefined, 'segredo'), null);
  assert.equal(readSessionToken('lixo', 'segredo'), null);
});

test('cookie de sessão sai trancado e volta a ser lido', () => {
  const cookie = buildCookie('valor-com espaço', { maxAgeSeconds: 3600, secure: false });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Secure/);
  assert.equal(readCookie('outra=1; operacao_sessao=abc; mais=2', 'operacao_sessao'), 'abc');
  assert.equal(readCookie(undefined, 'operacao_sessao'), undefined);
  assert.equal(readCookie('sem-igual', 'operacao_sessao'), undefined);
});
