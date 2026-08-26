import { type Side, gainPerUnit } from '../direction.ts';
import type { CostSettings } from './costs.ts';
import { netPnl, stopFillPrice } from './costs.ts';
import { roundDownToStep } from './filters.ts';

/**
 * Tamanho da posição a partir do PREJUÍZO no stop, não do valor investido.
 *
 * "Investir 10% do capital" não é uma regra de risco: com stop a 1% arrisca-se
 * 0,1% do capital, com stop a 20% arrisca-se 2%. A mesma configuração produz
 * riscos vinte vezes diferentes conforme a volatilidade do ativo — e é
 * justamente em ativo volátil que o stop fica largo. MOMENTUM_BURST, a única
 * estratégia automática validada, é a que mais sofre com isso: o stop na
 * mínima da explosão costuma ser largo por natureza.
 *
 * Aqui o orçamento é o prejuízo aceito. A quantidade sai dele, e todos os
 * outros tetos entram como limite — nunca como ponto de partida.
 */

export type SizingLimit =
  | 'RISK_BUDGET'
  | 'MAX_POSITION_PERCENT'
  | 'MAX_NOTIONAL'
  | 'AVAILABLE_BALANCE'
  | 'REQUESTED'
  | 'EXCHANGE_STEP'
  | 'EXCHANGE_MINIMUM';

export interface RiskSizingInput {
  entryPrice: number;
  stopLoss: number;
  /** patrimônio de referência do orçamento de risco */
  equity: number;
  /** saldo que dá para gastar agora */
  available: number;
  riskPerTradePercent: number;
  maxPositionPercent: number;
  /** teto absoluto por ordem, em USDT */
  maxNotional: number;
  costs: CostSettings;
  /** valor que o usuário pediu explicitamente; ausente = o robô decide */
  requestedQuote?: number;
  /**
   * Aplica os tetos internos de risco e de tamanho.
   *
   * `false` existe somente para a compra manual spot: nesse fluxo o valor
   * digitado é a decisão do usuário, e risco/tamanho viram avisos na etapa de
   * confirmação. Saldo, passo do lote e mínimo da corretora continuam sendo
   * aplicados porque não são política do painel.
   */
  enforcePolicyLimits?: boolean;
  /** encolhimento vindo do regime (BTC volátil, evento de mercado) */
  sizeFactor?: number;
  /** passo de lote da corretora, quando conhecido */
  stepSize?: number;
  /**
   * Valor mínimo por ordem na corretora — PISO, não teto.
   *
   * Existe para um beco sem saída que só aparece em conta pequena: o
   * orçamento de risco encolhe a posição para um valor abaixo do mínimo que a
   * Binance aceita, e a ordem fica impossível. O painel dizia "bloqueada" sem
   * caminho — o teto de risco é regra NOSSA e negociável, mas quem aparecia
   * na tela era o mínimo da corretora, que é intransponível.
   *
   * Com o piso, a ordem sobe até o mínimo negociável e o risco extra vira o
   * que ele sempre foi: uma trava de política, visível em número e liberável
   * por confirmação. Só é informado em ordem MANUAL — o robô não tem
   * autorização para estourar o próprio orçamento.
   */
  minNotional?: number;
  /** lado da posição; ausente = comprado */
  side?: Side;
  /**
   * Alavancagem do contrato (1 = spot).
   *
   * Ela NÃO muda o orçamento de risco: o tamanho continua saindo do prejuízo
   * no stop. O que a alavancagem muda é quanto saldo aquele tamanho consome —
   * e, por isso, quanto o saldo deixa comprar. Tratá-la como permissão para
   * arriscar mais seria trocar a régua justamente onde ela mais importa.
   */
  leverage?: number;
}

export interface RiskSizingResult {
  quantity: number;
  notional: number;
  /**
   * Prejuízo por unidade se o stop for acionado: a distância até o
   * preenchimento real do stop MAIS as duas corretagens. É este número que o
   * cálculo antigo ignorava.
   */
  perUnitLoss: number;
  /** prejuízo por unidade sem custos — só para mostrar o quanto os custos pesam */
  grossPerUnitLoss: number;
  /** prejuízo total estimado no stop, com custos */
  riskAmount: number;
  grossRiskAmount: number;
  riskPercentOfEquity: number;
  /** preço em que o stop deve realmente preencher */
  stopFill: number;
  /** qual limite determinou a quantidade final */
  boundBy: SizingLimit;
  /** quantidade que cada limite permitiria, para o painel explicar a conta */
  allowedByLimit: Record<SizingLimit, number>;
  /** true quando não há quantidade possível respeitando o risco */
  blocked: boolean;
  blockReason: string | null;
  /** alavancagem considerada (1 em spot) */
  leverage: number;
  /** saldo que a posição prende como margem: notional ÷ alavancagem */
  marginRequired: number;
}

