import { useEffect } from 'react';
import type { AlertRecord } from '../lib/types.ts';

const AUTO_DISMISS_MS = 6_000;

interface AlertToastsProps {
  alerts: AlertRecord[];
  onOpen: (setupId: string) => void;
  onDismiss: (id: string) => void;
}

/** Aviso breve: abre o setup, mas nunca fica cobrindo o painel indefinidamente. */
export function AlertToasts({ alerts, onOpen, onDismiss }: AlertToastsProps) {
  useEffect(() => {
    const timers = alerts.map((alert) =>
      window.setTimeout(() => onDismiss(alert.id), AUTO_DISMISS_MS),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [alerts, onDismiss]);

  if (alerts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-40 flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:items-end">
      {alerts.slice(0, 1).map((alert) => (
        <div
          key={alert.id}
          className="pointer-events-auto w-full max-w-md rounded-xl border border-bull/40 bg-terminal-panel p-3 shadow-lg"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">🔥 {alert.title}</p>
              <p className="mt-0.5 text-xs text-terminal-muted tabular">{alert.body}</p>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(alert.id)}
              className="text-xs text-terminal-muted hover:text-terminal-text"
            >
              ✕
            </button>
          </div>
          <button
            type="button"
            onClick={() => onOpen(alert.setupId)}
            className="mt-2 w-full rounded-lg bg-bull px-3 py-2 text-xs font-bold text-black"
          >
            VER SETUP
          </button>
        </div>
      ))}
    </div>
  );
}
