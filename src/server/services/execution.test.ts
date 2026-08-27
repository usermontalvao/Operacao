import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SymbolFilters, TradeSetup } from '../../core/types.ts';
import { EventBus } from '../events.ts';
import { JsonStore } from '../store/jsonStore.ts';
import { AuditService } from './auditService.ts';
import {
  ExecutionService,
  hasActiveLiveArm,
  manualLimitPrice,
  patrimonio,
} from './executionService.ts';
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
  ocoAllowed: true,
  market: 'SPOT',
};

test('armamento real aceita prazo ou permanência explícita, nunca null como sem prazo', () => {
  const now = Date.parse('2026-08-26T12:00:00.000Z');
  assert.equal(
    hasActiveLiveArm({ liveArmedUntil: null, liveArmedIndefinitely: false }, now),
    false,
  );
  assert.equal(
    hasActiveLiveArm(
      { liveArmedUntil: '2026-08-26T13:00:00.000Z', liveArmedIndefinitely: false },
      now,
    ),
    true,
  );
  assert.equal(
    hasActiveLiveArm(
      { liveArmedUntil: '2026-08-26T11:00:00.000Z', liveArmedIndefinitely: false },
      now,
    ),
    false,
  );
  assert.equal(
    hasActiveLiveArm({ liveArmedUntil: null, liveArmedIndefinitely: true }, now),
    true,
  );
});

function makeSetup(overrides: Partial<TradeSetup> = {}): TradeSetup {
  return {
    id: 'setup-xrp-1',
    symbol: 'XRPUSDT',
    side: 'BUY',
    market: 'SPOT',
    timeframe: '4h',
    anchorTimeframe: '1d',
    setupType: 'PULLBACK',
    currentPrice: 1.43,
    entryLow: 1.41,
    entryHigh: 1.44,
    stopLoss: 1.37,
    target1: 1.52,
    target2: 1.61,
    target3: 1.7,
    riskReward: 2.1,
    score: 84,
    classification: 'SETUP_FORTE',
    scoreBreakdown: { total: 84, classification: 'SETUP_FORTE', components: [], penalties: [] },
    reasons: ['Suporte defendido no 4H'],
    btcContext: 'BTC_NEUTRAL',
    status: 'ACTIVE',
    visualState: 'COMPRAVEL',
    extended: false,
    extensionReasons: [],
    evidence: {
      rsi14: 45,
      atrPercent: 1.8,
      relativeVolume: 1.3,
      macdHistogram: 0.002,
      distanceToEma20InAtr: -0.4,
      triggerTrend: 'UP',
      anchorTrend: 'UP',
      anchorStructure: 'HH_HL',
      levelQuality: 0.8,
      volumeConfirmation: true,
      momentumTurning: true,
      btcScoreModifier: 5,
    },
    fingerprint: 'XRPUSDT:PULLBACK:4h:1.41',
    invalidationNote: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ignoredAt: null,
    ...overrides,
  };
}

function makeAutomaticSetup(overrides: Partial<TradeSetup> = {}): TradeSetup {
  return makeSetup({
    setupType: 'MOMENTUM_BURST',
    score: 90,
    riskReward: 3,
    target1: 1.61,
    target2: null,
    target3: null,
    fingerprint: 'XRPUSDT:MOMENTUM_BURST:4h:1.44',
    ...overrides,
  });
}