const LIMIT_ORDER: readonly SizingLimit[] = [
  'RISK_BUDGET',
  'MAX_POSITION_PERCENT',
  'MAX_NOTIONAL',
  'AVAILABLE_BALANCE',
  'REQUESTED',
];

export function sizeByRisk(input: RiskSizingInput): RiskSizingResult {
  const {
    entryPrice,
    stopLoss,
    equity,
    available,
    riskPerTradePercent,
    maxPositionPercent,
    maxNotional,
    costs,
  } = input;
  const sizeFactor = clamp01(input.sizeFactor ?? 1);
  const enforcePolicyLimits = input.enforcePolicyLimits ?? true;
  const side = input.side ?? 'BUY';
  const leverage = normalizeLeverage(input.leverage);

  const stopFill = stopFillPrice(stopLoss, costs, side);
  // uma unidade comprada a entryPrice e vendida no preenchimento do stop; o
  // sinal negativo transforma "resultado" em "prejuízo". Reaproveitar netPnl
  // aqui é de propósito: é a MESMA função que o backtest e o PAPER usam para
  // fechar a operação, então o risco planejado e o prejuízo realizado não
  // podem divergir por terem sido escritos duas vezes.
  const perUnitLoss = -netPnl({
    entryPrice,
    exitPrice: stopFill,
    quantity: 1,
    feePercent: costs.feePercent,
    side,
  });
  const grossPerUnitLoss = -gainPerUnit(side, entryPrice, stopLoss);
  // perUnitLoss nunca é menor que grossPerUnitLoss: as duas corretagens SOMAM
  // ao prejuízo, jamais o compensam. Por isso a única guarda necessária é o
  // stop estar do lado perdedor da entrada (grossPerUnitLoss > 0), verificada
  // logo abaixo — um stop curto não gera risco negativo, gera posição grande,
  // e quem segura isso é maxPositionPercent.

  const empty = (reason: string): RiskSizingResult => ({
    quantity: 0,
    notional: 0,
    perUnitLoss: round8(Math.max(perUnitLoss, 0)),
    grossPerUnitLoss: round8(Math.max(grossPerUnitLoss, 0)),
    riskAmount: 0,
    grossRiskAmount: 0,
    riskPercentOfEquity: 0,
    stopFill: round8(stopFill),
    boundBy: 'RISK_BUDGET',
    allowedByLimit: {
      RISK_BUDGET: 0,
      MAX_POSITION_PERCENT: 0,
      MAX_NOTIONAL: 0,
      AVAILABLE_BALANCE: 0,
      EXCHANGE_MINIMUM: 0,
      REQUESTED: 0,
      EXCHANGE_STEP: 0,
    },
    blocked: true,
    blockReason: reason,
    leverage,
    marginRequired: 0,
  });

  if (entryPrice <= 0) return empty('Preço de entrada inválido');
  if (stopLoss <= 0 || grossPerUnitLoss <= 0) {
    return empty(
      side === 'SELL'
        ? 'Stop precisa ficar acima da entrada'
        : 'Stop precisa ficar abaixo da entrada',
    );
  }
  if (equity <= 0) return empty('Sem patrimônio de referência para calcular o risco');
  if (enforcePolicyLimits && riskPerTradePercent <= 0) {
    return empty('Risco por operação está zerado nas configurações');
  }

  const riskBudget = enforcePolicyLimits
    ? equity * (riskPerTradePercent / 100)
    : Number.POSITIVE_INFINITY;

  // Com alavancagem, os dois limites que falam de SALDO passam a falar de
  // margem: o percentual do capital é quanto do patrimônio fica preso na
  // posição, e o saldo disponível compra `leverage` vezes mais notional. O
  // teto absoluto por ordem continua sendo notional puro — ele existe para
  // limitar o tamanho da aposta, não a margem dela.
  const allowedByLimit: Record<SizingLimit, number> = {
    RISK_BUDGET: riskBudget / perUnitLoss,
    MAX_POSITION_PERCENT:
      enforcePolicyLimits && maxPositionPercent > 0
        ? (equity * (maxPositionPercent / 100) * leverage) / entryPrice
        : Infinity,
    MAX_NOTIONAL:
      enforcePolicyLimits && maxNotional > 0 ? maxNotional / entryPrice : Infinity,
    AVAILABLE_BALANCE: available > 0 ? (available * leverage) / entryPrice : 0,
    REQUESTED:
      input.requestedQuote !== undefined && input.requestedQuote > 0
        ? input.requestedQuote / entryPrice
        : Infinity,
    EXCHANGE_STEP: Infinity,
    EXCHANGE_MINIMUM: 0,
  };

  let boundBy: SizingLimit = 'RISK_BUDGET';
  let quantity = Infinity;
  for (const limit of LIMIT_ORDER) {
    const allowed = allowedByLimit[limit];
    if (allowed < quantity) {
      quantity = allowed;
      boundBy = limit;
    }
  }

  quantity *= sizeFactor;

  // O passo do lote entra POR ÚLTIMO e sempre para baixo. Arredondar para cima
  // aqui devolveria uma posição que arrisca mais do que o orçamento aprovado —
  // silenciosamente, e justo no limite, que é onde importa.
  //
  // Ele quantiza a ordem, mas não é a regra econômica que escolheu o tamanho.
  // Se o usuário pediu 10% e a Binance só aceita décimos da moeda, continua
  // sendo o valor pedido que limitou a posição; trocar `boundBy` por
  // EXCHANGE_STEP fazia o painel afirmar o contrário em praticamente toda
  // ordem arredondada.
  if (input.stepSize !== undefined && input.stepSize > 0) {
    const stepped = roundDownToStep(quantity, input.stepSize);
    quantity = stepped;
    allowedByLimit.EXCHANGE_STEP = stepped;
  }

  /*
   * O piso da corretora entra DEPOIS de tudo, e para cima.
   *
   * É a única subida de tamanho neste cálculo, e ela é deliberada: abaixo
   * deste valor não existe ordem, então a alternativa não é "arriscar menos",
   * é "não operar". Subir arredonda para CIMA no passo de lote — para baixo
   * cairia de novo abaixo do mínimo, que é o erro que o piso existe para
   * evitar.
   *
   * O saldo continua mandando: se nem o mínimo cabe no que há disponível, a
   * quantidade fica como estava e a ordem segue impossível — corretamente.
   */
  const piso = input.minNotional ?? 0;
  if (piso > 0 && quantity * entryPrice < piso && available * leverage >= piso) {
    const passo = input.stepSize !== undefined && input.stepSize > 0 ? input.stepSize : 0;
    const bruto = piso / entryPrice;
    const subido = passo > 0 ? Math.ceil(bruto / passo) * passo : bruto;
    if (subido * entryPrice <= available * leverage) {
      quantity = subido;
      boundBy = 'EXCHANGE_MINIMUM';
      allowedByLimit.EXCHANGE_MINIMUM = subido;
    }
  }

  if (!(quantity > 0)) {
    return {
      ...empty('Não há quantidade possível dentro do orçamento de risco e do saldo'),
      allowedByLimit,
    };
  }

  const riskAmount = quantity * perUnitLoss;
  return {
    quantity: round8(quantity),
    notional: round2(quantity * entryPrice),
    leverage,
    marginRequired: round2((quantity * entryPrice) / leverage),
    perUnitLoss: round8(perUnitLoss),
    grossPerUnitLoss: round8(grossPerUnitLoss),
    riskAmount: round2(riskAmount),
    grossRiskAmount: round2(quantity * grossPerUnitLoss),
    riskPercentOfEquity: round2((riskAmount / equity) * 100),
    stopFill: round8(stopFill),
    boundBy,
    allowedByLimit,
    blocked: false,
    blockReason: null,
  };
}

/** Alavancagem sempre ≥ 1: zero ou negativa viraria divisão por zero na margem. */
function normalizeLeverage(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return 1;
  return value;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(value, 0), 1);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
