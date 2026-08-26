import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SymbolFilters, Trade, TradeSetup } from '../../core/types.ts';
import { EventBus } from '../events.ts';
import { JsonStore } from '../store/jsonStore.ts';
import { AuditService } from './auditService.ts';
import { CloseService } from './closeService.ts';
import { ExecutionService } from './executionService.ts';
import type { MarketDataService } from './marketDataService.ts';
import { PaperTradingEngine } from './paperTradingEngine.ts';
import { RiskService } from './riskService.ts';
import { SettingsService } from './settingsService.ts';

const FILTERS: SymbolFilters = {
  symbol: 'XRPUSDT',
  baseAsset: 'XRP',
  quoteAsset: 'USDT',
  status: 'TRADING',
  tickSize: 0.0001,
  stepSize: 0.1,
  minQty: 0.1,
  maxQty: 9222449,
  minNotional: 5,
  applyMinToMarket: true,
  baseAssetPrecision: 8,
  quotePrecision: 8,
  isSpotTradingAllowed: true,
  ocoAllowed: false,
  market: 'FUTURES',
  maxLeverage: 20,
};

/** Uma tese VENDIDA: stop acima da entrada, alvos abaixo. */
function makeShortSetup(overrides: Partial<TradeSetup> = {}): TradeSetup {
  return {
    id: 'setup-xrp-short',
    symbol: 'XRPUSDT',
    side: 'SELL',
    market: 'FUTURES',
    timeframe: '4h',
    anchorTimeframe: '1d',
    setupType: 'PULLBACK',
    currentPrice: 1.43,
    entryLow: 1.42,
    entryHigh: 1.45,
    stopLoss: 1.49,
    target1: 1.34,
    target2: 1.28,
    target3: 1.22,
    riskReward: 2.1,
    score: 84,
    classification: 'SETUP_FORTE',
    scoreBreakdown: { total: 84, classification: 'SETUP_FORTE', components: [], penalties: [] },
    reasons: ['Resistência rejeitada no 4H'],
    btcContext: 'BTC_BEARISH',
    status: 'ACTIVE',
    visualState: 'COMPRAVEL',
    extended: false,
    extensionReasons: [],
    evidence: {
      rsi14: 55,
      atrPercent: 1.8,
      relativeVolume: 1.3,
      macdHistogram: -0.002,
      distanceToEma20InAtr: 0.4,
      triggerTrend: 'DOWN',
      anchorTrend: 'DOWN',
      anchorStructure: 'LH_LL',
      levelQuality: 0.8,
      volumeConfirmation: true,
      momentumTurning: true,
      btcScoreModifier: -5,
    },
    fingerprint: 'XRPUSDT:PULLBACK:4h:1.45:S',
    invalidationNote: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ignoredAt: null,
    ...overrides,
  };
}

