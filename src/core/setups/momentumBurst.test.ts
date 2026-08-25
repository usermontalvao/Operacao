import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle, MarketContext } from '../types.ts';
import { computeIndicators } from '../engines/indicatorEngine.ts';
import { computeStructure } from '../engines/structureEngine.ts';
import { analysisFrom } from '../testing/fixtures.ts';
import { detectMomentumBurst } from './momentumBurst.ts';

function context(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    state: 'BTC_NEUTRAL',
    scoreModifier: 0,
    reasons: [],
    btcPrice: 60000,
    btcChangePercent24h: 0,
    btcTrend4h: 'SIDEWAYS',
    btcTrend1d: 'SIDEWAYS',
    highVolatility: false,
    btcAboveDailyMean: true,
    ...overrides,
  } as MarketContext;
}

/**
 * Série calma seguida de uma barra de explosão sob medida. Os parâmetros da
 * barra final são os que o teste manipula: corpo, volume e fechamento.
 */
function seriesWithBurst(options: {
  bodyMultiple?: number;
  volumeMultiple?: number;
  closeAtTop?: boolean;
  breaksHigh?: boolean;
} = {}): Candle[] {
  const { bodyMultiple = 4, volumeMultiple = 5, closeAtTop = true, breaksHigh = true } = options;
  const candles: Candle[] = [];
  const start = Date.UTC(2026, 0, 1);
  let price = 100;

  // 80 barras de oscilação pequena: é isto que define o ATR e a média de volume
  for (let i = 0; i < 80; i += 1) {
    const drift = i % 2 === 0 ? 0.4 : -0.35;
    const open = price;
    const close = price + drift;
    candles.push({
      openTime: start + i * 3_600_000,
      open,
      high: Math.max(open, close) + 0.2,
      low: Math.min(open, close) - 0.2,
      close,
      volume: 1000,
      quoteVolume: 1000 * close,
      closeTime: start + (i + 1) * 3_600_000 - 1,
      closed: true,
    });
    price = close;
  }

  const reference = 0.8; // ATR aproximado da série acima
  const open = price;
  const close = breaksHigh ? open + reference * bodyMultiple : open + 0.1;
  const high = closeAtTop ? close + 0.05 : close + (close - open);
  const low = open - 0.1;
  candles.push({
    openTime: start + 80 * 3_600_000,
    open,
    high,
    low,
    close,
    volume: 1000 * volumeMultiple,
    quoteVolume: 1000 * volumeMultiple * close,
    closeTime: start + 81 * 3_600_000 - 1,
    closed: true,
  });
  return candles;
}

function detect(candles: Candle[], ctx: MarketContext | null, observedAt?: string) {
  const analysis = analysisFrom('SOLUSDT', candles, ['1h', '4h']);
  const last = candles[candles.length - 1] as Candle;
  analysis.updatedAt = observedAt ?? new Date(last.closeTime + 60_000).toISOString();
  const indicators = computeIndicators(candles, '1h');
  const timeframe = {
    timeframe: '1h' as const,
    candles,
    indicators,
    structure: computeStructure(candles, indicators),
  };
  return detectMomentumBurst({ analysis, trigger: timeframe, anchor: timeframe, context: ctx });
}

test('a explosão vira setup quando corpo, volume, rompimento e regime batem juntos', () => {
  const setup = detect(seriesWithBurst(), context());
  assert.ok(setup, 'a barra de explosão precisa gerar setup');
  assert.equal(setup.setupType, 'MOMENTUM_BURST');
  assert.equal(setup.target2, null, 'alvo único: foi saída inteira que o laboratório mediu');
  assert.equal(setup.target3, null);
  const entry = (setup.entryLow + setup.entryHigh) / 2;
  const risk = entry - setup.stopLoss;
  assert.ok(Math.abs((setup.target1 - entry) / risk - 3) < 0.01, 'o alvo é 3R medidos da entrada');
});

test('a entrada é agora, não numa zona lá embaixo', () => {
  const candles = seriesWithBurst();
  const setup = detect(candles, context());
  assert.ok(setup);
  const close = (candles[candles.length - 1] as Candle).close;
  assert.ok(
    close >= setup.entryLow && close <= setup.entryHigh,
    'o preço do fechamento tem de estar dentro da zona — quem espera repique perde a explosão',
  );
  assert.equal(setup.stopLoss, (candles[candles.length - 1] as Candle).low, 'o stop é o pé da barra');
});

test('sem o regime do BTC não existe setup — foi medido: sem ele nenhuma variante é positiva', () => {
  assert.equal(detect(seriesWithBurst(), context({ btcAboveDailyMean: false })), null);
  assert.equal(detect(seriesWithBurst(), context({ btcAboveDailyMean: null })), null);
  assert.equal(detect(seriesWithBurst(), null), null, 'não saber também não autoriza');
});

test('corpo pequeno não é explosão, mesmo com volume enorme', () => {
  assert.equal(detect(seriesWithBurst({ bodyMultiple: 1, volumeMultiple: 10 }), context()), null);
});

test('volume comum não é explosão, mesmo com corpo enorme', () => {
  assert.equal(detect(seriesWithBurst({ volumeMultiple: 1.5 }), context()), null);
});

test('barra que devolveu metade do avanço não conta: o fechamento tem de ser no topo', () => {
  assert.equal(detect(seriesWithBurst({ closeAtTop: false }), context()), null);
});

test('sem romper a máxima das últimas 40 barras não há rompimento', () => {
  assert.equal(detect(seriesWithBurst({ breaksHigh: false }), context()), null);
});

test('explosão velha não vira setup: a medição entra na abertura da barra seguinte', () => {
  const candles = seriesWithBurst();
  const last = candles[candles.length - 1] as Candle;

  const naHora = detect(candles, context(), new Date(last.closeTime + 5 * 60_000).toISOString());
  assert.ok(naHora, '5 minutos depois do fechamento ainda é a mesma oportunidade');

  const atrasado = detect(candles, context(), new Date(last.closeTime + 3 * 3_600_000).toISOString());
  assert.equal(
    atrasado,
    null,
    'três horas depois é outra aposta — foi assim que o TLMUSDT nasceu 8% abaixo da zona',
  );
});

test('o reinício do servidor não ressuscita uma explosão de horas atrás', () => {
  const candles = seriesWithBurst();
  const last = candles[candles.length - 1] as Candle;
  // a varredura roda de novo do zero, com os mesmos candles em disco
  const rescan = detect(candles, context(), new Date(last.closeTime + 45 * 60_000).toISOString());
  assert.equal(rescan, null, 'candle de 45 min atrás no gatilho de 1h já passou da tolerância');
});
