import { config } from './config.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel];

const SENSITIVE = /(api[_-]?key|api[_-]?secret|signature|authorization|x-mbx-apikey|token|secret)/i;

/** Nenhum segredo pode vazar em log — nem por acidente, dentro de um objeto. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/(signature=)[A-Fa-f0-9]+/g, '$1***');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE.test(key) ? '***' : redact(item);
    }
    return out;
  }
  return value;
}

function emit(level: keyof typeof LEVELS, message: string, meta?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  if (meta === undefined) console[level === 'debug' ? 'log' : level](line);
  else console[level === 'debug' ? 'log' : level](line, JSON.stringify(redact(meta)));
}

export const logger = {
  debug: (message: string, meta?: unknown) => emit('debug', message, meta),
  info: (message: string, meta?: unknown) => emit('info', message, meta),
  warn: (message: string, meta?: unknown) => emit('warn', message, meta),
  error: (message: string, meta?: unknown) => emit('error', message, meta),
};