async function harness(price = 1.43) {
  const directory = await mkdtemp(join(tmpdir(), 'hunter-fut-'));
  const repository = new JsonStore(directory);
  await repository.init();
  const settings = new SettingsService(repository);
  await settings.load();
  await settings.update({
    // o interruptor geral vem primeiro: sem ele a modalidade nem é aceita
    futuresEnabled: true,
    market: 'FUTURES',
    risk: { paperCapital: 1000, paperCapitalCurrency: 'USDT' },
    futures: { leverage: 3, allowShort: true },
    guard: { minNetRiskReward: 1, lossCooldownMinutes: 0, maxDailyTrades: 50 },
  });
  const bus = new EventBus();
  const audit = new AuditService(repository);
  const paper = new PaperTradingEngine(repository, bus, audit, settings);
  let currentPrice = price;
  const market = {
    getPrice: () => currentPrice,
    getSnapshot: () => ({ quoteVolume24h: 500_000_000 }),
  } as unknown as MarketDataService;
  const risk = new RiskService(repository, settings, market);
  const execution = new ExecutionService(repository, settings, market, paper, audit, bus, risk, {
    loadFilters: async () => FILTERS,
    loadUsdtBalance: async () => ({ free: 1000, locked: 0 }),
    loadBrlRate: async () => 5.16,
  });
  const close = new CloseService(repository, paper, market, audit, settings, bus, async () => {});
  return {
    repository,
    settings,
    paper,
    audit,
    execution,
    close,
    setPrice: (value: number) => {
      currentPrice = value;
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('o preview de uma venda alavancada mostra margem e liquidação', async (t) => {
  const context = await harness();
  t.after(context.cleanup);

  const setup = makeShortSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 300 }, setup);

  assert.equal(preview.market, 'FUTURES');
  assert.equal(preview.side, 'SELL');
  assert.equal(preview.leverage, 3);
  assert.equal(preview.canExecute, true, preview.blockers.join(' | '));

  // a margem é o notional dividido pela alavancagem — não o notional
  assert.ok(preview.margin < preview.sizing.notional);
  assert.ok(Math.abs(preview.margin - preview.sizing.notional / 3) < 0.02);

  // vendido: a liquidação fica ACIMA da entrada, e depois do stop
  assert.ok(preview.liquidationPrice !== null);
  assert.ok((preview.liquidationPrice as number) > preview.entryPrice);
  assert.ok((preview.liquidationPrice as number) > setup.stopLoss, 'o stop precisa vir antes');

  // o risco no stop continua sendo o orçamento de 1% do patrimônio
  assert.ok(preview.riskSizing.riskPercentOfEquity <= 1.01);
});

test('venda a descoberto é recusada em spot e quando não está liberada', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  const setup = makeShortSetup();

  await context.settings.update({ futures: { allowShort: false } });
  const bloqueado = await context.execution.preview({ setupId: setup.id, quoteAmount: 300 }, setup);
  assert.equal(bloqueado.canExecute, false);
  assert.ok(bloqueado.blockers.some((item) => /não está liberada/i.test(item)));

  // o SELETOR da tela não decide mais onde a ordem cai: quem decide é a tese
  // clicada. Com as duas colunas no radar, olhar spot e clicar numa tese de
  // futuros é o caminho normal, não um erro
  // libera a venda NO BALDE DE FUTUROS e depois leva a tela para spot: o
  // ajuste é de cada modalidade, e mandar os dois no mesmo patch escreveria
  // `allowShort` no balde do spot, onde ele não significa nada
  await context.settings.update({ futures: { allowShort: true } });
  await context.settings.update({ market: 'SPOT' });
  const comSeletorEmSpot = await context.execution.preview(
    { setupId: setup.id, quoteAmount: 300 },
    setup,
  );
  assert.equal(comSeletorEmSpot.market, 'FUTURES');
  assert.deepEqual(comSeletorEmSpot.blockers, [], 'o seletor da tela não pode bloquear a tese');
  assert.equal(comSeletorEmSpot.canExecute, true);

  // a trava continua de pé para quem forçar a modalidade errada por dentro
  const forcadoEmSpot = await context.execution.preview(
    { setupId: setup.id, quoteAmount: 300 },
    setup,
    false,
    'PAPER',
    'SPOT',
  );
  assert.equal(forcadoEmSpot.canExecute, false);
  assert.ok(forcadoEmSpot.blockers.some((item) => /só existe em futuros/i.test(item)));
});

test('alavancagem que coloca a liquidação antes do stop é bloqueio, com o máximo seguro junto', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  // stop a ~4% da entrada com 10x: a corretora liquidaria por volta de -9,5%…
  // o suficiente para o teste é que o painel recuse e diga qual serve
  await context.settings.update({ futures: { leverage: 10, maxLeverage: 10 } });

  const setup = makeShortSetup({ stopLoss: 1.62, target1: 1.2 });
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 300 }, setup);

  assert.equal(preview.canExecute, false);
  assert.ok(preview.blockers.some((item) => /liquidação/i.test(item)), preview.blockers.join(' | '));
  assert.ok(preview.safeLeverage !== null && (preview.safeLeverage as number) < 10);
});

test('a demo vendida ganha quando o preço cai, e a margem volta para o caixa', async (t) => {
  const context = await harness(1.43);
  t.after(context.cleanup);

  const setup = makeShortSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 300 }, setup);
  const trade = await context.execution.execute(
    {
      setupId: setup.id,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: 'venda-demo',
    },
    setup,
  );

  assert.equal(trade.market, 'FUTURES');
  assert.equal(trade.side, 'SELL');
  assert.equal(trade.leverage, 3);
  assert.equal(trade.status, 'OPEN', 'o preço já está na zona: preenche na hora');
  assert.ok(trade.initialMargin > 0 && trade.initialMargin < trade.notional);

  // caiu até o alvo 1: metade da posição sai com lucro
  context.setPrice(1.34);
  await context.paper.onPrice('XRPUSDT', 1.34);
  const parcial = context.paper.getTrade(trade.id) as Trade;
  assert.ok(parcial.realizedPnl > 0, `vendido deveria ganhar na queda: ${parcial.realizedPnl}`);
  assert.ok(parcial.remainingQuantity < trade.filledQuantity);

  // e a excursão favorável é medida para baixo
  assert.ok(parcial.maxFavorablePercent > 0);
});

