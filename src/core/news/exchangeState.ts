import type { SymbolFilters } from '../types.ts';
import type { MarketEvent } from './types.ts';

/**
 * Camada 1 do monitor: o que a própria corretora declara sobre cada par.
 *
 * É a única fonte que não depende de ninguém publicar texto: o exchangeInfo é
 * documentado, público e sempre atual. Se o par saiu de TRADING, não há
 * notícia a interpretar — ele simplesmente não é operável, e o sistema precisa
 * saber disso antes de mandar uma ordem que a corretora vai recusar.
 *
 * Os eventos daqui são de ESTADO, não de notícia: eles são recalculados do
 * zero a cada leitura. Quando o par volta a negociar, o bloqueio some sozinho,
 * sem ninguém precisar retirá-lo.
 */
export function stateEventsFrom(symbols: SymbolFilters[], now: Date): MarketEvent[] {
  const observedAt = now.toISOString();
  const events: MarketEvent[] = [];

  for (const item of symbols) {
    if (item.status === 'TRADING' && item.isSpotTradingAllowed) continue;
    const halted = item.status !== 'TRADING';
    events.push({
      id: `exchangeInfo:${item.symbol}:${item.status}:${item.isSpotTradingAllowed}`,
      source: 'exchangeInfo',
      kind: halted ? 'TRADING_HALTED' : 'RULES_CHANGED',
      symbols: [item.symbol],
      severity: 'BLOCK',
      confidence: 1,
      title: halted
        ? `${item.symbol} não está negociando (${item.status})`
        : `${item.symbol} sem permissão de spot`,
      detail: `status=${item.status} spot=${item.isSpotTradingAllowed}`,
      observedAt,
      expiresAt: null,
    });
  }

  return events;
}

/**
 * O que MUDOU entre duas leituras. Diferente do estado, isto é notícia: o par
 * que sumiu da lista foi deslistado, e some justamente por isso — o estado
 * sozinho não conseguiria contar essa história.
 */
export function transitionEventsFrom(
  previous: SymbolFilters[] | null,
  current: SymbolFilters[],
  now: Date,
): MarketEvent[] {
  if (previous === null || previous.length === 0) return [];
  const observedAt = now.toISOString();
  const before = new Map(previous.map((item) => [item.symbol, item]));
  const after = new Map(current.map((item) => [item.symbol, item]));
  const events: MarketEvent[] = [];

  for (const [symbol, item] of before) {
    if (after.has(symbol)) continue;
    events.push({
      id: `exchangeInfo:removed:${symbol}`,
      source: 'exchangeInfo',
      kind: 'DELISTING',
      symbols: [symbol],
      severity: 'BLOCK',
      confidence: 1,
      title: `${symbol} saiu da lista de pares da corretora`,
      detail: `estava em ${item.status}; não aparece mais no exchangeInfo`,
      observedAt,
      expiresAt: null,
    });
  }

  for (const [symbol, item] of after) {
    const old = before.get(symbol);
    if (!old) {
      events.push({
        id: `exchangeInfo:listed:${symbol}`,
        source: 'exchangeInfo',
        kind: 'LISTING',
        symbols: [symbol],
        severity: 'INFORM',
        confidence: 1,
        title: `${symbol} passou a ser negociado`,
        detail: 'par novo — sem histórico suficiente para as regras de estrutura',
        observedAt,
        expiresAt: null,
      });
      continue;
    }
    if (old.minNotional !== item.minNotional || old.stepSize !== item.stepSize || old.tickSize !== item.tickSize) {
      events.push({
        id: `exchangeInfo:filters:${symbol}:${item.minNotional}:${item.stepSize}:${item.tickSize}`,
        source: 'exchangeInfo',
        kind: 'RULES_CHANGED',
        symbols: [symbol],
        severity: 'INFORM',
        confidence: 1,
        title: `${symbol} mudou os filtros de ordem`,
        detail:
          `minNotional ${old.minNotional} -> ${item.minNotional}, ` +
          `stepSize ${old.stepSize} -> ${item.stepSize}, tickSize ${old.tickSize} -> ${item.tickSize}`,
        observedAt,
        expiresAt: null,
      });
    }
  }

  return events;
}