async function harness(price = 1.43) {
  const directory = await mkdtemp(join(tmpdir(), 'hunter-test-'));
  const repository = new JsonStore(directory);
  await repository.init();
  const settings = new SettingsService(repository);
  await settings.load();
  await settings.update({
    risk: { paperCapital: 1000, paperCapitalCurrency: 'USDT' },
    // o disjuntor tem testes próprios; aqui ele fica frouxo de propósito para
    // que estas provas falem só sobre o caminho da ordem
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
  let saldo: {
    free: number;
    locked: number;
    idle?: Array<{ asset: string; free: number; locked?: number }>;
  } = {
    free: 1000,
    locked: 0,
  };
  const execution = new ExecutionService(repository, settings, market, paper, audit, bus, risk, {
    loadFilters: async () => FILTERS,
    loadUsdtBalance: async () => saldo,
    loadBrlRate: async () => 5.16,
  });
  return {
    directory,
    setBalance: (value: typeof saldo) => {
      saldo = value;
    },
    repository,
    settings,
    paper,
    audit,
    risk,
    execution,
    setPrice: (value: number) => {
      currentPrice = value;
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test('preview calcula quantidade, risco e devolve token de confirmação', async (t) => {
  const context = await harness();
  t.after(context.cleanup);

  const preview = await context.execution.preview(
    { setupId: 'setup-xrp-1', quoteAmount: 200 },
    makeSetup(),
  );

  assert.equal(preview.mode, 'PAPER');
  assert.equal(preview.entryPrice, 1.43);
  assert.equal(preview.sizing.quantity, 139.8, 'quantidade arredondada pelo stepSize');
  assert.ok(preview.sizing.riskAmount > 0);
  assert.equal(preview.canExecute, true);
  assert.ok(preview.confirmationToken);
  assert.equal(preview.blockers.length, 0);
});

test('preview em percentual do capital respeita o saldo disponível', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  const preview = await context.execution.preview(
    { setupId: 'setup-xrp-1', percentOfCapital: 10 },
    makeSetup(),
  );
  assert.equal(preview.available, 1000);

  // 10% de 1000 são 100 USDT, mas o passo de lote (0,1) arredonda a quantidade
  // para baixo — e o valor tem de acompanhar. Antes o notional continuava
  // dizendo 100 enquanto a quantidade já era a arredondada: dois números na
  // mesma tela que não fechavam entre si.
  assert.ok(preview.sizing.notional <= 100, 'nunca acima do pedido');
  assert.ok(preview.sizing.notional > 99, 'nem tão abaixo a ponto de indicar outro limite');
  assert.equal(
    preview.sizing.notional,
    Math.round(preview.sizing.quantity * preview.entryPrice * 100) / 100,
    'valor e quantidade precisam descrever a MESMA ordem',
  );
});

test('compra manual spot honra o valor escolhido e transforma política em aviso', async (t) => {
  const context = await harness(0.002334);
  t.after(context.cleanup);
  await context.settings.update({
    risk: { paperCapital: 24.36, paperCapitalCurrency: 'USDT' },
    guard: { minNetRiskReward: 1.8, maxAltExposurePercent: 40 },
  });
  const setup = makeSetup({
    symbol: 'CELRUSDT',
    currentPrice: 0.002334,
    entryLow: 0.00232,
    entryHigh: 0.00235,
    stopLoss: 0.002249,
    target1: 0.00247,
    target2: 0.002535,
    target3: 0.002623,
  });

  const preview = await context.execution.preview(
    { setupId: setup.id, percentOfCapital: 50 },
    setup,
  );

  assert.ok(preview.sizing.notional > 12.17 && preview.sizing.notional <= 12.18);
  assert.equal(preview.canExecute, true, preview.blockers.join(' | '));
  assert.equal(preview.overridden, true);
  assert.equal(preview.blockers.length, 0);
  assert.ok(preview.overridableBlockers.some((item) => item.includes('R/R líquido')));
  assert.ok(preview.overridableBlockers.some((item) => item.includes('Exposição em altcoins')));
  assert.ok(preview.warnings.some((item) => item.includes('ORDEM MANUAL')));

  const semSaldo = await context.execution.preview(
    { setupId: setup.id, quoteAmount: 30 },
    setup,
  );
  assert.equal(semSaldo.canExecute, false, 'confirmação não cria saldo que não existe');
  assert.ok(semSaldo.blockers.some((item) => item.includes('Saldo insuficiente')));
});

test('ordem só é criada com o token da confirmação que o usuário aprovou', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  const setup = makeSetup();

  await assert.rejects(
    context.execution.execute(
      {
        setupId: setup.id,
        confirmationToken: 'ZmFsc28.deadbeef',
        idempotencyKey: 'chave-invalida-1',
      },
      setup,
    ),
    /não conferem|inválida|expirou/i,
  );

  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 200 }, setup);
  const trade = await context.execution.execute(
    {
      setupId: setup.id,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: 'chave-valida-1',
    },
    setup,
  );
  assert.equal(trade.mode, 'PAPER');
  assert.equal(trade.symbol, 'XRPUSDT');
  assert.equal(trade.status, 'OPEN', 'preço dentro da zona preenche na hora');
  assert.equal(trade.filledQuantity, 139.8);
});

test('compra manual no DEMO entra agora, mesmo com o preço acima da antiga zona', async (t) => {
  const context = await harness(1.5);
  t.after(context.cleanup);
  const setup = makeSetup({
    currentPrice: 1.5,
    entryLow: 1.41,
    entryHigh: 1.44,
    stopLoss: 1.37,
    target1: 1.75,
    target2: null,
    target3: null,
  });

  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 200 }, setup);
  assert.equal(preview.entryPrice, 1.5, 'o modal precisa mostrar o preço em que vai entrar');
  assert.equal(preview.canExecute, true, preview.blockers.join(' | '));

  const trade = await context.execution.execute(
    {
      setupId: setup.id,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: 'manual-entra-agora',
    },
    setup,
  );

  assert.equal(trade.status, 'OPEN');
  assert.equal(trade.averageFillPrice, 1.5);
  assert.ok(trade.fills.some((item) => item.kind === 'ENTRY'));
});

