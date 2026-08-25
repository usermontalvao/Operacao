import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LoginError, login, type SessionState } from '../lib/auth.ts';
import { Marca } from '../components/Marca.tsx';

interface Props {
  session: SessionState;
  onEntered: () => void;
}

/**
 * Porta de entrada do painel.
 *
 * A tela nunca diz se o erro foi no usuário ou na senha — dizer "usuário não
 * existe" entregaria quais contas existem. O que ela mostra é o que ajuda quem
 * é dono da conta: quantas tentativas ainda restam e, quando a trava fecha,
 * quanto falta para reabrir, contando na tela em vez de deixar a pessoa
 * batendo no botão.
 */
export function Login({ session, onEntered }: Props) {
  const [user, setUser] = useState(session.user ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [lockedFor, setLockedFor] = useState<number>(0);
  const userField = useRef<HTMLInputElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (user) passwordField.current?.focus();
    else userField.current?.focus();
    // só no primeiro desenho: mexer no foco a cada tecla atrapalha quem digita
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // contagem regressiva da trava
  useEffect(() => {
    if (lockedFor <= 0) return;
    const timer = setInterval(() => setLockedFor((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [lockedFor]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || lockedFor > 0) return;
    setBusy(true);
    setMessage(null);
    try {
      await login(user, password);
      setPassword('');
      onEntered();
    } catch (failure) {
      const error = failure as LoginError;
      setMessage(error.message);
      setRemaining(error instanceof LoginError ? error.remainingAttempts : null);
      if (error instanceof LoginError && error.retryAfterSeconds) {
        setLockedFor(error.retryAfterSeconds);
      }
      setPassword('');
      passwordField.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const travado = lockedFor > 0;

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          {/* aqui ela é grande: é a primeira coisa que se vê do sistema */}
          <Marca tamanho={56} className="mb-3" />
          <h1 className="text-lg font-semibold tracking-tight">Operação</h1>
          <p className="mt-1 text-sm text-terminal-muted">
            O painel envia ordens de compra. Entre para continuar.
          </p>
        </div>

        {!session.configured ? (
          <div className="rounded-lg border border-warn/40 bg-warn/10 p-4 text-sm">
            <p className="font-medium text-warn">Supabase Auth ainda não configurado</p>
            <p className="mt-2 text-terminal-muted">
              Confira nas variáveis da stack:
            </p>
            <code className="mt-2 block rounded bg-terminal-bg px-3 py-2 font-mono text-xs text-terminal-text">
              PANEL_USER · SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY
            </code>
            <p className="mt-2 text-terminal-muted">
              A senha é a mesma da conta do Supabase; nenhum hash local é necessário.
            </p>
          </div>
        ) : (
          <form
            onSubmit={(event) => void submit(event)}
            className="rounded-lg border border-terminal-border bg-terminal-panel p-5"
          >
            <label className="block text-xs uppercase tracking-wide text-terminal-muted" htmlFor="usuario">
              {session.backend === 'supabase' ? 'E-mail' : 'Usuário'}
            </label>
            <input
              id="usuario"
              ref={userField}
              value={user}
              onChange={(event) => setUser(event.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              className="mt-1 w-full rounded-md border border-terminal-border bg-terminal-bg px-3 py-2 text-sm outline-none focus:border-info"
            />

            <label
              className="mt-4 block text-xs uppercase tracking-wide text-terminal-muted"
              htmlFor="senha"
            >
              Senha
            </label>
            <input
              id="senha"
              ref={passwordField}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="mt-1 w-full rounded-md border border-terminal-border bg-terminal-bg px-3 py-2 text-sm outline-none focus:border-info"
            />

            <button
              type="submit"
              disabled={busy || travado || !user || !password}
              className="mt-5 w-full rounded-md bg-bull px-3 py-2 text-sm font-medium text-terminal-bg disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Conferindo…' : travado ? `Aguarde ${formatWait(lockedFor)}` : 'Entrar'}
            </button>

            {message ? (
              <p className="mt-3 rounded-md border border-bear/40 bg-bear/10 px-3 py-2 text-sm text-bear">
                {travado ? `Muitas tentativas — tente de novo em ${formatWait(lockedFor)}` : message}
              </p>
            ) : null}

            {!travado && remaining !== null && remaining > 0 ? (
              <p className="mt-2 text-xs text-terminal-muted">
                {remaining === 1
                  ? 'Resta 1 tentativa antes do bloqueio temporário.'
                  : `Restam ${remaining} tentativas antes do bloqueio temporário.`}
              </p>
            ) : null}
          </form>
        )}
      </div>
    </div>
  );
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}min` : `${minutes}min ${rest}s`;
}
