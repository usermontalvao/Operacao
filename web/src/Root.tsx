import { useCallback, useEffect, useState } from 'react';
import { App } from './App.tsx';
import { Login } from './pages/Login.tsx';
import { SESSION_LOST, readSession, type SessionState } from './lib/auth.ts';

/**
 * Quem decide entre a porta e o painel.
 *
 * O App só é montado depois da sessão confirmada — se ele subisse antes,
 * dispararia uma dúzia de chamadas que voltariam 401 e o painel apareceria
 * por um instante, vazio e piscando erro, antes de sumir.
 *
 * A `key` no App força uma árvore nova a cada entrada: sem isso, um login
 * seguido de outro reaproveitaria o estado vivo do usuário anterior.
 */
export function Root() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [entradas, setEntradas] = useState(0);

  const carregar = useCallback(async () => {
    try {
      setSession(await readSession());
      setErro(null);
    } catch (failure) {
      setErro((failure as Error).message);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  useEffect(() => {
    const aoPerder = (): void => {
      setSession((atual) => (atual ? { ...atual, authenticated: false } : atual));
    };
    window.addEventListener(SESSION_LOST, aoPerder);
    return () => window.removeEventListener(SESSION_LOST, aoPerder);
  }, []);

  if (erro) {
    return (
      <div className="flex min-h-full items-center justify-center px-4">
        <p className="max-w-sm rounded-lg border border-bear/40 bg-bear/10 p-4 text-sm text-bear">
          {erro} — o servidor está rodando?
        </p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <p className="text-sm text-terminal-muted">Carregando…</p>
      </div>
    );
  }

  if (!session.authenticated) {
    return (
      <Login
        session={session}
        onEntered={() => {
          setEntradas((valor) => valor + 1);
          void carregar();
        }}
      />
    );
  }

  return <App key={entradas} userLabel={session.user} onLoggedOut={() => void carregar()} />;
}
