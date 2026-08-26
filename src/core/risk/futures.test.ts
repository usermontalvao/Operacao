import assert from 'node:assert/strict';
import test from 'node:test';
import { checkLiquidation, liquidationPrice, marginRequired, maxSafeLeverage } from './futures.ts';
import { netPnl, stopFillPrice, breakevenPrice, netRiskReward, DEFAULT_COSTS } from './costs.ts';
import { nextProtectiveStop, sanitizeTargets } from './stops.ts';
import { sizeByRisk } from './sizeByRisk.ts';

test('a liquidação de uma compra alavancada fica abaixo da entrada, e a de uma venda acima', () => {
  const comprada = liquidationPrice({
    side: 'BUY',
    entryPrice: 100,
    quantity: 3,
    leverage: 3,
    marginMode: 'ISOLATED',
  });
  const vendida = liquidationPrice({
    side: 'SELL',
    entryPrice: 100,
    quantity: 3,
    leverage: 3,
    marginMode: 'ISOLATED',
  });

  // com 3x, a margem é ~33% do notional; tirando a manutenção sobram ~32,8%
  assert.ok(comprada !== null && comprada > 66 && comprada < 68, `comprada: ${comprada}`);
  assert.ok(vendida !== null && vendida > 132 && vendida < 134, `vendida: ${vendida}`);
});

test('margem cruzada usa a carteira inteira — a liquidação fica bem mais longe', () => {
  const isolada = liquidationPrice({
    side: 'BUY',
    entryPrice: 100,
    quantity: 3,
    leverage: 3,
    marginMode: 'ISOLATED',
  }) as number;
  const cruzada = liquidationPrice({
    side: 'BUY',
    entryPrice: 100,
    quantity: 3,
    leverage: 3,
    marginMode: 'CROSSED',
    walletBalance: 1000,
  }) as number;

  assert.ok(cruzada < isolada, 'na cruzada o preço aguenta cair mais antes de liquidar');
});

test('stop depois da liquidação é bloqueio, não aviso', () => {
  // 10x com stop a 15% da entrada: a corretora liquida por volta de -9,5%
  const check = checkLiquidation({
    side: 'BUY',
    entryPrice: 100,
    stopLoss: 85,
    quantity: 10,
    leverage: 10,
    marginMode: 'ISOLATED',
    minBufferPercent: 1.5,
  });

  assert.equal(check.stopBeyondLiquidation, true);
  assert.match(check.blockReason ?? '', /liquidação/i);
});

test('a alavancagem máxima segura passa na própria checagem que bloqueou a pedida', () => {
  const entrada = 100;
  const stop = 96; // 4% de risco
  const seguro = maxSafeLeverage({
    side: 'BUY',
    entryPrice: entrada,
    stopLoss: stop,
    minBufferPercent: 1.5,
    ceiling: 10,
  });

  assert.ok(seguro >= 1 && seguro <= 10);
  const check = checkLiquidation({
    side: 'BUY',
    entryPrice: entrada,
    stopLoss: stop,
    quantity: 1,
    leverage: seguro,
    marginMode: 'ISOLATED',
    minBufferPercent: 1.5,
  });
  assert.equal(check.blockReason, null, `com ${seguro}x ainda deveria passar`);
});

test('a alavancagem não muda o risco no stop — muda quanto de saldo a posição prende', () => {
  const comum = {
    entryPrice: 100,
    stopLoss: 95,
    equity: 1000,
    available: 1000,
    riskPerTradePercent: 1,
    maxPositionPercent: 100,
    maxNotional: Number.POSITIVE_INFINITY,
    costs: DEFAULT_COSTS,
  };
  const semAlavancagem = sizeByRisk(comum);
  const comTres = sizeByRisk({ ...comum, leverage: 3 });

  assert.equal(comTres.quantity, semAlavancagem.quantity, 'o orçamento de risco é o mesmo');
  assert.equal(comTres.riskAmount, semAlavancagem.riskAmount);
  assert.ok(
    Math.abs(comTres.marginRequired - marginRequired(comTres.notional, 3)) < 0.01,
    'a margem é o notional dividido pela alavancagem',
  );
  assert.ok(comTres.marginRequired < comTres.notional);
});