test('entrada manual aceita só a pequena tolerância além da zona', () => {
  const compra = makeSetup({ side: 'BUY', entryLow: 1, entryHigh: 1.1 });
  assert.equal(manualLimitPrice(1.105, compra, 0.5), 1.105, '0,45% acima deve entrar agora');
  assert.equal(manualLimitPrice(1.106, compra, 0.5), 1.1, '0,55% acima deve esperar na zona');

  const venda = makeSetup({ side: 'SELL', entryLow: 1, entryHigh: 1.1 });
  assert.equal(manualLimitPrice(0.996, venda, 0.5), 0.996, '0,4% abaixo deve entrar agora');
  assert.equal(manualLimitPrice(0.994, venda, 0.5), 1, '0,6% abaixo deve esperar na zona');
});

test('tolerância manual não é herdada pelo robô', async (t) => {
  const context = await harness(1.445);
  t.after(context.cleanup);
  await context.settings.update({ mode: 'TESTNET' });
  const setup = makeAutomaticSetup({
    currentPrice: 1.445,
    entryLow: 1.41,
    entryHigh: 1.44,
    stopLoss: 1.37,
    target1: 1.7,
  });

  const manual = await context.execution.preview({ setupId: setup.id, quoteAmount: 20 }, setup);
  const automatic = await context.execution.preview(
    { setupId: setup.id, quoteAmount: 20 },
    setup,
    true,
  );

  assert.equal(manual.entryPrice, 1.445, '0,35% acima está dentro da margem manual');
  assert.equal(automatic.entryPrice, 1.44, 'o robô continua sem perseguir o preço');
  assert.ok(manual.warnings.some((item) => /dentro da tolerância/i.test(item)));
});

test('token preserva o plano aprovado mesmo se o radar mudar depois', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  const setup = makeSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 200 }, setup);
  const token = preview.confirmationToken as string;

  const trade = await context.execution.execute(
    { setupId: setup.id, confirmationToken: token, idempotencyKey: 'plano-mudou' },
    { ...setup, stopLoss: 1.39 },
  );
  assert.equal(trade.stopLoss, setup.stopLoss, 'quem manda é o plano assinado que apareceu na confirmação');

  // token válido apontando para outro setup
  await assert.rejects(
    context.execution.execute(
      { setupId: 'setup-xrp-9', confirmationToken: token, idempotencyKey: 'outro-setup' },
      makeSetup({ id: 'setup-xrp-9' }),
    ),
    /outro setup/i,
  );

  // assinatura adulterada
  const [body] = token.split('.');
  await assert.rejects(
    context.execution.execute(
      { setupId: setup.id, confirmationToken: `${body}.00`, idempotencyKey: 'assinatura-falsa' },
      setup,
    ),
    /não conferem/i,
  );
});