test('a demo vendida perde quando o preço sobe até o stop', async (t) => {
  const context = await harness(1.43);
  t.after(context.cleanup);

  const setup = makeShortSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 300 }, setup);
  const trade = await context.execution.execute(
    {
      setupId: setup.id,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: 'venda-stop',
    },
    setup,
  );

  context.setPrice(1.5);
  await context.paper.onPrice('XRPUSDT', 1.5);
  const fechada = context.paper.getTrade(trade.id) ?? (await context.repository.listTrades()).find(
    (item) => item.id === trade.id,
  );

  assert.ok(fechada);
  assert.equal(fechada?.status, 'CLOSED');
  assert.equal(fechada?.outcome, 'STOP');
  assert.ok((fechada?.realizedPnl ?? 0) < 0);
  // o prejuízo fica na ordem do orçamento de risco, não da margem inteira
  assert.ok(Math.abs(fechada?.realizedPnl ?? 0) < (fechada?.initialMargin ?? 0));
});

test('o robô não opera vendido — o laboratório mediu só a compra', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  await context.settings.update({
    autoTrade: { enabled: true, minimumScore: 90 },
  });

  const setup = makeShortSetup({ setupType: 'MOMENTUM_BURST', score: 95, target2: null, target3: null });
  const trade = await context.execution.executeAutomatic(setup, 'PAPER');
  assert.equal(trade, null);

  const audit = await context.audit.list(20);
  const recusa = audit.find((entry) => entry.action === 'AUTO_TRADE_SKIPPED');
  assert.ok(recusa, 'a recusa precisa deixar rastro');
  assert.match(JSON.stringify(recusa?.detail ?? {}), /vendida/i);
});

test('a carteira de papel de futuros é separada da de spot', async (t) => {
  const context = await harness();
  t.after(context.cleanup);

  const setup = makeShortSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 300 }, setup);
  await context.execution.execute(
    {
      setupId: setup.id,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: 'carteira-separada',
    },
    setup,
  );

  const futuros = await context.execution.getCapital('PAPER', 'FUTURES');
  const spot = await context.execution.getCapital('PAPER', 'SPOT');

  assert.ok(futuros.available < spot.available, 'a margem presa é da conta de futuros');
  assert.equal(spot.available, spot.capital, 'a demo de spot continua intacta');
});

test('a modalidade da ordem é a da TESE, não a do seletor da tela', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  await context.settings.update({ market: 'SPOT' });

  // é o caminho normal com as duas colunas: olhando spot, clicando em futuros
  const setup = makeShortSetup({ side: 'BUY', stopLoss: 1.35, target1: 1.58, target2: null, target3: null });
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 300 }, setup);

  assert.equal(preview.market, 'FUTURES');
  assert.ok(preview.leverage > 1, 'a alavancagem da modalidade tem de aparecer');
  assert.ok(preview.liquidationPrice !== null, 'futuros sempre tem linha de liquidação');
  assert.ok(
    !preview.blockers.some((item) => /modalidade ativa é outra/i.test(item)),
    `o seletor não pode recusar a tese: ${preview.blockers.join(' | ')}`,
  );
});

