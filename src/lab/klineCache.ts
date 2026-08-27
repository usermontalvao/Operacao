import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Candle, Timeframe } from '../core/types.ts';

const BASE = 'https://api.binance.com';
const CACHE_DIR = join(process.cwd(), 'data', 'cache', 'klines');
const PAGE = 1000;
/** Pausa entre chamadas: o limite de peso da Binance é por minuto, não por rajada. */
const PACE_MS = 180;

const MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export function intervalMs(timeframe: Timeframe): number {
  return MS[timeframe] ?? 3_600_000;
}

/**
 * Um arquivo histórico não fica correto para sempre.
 *
 * O cache antigo devolvia imediatamente qualquer arquivo não vazio. Assim,
 * `540d` baixado hoje e `900d` baixado ontem terminavam em instantes
 * diferentes e produziam sinais diferentes NA MESMA janela de teste. O
 * último candle completamente encerrado é a fronteira objetiva de frescor.
 */
export function klineCacheIsFresh(
  candles: Candle[],
  timeframe: Timeframe,
  now = Date.now(),
): boolean {
  const last = candles[candles.length - 1];
  if (!last) return false;
  const step = intervalMs(timeframe);
  const latestClosedAt = Math.floor(now / step) * step - 1;
  return last.closeTime >= latestClosedAt;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return (await response.json()) as T;
    // 418/429 = passamos do limite de peso; esperar é a única saída correta
    if (response.status === 429 || response.status === 418 || response.status >= 500) {
      await sleep(2_000 * (attempt + 1));
      continue;
    }
    throw new Error(`${response.status} em ${url}`);
  }
  throw new Error(`falhou depois de 5 tentativas: ${url}`);
}

type RawRow = [number, string, string, string, string, string, number, string, ...unknown[]];

function toCandle(row: RawRow): Candle {
  return {
    openTime: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: row[6],
    quoteVolume: Number(row[7]),
    closed: true,
  };
}

/**
 * Candles históricos, do disco quando já baixados.
 *
 * O último candle é sempre descartado: no momento do download ele ainda está
 * em formação, e um candle pela metade no fim da série contamina o último
 * sinal de todo backtest.
 */
export async function loadKlines(symbol: string, timeframe: Timeframe, days: number): Promise<Candle[]> {
  await mkdir(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${symbol}-${timeframe}-${days}d.json`);
  let cached: Candle[] = [];
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Candle[];
    if (Array.isArray(parsed)) cached = parsed;
    if (klineCacheIsFresh(cached, timeframe)) return cached;
  } catch {
    // sem cache: baixa
  }

  const step = intervalMs(timeframe);
  const start = Date.now() - days * 86_400_000;
  // Se já há histórico, completa a partir da barra seguinte. A deduplicação
  // no fim também torna seguro repetir a última página depois de uma queda.
  const candles: Candle[] = [...cached];
  let cursor = cached.length > 0 ? (cached[cached.length - 1] as Candle).openTime + step : start;

  for (let guard = 0; guard < 200; guard += 1) {
    const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=${timeframe}&startTime=${cursor}&limit=${PAGE}`;
    const rows = await getJson<RawRow[]>(url);
    if (rows.length === 0) break;
    for (const row of rows) candles.push(toCandle(row));
    const last = rows[rows.length - 1] as RawRow;
    if (rows.length < PAGE) break;
    cursor = last[0] + step;
    await sleep(PACE_MS);
  }

  // fora o candle em formação e qualquer duplicata da paginação
  const unique = new Map<number, Candle>();
  for (const candle of candles) unique.set(candle.openTime, candle);
  const ordered = [...unique.values()].sort((a, b) => a.openTime - b.openTime);
  const closedOnly = ordered.filter((candle) => candle.closeTime < Date.now());

  await writeFile(file, JSON.stringify(closedOnly), 'utf8');
  return closedOnly;
}

export interface UniverseEntry {
  symbol: string;
  quoteVolume: number;
}

/**
 * Universo por regra, não por escolha a dedo: pares USDT negociáveis, sem
 * stablecoins nem tokens alavancados, ordenados por volume.
 *
 * Fica registrado o viés que isto NÃO resolve: quem foi deslistado não aparece
 * nesta lista, então o histórico é o dos sobreviventes.
 */
export async function topUsdtSymbols(limit: number, minQuoteVolume: number): Promise<UniverseEntry[]> {
  const info = await getJson<{ symbols: Array<{ symbol: string; status: string; quoteAsset: string; isSpotTradingAllowed: boolean }> }>(
    `${BASE}/api/v3/exchangeInfo`,
  );
  const tradable = new Set(
    info.symbols
      .filter((item) => item.status === 'TRADING' && item.quoteAsset === 'USDT' && item.isSpotTradingAllowed)
      .map((item) => item.symbol),
  );

  const tickers = await getJson<Array<{ symbol: string; quoteVolume: string }>>(`${BASE}/api/v3/ticker/24hr`);
  const stable = /^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EUR|BRL|TRY|AEUR|XUSD|USD1|PYUSD)USDT$/;
  const leveraged = /(UP|DOWN|BULL|BEAR)USDT$/;

  return tickers
    .filter((item) => tradable.has(item.symbol))
    .filter((item) => !stable.test(item.symbol) && !leveraged.test(item.symbol))
    .map((item) => ({ symbol: item.symbol, quoteVolume: Number(item.quoteVolume) }))
    .filter((item) => item.quoteVolume >= minQuoteVolume)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, limit);
}
