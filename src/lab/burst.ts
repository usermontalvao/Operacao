import type { Candle } from '../core/types.ts';
import { loadKlines, topUsdtSymbols } from './klineCache.ts';

/**
 * A tese do scalper, medida antes de ser construída.
 *
 * As saídas todas empataram entre si em -0,26R e -0,41R: com a entrada atual,
 * conduzir a posição não muda nada. Isso é assinatura de entrada sem vantagem.
 * Então aqui se testa uma entrada DIFERENTE — a oposta, na verdade: em vez de
 * esperar o repique, comprar a força no momento em que ela aparece (candle de
 * corpo grande, volume alto, fechando na máxima de N barras) e sair rápido.
 *
 * Regras honestas do teste:
 *  - a entrada é na ABERTURA da barra seguinte, nunca no fechamento do sinal;
 *  - dentro da barra, stop antes de alvo (a convenção pessimista);
 *  - custos nas duas pontas;
 *  - uma posição por par de cada vez;
 *  - treino decide, teste confirma.
 */

const FEE = 0.1;
const SLIP = 0.15;

interface Params {
  bodyAtr: number;
  volumeMultiple: number;
  lookback: number;
  stopAtr: number;
  targetR: number;
  maxBars: number;
  label: string;
}

interface Trade {
  symbol: string;
  openTime: number;
  rMultiple: number;
  win: boolean;
  bars: number;
}

function atr14(candles: Candle[]): number[] {
  const out: number[] = new Array(candles.length).fill(0);
  let previous = candles[0]?.close ?? 0;
  const ranges: number[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const bar = candles[i] as Candle;
    const range = Math.max(bar.high - bar.low, Math.abs(bar.high - previous), Math.abs(bar.low - previous));
    ranges.push(range);
    previous = bar.close;
    if (i >= 14) {
      let total = 0;
      for (let k = i - 13; k <= i; k += 1) total += ranges[k] as number;
      out[i] = total / 14;
    }
  }
  return out;
}

function averageVolume(candles: Candle[], length: number): number[] {
  const out: number[] = new Array(candles.length).fill(0);
  for (let i = length; i < candles.length; i += 1) {
    let total = 0;
    for (let k = i - length + 1; k <= i; k += 1) total += (candles[k] as Candle).volume;
    out[i] = total / length;
  }
  return out;
}

function run(symbol: string, candles: Candle[], params: Params, allow: (time: number) => boolean): Trade[] {
  const atr = atr14(candles);
  const volume = averageVolume(candles, 20);
  const trades: Trade[] = [];
  let busyUntil = -1;

  for (let i = 60; i < candles.length - 2; i += 1) {
    if (i <= busyUntil) continue;
    const bar = candles[i] as Candle;
    const range = bar.high - bar.low;
    const body = bar.close - bar.open;
    const reference = atr[i] as number;
    if (reference <= 0 || range <= 0) continue;

    // 1. corpo grande de alta
    if (body <= 0 || body < params.bodyAtr * reference) continue;
    // 2. fecha na parte de cima da própria barra: quem comprou está no lucro
    if ((bar.close - bar.low) / range < 0.7) continue;
    // 3. volume acima do normal — é isso que separa força de ruído
    if ((volume[i] as number) <= 0 || bar.volume < params.volumeMultiple * (volume[i] as number)) continue;
    // 4. rompimento: fecha acima da máxima das últimas N barras
    let highest = 0;
    for (let k = i - params.lookback; k < i; k += 1) highest = Math.max(highest, (candles[k] as Candle).high);
    if (bar.close < highest) continue;
    if (!allow(bar.closeTime)) continue;

    const next = candles[i + 1] as Candle;
    const entry = next.open * (1 + SLIP / 100);
    const stop = Math.min(bar.low, entry - params.stopAtr * reference);
    const risk = entry - stop;
    if (risk <= 0) continue;
    const target = entry + params.targetR * risk;

    let exit: number | null = null;
    let bars = 0;
    for (let k = i + 1; k < Math.min(i + 1 + params.maxBars, candles.length); k += 1) {
      const forward = candles[k] as Candle;
      bars = k - i;
      if (forward.low <= stop) {
        exit = stop * (1 - SLIP / 100);
        break;
      }
      if (forward.high >= target) {
        exit = target;
        break;
      }
    }
    if (exit === null) {
      const last = candles[Math.min(i + params.maxBars, candles.length - 1)] as Candle;
      exit = last.close * (1 - SLIP / 100);
    }

    const gross = exit - entry;
    const fees = (entry + exit) * (FEE / 100);
    trades.push({
      symbol,
      openTime: bar.closeTime,
      rMultiple: (gross - fees) / risk,
      win: gross - fees > 0,
      bars,
    });
    busyUntil = i + bars;
  }

  return trades;
}

function stats(label: string, trades: Trade[]): string {
  if (trades.length === 0) return `${label.padEnd(38)} sem operações`;
  const wins = trades.filter((item) => item.rMultiple > 0);
  const grossWin = wins.reduce((total, item) => total + item.rMultiple, 0);
  const grossLoss = trades
    .filter((item) => item.rMultiple < 0)
    .reduce((total, item) => total + Math.abs(item.rMultiple), 0);
  const total = trades.reduce((sum, item) => sum + item.rMultiple, 0);
  const pf = grossLoss === 0 ? Infinity : grossWin / grossLoss;
  return [
    label.padEnd(38),
    String(trades.length).padStart(6),
    `${((wins.length / trades.length) * 100).toFixed(1)}%`.padStart(7),
    (total / trades.length).toFixed(3).padStart(8),
    pf.toFixed(2).padStart(6),
    total.toFixed(1).padStart(8),
  ].join(' ');
}