test('a alavancagem do modal vale para a ordem, e o teto dos ajustes não é furado', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  await context.settings.update({ futures: { leverage: 3, maxLeverage: 5 } });

  const setup = makeShortSetup({ side: 'BUY', stopLoss: 1.35, target1: 1.58, target2: null, target3: null });

  const padrao = await context.execution.preview({ setupId: setup.id, quoteAmount: 300 }, setup);
  assert.equal(padrao.leverage, 3, 'sem pedir nada, vale a alavancagem dos ajustes');

  const pedida = await context.execution.preview(
    { setupId: setup.id, quoteAmount: 300, leverage: 5 },
    setup,
  );
  assert.equal(pedida.leverage, 5);
  // mais alavancagem = menos margem presa, e o RISCO no stop não se mexe
  assert.ok(pedida.margin < padrao.margin, 'com mais alavancagem a posição prende menos margem');
  assert.equal(pedida.sizing.riskAmount, padrao.sizing.riskAmount);

  // e o teto dos ajustes segura: pedir 10 com teto 5 entrega 5
  const furada = await context.execution.preview(
    { setupId: setup.id, quoteAmount: 300, leverage: 10 },
    setup,
  );
  assert.equal(furada.leverage, 5, 'o modal não é caminho para furar o teto configurado');
});

test('o R/R do preview é o do preço de AGORA, não o de quando a tese nasceu', async (t) => {
  // o caso real (ONT): a tese nasceu com entrada em 0,05199 e R/R 1:2,7. O
  // preço subiu para dentro da zona; nesse preço o alvo está mais perto e o
  // stop mais longe, e o R/R real é 1,6. A tela mostrava 2,7 e o painel
  // recusava a ordem falando de um número que não aparecia em lugar nenhum
  const context = await harness(0.052715);
  t.after(context.cleanup);

  const setup = makeShortSetup({
    side: 'BUY',
    symbol: 'XRPUSDT',
    currentPrice: 0.052715,
    entryLow: 0.0515,
    entryHigh: 0.0535,
    stopLoss: 0.050257,
    target1: 0.05667,
    target2: null,
    target3: null,
    riskReward: 2.7,
  });

  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 200 }, setup);

  assert.equal(preview.entryPrice, 0.052715);
  assert.ok(
    Math.abs(preview.sizing.riskReward - 1.61) < 0.05,
    `esperava ~1,61 no preço de agora, veio ${preview.sizing.riskReward}`,
  );
  assert.notEqual(preview.sizing.riskReward, 2.7, 'o R/R gravado na tese não pode vazar para a ordem');
  // e o líquido, que é quem decide, fica ABAIXO do bruto: taxa e escorregamento
  assert.ok(preview.netRiskReward < preview.sizing.riskReward);
});

test('R/R manual abaixo do mínimo explica a trava sem prometer que a ordem está liberada', async (t) => {
  const context = await harness(0.052715);
  t.after(context.cleanup);
  await context.settings.update({ guard: { minNetRiskReward: 1.8 } });

  const setup = makeShortSetup({
    side: 'BUY',
    currentPrice: 0.052715,
    entryLow: 0.0515,
    entryHigh: 0.0535,
    stopLoss: 0.050257,
    target1: 0.05667,
    target2: 0.05887,
    target3: 0.065,
  });
  const preview = await context.execution.preview(
    { setupId: setup.id, percentOfCapital: 10, leverage: 3 },
    setup,
  );

  assert.equal(preview.canExecute, false);
  assert.ok(preview.blockers.some((item) => /R\/R líquido.+abaixo do mínimo/i.test(item)));
  assert.ok(
    preview.warnings.some((item) => /demais travas de risco continuam valendo/i.test(item)),
  );
  assert.ok(!preview.warnings.some((item) => /ordem manual segue liberada/i.test(item)));
  assert.equal(new Set(preview.warnings).size, preview.warnings.length, 'avisos não podem se repetir');
  assert.ok(
    preview.warnings.some((item) => /valor pedido/i.test(item)),
    '10% escolhido pelo usuário, e não o arredondamento do lote, limita a posição',
  );
  assert.ok(!preview.warnings.some((item) => /passo de lote/i.test(item)));
});

test('dá para encerrar uma posição de futuros com a tela em spot', async (t) => {
  const context = await harness(1.43);
  t.after(context.cleanup);

  const setup = makeShortSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 300 }, setup);
  const trade = await context.execution.execute(
    {
      setupId: setup.id,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: 'fechar-de-outra-aba',
    },
    setup,
  );
  assert.equal(trade.market, 'FUTURES');

  // a carteira lista as duas modalidades de propósito; o botão "Encerrar" não
  // pode responder "troque de modalidade" bem na hora em que se quer sair
  await context.settings.update({ market: 'SPOT' });
  const fechada = await context.close.close(trade.id, 'saída manual de outra aba');

  assert.equal(fechada.status, 'CLOSED');
  assert.equal(fechada.outcome, 'MANUAL');
});

