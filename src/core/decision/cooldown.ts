import type { Trade, TradingMode } from '../types.ts';

/**
 * Descanso por ativo, derivado do que está GRAVADO.
 *
 * Antes isto era um Map em memória no AutoTrader. Um mapa em memória não é uma
 * regra de risco: é uma lembrança. Reiniciar o servidor apagava o descanso e o
 * robô podia recomprar o mesmo ativo segundos depois de tê-lo vendido — e
 * reiniciar acontece justamente quando algo deu errado, que é quando o
 * descanso mais importa.
 *
 * A fonte da verdade passa a ser a abertura da última operação automática no
 * ativo. Isso sobrevive a reinício porque a operação sobrevive a reinício.
 */
export function symbolCooldownUntil(input: {
  trades: Trade[];
  symbol: string;
  mode: TradingMode;
  cooldownMinutes: number;
}): number | null {
  const { trades, symbol, mode, cooldownMinutes } = input;
  if (cooldownMinutes <= 0) return null;

  let latest: number | null = null;
  for (const trade of trades) {
    if (trade.symbol !== symbol) continue;
    if (trade.mode !== mode) continue;
    // só a compra do robô conta: uma compra manual é uma decisão do usuário e
    // não deve prender o robô, nem o contrário
    if (trade.automatic !== true) continue;
    const openedAt = new Date(trade.openedAt).getTime();
    if (Number.isNaN(openedAt)) continue;
    if (latest === null || openedAt > latest) latest = openedAt;
  }

  if (latest === null) return null;
  return latest + cooldownMinutes * 60_000;
}

/** Todos os descansos ativos agora — para o painel mostrar a hora da liberação. */
export function activeCooldowns(input: {
  trades: Trade[];
  mode: TradingMode;
  cooldownMinutes: number;
  now: number;
}): Array<{ symbol: string; until: string; remainingMinutes: number }> {
  const { trades, mode, cooldownMinutes, now } = input;
  if (cooldownMinutes <= 0) return [];

  const symbols = new Set(
    trades.filter((trade) => trade.automatic === true && trade.mode === mode).map((t) => t.symbol),
  );
  const result: Array<{ symbol: string; until: string; remainingMinutes: number }> = [];
  for (const symbol of symbols) {
    const until = symbolCooldownUntil({ trades, symbol, mode, cooldownMinutes });
    if (until === null || until <= now) continue;
    result.push({
      symbol,
      until: new Date(until).toISOString(),
      remainingMinutes: Math.ceil((until - now) / 60_000),
    });
  }
  return result.sort((a, b) => a.until.localeCompare(b.until));
}