const VARIANTS: Params[] = [
  { label: 'corpo 1,5 ATR · vol 3x · 20 barras · 2R', bodyAtr: 1.5, volumeMultiple: 3, lookback: 20, stopAtr: 0, targetR: 2, maxBars: 24 },
  { label: 'corpo 2,0 ATR · vol 3x · 40 barras · 2R', bodyAtr: 2.0, volumeMultiple: 3, lookback: 40, stopAtr: 0, targetR: 2, maxBars: 24 },
  { label: 'corpo 2,0 ATR · vol 4x · 40 barras · 2R', bodyAtr: 2.0, volumeMultiple: 4, lookback: 40, stopAtr: 0, targetR: 2, maxBars: 24 },
  { label: 'corpo 2,5 ATR · vol 3x · 40 barras · 2R', bodyAtr: 2.5, volumeMultiple: 3, lookback: 40, stopAtr: 0, targetR: 2, maxBars: 24 },
  { label: 'corpo 2,5 ATR · vol 4x · 60 barras · 2R', bodyAtr: 2.5, volumeMultiple: 4, lookback: 60, stopAtr: 0, targetR: 2, maxBars: 24 },
  { label: 'corpo 3,0 ATR · vol 4x · 60 barras · 2R', bodyAtr: 3.0, volumeMultiple: 4, lookback: 60, stopAtr: 0, targetR: 2, maxBars: 24 },
  { label: 'corpo 2,0 ATR · vol 3x · 40 barras · 1,5R', bodyAtr: 2.0, volumeMultiple: 3, lookback: 40, stopAtr: 0, targetR: 1.5, maxBars: 24 },
  { label: 'corpo 2,0 ATR · vol 3x · 40 barras · 3R', bodyAtr: 2.0, volumeMultiple: 3, lookback: 40, stopAtr: 0, targetR: 3, maxBars: 48 },
  { label: 'corpo 2,0 ATR · vol 3x · 40 barras · 2R · 12 barras', bodyAtr: 2.0, volumeMultiple: 3, lookback: 40, stopAtr: 0, targetR: 2, maxBars: 12 },
  { label: 'corpo 2,0 ATR · vol 3x · 40 barras · 2R · 72 barras', bodyAtr: 2.0, volumeMultiple: 3, lookback: 40, stopAtr: 0, targetR: 2, maxBars: 72 },
];

const TF = (process.argv.find((a) => a.startsWith('--tf='))?.split('=')[1] ?? '1h') as '1h' | '4h';

async function main(): Promise<void> {
  const days = 900;
  const universe = await topUsdtSymbols(40, 3_000_000);
  const series = new Map<string, Candle[]>();
  for (const item of universe) {
    const candles = await loadKlines(item.symbol, TF, days);
    if (candles.length > (TF === '4h' ? 500 : 2000)) series.set(item.symbol, candles);
  }

  // regime do BTC pela média de 200 dias, lido no instante do sinal
  const btcDaily = await loadKlines('BTCUSDT', '1d', days);
  const regime: Array<{ time: number; up: boolean }> = [];
  for (let i = 199; i < btcDaily.length; i += 1) {
    let total = 0;
    for (let k = i - 199; k <= i; k += 1) total += (btcDaily[k] as Candle).close;
    regime.push({ time: (btcDaily[i] as Candle).closeTime, up: (btcDaily[i] as Candle).close > total / 200 });
  }
  const btcUp = (time: number): boolean => {
    let low = 0;
    let high = regime.length - 1;
    let found = false;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const entry = regime[mid] as { time: number; up: boolean };
      if (entry.time <= time) {
        found = entry.up;
        low = mid + 1;
      } else high = mid - 1;
    }
    return found;
  };

  const times = [...series.values()].flatMap((candles) => [
    (candles[0] as Candle).closeTime,
    (candles[candles.length - 1] as Candle).closeTime,
  ]);
  const first = Math.min(...times);
  const last = Math.max(...times);
  const splitAt = first + (last - first) * 0.65;

  console.log(`gatilho ${TF} | ${series.size} pares | treino até ${new Date(splitAt).toISOString().slice(0, 10)}`);
  console.log('\n########## ENTRADA POR EXPLOSÃO (a tese do scalper) ##########\n');
  console.log(
    'variante'.padEnd(38) + 'oper.'.padStart(7) + 'acerto'.padStart(8) + 'expec.R'.padStart(9) + 'PF'.padStart(7) + 'totalR'.padStart(9),
  );
  console.log('-'.repeat(80));

  for (const params of VARIANTS) {
    for (const [filterName, allow] of [
      ['', () => true],
      [' · só com BTC acima da média 200', (time: number) => btcUp(time)],
    ] as Array<[string, (time: number) => boolean]>) {
      const trades: Trade[] = [];
      for (const [symbol, candles] of series) trades.push(...run(symbol, candles, params, allow));
      const train = trades.filter((item) => item.openTime < splitAt);
      const test = trades.filter((item) => item.openTime >= splitAt);
      console.log(stats(`T ${params.label}${filterName}`, train));
      console.log(stats(`t ${params.label}${filterName}`, test));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