test('plano ajustado no gráfico atravessa preview, token e operação', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  const setup = makeSetup();
  const adjusted = {
    stopLoss: 1.39,
    target1: 1.55,
    target2: 1.62,
    target3: 1.7,
  };

  const preview = await context.execution.preview(
    { setupId: setup.id, quoteAmount: 200, ...adjusted },
    setup,
  );
  assert.deepEqual(
    {
      stopLoss: preview.setup.stopLoss,
      target1: preview.setup.target1,
      target2: preview.setup.target2,
      target3: preview.setup.target3,
    },
    adjusted,
  );
  assert.ok(preview.confirmationToken, preview.blockers.join(' | '));

  const trade = await context.execution.execute(
    {
      setupId: setup.id,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: 'plano-personalizado',
    },
    setup,
  );
  assert.equal(trade.stopLoss, adjusted.stopLoss);
  assert.equal(trade.target1, adjusted.target1);
  assert.equal(trade.target2, adjusted.target2);
  assert.equal(trade.target3, adjusted.target3);
});

test('robô compra na conta de teste e não empilha no mesmo ativo', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  const setup = makeAutomaticSetup();

  await context.settings.update({
    autoTrade: { enabled: true, percentOfCapital: 20, minimumScore: 90, maxNotionalPerTrade: 500 },
  });
  const trade = await context.execution.executeAutomatic(setup);
  assert.ok(trade, 'esperava uma operação automática no modo PAPER');
  assert.equal(trade.automatic, true);
  assert.equal(trade.mode, 'PAPER');
  assert.equal(trade.status, 'OPEN');

  // segunda tentativa no mesmo setup não vira ordem nenhuma
  assert.equal(await context.execution.executeAutomatic(setup), null);
  // nem em outro setup do mesmo ativo: a exposição seria dobrada no mesmo risco
  assert.equal(
    await context.execution.executeAutomatic(makeAutomaticSetup({ id: 'setup-xrp-2', fingerprint: 'outro' })),
    null,
  );
  assert.equal((await context.repository.listTrades()).length, 1);
});

test('robô PAPER usa o caixa demo mesmo quando a tela está na conta LIVE', async (t) => {
  const context = await harness();
  t.after(context.cleanup);

  // Primeiro configura a sessão PAPER; depois apenas muda a conta exibida.
  await context.settings.update({
    autoTrade: { enabled: true, percentOfCapital: 20, minimumScore: 90, maxNotionalPerTrade: 50 },
  });
  await context.settings.update({ mode: 'LIVE' });
  context.setBalance({ free: 24.42, locked: 0 });

  const trade = await context.execution.executeAutomatic(makeAutomaticSetup(), 'PAPER');

  assert.ok(trade, 'o saldo real pequeno não pode bloquear a sessão demo');
  assert.equal(trade.mode, 'PAPER');
  assert.ok(trade.notional > 24.42, 'a ordem deve ter sido dimensionada pelo capital demo');
});

test('teto por ordem limita a compra automática mesmo com percentual alto', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  await context.settings.update({
    autoTrade: {
      enabled: true,
      percentOfCapital: 90,
      minimumScore: 90,
      maxNotionalPerTrade: 40,
    },
  });
  const trade = await context.execution.executeAutomatic(makeAutomaticSetup());
  assert.ok(trade, 'esperava a operação');
  assert.ok(trade.notional <= 40.5, `notional ${trade.notional} deveria respeitar o teto de 40`);
});

test('robô não compra estratégia que foi negativa no treino e no teste', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  await context.settings.update({ autoTrade: { enabled: true, minimumScore: 90 } });

  const trade = await context.execution.executeAutomatic(makeSetup({ score: 99, riskReward: 5 }));

  assert.equal(trade, null, 'score alto não pode autorizar uma estratégia sem vantagem medida');
  assert.equal((await context.repository.listTrades()).length, 0);
  const audit = await context.audit.list(20);
  assert.ok(audit.some((entry) => entry.action === 'AUTO_TRADE_SKIPPED'));
});

