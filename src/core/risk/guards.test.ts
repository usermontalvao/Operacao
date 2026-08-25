import assert from 'node:assert/strict';
import test from 'node:test';
import type { Trade } from '../types.ts';
import {
  DEFAULT_COSTS,
  breakevenPrice,
  feeFor,
  marketExitPrice,
  netPnl,
  netRiskReward,
  stopFillPrice,
} from './costs.ts';
import {
  DEFAULT_GUARD,
  PANIC_CLOSE_REASON,
  computeRiskSnapshot,
  evaluateEntryGate,
} from './governor.ts';
import { nextProtectiveStop, sanitizeTargets } from './stops.ts';

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'trade-1',
    setupId: 'setup-1',
    automatic: true,
    symbol: 'XRPUSDT',
    mode: 'PAPER',
    side: 'BUY',
    setupType: 'PULLBACK',
    timeframe: '1h',
    score: 80,
    status: 'CLOSED',
    outcome: 'STOP',
    requestedQuantity: 100,
    filledQuantity: 100,
    remainingQuantity: 0,
    entryPrice: 1,
    averageFillPrice: 1,
    stopLoss: 0.95,
    target1: 1.1,
    target2: null,
    target3: null,
    notional: 100,
    riskAmount: 5,
    realizedPnl: -5,
    realizedPnlPercent: -5,
    maxFavorablePercent: 0,
    maxAdversePercent: -5,
    fills: [],
    exchangeOrderIds: [],
    clientOrderId: 'csh1',
    openedAt: '2026-08-25T10:00:00.000Z',
    closedAt: '2026-08-25T11:00:00.000Z',
    updatedAt: '2026-08-25T11:00:00.000Z',
    ...overrides,
  } as Trade;
}

test('taxa é cobrada nas duas pontas e derruba o resultado', () => {
  const gross = (1.1 - 1) * 100;
  const net = netPnl({ entryPrice: 1, exitPrice: 1.1, quantity: 100, feePercent: 0.1 });
  assert.equal(gross, 10.000000000000009);
  // 0,1% de 100 na compra + 0,1% de 110 na venda = 0,21
  assert.ok(Math.abs(net - 9.79) < 0.001, `esperado ~9,79, veio ${net}`);
  assert.equal(feeFor(1, 100, 0.1), 0.1);
});

test('empate fica acima da entrada porque as duas taxas precisam caber', () => {
  const breakeven = breakevenPrice(100, 0.1);
  assert.ok(breakeven > 100, 'empate tem de ser acima da entrada');
  const net = netPnl({ entryPrice: 100, exitPrice: breakeven, quantity: 1, feePercent: 0.1 });
  assert.ok(Math.abs(net) < 1e-9, `saída no empate deveria zerar, veio ${net}`);
});

test('stop preenche abaixo do gatilho e saída a mercado abaixo do preço visto', () => {
  assert.ok(stopFillPrice(100, DEFAULT_COSTS) < 100);
  assert.ok(marketExitPrice(100, DEFAULT_COSTS) < 100);
});

test('R/R líquido é menor que o bruto e some quando o alvo é curto demais', () => {
  const bruto = (1.1 - 1) / (1 - 0.95);
  const liquido = netRiskReward({ entryPrice: 1, stopLoss: 0.95, target: 1.1, costs: DEFAULT_COSTS });
  assert.ok(liquido < bruto, `líquido ${liquido} deveria ser menor que o bruto ${bruto}`);
  assert.ok(liquido > 1.5, `líquido ${liquido} não deveria desabar em alvo saudável`);

  // alvo a 0,15% da entrada não paga nem a corretagem das duas pontas
  const curto = netRiskReward({ entryPrice: 1, stopLoss: 0.95, target: 1.0015, costs: DEFAULT_COSTS });
  assert.equal(curto, 0);
});

const TRES_PERDIDAS = [
  makeTrade({ id: 'a', realizedPnl: -5, closedAt: '2026-08-25T09:00:00.000Z' }),
  makeTrade({ id: 'b', realizedPnl: -4, closedAt: '2026-08-25T10:00:00.000Z' }),
  makeTrade({ id: 'c', realizedPnl: -3, closedAt: '2026-08-25T11:00:00.000Z' }),
];