test('a ordem forçada desarma a trava de POLÍTICA e nada além dela', async (t) => {
  const context = await harness(1.43);
  t.after(context.cleanup);
  // R/R mínimo alto o bastante para recusar a tese
  await context.settings.update({ guard: { minNetRiskReward: 9 } });

  const setup = makeShortSetup();
  const normal = await context.execution.preview({ setupId: setup.id, quoteAmount: 300 }, setup);
  assert.equal(normal.canExecute, false);
  assert.equal(normal.canOverride, true, 'só falta a confirmação — o atalho tem de aparecer');
  assert.ok(normal.overridableBlockers.some((item) => /R\/R líquido/.test(item)));

  const forcada = await context.execution.preview(
    { setupId: setup.id, quoteAmount: 300, override: true },
    setup,
  );
  assert.equal(forcada.canExecute, true, forcada.blockers.join(' | '));
  assert.equal(forcada.overridden, true);
  assert.ok(forcada.warnings.some((item) => /ORDEM FORÇADA/.test(item)));
  assert.ok(forcada.confirmationToken, 'a ordem forçada precisa de token como qualquer outra');

  // e a ordem sai mesmo, deixando rastro com nome próprio
  const trade = await context.execution.execute(
    {
      setupId: setup.id,
      confirmationToken: forcada.confirmationToken as string,
      idempotencyKey: 'forcada-uma-vez',
    },
    setup,
  );
  // preço dentro da zona preenche na hora; o que importa é que a ordem SAIU
  assert.ok(trade.status === 'PENDING' || trade.status === 'OPEN', trade.status);

  const audit = await context.audit.list(30);
  const registro = audit.find((entry) => entry.action === 'ORDER_OVERRIDE');
  assert.ok(registro, 'uma ordem que passou por cima das travas precisa ser encontrável sozinha');
  assert.match(JSON.stringify(registro?.detail ?? {}), /R\/R líquido/);
});

test('forçar não cria dinheiro: a ordem nunca passa do saldo que existe', async (t) => {
  const context = await harness(1.43);
  t.after(context.cleanup);
  await context.settings.update({ risk: { paperCapital: 12, paperCapitalCurrency: 'USDT' } });

  const setup = makeShortSetup();
  // pede quatrocentas vezes o que a carteira tem, com as travas desarmadas
  const forcada = await context.execution.preview(
    { setupId: setup.id, quoteAmount: 5_000, override: true },
    setup,
  );

  // o painel não recusa: ele ENCOLHE. O que não pode, em hipótese nenhuma, é
  // a margem exigida passar do saldo — override desarma régua, não aritmética
  assert.ok(
    forcada.margin <= forcada.available + 0.01,
    `margem ${forcada.margin} não cabe no disponível ${forcada.available}`,
  );
  assert.ok(forcada.sizing.notional <= forcada.available * 10 + 0.01, 'nem a alavancagem cria saldo');
});

test('saldo que não existe recusa mesmo com as travas desarmadas', async (t) => {
  const context = await harness(1.43);
  t.after(context.cleanup);
  // carteira menor que o mínimo de nocional da corretora: não há tamanho que sirva
  await context.settings.update({ risk: { paperCapital: 1, paperCapitalCurrency: 'USDT' } });

  const setup = makeShortSetup();
  const forcada = await context.execution.preview(
    { setupId: setup.id, quoteAmount: 50, override: true },
    setup,
  );

  assert.equal(forcada.canExecute, false, 'nenhuma confirmação inventa saldo');
  assert.equal(forcada.confirmationToken, null);
  assert.ok(
    [...forcada.blockers, ...forcada.filterErrors].length > 0,
    'a recusa precisa dizer o motivo',
  );
});

test('o robô nunca recebe o atalho: override não vem de entrada automática', async (t) => {
  const context = await harness(1.43);
  t.after(context.cleanup);
  await context.settings.update({
    autoTrade: { enabled: true, minimumScore: 50 },
    guard: { minNetRiskReward: 9 },
  });

  const setup = makeShortSetup({ side: 'BUY', setupType: 'MOMENTUM_BURST', score: 95 });
  const trade = await context.execution.executeAutomatic(setup, 'PAPER');
  assert.equal(trade, null, 'o robô não pode se autoconceder a confirmação do usuário');
});