test('conta real exige as duas chaves: servidor e armamento no painel', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  await context.settings.update({
    autoTrade: { enabled: true, percentOfCapital: 20, minimumScore: 90 },
    mode: 'LIVE',
  });

  // sem nada liberado
  assert.equal(await context.execution.executeAutomatic(makeAutomaticSetup({ id: 'live-1' })), null);

  // liberado nos ajustes, mas ainda desarmado
  await context.settings.update({ autoTrade: { allowLive: true } });
  assert.equal(await context.execution.executeAutomatic(makeAutomaticSetup({ id: 'live-2' })), null);

  // armado, porém com o armamento já vencido
  await context.settings.update({
    autoTrade: { liveArmedUntil: new Date(Date.now() - 60_000).toISOString() },
  });
  assert.equal(await context.execution.executeAutomatic(makeAutomaticSetup({ id: 'live-3' })), null);

  const audit = await context.audit.list(50);
  const blocked = audit.filter((entry) => entry.action === 'AUTO_TRADE_BLOCKED_LIVE');
  assert.equal(blocked.length, 3, 'cada recusa precisa deixar rastro na auditoria');
  assert.equal((await context.repository.listTrades()).length, 0);
});

test('desligar o robô desarma a conta real junto', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  await context.settings.update({
    autoTrade: {
      enabled: true,
      allowLive: true,
      liveArmedUntil: new Date(Date.now() + 600_000).toISOString(),
    },
  });
  assert.ok(context.settings.get().autoTrade.liveArmedUntil !== null);

  const off = await context.settings.update({ autoTrade: { enabled: false } });
  assert.equal(off.autoTrade.liveArmedUntil, null, 'religar não pode herdar o armamento antigo');
});

test('clique duplo não cria duas ordens', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  const setup = makeSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 200 }, setup);
  const request = {
    setupId: setup.id,
    confirmationToken: preview.confirmationToken as string,
    idempotencyKey: 'clique-duplo',
  };

  const [first, second] = await Promise.all([
    context.execution.execute(request, setup),
    context.execution.execute(request, setup),
  ]);
  const third = await context.execution.execute(request, setup);

  assert.equal(first.id, second.id);
  assert.equal(first.id, third.id);
  const trades = await context.repository.listTrades();
  assert.equal(trades.length, 1);
});

test('paper trade percorre entrada, alvos e fechamento com PnL', async (t) => {
  const context = await harness(1.43);
  t.after(context.cleanup);
  const setup = makeSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 200 }, setup);
  const trade = await context.execution.execute(
    {
      setupId: setup.id,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: 'ciclo-completo',
    },
    setup,
  );
  assert.equal(trade.status, 'OPEN');

  await context.paper.onPrice('XRPUSDT', 1.52);
  let current = context.paper.getOpenTrades()[0];
  assert.ok(current);
  assert.ok(current.fills.some((fill) => fill.kind === 'TARGET1'), 'alvo 1 realiza parcial');
  assert.ok(current.realizedPnl > 0);

  await context.paper.onPrice('XRPUSDT', 1.61);
  await context.paper.onPrice('XRPUSDT', 1.7);

  const trades = await context.repository.listTrades();
  const closed = trades[0];
  assert.ok(closed);
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.outcome, 'TARGET3');
  assert.equal(closed.remainingQuantity, 0);
  assert.ok(closed.realizedPnl > 20, `esperava lucro relevante, veio ${closed.realizedPnl}`);
  assert.ok(closed.maxFavorablePercent >= 18);
});

test('stop encerra a operação com prejuízo controlado', async (t) => {
  const context = await harness(1.43);
  t.after(context.cleanup);
  const setup = makeSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 200 }, setup);
  await context.execution.execute(
    {
      setupId: setup.id,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: 'stopado',
    },
    setup,
  );

  await context.paper.onPrice('XRPUSDT', 1.4);
  await context.paper.onPrice('XRPUSDT', 1.36);

  const trades = await context.repository.listTrades();
  const closed = trades[0];
  assert.ok(closed);
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.outcome, 'STOP');
  assert.ok(closed.realizedPnl < 0);
  assert.ok(closed.maxAdversePercent < 0);
});

test('limite de operações abertas vira aviso na compra manual', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  await context.settings.update({ risk: { maxOpenTrades: 1 } });
  const setup = makeSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 200 }, setup);
  await context.execution.execute(
    {
      setupId: setup.id,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: 'primeira-ordem',
    },
    setup,
  );

  const second = makeSetup({ id: 'setup-xrp-2', fingerprint: 'XRPUSDT:PULLBACK:1h:1.41' });
  const blocked = await context.execution.preview({ setupId: second.id, quoteAmount: 100 }, second);
  assert.equal(blocked.canExecute, true, blocked.blockers.join(' | '));
  assert.equal(blocked.overridden, true);
  assert.ok(blocked.overridableBlockers.some((item) => item.includes('operações abertas')));
});

