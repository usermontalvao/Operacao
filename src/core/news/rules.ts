import type { MarketEvent, SymbolVerdict } from './types.ts';

/** Quanto uma notícia de risco médio encolhe a posição. */
export const REDUCE_FACTOR = 0.5;
/** Abaixo desta confiança o evento só informa — não bloqueia nem encolhe. */
export const MIN_ACTIONABLE_CONFIDENCE = 0.6;

/** O evento ainda vale agora? Manutenção que terminou não bloqueia mais nada. */
export function isActive(event: MarketEvent, now: Date): boolean {
  if (event.expiresAt === null) return true;
  const expires = Date.parse(event.expiresAt);
  return Number.isFinite(expires) ? expires > now.getTime() : true;
}

/**
 * Veredito de um ativo diante do que se sabe sobre ele agora.
 *
 * Bloquear é definitivo dentro da janela do evento; reduzir é multiplicativo,
 * porque dois motivos independentes para desconfiar valem mais que um.
 */
export function verdictFor(symbol: string, events: MarketEvent[], now: Date): SymbolVerdict {
  const relevant = events.filter(
    (event) => event.symbols.includes(symbol) && isActive(event, now),
  );

  const reasons: string[] = [];
  const applied: MarketEvent[] = [];
  let blocked = false;
  let sizeFactor = 1;

  for (const event of relevant) {
    if (event.severity === 'INFORM' || event.confidence < MIN_ACTIONABLE_CONFIDENCE) continue;
    applied.push(event);
    reasons.push(`${event.title} (${event.source})`);
    if (event.severity === 'BLOCK') {
      blocked = true;
      sizeFactor = 0;
    } else if (!blocked) {
      sizeFactor *= REDUCE_FACTOR;
    }
  }

  return { symbol, blocked, sizeFactor: blocked ? 0 : sizeFactor, reasons, events: applied };
}

/**
 * Junta eventos de fontes diferentes. O primeiro a chegar com um id vence, mas
 * a severidade sobe: se uma fonte diz "manutenção" e outra diz "suspenso", o
 * ativo fica bloqueado, não reduzido.
 */
export function mergeEvents(existing: MarketEvent[], incoming: MarketEvent[]): MarketEvent[] {
  const byId = new Map(existing.map((event) => [event.id, event]));
  for (const event of incoming) {
    const current = byId.get(event.id);
    if (!current) {
      byId.set(event.id, event);
      continue;
    }
    byId.set(event.id, {
      ...current,
      severity: strongest(current.severity, event.severity),
      confidence: Math.max(current.confidence, event.confidence),
      // a janela mais longa manda: o risco só acaba quando o último acaba
      expiresAt: longestWindow(current.expiresAt, event.expiresAt),
    });
  }
  return [...byId.values()];
}

function strongest(a: MarketEvent['severity'], b: MarketEvent['severity']): MarketEvent['severity'] {
  const rank = { INFORM: 0, REDUCE: 1, BLOCK: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

function longestWindow(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}
