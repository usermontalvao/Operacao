import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle, MarketContext } from '../types.ts';
import { computeIndicators } from '../engines/indicatorEngine.ts';
import { computeStructure } from '../engines/structureEngine.ts';
import { analysisFrom } from '../testing/fixtures.ts';
import {
  TETO_ABSOLUTO_DE_ATRASO_MS,
  detectMomentumBurst,
  toleranciaDeAtraso,
} from './momentumBurst.ts';

/** Corpo aproximado que a fixture produz para um dado multiplicador. */
function corpoDe(candles: Candle[]): number {
  const bar = candles[candles.length - 1] as Candle;
  return bar.close - bar.open;
}

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

function detect(
  candles: Candle[],
  ctx: MarketContext | null,
  observedAt?: string,
  exigirRegimeDoBtc?: boolean,
) {
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
  return detectMomentumBurst({
    analysis,
    trigger: timeframe,
    anchor: timeframe,
    context: ctx,
    exigirRegimeDoBtc,
  });
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

test('com o filtro ligado (padrão), sem BTC em alta não existe setup', () => {
  assert.equal(detect(seriesWithBurst(), context({ btcAboveDailyMean: false })), null);
  assert.equal(detect(seriesWithBurst(), context({ btcAboveDailyMean: null })), null);
  assert.equal(detect(seriesWithBurst(), null), null, 'não saber também não autoriza');
});

/*
 * O interruptor dos Ajustes tem de mudar o comportamento de verdade — e só
 * ele. Um interruptor que não desliga nada foi exatamente o defeito do
 * "confirmar no candle de 1m", que aparecia na tela e nada lia.
 */
test('com o filtro desligado, a explosão nasce nos dois regimes', () => {
  assert.ok(detect(seriesWithBurst(), context({ btcAboveDailyMean: false }), undefined, false));
  assert.ok(detect(seriesWithBurst(), context({ btcAboveDailyMean: null }), undefined, false));
  assert.ok(detect(seriesWithBurst(), null, undefined, false), 'sem contexto também passa');
});

test('desligar o regime não afrouxa NENHUMA outra exigência', () => {
  const semRegime = { ...context({ btcAboveDailyMean: false }) };
  assert.equal(
    detect(seriesWithBurst({ bodyMultiple: 1, volumeMultiple: 10 }), semRegime, undefined, false),
    null,
    'corpo pequeno continua não sendo explosão',
  );
  assert.equal(
    detect(seriesWithBurst({ volumeMultiple: 1.5 }), semRegime, undefined, false),
    null,
    'volume comum continua não sendo explosão',
  );
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

test('a tolerância de atraso acompanha a volta da varredura, com teto', () => {
  const umaHora = 3_600_000;
  // sem medição vale o número fixo de antes: 15% da barra
  assert.equal(toleranciaDeAtraso(umaHora), 9 * 60_000);

  // com a varredura real medida em produção (12,7 min), a tolerância passa a
  // cobrir uma volta inteira — senão a regra descarta o que o próprio sistema
  // demorou para ver
  assert.equal(toleranciaDeAtraso(umaHora, 761_000), Math.round(761_000 * 1.2));

  // uma volta muito curta não ENCOLHE a tolerância abaixo do que já valia
  assert.equal(toleranciaDeAtraso(umaHora, 60_000), 9 * 60_000);

  // e nenhuma cadência autoriza o desastre que originou a regra (173 min)
  assert.equal(toleranciaDeAtraso(4 * umaHora, 3 * umaHora), TETO_ABSOLUTO_DE_ATRASO_MS);
  assert.ok(toleranciaDeAtraso(4 * umaHora, 3 * umaHora) < 173 * 60_000);

  // nos gatilhos curtos vale o teto relativo: uma volta de 13 minutos não
  // pode autorizar uma explosão de 5m com três barras de idade
  const cincoMin = 5 * 60_000;
  assert.equal(toleranciaDeAtraso(cincoMin, 761_000), cincoMin * 0.5);
  assert.equal(toleranciaDeAtraso(15 * 60_000, 761_000), 15 * 60_000 * 0.5);
});

/*
 * O PISO DO CORPO, no detector de verdade.
 *
 * A fixture constrói a barra final com `bodyMultiple` sobre um ATR de
 * referência de 0,8, então o corpo em ATRs sai próximo do multiplicador. As
 * asserções usam folga porque o ATR real da série é calculado, não fixado —
 * o que importa é a fronteira existir e cair no lugar certo.
 */
test('o piso de 2 ATR: abaixo recusa, em cima aceita', () => {
  assert.equal(detect(seriesWithBurst({ bodyMultiple: 1.5 }), context()), null, '1,5 ATR recusa');
  const aceito = detect(seriesWithBurst({ bodyMultiple: 2.2 }), context());
  assert.ok(aceito, '2,2 ATR tinha de virar setup');
  assert.ok(corpoDe(seriesWithBurst({ bodyMultiple: 2.2 })) > 0);
});

test('o detector avisa a recusa por corpo, com o número que faltou', () => {
  const avisos: Array<Record<string, unknown>> = [];
  const candles = seriesWithBurst({ bodyMultiple: 1.2 });
  const analysis = analysisFrom('SOLUSDT', candles, ['1h', '4h']);
  const last = candles[candles.length - 1] as Candle;
  analysis.updatedAt = new Date(last.closeTime + 60_000).toISOString();
  const indicators = computeIndicators(candles, '1h');
  const timeframe = {
    timeframe: '1h' as const,
    candles,
    indicators,
    structure: computeStructure(candles, indicators),
  };
  detectMomentumBurst({
    analysis,
    trigger: timeframe,
    anchor: timeframe,
    context: context(),
    onRejeicao: (m) => avisos.push(m as unknown as Record<string, unknown>),
  });
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0]?.reason, 'BURST_BODY_BELOW_MINIMUM');
  assert.equal(avisos[0]?.minimum, 2);
  assert.ok(typeof avisos[0]?.burstBodyAtr === 'number');
});