test('setup inválido não pode ser comprado', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  const dead = makeSetup({ status: 'INVALIDATED' });
  const preview = await context.execution.preview({ setupId: dead.id, quoteAmount: 100 }, dead);
  assert.equal(preview.canExecute, false);
  assert.ok(preview.blockers.some((item) => item.includes('não está mais válido')));
});

test('corretagem sai do resultado e fica registrada', async (t) => {
  const context = await harness(1.43);
  t.after(context.cleanup);
  const setup = makeSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 200 }, setup);
  const trade = await context.execution.execute(
    { setupId: setup.id, confirmationToken: preview.confirmationToken as string, idempotencyKey: 'taxa-1' },
    setup,
  );

  // a taxa da compra já é cobrada no preenchimento
  const afterEntry = context.paper.getOpenTrades().find((item) => item.id === trade.id);
  assert.ok(afterEntry && afterEntry.feesPaid > 0, 'entrada tem de cobrar corretagem');

  await context.paper.onPrice('XRPUSDT', 1.52);
  await context.paper.onPrice('XRPUSDT', 1.61);
  await context.paper.onPrice('XRPUSDT', 1.7);

  const closed = (await context.repository.listTrades())[0];
  assert.ok(closed);
  assert.equal(closed.status, 'CLOSED');

  const quantity = closed.filledQuantity;
  const grossTarget1 = (1.52 - 1.43) * quantity * 0.5;
  const grossTarget2 = (1.61 - 1.43) * quantity * 0.3;
  const grossTarget3 = (1.7 - 1.43) * quantity * 0.2;
  const gross = grossTarget1 + grossTarget2 + grossTarget3;
  assert.ok(
    closed.realizedPnl < gross,
    `líquido ${closed.realizedPnl} deveria ficar abaixo do bruto ${gross.toFixed(2)}`,
  );
  assert.ok(closed.feesPaid > 0, 'a corretagem paga precisa ficar gravada');
  assert.ok(
    Math.abs(gross - closed.realizedPnl - closed.feesPaid) < 0.05,
    'bruto menos taxa tem de bater com o líquido',
  );
});

test('depois do alvo 1 o stop vai para o empate e a operação não vira prejuízo', async (t) => {
  const context = await harness(1.43);
  t.after(context.cleanup);
  const setup = makeSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 200 }, setup);
  const trade = await context.execution.execute(
    { setupId: setup.id, confirmationToken: preview.confirmationToken as string, idempotencyKey: 'empate-1' },
    setup,
  );

  await context.paper.onPrice('XRPUSDT', 1.52);
  const afterTarget = context.paper.getOpenTrades().find((item) => item.id === trade.id);
  assert.ok(afterTarget, 'a posição continua aberta com a sobra');
  assert.ok(
    afterTarget.stopLoss > 1.43,
    `stop deveria ter subido para o empate, ficou em ${afterTarget.stopLoss}`,
  );
  assert.equal(afterTarget.protectiveStop, afterTarget.stopLoss);

  // o preço volta até onde ficava o stop original: antes isso era prejuízo
  await context.paper.onPrice('XRPUSDT', 1.37);
  const closed = (await context.repository.listTrades()).find((item) => item.id === trade.id);
  assert.ok(closed);
  assert.equal(closed.status, 'CLOSED');
  assert.ok(
    closed.realizedPnl > 0,
    `com o stop no empate o resultado não pode ser negativo, veio ${closed.realizedPnl}`,
  );
});