test('perdas seguidas mandam o robô para o intervalo', () => {
  const snapshot = computeRiskSnapshot({
    trades: TRES_PERDIDAS,
    mode: 'PAPER',
    capital: 1000,
    dailyLossLimitPercent: 50,
    guard: { ...DEFAULT_GUARD, maxConsecutiveLosses: 3, lossPauseMinutes: 60 },
    prices: {},
    // meia hora depois da terceira perda: no meio do intervalo
    now: new Date('2026-08-25T11:30:00.000Z'),
  });
  assert.equal(snapshot.consecutiveLosses, 3);
  assert.equal(snapshot.halted, true);
  assert.equal(snapshot.resumesAt, '2026-08-25T12:00:00.000Z');
  assert.match(snapshot.haltReasons.join(' '), /volta sozinho em 30 min/);
});

test('passado o intervalo o robô volta sozinho, sem ninguém clicar', () => {
  // ESTE é o defeito que o usuário apontou: antes o botão dava 60 minutos de
  // folga e travava de novo — o alívio e a pausa estavam trocados de lado
  const snapshot = computeRiskSnapshot({
    trades: TRES_PERDIDAS,
    mode: 'PAPER',
    capital: 1000,
    dailyLossLimitPercent: 50,
    guard: { ...DEFAULT_GUARD, maxConsecutiveLosses: 3, lossPauseMinutes: 60 },
    prices: {},
    now: new Date('2026-08-25T12:00:01.000Z'),
  });
  assert.equal(snapshot.halted, false);
  assert.equal(snapshot.resumesAt, null);
  // a contagem zera junto: cumprido o intervalo, a sequência está paga
  assert.equal(snapshot.consecutiveLosses, 0);
});

test('perder de novo depois do intervalo recomeça a contagem, não retranca na hora', () => {
  const trades = [
    ...TRES_PERDIDAS,
    makeTrade({ id: 'd', realizedPnl: -2, closedAt: '2026-08-25T13:00:00.000Z' }),
  ];
  const snapshot = computeRiskSnapshot({
    trades,
    mode: 'PAPER',
    capital: 1000,
    dailyLossLimitPercent: 50,
    guard: { ...DEFAULT_GUARD, maxConsecutiveLosses: 3, lossPauseMinutes: 60 },
    prices: {},
    now: new Date('2026-08-25T13:05:00.000Z'),
  });
  assert.equal(snapshot.consecutiveLosses, 1);
  assert.equal(snapshot.halted, false);
});

test('a sequência ruim de ontem não trava o robô hoje', () => {
  // sem isto o disjuntor vira armadilha: bloqueado, o robô não abre operação
  // nova, e sem operação nova nenhuma vitória chega para quebrar a sequência
  const trades = [
    makeTrade({ id: 'a', realizedPnl: -5, closedAt: '2026-08-24T09:00:00.000Z' }),
    makeTrade({ id: 'b', realizedPnl: -4, closedAt: '2026-08-24T10:00:00.000Z' }),
    makeTrade({ id: 'c', realizedPnl: -3, closedAt: '2026-08-24T11:00:00.000Z' }),
  ];
  const snapshot = computeRiskSnapshot({
    trades,
    mode: 'PAPER',
    capital: 1000,
    dailyLossLimitPercent: 50,
    guard: { ...DEFAULT_GUARD, maxConsecutiveLosses: 3 },
    prices: {},
    now: new Date('2026-08-25T12:00:00.000Z'),
  });
  assert.equal(snapshot.consecutiveLosses, 0);
  assert.equal(snapshot.halted, false);
});

test('encerrar tudo no pânico não conta como sequência de perdas', () => {
  const trades = [
    makeTrade({
      id: 'a',
      realizedPnl: -0.2,
      closedAt: '2026-08-25T09:00:00.000Z',
      outcome: 'MANUAL',
      closeReason: PANIC_CLOSE_REASON,
    }),
    makeTrade({
      id: 'b',
      realizedPnl: -0.3,
      closedAt: '2026-08-25T09:00:01.000Z',
      outcome: 'MANUAL',
      closeReason: PANIC_CLOSE_REASON,
    }),
    makeTrade({
      id: 'c',
      realizedPnl: -0.1,
      closedAt: '2026-08-25T09:00:02.000Z',
      outcome: 'MANUAL',
      closeReason: PANIC_CLOSE_REASON,
    }),
    makeTrade({ id: 'd', realizedPnl: -4, closedAt: '2026-08-25T10:00:00.000Z' }),
  ];
  const snapshot = computeRiskSnapshot({
    trades,
    mode: 'PAPER',
    capital: 1000,
    dailyLossLimitPercent: 50,
    guard: { ...DEFAULT_GUARD, maxConsecutiveLosses: 3 },
    prices: {},
    now: new Date('2026-08-25T12:00:00.000Z'),
  });
  // um clique fechou três posições; o único erro do sistema foi o stop
  assert.equal(snapshot.consecutiveLosses, 1);
  assert.equal(snapshot.halted, false);
});

