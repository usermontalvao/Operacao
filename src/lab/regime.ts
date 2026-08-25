import { formatTable, groupBy, summarize, type Stats } from '../core/backtest/metrics.ts';
import type { Outcome } from '../core/backtest/types.ts';
import type { Candle } from '../core/types.ts';
import { BASE_POLICY, simulateAll } from './engine.ts';
import { loadKlines } from './klineCache.ts';
import { byWindow, prepare } from './study.ts';

/**
 * A pergunta que as políticas de saída não conseguiram responder.
 *
 * Todas as saídas testadas dão expectativa entre -0,26R e -0,41R: não existe
 * condução que salve uma entrada sem vantagem. Então a pergunta muda de "como
 * sair" para "em que mundo esta entrada funciona" — e o candidato mais óbvio é
 * o regime do mercado. Comprar repique de altcoin com o BTC abaixo da média de
 * 200 dias é uma estratégia diferente de fazer o mesmo com ele acima.
 *
 * Nada aqui olha o futuro: cada característica é lida na série diária ANTES da
 * barra do sinal.
 */

interface DailyPoint {
  closeTime: number;
  close: number;
  sma200: number | null;
  return30d: number | null;
}

function dailySeries(candles: Candle[]): DailyPoint[] {
  const points: DailyPoint[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const bar = candles[i] as Candle;
    let sma: number | null = null;
    if (i >= 199) {
      let total = 0;
      for (let k = i - 199; k <= i; k += 1) total += (candles[k] as Candle).close;
      sma = total / 200;
    }
    const before = candles[i - 30];
    points.push({
      closeTime: bar.closeTime,
      close: bar.close,
      sma200: sma,
      return30d: before && before.close > 0 ? ((bar.close - before.close) / before.close) * 100 : null,
    });
  }
  return points;
}

/** Último ponto JÁ fechado naquele instante — nunca o candle em formação. */
function pointAt(points: DailyPoint[], time: number): DailyPoint | null {
  let low = 0;
  let high = points.length - 1;
  let found: DailyPoint | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const point = points[mid] as DailyPoint;
    if (point.closeTime <= time) {
      found = point;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

function btcRegime(point: DailyPoint | null): string {
  if (!point || point.sma200 === null) return 'sem dados';
  const above = point.close > point.sma200;
  const rising = (point.return30d ?? 0) > 0;
  if (above && rising) return 'BTC alta (acima da média 200 e subindo)';
  if (above) return 'BTC acima da média 200, mas caindo em 30d';
  if (rising) return 'BTC abaixo da média 200, mas subindo em 30d';
  return 'BTC baixa (abaixo da média 200 e caindo)';
}

function bucket(value: number | null, edges: number[], labels: string[]): string {
  if (value === null || !Number.isFinite(value)) return 'sem dados';
  for (let i = 0; i < edges.length; i += 1) {
    if (value < (edges[i] as number)) return labels[i] as string;
  }
  return labels[labels.length - 1] as string;
}

function rows(label: string, groups: Map<string, Outcome[]>, splitAt: number): Stats[] {
  const list: Stats[] = [];
  for (const [name, outcomes] of [...groups].sort()) {
    const windows = byWindow(outcomes, splitAt);
    if (windows.train.length < 40 && windows.test.length < 40) continue;
    list.push(summarize(`T ${label} ${name}`, windows.train));
    list.push(summarize(`t ${label} ${name}`, windows.test));
  }
  return list;
}

async function main(): Promise<void> {
  const { dataset, signals, settings, splitAt } = await prepare();
  const outcomes = simulateAll(signals, dataset, '1h', BASE_POLICY, settings);

  const btcDaily = dailySeries(await loadKlines('BTCUSDT', '1d', 900));
  const coinDaily = new Map<string, DailyPoint[]>();
  for (const entry of dataset) coinDaily.set(entry.symbol, dailySeries(entry.series.get('1d') ?? []));

  // característica de cada operação, lida no instante em que ela nasceu
  const feature = new Map<Outcome, { regime: string; strength: number | null; trend: string }>();
  for (let i = 0; i < outcomes.length; i += 1) {
    const outcome = outcomes[i] as Outcome;
    const signal = signals[i];
    const time = signal?.openTime ?? outcome.openTime;
    const btc = pointAt(btcDaily, time);
    const coin = pointAt(coinDaily.get(outcome.symbol) ?? [], time);
    feature.set(outcome, {
      regime: btcRegime(btc),
      strength:
        coin?.return30d !== null && coin?.return30d !== undefined && btc?.return30d !== null && btc?.return30d !== undefined
          ? coin.return30d - btc.return30d
          : null,
      trend:
        !coin || coin.sma200 === null
          ? 'sem dados'
          : coin.close > coin.sma200
            ? 'moeda acima da média 200'
            : 'moeda abaixo da média 200',
    });
  }

  console.log('\n########## O REGIME DO BTC MUDA O RESULTADO? ##########');
  console.log('TREINO decide; TESTE confirma. Linha com menos de 40 operações na janela é omitida.\n');
  console.log(
    formatTable(rows('', groupBy(outcomes, (item) => feature.get(item)?.regime ?? 'sem dados'), splitAt)),
  );

  console.log('\n########## A MOEDA ACIMA OU ABAIXO DA PRÓPRIA MÉDIA DE 200 DIAS ##########\n');
  console.log(
    formatTable(rows('', groupBy(outcomes, (item) => feature.get(item)?.trend ?? 'sem dados'), splitAt)),
  );

  console.log('\n########## FORÇA RELATIVA: A MOEDA CONTRA O BTC EM 30 DIAS ##########\n');
  console.log(
    formatTable(
      rows(
        '',
        groupBy(outcomes, (item) =>
          bucket(
            feature.get(item)?.strength ?? null,
            [-20, 0, 20],
            ['perdendo muito do BTC', 'perdendo do BTC', 'ganhando do BTC', 'ganhando muito do BTC'],
          ),
        ),
        splitAt,
      ),
    ),
  );

  console.log('\n########## REGIME DO BTC + MOEDA ACIMA DA MÉDIA (a combinação) ##########\n');
  console.log(
    formatTable(
      rows(
        '',
        groupBy(outcomes, (item) => {
          const data = feature.get(item);
          const regime = (data?.regime ?? '').startsWith('BTC alta') ? 'BTC alta' : 'resto';
          const trend = data?.trend === 'moeda acima da média 200' ? 'moeda forte' : 'moeda fraca';
          return `${regime} + ${trend}`;
        }),
        splitAt,
      ),
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