test('encerramento manual sai a mercado, com escorregamento e taxa', async (t) => {
  const context = await harness(1.43);
  t.after(context.cleanup);
  const setup = makeSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 200 }, setup);
  const trade = await context.execution.execute(
    { setupId: setup.id, confirmationToken: preview.confirmationToken as string, idempotencyKey: 'manual-1' },
    setup,
  );

  const closed = await context.paper.closeAtMarket(trade, 1.48, 'encerrado pelo usuário');
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.outcome, 'MANUAL');
  assert.equal(closed.closeReason, 'encerrado pelo usuário');
  assert.equal(closed.remainingQuantity, 0);

  const gross = (1.48 - 1.43) * closed.filledQuantity;
  assert.ok(
    closed.realizedPnl < gross,
    `saída a mercado não pode render o preço cheio: ${closed.realizedPnl} vs ${gross.toFixed(2)}`,
  );
  assert.ok(closed.realizedPnl > 0);
});

test('saldo que não é USDT aparece como aviso — o depósito chegou, na moeda errada', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  await context.settings.update({ mode: 'TESTNET' });
  // a conta tem 5 USDT e 100 BRL: o painel conta 5 e precisa DIZER dos 100
  context.setBalance({ free: 5.08, locked: 0, idle: [{ asset: 'BRL', free: 100 }] });

  const setup = makeSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 5 }, setup);

  assert.equal(preview.available, 5.08, 'o capital continua sendo só o USDT');
  assert.ok(
    preview.warnings.some((item) => /100 BRL/.test(item) && /Converta na Binance/.test(item)),
    `esperava o aviso do saldo parado, veio: ${preview.warnings.join(' | ')}`,
  );
});

test('moeda parada vira UM aviso, e a da posição aberta não entra nele', async (t) => {
  const context = await harness();
  t.after(context.cleanup);

  // uma posição aberta em XRP, na mesma conta que o preview vai avaliar
  const setup = makeSetup();
  const primeira = await context.execution.preview({ setupId: setup.id, quoteAmount: 200 }, setup);
  const aberta = await context.execution.execute(
    {
      setupId: setup.id,
      confirmationToken: primeira.confirmationToken as string,
      idempotencyKey: 'chave-poeira',
    },
    setup,
  );
  await context.settings.update({ mode: 'TESTNET' });
  context.paper.track({ ...aberta, mode: 'TESTNET' });

  /*
   * A conta real de 26/08/2026: seis moedas listadas, seis avisos idênticos de
   * trinta palavras cada. Cinco eram resíduo de venda antiga (centavos que a
   * corretora nem aceita vender) e a sexta era a posição que o sistema ACABOU
   * de abrir — mandando converter justamente o que ele comprou de propósito.
   */
  context.setBalance({
    free: 500,
    locked: 0,
    idle: [
      { asset: 'XRP', free: 100 },
      { asset: 'BRL', free: 100 },
      { asset: 'PEPE', free: 0.0000001 },
    ],
  });

  const depois = await context.execution.preview({ setupId: setup.id, quoteAmount: 50 }, setup);
  const avisos = depois.warnings.filter((item) => /Converta na Binance/.test(item));

  assert.equal(avisos.length, 1, `esperava um aviso só, veio: ${avisos.join(' | ')}`);
  assert.ok(!/XRP/.test(avisos[0] as string), 'a moeda da posição aberta não é dinheiro parado');
  assert.ok(!/PEPE/.test(avisos[0] as string), 'resíduo abaixo do mínimo não vira aviso');
  assert.ok(/BRL/.test(avisos[0] as string));
});

test('em spot, capital é caixa MAIS o valor das moedas — inclusive o preso na proteção', async (t) => {
  const context = await harness(218.19);
  t.after(context.cleanup);
  await context.settings.update({ mode: 'TESTNET' });
  /*
   * O retrato da conta real em 26/08/2026: 1,07 USDT em caixa e uma posição de
   * NVDAB com quase tudo preso na ordem OCO de venda. O sistema lia 1,07 como
   * capital, e o teto de exposição — que compara contra a posição inteira —
   * nunca fechava: 80% de 1,07 é 0,86, e 0,86 não cabe 23,78.
   */
  context.setBalance({
    free: 1.07,
    locked: 0,
    idle: [{ asset: 'NVDAB', free: 0.000891, locked: 0.108 }],
  });

  const capital = await context.execution.getCapital('TESTNET', 'SPOT');

  assert.equal(capital.available, 1.07, 'só o caixa pode ser gasto');
  assert.equal(capital.capital, 1.07, 'capital continua sendo o caixa');
  assert.ok(
    patrimonio(capital) > 24 && patrimonio(capital) < 25,
    `o patrimônio devia somar as moedas (~24,85), veio ${patrimonio(capital)}`,
  );
});