test('com saldo curto, a alavancagem é o que permite a posição existir', () => {
  const comum = {
    entryPrice: 100,
    stopLoss: 95,
    equity: 1000,
    // saldo bem menor que o notional que o risco pediria
    available: 50,
    riskPerTradePercent: 1,
    maxPositionPercent: 100,
    maxNotional: Number.POSITIVE_INFINITY,
    costs: DEFAULT_COSTS,
  };
  const spot = sizeByRisk(comum);
  const futuros = sizeByRisk({ ...comum, leverage: 3 });

  assert.equal(spot.boundBy, 'AVAILABLE_BALANCE');
  assert.ok(futuros.quantity > spot.quantity, 'o mesmo saldo compra três vezes mais notional');
});

test('vendido, o stop precisa ficar ACIMA da entrada', () => {
  const invertido = sizeByRisk({
    entryPrice: 100,
    stopLoss: 95,
    equity: 1000,
    available: 1000,
    riskPerTradePercent: 1,
    maxPositionPercent: 100,
    maxNotional: Number.POSITIVE_INFINITY,
    costs: DEFAULT_COSTS,
    side: 'SELL',
  });
  assert.equal(invertido.blocked, true);
  assert.match(invertido.blockReason ?? '', /acima da entrada/i);

  const certo = sizeByRisk({
    entryPrice: 100,
    stopLoss: 105,
    equity: 1000,
    available: 1000,
    riskPerTradePercent: 1,
    maxPositionPercent: 100,
    maxNotional: Number.POSITIVE_INFINITY,
    costs: DEFAULT_COSTS,
    side: 'SELL',
  });
  assert.equal(certo.blocked, false);
  assert.ok(certo.quantity > 0);
});

test('vendido, lucro é o preço caindo — e os custos continuam contra', () => {
  const lucro = netPnl({ entryPrice: 100, exitPrice: 90, quantity: 1, feePercent: 0.05, side: 'SELL' });
  const prejuizo = netPnl({ entryPrice: 100, exitPrice: 110, quantity: 1, feePercent: 0.05, side: 'SELL' });

  assert.ok(lucro > 0 && lucro < 10, 'o bruto é 10; a corretagem come um pedaço');
  assert.ok(prejuizo < 0);

  // o stop de quem vende preenche ACIMA do gatilho, e o empate fica ABAIXO da entrada
  assert.ok(stopFillPrice(110, DEFAULT_COSTS, 'SELL') > 110);
  assert.ok(breakevenPrice(100, 0.05, 'SELL') < 100);

  const rr = netRiskReward({ entryPrice: 100, stopLoss: 105, target: 90, costs: DEFAULT_COSTS, side: 'SELL' });
  assert.ok(rr > 1.5, `R/R vendido deveria ser positivo: ${rr}`);
  // o mesmo plano lido como compra não é operação nenhuma
  assert.equal(netRiskReward({ entryPrice: 100, stopLoss: 105, target: 90, costs: DEFAULT_COSTS }), 0);
});

test('o stop de proteção de uma venda só DESCE, e nunca para cima do preço', () => {
  const desceu = nextProtectiveStop(
    {
      side: 'SELL',
      entryPrice: 100,
      currentStop: 105,
      highWaterPrice: 90, // o "topo" de quem vende é o fundo
      currentPrice: 92,
      target1Filled: true,
    },
    { breakevenAfterTarget1: true, trailingStopPercent: 5, feePercent: 0.05 },
  );
  assert.ok(desceu !== null && desceu < 105 && desceu > 92, `stop novo: ${desceu}`);

  // stop que já estaria acionado pelo preço de agora não é proteção, é saída
  // a mercado: o fundo foi 80, mas o preço voltou para 95, e um stop em 84
  // ficaria ABAIXO do preço — do lado errado para quem está vendido
  const recusado = nextProtectiveStop(
    {
      side: 'SELL',
      entryPrice: 100,
      currentStop: 105,
      highWaterPrice: 80,
      currentPrice: 95,
      target1Filled: false,
    },
    { breakevenAfterTarget1: false, trailingStopPercent: 5, feePercent: 0.05 },
  );
  assert.equal(recusado, null);
});

test('o teto de alvo vale para baixo também', () => {
  const limpo = sanitizeTargets({
    entryPrice: 100,
    target1: 95,
    target2: 90,
    target3: 20, // 80% de queda: o mercado não entrega, e a parcela ficaria pendurada
    maxTargetPercent: 30,
    side: 'SELL',
  });
  assert.equal(limpo.target2, 90);
  assert.equal(limpo.target3, null);
  assert.equal(limpo.dropped.length, 1);
});