test('um ganho no meio zera a contagem de perdas seguidas', () => {
  const trades = [
    makeTrade({ id: 'a', realizedPnl: -5, closedAt: '2026-08-25T09:00:00.000Z' }),
    makeTrade({ id: 'b', realizedPnl: 8, closedAt: '2026-08-25T10:00:00.000Z' }),
    makeTrade({ id: 'c', realizedPnl: -3, closedAt: '2026-08-25T11:00:00.000Z' }),
  ];
  const snapshot = computeRiskSnapshot({
    trades,
    mode: 'PAPER',
    capital: 1000,
    dailyLossLimitPercent: 50,
    guard: DEFAULT_GUARD,
    prices: {},
    now: new Date('2026-08-25T12:00:00.000Z'),
  });
  assert.equal(snapshot.consecutiveLosses, 1);
  assert.equal(snapshot.halted, false);
});

test('operação de outro modo não aciona o disjuntor do modo ativo', () => {
  const trades = [
    makeTrade({ id: 'a', mode: 'PAPER', realizedPnl: -50, closedAt: '2026-08-25T09:00:00.000Z' }),
    makeTrade({ id: 'b', mode: 'PAPER', realizedPnl: -50, closedAt: '2026-08-25T10:00:00.000Z' }),
    makeTrade({ id: 'c', mode: 'PAPER', realizedPnl: -50, closedAt: '2026-08-25T11:00:00.000Z' }),
  ];
  const snapshot = computeRiskSnapshot({
    trades,
    mode: 'LIVE',
    capital: 1000,
    dailyLossLimitPercent: 5,
    guard: DEFAULT_GUARD,
    prices: {},
    now: new Date('2026-08-25T12:00:00.000Z'),
  });
  assert.equal(snapshot.consecutiveLosses, 0);
  assert.equal(snapshot.halted, false);
});

test('reconhecer o disjuntor libera a operação até a hora marcada', () => {
  const snapshot = computeRiskSnapshot({
    trades: TRES_PERDIDAS,
    mode: 'PAPER',
    capital: 1000,
    dailyLossLimitPercent: 50,
    guard: { ...DEFAULT_GUARD, mutedUntil: '2026-08-25T13:00:00.000Z' },
    prices: {},
    // dentro do intervalo: é aí que o atalho "não quero esperar" faz sentido
    now: new Date('2026-08-25T11:30:00.000Z'),
  });
  assert.equal(snapshot.halted, false);
  assert.equal(snapshot.mutedReasons.length, 1);
});

test('exposição em altcoin trava a segunda compra correlacionada', () => {
  const open = [
    makeTrade({
      id: 'open-1',
      symbol: 'SOLUSDT',
      status: 'OPEN',
      outcome: 'OPEN',
      closedAt: null,
      realizedPnl: 0,
      remainingQuantity: 100,
      averageFillPrice: 1,
      notional: 100,
    }),
  ];
  const snapshot = computeRiskSnapshot({
    trades: open,
    mode: 'PAPER',
    capital: 1000,
    dailyLossLimitPercent: 5,
    guard: DEFAULT_GUARD,
    prices: { SOLUSDT: 1 },
    now: new Date('2026-08-25T12:00:00.000Z'),
  });

  const gate = evaluateEntryGate({
    snapshot,
    guard: { ...DEFAULT_GUARD, maxAltExposurePercent: 15, lossCooldownMinutes: 0 },
    symbol: 'PEPEUSDT',
    quoteAmount: 100,
    netRiskReward: 3,
    openTrades: open,
    btcContext: 'BTC_NEUTRAL',
    quoteVolume24h: 50_000_000,
    now: new Date('2026-08-25T12:00:00.000Z'),
  });
  assert.equal(gate.allowed, false);
  assert.match(gate.blockers.join(' '), /altcoins/);
});

test('BTC vendedor bloqueia compra nova quando configurado', () => {
  const snapshot = computeRiskSnapshot({
    trades: [],
    mode: 'PAPER',
    capital: 1000,
    dailyLossLimitPercent: 5,
    guard: DEFAULT_GUARD,
    prices: {},
    now: new Date('2026-08-25T12:00:00.000Z'),
  });
  const gate = evaluateEntryGate({
    snapshot,
    guard: DEFAULT_GUARD,
    symbol: 'SOLUSDT',
    quoteAmount: 50,
    netRiskReward: 3,
    openTrades: [],
    btcContext: 'BTC_BEARISH',
    quoteVolume24h: 50_000_000,
    now: new Date('2026-08-25T12:00:00.000Z'),
  });
  assert.equal(gate.allowed, false);
  assert.match(gate.blockers.join(' '), /BTC vendedor/);
});