test('moeda sem preço vivo fica de fora do capital — errar para menos é o lado seguro', async (t) => {
  const context = await harness();
  t.after(context.cleanup);
  await context.settings.update({ mode: 'TESTNET' });
  context.setPrice(0);
  context.setBalance({ free: 10, locked: 0, idle: [{ asset: 'XYZ', free: 1_000 }] });

  const capital = await context.execution.getCapital('TESTNET', 'SPOT');

  assert.equal(patrimonio(capital), 10, 'sem cotação, a moeda não vira patrimônio inventado');
});

test('posição gravada como aberta volta para a memória do motor', async (t) => {
  const context = await harness();
  t.after(context.cleanup);

  const setup = makeSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 200 }, setup);
  const trade = await context.execution.execute(
    {
      setupId: setup.id,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: 'chave-reconcilia',
    },
    setup,
  );
  assert.ok(context.paper.getTrade(trade.id), 'a operação precisa nascer em memória');

  // simula o que aconteceu em 26/08/2026: a operação continua gravada como
  // aberta, mas sumiu do mapa que o monitor da conta real percorre
  context.paper.track({ ...trade, status: 'CLOSED' });
  assert.equal(context.paper.getOpenTrades().length, 0);

  const recuperadas = context.paper.reconcile(await context.repository.listTrades());

  assert.equal(recuperadas.length, 1, 'a posição do banco tem de voltar a ser vigiada');
  assert.equal(context.paper.getOpenTrades()[0]?.id, trade.id);
});

test('reconciliar NÃO ressuscita o que já encerrou', async (t) => {
  const context = await harness();
  t.after(context.cleanup);

  const setup = makeSetup();
  const preview = await context.execution.preview({ setupId: setup.id, quoteAmount: 200 }, setup);
  const trade = await context.execution.execute(
    {
      setupId: setup.id,
      confirmationToken: preview.confirmationToken as string,
      idempotencyKey: 'chave-encerrada',
    },
    setup,
  );
  await context.paper.closeAtMarket(trade, 1.5, 'encerrada no teste');
  assert.equal(context.paper.getOpenTrades().length, 0);

  const recuperadas = context.paper.reconcile(await context.repository.listTrades());

  assert.equal(recuperadas.length, 0);
  assert.equal(context.paper.getOpenTrades().length, 0);
});

test('o teto de exposição mede contra o patrimônio, não contra o caixa', async (t) => {
  const context = await harness(218.19);
  t.after(context.cleanup);
  await context.settings.update({ mode: 'TESTNET' });
  /*
   * A regressão de 26/08/2026, reproduzida.
   *
   * Conta com 1,07 USDT em caixa e 23,78 em NVDAB. A exposição soma a posição
   * inteira; o teto era 80% do CAIXA, ou seja 0,86 — e 23,78 nunca cabe em
   * 0,86. Toda ordem morria em "Exposição total", inclusive as que a decisão
   * do robô tinha acabado de liberar. Com o patrimônio como base, 80% de
   * 24,85 são 19,88 e a conta volta a fazer sentido.
   */
  context.setBalance({
    free: 1.07,
    locked: 0,
    idle: [{ asset: 'NVDAB', free: 0.000891, locked: 0.108 }],
  });
  const capital = await context.execution.getCapital('TESTNET', 'SPOT');
  const snapshot = await context.risk.snapshot(patrimonio(capital), 'TESTNET', 'SPOT');

  const porteiro = context.risk.gate({
    snapshot,
    symbol: 'XRPUSDT',
    quoteAmount: 1,
    netRiskReward: 3,
    openTrades: [],
    mode: 'TESTNET',
    market: 'SPOT',
  });

  assert.ok(
    !porteiro.blockers.some((item) => /Exposição total/.test(item)),
    `uma ordem de 1 USDT numa conta de 24,85 não pode estourar o teto: ${porteiro.blockers.join(' | ')}`,
  );
  assert.ok(snapshot.capital > 24, `o disjuntor precisa ver o patrimônio, viu ${snapshot.capital}`);
});
