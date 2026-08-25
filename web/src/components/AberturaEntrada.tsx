import { useEffect, useState } from 'react';

/**
 * Entrada do painel, logo depois do login.
 *
 * Ela não é enfeite: é o tempo em que o painel carrega POR BAIXO. O App é
 * montado no mesmo instante em que esta tela aparece, então os cinco segundos
 * são gastos buscando estado, saldo, setups e preços — quando ela sai, o que
 * está atrás já está pronto, em vez de um esqueleto piscando.
 *
 * A barra é determinada de propósito. Uma barra que anda de ponta a ponta sem
 * fim diz "não sei quanto falta"; esta sabe, porque o tempo é fixo — e saber
 * quanto falta é o que separa esperar de desconfiar.
 */
const DURACAO_MS = 5000;

export function AberturaEntrada({ nome, onFim }: { nome: string | null; onFim: () => void }) {
  const [saindo, setSaindo] = useState(false);

  useEffect(() => {
    // sai um pouco antes do fim para o esvaecimento terminar exatamente em 5s
    const fecha = window.setTimeout(() => setSaindo(true), DURACAO_MS - 320);
    const solta = window.setTimeout(onFim, DURACAO_MS);
    return () => {
      window.clearTimeout(fecha);
      window.clearTimeout(solta);
    };
  }, [onFim]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5 transition-opacity duration-300 ${
        saindo ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
      style={{ background: 'radial-gradient(120% 90% at 50% 0%, #14171d 0%, #0a0b0d 62%)' }}
    >
      <svg viewBox="0 0 32 32" className="h-16 w-16 entrada-marca" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="#121419" />
        <path
          d="M6 23 L13 15 L18 19 L26 9"
          fill="none"
          stroke="#16c784"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="entrada-traco"
        />
      </svg>

      <div className="text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-terminal-text">
          Crypto Hunter
        </p>
        <p className="mt-1 text-[11px] text-terminal-muted">
          {nome ? `Preparando a mesa de ${nome}` : 'Preparando a mesa'}
        </p>
      </div>

      <div className="h-[3px] w-44 overflow-hidden rounded-full bg-terminal-border">
        <div
          className="h-full rounded-full bg-bull entrada-barra"
          style={{ animationDuration: `${DURACAO_MS}ms` }}
        />
      </div>
    </div>
  );
}