test('BTC volátil reduz o tamanho em vez de bloquear', () => {
  const snapshot = computeRiskSnapshot({
    trades: [],
    mode: 'PAPER',
    capital: 1000,
    dailyLossLimitPercent: 5,
    guard: DEFAULT_GUARD,
    prices: {},
    now: new Date('2026-08-25T12:00:00.000Z'),
  });
  const gate = evaluateEntryGate({
    snapshot,
    guard: DEFAULT_GUARD,
    symbol: 'SOLUSDT',
    quoteAmount: 50,
    netRiskReward: 3,
    openTrades: [],
    btcContext: 'BTC_HIGH_VOLATILITY',
    quoteVolume24h: 50_000_000,
    now: new Date('2026-08-25T12:00:00.000Z'),
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.sizeFactor, 0.5);
});

test('stop sobe para o empate depois do alvo 1 e nunca desce', () => {
  const policy = { breakevenAfterTarget1: true, trailingStopPercent: 0, feePercent: 0.1 };
  const subiu = nextProtectiveStop(
    { entryPrice: 100, currentStop: 95, highWaterPrice: 110, currentPrice: 108, target1Filled: true },
    policy,
  );
  assert.ok(subiu !== null && subiu > 100, `stop deveria ir para o empate, veio ${subiu}`);

  const semAlvo = nextProtectiveStop(
    { entryPrice: 100, currentStop: 95, highWaterPrice: 102, currentPrice: 101, target1Filled: false },
    policy,
  );
  assert.equal(semAlvo, null);

  const jaProtegido = nextProtectiveStop(
    { entryPrice: 100, currentStop: 105, highWaterPrice: 110, currentPrice: 108, target1Filled: true },
    policy,
  );
  assert.equal(jaProtegido, null, 'stop não pode descer de 105 para o empate');
});

test('trailing segue o topo e nunca é colocado acima do preço atual', () => {
  const policy = { breakevenAfterTarget1: false, trailingStopPercent: 3, feePercent: 0.1 };
  const arrastado = nextProtectiveStop(
    { entryPrice: 100, currentStop: 95, highWaterPrice: 120, currentPrice: 118, target1Filled: false },
    policy,
  );
  assert.ok(arrastado !== null && Math.abs(arrastado - 116.4) < 0.001);

  const acimaDoPreco = nextProtectiveStop(
    { entryPrice: 100, currentStop: 95, highWaterPrice: 120, currentPrice: 110, target1Filled: false },
    policy,
  );
  assert.equal(acimaDoPreco, null, 'stop acima do preço venderia na hora');
});

test('alvo distante demais é descartado e a posição passa a viver do stop', () => {
  const result = sanitizeTargets({
    entryPrice: 0.09528994,
    target1: 0.11405,
    target2: 0.18501,
    target3: 0.195,
    maxTargetPercent: 40,
  });
  assert.equal(result.target1, 0.11405);
  assert.equal(result.target2, null);
  assert.equal(result.target3, null);
  assert.equal(result.dropped.length, 2);
});

test('posição de ontem não conta o lucro aberto duas vezes no patrimônio', () => {
  // uma única posição, aberta ontem, com 100 de lucro ainda não realizado
  const yesterday = new Date('2026-08-24T10:00:00.000Z').toISOString();
  const trade = makeTrade({
    status: 'OPEN',
    closedAt: null,
    outcome: 'OPEN',
    openedAt: yesterday,
    symbol: 'ARBUSDT',
    entryPrice: 100,
    averageFillPrice: 100,
    filledQuantity: 10,
    remainingQuantity: 10,
    notional: 1000,
    realizedPnl: 0,
  });

  const snapshot = computeRiskSnapshot({
    trades: [trade],
    mode: 'PAPER',
    capital: 1000,
    dailyLossLimitPercent: 5,
    guard: { ...DEFAULT_GUARD },
    prices: { ARBUSDT: 110 },
    now: new Date('2026-08-25T12:00:00.000Z'),
  });

  // 1000 de capital + 100 de lucro aberto = 1100. Contado duas vezes daria 1200.
  assert.equal(snapshot.equity, 1100);
  assert.equal(snapshot.dailyUnrealizedPnl, 0, 'posição de ontem não é resultado de hoje');
});
