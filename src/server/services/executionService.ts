import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  AppSettings,
  EntryDecision,
  MarketKind,
  Side,
  SymbolFilters,
  Trade,
  TradeSetup,
  TradingMode,
} from '../../core/types.ts';
import { gainPerUnit, sideLabel } from '../../core/direction.ts';
import { checkLiquidation, marginRequired, maxSafeLeverage } from '../../core/risk/futures.ts';
import { automaticStrategyRejectionReason } from '../../core/strategy/automationPolicy.ts';
import {
  computeRiskReward,
  formatPrice,
  formatQuantity,
  round,
  validateOrder,
} from '../../core/risk/index.ts';
import type { SizingResult } from '../../core/risk/index.ts';
import { sizeByRisk, type RiskSizingResult } from '../../core/risk/sizeByRisk.ts';
import { netRiskReward } from '../../core/risk/costs.ts';
import { sanitizeTargets } from '../../core/risk/stops.ts';
import { validateTradePlan } from '../../core/risk/tradePlan.ts';
import { config, environmentForMode, readCredentials } from '../config.ts';
import type { EventBus } from '../events.ts';
import { logger } from '../logger.ts';
import type { Repository } from '../store/index.ts';
import {
  BinanceError,
  getAccountBalances,
  getActiveEnvironment,
  getSymbolFilters,
  getUsdtBrlRate,
  newOtocoOrder,
} from '../binance/rest.ts';
import {
  futuresEntryOrder,
  getFuturesBalances,
  isHedgeMode,
  setLeverage,
  setMarginMode,
} from '../binance/futures.ts';
import type { AuditService } from './auditService.ts';
import type { MarketDataService } from './marketDataService.ts';
import { paperBalance, type PaperTradingEngine } from './paperTradingEngine.ts';
import type { RiskService } from './riskService.ts';
import type { SettingsService } from './settingsService.ts';
import { prioritizedFocus } from './focus.ts';

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/** Injetáveis para teste: em produção falam com a Binance de verdade. */
export interface ExecutionDependencies {
  /** filtros do par NA MODALIDADE pedida — passo e mínimo diferem entre as duas */
  loadFilters: (symbol: string, market: MarketKind) => Promise<SymbolFilters | null>;
  loadUsdtBalance: (
    market: MarketKind,
  ) => Promise<{
    free: number;
    locked: number;
    /*
     * `locked` faz falta aqui. Uma posição spot protegida por OCO tem quase
     * toda a quantidade presa na ordem de venda — na conta real de 26/08/2026,
     * 0,108 de 0,1089 NVDAB. Contar só o `free` avaliaria a posição em três
     * centavos em vez de 23,78 USDT.
     */
    idle?: Array<{ asset: string; free: number; locked?: number }>;
  }>;
  loadBrlRate: () => Promise<number | null>;
}

const defaultDependencies: ExecutionDependencies = {
  loadFilters: async (symbol, market) =>
    (await getSymbolFilters([symbol], market)).get(symbol) ?? null,
  loadUsdtBalance: async (market) => {
    if (market === 'FUTURES') {
      // em futuros o que importa é a margem livre, não o saldo bruto: o que
      // está preso nas posições abertas não abre posição nenhuma
      const balances = await getFuturesBalances();
      const usdt = balances.find((item) => item.asset === 'USDT');
      const wallet = usdt?.walletBalance ?? 0;
      const free = usdt?.availableBalance ?? 0;
      return { free, locked: Math.max(wallet - free, 0) };
    }
    const balances = await getAccountBalances();
    const usdt = balances.find((item) => item.asset === 'USDT');
    /*
     * O que está na conta e NÃO é USDT.
     *
     * O painel opera pares USDT e conta só USDT — o que é correto e era
     * invisível: um depósito em reais cai como BRL, o saldo do painel não se
     * mexe, e a conclusão natural é "o depósito não chegou". Chegou; está na
     * moeda errada, e só a corretora pode converter.
     *
     * A moeda-base de um par que já foi comprado fica de fora: aquilo é
     * posição, não dinheiro parado.
     */
    const idle = balances
      .filter((item) => item.asset !== 'USDT' && item.free + item.locked > 0)
      .map((item) => ({ asset: item.asset, free: item.free, locked: item.locked }));
    return { free: usdt?.free ?? 0, locked: usdt?.locked ?? 0, idle };
  },
  loadBrlRate: getUsdtBrlRate,
};

export class ExecutionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ExecutionError';
    this.status = status;
  }
}

/**
 * As recusas que uma confirmação explícita desarma.
 *
 * A lista é por TRECHO da frase, e não por código, porque os bloqueios nascem
 * como texto em dois módulos diferentes (o porteiro de risco e o coletor de
 * impedimentos). Um teste amarra cada trecho à frase real que o sistema
 * produz — sem ele, mudar a redação de um bloqueio o transformaria
 * silenciosamente em intransponível, ou pior, em transponível sem querer.
 *
 * O que NÃO está aqui é intransponível de propósito: mínimo da corretora,
 * par parado, saldo insuficiente, setup inválido, liquidação antes do stop e
 * modalidade barrada. Posição já aberta, disjuntor, contexto de mercado e os
 * demais tetos são política: na ordem manual aparecem como aviso e ficam
 * registrados, mas não fingem ser uma recusa da Binance.
 */
const TRAVAS_NEGOCIAVEIS = [
  'Disjuntor acionado',
  'R/R líquido',
  'Exposição total',
  'Exposição em altcoins',
  'do patrimônio acima do teto',
  'operações abertas atingido',
  'Limite de',
  'Já existe posição aberta',
  'Já existe uma operação aberta',
  'Descanso pós-perda',
  'Volume de',
  'mercado estiver contra',
  'Ativo bloqueado por evento de mercado',
] as const;

function cedeAConfirmacao(motivo: string): boolean {
  return TRAVAS_NEGOCIAVEIS.some((trecho) => motivo.includes(trecho));
}

export interface PreviewRequest {
  setupId: string;
  quoteAmount?: number;
  percentOfCapital?: number;
  /** níveis alterados no gráfico; ausentes preservam os calculados pelo setup */
  stopLoss?: number;
  target1?: number;
  target2?: number | null;
  target3?: number | null;
  /**
   * Ordem forçada: desarma as travas de POLÍTICA nesta ordem, e só nela.
   *
   * Existe para o caso em que afrouxar a régua de todas as ordens seria pior
   * que atropelá-la numa — testar a conta real com pouco dinheiro é o
   * exemplo. Nunca vem do robô, fica gravado na auditoria e não toca em nada
   * que seja da corretora.
   */
  override?: boolean;
  /**
   * Alavancagem desta ordem, quando o usuário mexe no seletor do modal.
   *
   * Ausente = a dos ajustes daquela modalidade. Existe porque alavancagem é
   * decisão de OPERAÇÃO, não de conta: o stop de uma tese pode aceitar 5x com
   * folga e o da seguinte liquidar antes do stop em 3x. O teto configurado
   * continua valendo — o modal não é caminho para furá-lo.
   */
  leverage?: number;
}

export interface CapitalView {
  /** caixa em USDT: o que a corretora mostra como saldo da moeda de cotação */
  capital: number;
  available: number;
  /**
   * O que as moedas já compradas valem agora, em USDT.
   *
   * Fica separado de `capital` de propósito. Somar os dois dá o PATRIMÔNIO —
   * é ele que o disjuntor tem de usar — mas há telas que precisam do caixa
   * puro, e uma soma feita cedo demais viraria dinheiro contado duas vezes na
   * primeira vez que alguém somasse posição por cima. Zero em PAPER (a
   * carteira de papel já é patrimônio) e em futuros (a margem já está no
   * saldo).
   */
  holdingsValue: number;
  source: string;
  currency: 'USDT';
  brlRate: number | null;
  /** saldos na conta que o painel NÃO usa por não serem USDT */
  idleAssets?: Array<{ asset: string; free: number; locked?: number }>;
}

export interface PreviewResult {
  setup: TradeSetup;
  mode: TradingMode;
  market: MarketKind;
  side: Side;
  /** 1 em spot */
  leverage: number;
  /** saldo que a posição prende (notional ÷ alavancagem) */
  margin: number;
  /** preço estimado de liquidação; null em spot */
  liquidationPrice: number | null;
  /** maior alavancagem que ainda deixa a liquidação atrás do stop */
  safeLeverage: number | null;
  entryPrice: number;
  currentPrice: number;
  /** a conta do risco por extenso: quanto se perde no stop e quem limitou o tamanho */
  riskSizing: RiskSizingResult;
  capital: number;
  available: number;
  brlRate: number | null;
  sizing: SizingResult;
  filters: SymbolFilters | null;
  filterErrors: string[];
  blockers: string[];
  warnings: string[];
  /** R/R já descontadas corretagem e escorregamento — é este que decide */
  netRiskReward: number;
  canExecute: boolean;
  /** travas de política que uma confirmação explícita desarmaria */
  overridableBlockers: string[];
  /** true quando SÓ falta a confirmação explícita para a ordem sair */
  canOverride: boolean;
  /** esta prévia já está com as travas de política desarmadas */
  overridden: boolean;
  /** só com este token o servidor aceita criar a ordem */
  confirmationToken: string | null;
  expiresAt: string | null;
}

export interface ExecuteRequest {
  setupId: string;
  confirmationToken: string;
  idempotencyKey: string;
}

/** Conteúdo assinado do token: é exatamente o que o usuário viu na tela. */
interface ConfirmationPayload {
  setupId: string;
  quantity: number;
  entryPrice: number;
  quoteAmount: number;
  stopLoss: number;
  target1: number;
  target2: number | null;
  target3: number | null;
  mode: TradingMode;
  expiresAt: number;
  automatic: boolean;
  /** modalidade, lado e alavancagem aprovados — mudar qualquer um refaz o preview */
  market: MarketKind;
  side: Side;
  leverage: number;
  /** a ordem foi aprovada com as travas de política desarmadas */
  override?: boolean;
  /** quais travas o usuário viu na tela quando aprovou — vai para a auditoria */
  overrideReasons?: string[];
}

/**
 * Único caminho por onde uma ordem pode nascer.
 *
 * Duas invariantes que o resto do sistema depende:
 *  1. Ordem em conta REAL só sai com token assinado a partir de um preview que
 *     o usuário confirmou. Nenhum cron, alerta ou robô chega aqui.
 *  2. A compra automática existe apenas para PAPER e TESTNET — o modo LIVE é
 *     recusado explicitamente, não por configuração.
 */
/**
 * Patrimônio da conta: o caixa mais o que as moedas valem.
 *
 * Um lugar só para a soma, porque ela precisa bater em toda porta que decide
 * risco. Quem quer o dinheiro gastável continua lendo `available`.
 */
/**
 * Abaixo disto, o saldo é resíduo de venda e não vale um aviso.
 *
 * Um centavo de PEPE não é dinheiro esquecido: é o que sobra do arredondamento
 * de lote da última saída, e a corretora nem aceita vendê-lo. Avisar sobre ele
 * é gastar a atenção do usuário com algo que não tem ação possível.
 */
const POEIRA_USDT = 1;

export function patrimonio(view: CapitalView): number {
  return round(view.capital + view.holdingsValue, 2);
}

export class ExecutionService {
  private readonly repository: Repository;
  private readonly settings: SettingsService;
  private readonly market: MarketDataService;
  private readonly paper: PaperTradingEngine;
  private readonly audit: AuditService;
  private readonly bus: EventBus;
  private readonly risk: RiskService;
  private readonly dependencies: ExecutionDependencies;
  private readonly inFlight = new Map<string, Promise<Trade>>();
  /** avisado quando o robô compra — o scanner tira o setup do radar */
  private onBought: ((setup: TradeSetup) => Promise<unknown>) | null = null;

  constructor(
    repository: Repository,
    settings: SettingsService,
    market: MarketDataService,
    paper: PaperTradingEngine,
    audit: AuditService,
    bus: EventBus,
    risk: RiskService,
    dependencies: ExecutionDependencies = defaultDependencies,
  ) {
    this.repository = repository;
    this.settings = settings;
    this.market = market;
    this.paper = paper;
    this.audit = audit;
    this.bus = bus;
    this.risk = risk;
    this.dependencies = dependencies;
  }

  setOnBought(handler: (setup: TradeSetup) => Promise<unknown>): void {
    this.onBought = handler;
  }

  /**
   * Capital sempre em USDT — o valor em reais é só apresentação.
   *
   * Recebe o modo porque cada sessão tem a sua carteira: o robô do demo
   * continua operando o capital do demo enquanto o usuário olha a conta real.
   */
  async getCapital(
    mode: TradingMode = this.settings.get().mode,
    market: MarketKind = this.settings.get().market,
  ): Promise<CapitalView> {
    const policy = this.settings.forMode(mode, market);
    const brlRate = await this.dependencies.loadBrlRate();

    if (mode === 'PAPER') {
      const trades = await this.repository.listTrades();
      const base = this.paperCapitalInUsdt(policy.risk.paperCapital, policy.risk.paperCapitalCurrency, brlRate);
      // a carteira de papel é de cada modalidade: a demo de futuros não pode
      // gastar o caixa que a demo de spot já comprometeu
      const balance = paperBalance(trades, base, market);
      return {
        capital: balance.capital,
        available: balance.available,
        holdingsValue: 0,
        source: 'PAPER',
        currency: 'USDT',
        brlRate,
      };
    }

    const usdt = await this.dependencies.loadUsdtBalance(market);
    const environment = environmentForMode(mode, market);
    /*
     * Em spot, capital é caixa MAIS o que as moedas valem.
     *
     * Isto era só o USDT — e por isso o capital de uma conta spot despencava
     * no instante em que ela comprava alguma coisa: o dinheiro saía do caixa e
     * passava a existir como moeda, que ninguém contava. Em 26/08/2026 a conta
     * real valia 24,86 USDT (1,07 em caixa e 23,78 em NVDAB) e o sistema
     * inteiro trabalhava com 1,07.
     *
     * As consequências não eram de tela. O teto de exposição compara
     * `exposição + ordem nova` contra `capital × 80%`; com a exposição
     * contando a posição (23,78) e o capital contando só o caixa (1,07), os
     * dois lados falavam de coisas diferentes e a conta NUNCA fechava — 80% de
     * 1,07 é 0,86, e qualquer ordem era recusada por "exposição total". Pior:
     * o tamanho da ordem também sai daqui, então as poucas que passavam
     * nasciam de centavos e morriam no mínimo da Binance. O robô ficou
     * impedido de comprar na conta real enquanto houvesse UMA posição aberta.
     *
     * `available` continua sendo o caixa: patrimônio é o que se tem, mas só o
     * caixa é o que se pode gastar. O que não tem preço vivo fica de fora — um
     * capital menor só aperta o porteiro, e apertar erra para o lado seguro.
     */
    const holdingsValue =
      market === 'SPOT'
        ? (usdt.idle ?? []).reduce((total, holding) => {
            const price = this.market.getPrice(`${holding.asset}USDT`);
            if (price === null || price <= 0) return total;
            return total + (holding.free + (holding.locked ?? 0)) * price;
          }, 0)
        : 0;
    return {
      capital: round(usdt.free + usdt.locked, 2),
      available: round(usdt.free, 2),
      holdingsValue: round(holdingsValue, 2),
      source:
        environment.network === 'testnet'
          ? market === 'FUTURES'
            ? 'BINANCE_FUTURES_TESTNET'
            : 'BINANCE_TESTNET'
          : market === 'FUTURES'
            ? 'BINANCE_FUTURES'
            : 'BINANCE',
      currency: 'USDT',
      brlRate,
      idleAssets: usdt.idle,
    };
  }

  private paperCapitalInUsdt(
    amount: number,
    currency: 'USDT' | 'BRL',
    brlRate: number | null,
  ): number {
    if (currency === 'USDT') return amount;
    if (!brlRate || brlRate <= 0) return amount; // sem cotação, não inventa conversão
    return round(amount / brlRate, 2);
  }

  /**
   * Passo 1 do fluxo de ordem: a conta exata antes de qualquer envio.
   *
   * A modalidade vem do SETUP, não do seletor da tela.
   *
   * Enquanto havia uma modalidade ativa por vez as duas coisas eram a mesma;
   * com as duas colunas no radar, não são. Clicar numa tese de futuros com o
   * seletor em spot pedia a ordem no livro errado — e o painel respondia com
   * "este setup é de futuros e a modalidade ativa é outra", uma recusa
   * correta para uma pergunta que ninguém fez. O seletor organiza; quem
   * decide onde a ordem cai é a tese que foi clicada.
   */
  async preview(
    request: PreviewRequest,
    setup: TradeSetup,
    automatic = false,
    mode: TradingMode = this.settings.get().mode,
    market: MarketKind = setup.market ?? this.settings.get().market,
  ): Promise<PreviewResult> {
    const policy = this.settings.forMode(mode, market);
    const side = setup.side;
    const futures = market === 'FUTURES';
    // spot não tem alavancagem: forçar 1 aqui evita que uma configuração de
    // futuros esquecida no balde do spot vire margem inventada
    const pedida = request.leverage ?? policy.futures.leverage;
    // o teto dos ajustes vale sempre: o seletor do modal escolhe DENTRO dele
    const leverage = futures
      ? Math.min(Math.max(1, Math.round(pedida)), Math.max(1, Math.round(policy.futures.maxLeverage)))
      : 1;
    const currentPrice = this.market.getPrice(setup.symbol) ?? setup.currentPrice;
    /*
     * Clique manual no DEMO significa entrar agora. Em conta real/testnet a
     * ordem continua LIMIT, mas o usuário pode aceitar uma folga curta além
     * da zona. A folga nasce em 0,5%, tem teto de 2% no schema e nunca chega
     * ao robô: entrada automática continua estritamente presa à tese.
     */
    const entryPrice =
      mode === 'PAPER' && !automatic
        ? currentPrice
        : !automatic
          ? manualLimitPrice(currentPrice, setup, policy.guard.manualEntryTolerancePercent)
          : clampToZone(currentPrice, setup);
    const requestedSetup: TradeSetup = {
      ...setup,
      stopLoss: request.stopLoss ?? setup.stopLoss,
      target1: request.target1 ?? setup.target1,
      target2: request.target2 === undefined ? setup.target2 : request.target2,
      target3: request.target3 === undefined ? setup.target3 : request.target3,
    };
    const planErrors = validateTradePlan(requestedSetup, side, entryPrice);

    const capitalView = await this.getCapital(mode, market);
    const requested =
      request.quoteAmount ??
      (request.percentOfCapital
        ? round((capitalView.available * request.percentOfCapital) / 100, 2)
        : 0);
    // Na compra manual spot, "quero investir" é o tamanho escolhido — não o
    // máximo de uma conta que o servidor pode reduzir sem pedir licença.
    const manualSpotAmount = !automatic && market === 'SPOT' && requested > 0;

    // R/R líquido: é ele que decide se a operação vale, não o bruto da tela
    const netRR = netRiskReward({
      entryPrice,
      stopLoss: requestedSetup.stopLoss,
      target: requestedSetup.target1,
      costs: policy.guard,
      side,
    });

    /*
      O disjuntor mede contra o PATRIMÔNIO, não contra o caixa.

      Era aqui que a conta não fechava: a exposição soma as posições abertas e
      o teto era 80% do caixa. Em 26/08/2026, com 1,07 USDT em caixa e 23,78
      em NVDAB, o porteiro comparava 23,78 contra 0,86 e recusava TUDO —
      inclusive BABYUSDT, que a decisão tinha acabado de liberar. Enquanto
      houvesse uma posição aberta, o robô não comprava mais nada na conta real.
    */
    const snapshot = await this.risk.snapshot(patrimonio(capitalView), mode, market);
    const openTrades = this.paper
      .getOpenTrades()
      .filter((trade) => trade.mode === mode && trade.market === market);
    const firstGate = this.risk.gate({
      snapshot,
      symbol: setup.symbol,
      quoteAmount: requested,
      netRiskReward: netRR,
      openTrades,
      side,
      mode,
      market,
    });

    // O robô continua reduzindo tamanho em mercado nervoso. Na ordem manual,
    // o usuário vê o alerta e confirma o valor que escolheu.
    const quoteAmount =
      !manualSpotAmount && firstGate.sizeFactor < 1
        ? round(requested * firstGate.sizeFactor, 2)
        : requested;
    const gate =
      !manualSpotAmount && firstGate.sizeFactor < 1
        ? this.risk.gate({
            snapshot,
            symbol: setup.symbol,
            quoteAmount,
            netRiskReward: netRR,
            openTrades,
            side,
            mode,
            market,
          })
        : firstGate;

    let filters: SymbolFilters | null = null;
    const filterErrors: string[] = [];
    try {
      filters = await this.dependencies.loadFilters(setup.symbol, market);
    } catch (error) {
      filterErrors.push(`Não foi possível validar os filtros da Binance: ${(error as Error).message}`);
    }

    /*
     * Tamanho pelo PREJUÍZO no stop, não pelo valor investido.
     *
     * O orçamento é riskPerTradePercent do patrimônio, já descontadas taxa e
     * escorregamento. Tudo o mais — percentual do capital, teto por ordem,
     * saldo, passo do lote — entra como limite. Antes o cálculo partia do
     * valor a investir e, quando o risco estourava, o excesso virava um aviso
     * que não impedia nada: com stop largo, "10% do capital" arriscava vários
     * por cento sem que ninguém visse.
     */
    const sized = sizeByRisk({
      entryPrice,
      stopLoss: requestedSetup.stopLoss,
      equity: snapshot.equity > 0 ? snapshot.equity : patrimonio(capitalView),
      available: capitalView.available,
      riskPerTradePercent: policy.risk.riskPerTradePercent,
      maxPositionPercent: policy.risk.maxPositionPercent,
      maxNotional: automatic ? policy.autoTrade.maxNotionalPerTrade : Number.POSITIVE_INFINITY,
      costs: policy.guard,
      requestedQuote: automatic ? undefined : quoteAmount > 0 ? quoteAmount : undefined,
      // Compra manual spot usa o valor pedido. O risco continua calculado e
      // mostrado, mas os tetos internos deixam de alterar a quantidade.
      enforcePolicyLimits: !manualSpotAmount,
      sizeFactor: manualSpotAmount ? 1 : gate.sizeFactor,
      stepSize: filters?.stepSize,
      /*
       * O piso da corretora só existe para a ordem MANUAL.
       *
       * Quem clica decide com o número na frente e pode assumir risco acima do
       * orçamento — a tela mostra quanto e exige confirmação. O robô não:
       * ele opera dentro do orçamento ou não opera. Deixá-lo subir sozinho até
       * o mínimo da corretora seria autorizá-lo a estourar a régua toda vez
       * que a conta ficasse pequena, que é justamente quando ela mais protege.
       */
      minNotional: automatic ? undefined : filters?.minNotional,
      side,
      leverage,
    });

    /*
     * Os alvos do PREVIEW são os mesmos da ordem.
     *
     * A peneira só rodava na execução, então a tela oferecia alvos que a
     * ordem descartava em silêncio — e o pior deles era um preço NEGATIVO,
     * que só o lado vendido consegue produzir. Mostrar aqui o que vai ser
     * enviado é a diferença entre conferir a operação e adivinhar.
     */
    const alvos = sanitizeTargets({
      entryPrice,
      target1: requestedSetup.target1,
      target2: requestedSetup.target2,
      target3: requestedSetup.target3,
      maxTargetPercent: policy.guard.maxTargetPercent,
      side,
    });
    const setupComAlvosReais: TradeSetup = {
      ...requestedSetup,
      target1: alvos.target1,
      target2: alvos.target2,
      target3: alvos.target3,
    };

    const sizing = toSizingResult(
      sized,
      setupComAlvosReais,
      entryPrice,
      capitalView.capital,
      policy.risk,
      side,
    );

    /*
     * A segunda saída, a que não é sua.
     *
     * Alavancado, a corretora fecha a posição quando a margem acaba — e se
     * essa linha estiver antes do stop, o stop nunca executa. O prejuízo
     * deixaria de ser o 1% do orçamento para ser a margem inteira, e o
     * sistema teria aprovado a operação achando que estava protegido.
     */
    const liquidation = futures
      ? checkLiquidation({
          side,
          entryPrice,
          quantity: sizing.quantity,
          leverage,
          marginMode: policy.futures.marginMode,
          walletBalance: capitalView.capital,
          stopLoss: requestedSetup.stopLoss,
          minBufferPercent: policy.futures.minLiquidationBufferPercent,
        })
      : null;
    const safeLeverage = futures
      ? maxSafeLeverage({
          side,
          entryPrice,
          stopLoss: requestedSetup.stopLoss,
          minBufferPercent: policy.futures.minLiquidationBufferPercent,
          ceiling: policy.futures.maxLeverage,
        })
      : null;

    if (filters) {
      const validation = validateOrder(filters, sizing.quantity, entryPrice);
      filterErrors.push(...validation.errors);
      if (validation.valid) sizing.quantity = validation.quantity;
    }

    const margin = futures ? round(marginRequired(sizing.notional, leverage), 2) : sizing.notional;

    /*
     * As travas julgam a ORDEM QUE VAI SAIR, não o valor digitado.
     *
     * O dimensionamento é um funil: pede-se 6 USDT, o teto por posição corta
     * para 1,26, e é 1,26 que vai para a corretora. Julgar o pedido produzia
     * uma tela que se contradizia — "Valor da posição US$ 1,26" logo acima de
     * "Saldo insuficiente: disponível 5,08" e "Exposição chegaria a 6,00".
     * Três números, um só verdadeiro, e o usuário sem como saber qual.
     *
     * Em futuros o que precisa caber no saldo é a MARGEM: com 3x, uma posição
     * de 300 USDT prende 100.
     */
    const gateFinal =
      round(sizing.notional, 2) === round(quoteAmount, 2)
        ? gate
        : this.risk.gate({
            snapshot,
            symbol: setup.symbol,
            quoteAmount: sizing.notional,
            netRiskReward: netRR,
            openTrades,
            side,
            mode,
            market,
          });

    const blockers = [
      ...(await this.collectBlockers({
        setup,
        mode,
        market,
        // Se o usuário pediu mais do que possui, não esconda isso reduzindo a
        // ordem até o saldo. O bloqueio precisa comparar o pedido original.
        quoteAmount: manualSpotAmount ? requested : margin,
        available: capitalView.available,
        sizingBlockers: sizing.blockReasons,
      })),
      ...gateFinal.blockers,
      ...planErrors,
    ];
    if (liquidation?.blockReason) {
      blockers.push(
        safeLeverage !== null && safeLeverage < leverage
          ? `${liquidation.blockReason} (com este stop, o máximo seguro é ${safeLeverage}x)`
          : liquidation.blockReason,
      );
    }

    const warnings = [...sizing.warnings, ...gateFinal.warnings];
    const manualDistance =
      !automatic && mode !== 'PAPER' ? unfavorableDistancePercent(currentPrice, setup) : 0;
    if (manualDistance > 0 && entryPrice === currentPrice) {
      warnings.push(
        `Entrada manual ${manualDistance.toFixed(2)}% além da zona, dentro da tolerância de ${policy.guard.manualEntryTolerancePercent.toFixed(2)}%. Risco e R/R foram recalculados nesse preço`,
      );
    }
    if (alvos.dropped.length > 0) {
      warnings.push(`Alvo descartado — ${alvos.dropped.join('; ')}. A posição vive do alvo 1 e do stop`);
    }
    if (futures && liquidation?.liquidationPrice) {
      warnings.push(
        `Posição ${sideLabel(side)} ${leverage}x — margem de ${margin.toFixed(2)} USDT, liquidação estimada em ${liquidation.liquidationPrice.toPrecision(6)}`,
      );
    }
    const strategyRejection = automaticStrategyRejectionReason(setup);
    if (strategyRejection !== null) {
      // "compra automática" numa tese de VENDA é a frase contradizendo o
      // próprio aviso; o que está bloqueado é a ENTRADA do robô, dos dois lados
      warnings.push(
        `O robô não entra sozinho nesta tese: ${strategyRejection}. Isso não bloqueia a ordem manual por si só; as demais travas de risco continuam valendo`,
      );
    }
    if (setup.extended) {
      warnings.push('Setup marcado como ESTICADO — o preço já se afastou do ponto de invalidação');
    }
    /*
     * Dinheiro na conta que o painel não enxerga — UM aviso, não sete.
     *
     * Depósito em reais cai como BRL. O painel opera pares USDT, então o caixa
     * não se mexe e a conclusão natural de quem depositou é "não caiu". Caiu,
     * está na moeda errada, e só a corretora converte.
     *
     * Isto virava uma linha POR MOEDA, com o mesmo texto de trinta palavras
     * repetido. Numa conta com poeira de seis vendas antigas, o aviso que
     * importa some no meio de seis irmãos idênticos. Duas correções:
     *
     *  1. a moeda de uma POSIÇÃO ABERTA não é dinheiro parado. Ela aparecia
     *     aqui pedindo para ser convertida — exatamente a moeda que o sistema
     *     acabou de comprar de propósito;
     *  2. o que sobra é resíduo. Só vale avisar sobre o que dá para converter:
     *     poeira abaixo do mínimo negociável não tem ação possível, e um aviso
     *     sem ação é ruído. Uma linha, as moedas juntas, maior primeiro.
     */
    const emPosicao = new Set(
      openTrades.map((trade) => trade.symbol.replace(/USDT$/, '')),
    );
    const parados = (capitalView.idleAssets ?? [])
      .filter((parado) => !emPosicao.has(parado.asset))
      .map((parado) => {
        const quantidade = parado.free + (parado.locked ?? 0);
        const preco = this.market.getPrice(`${parado.asset}USDT`);
        return { asset: parado.asset, quantidade, valor: preco === null ? null : quantidade * preco };
      })
      // sem cotação não dá para dizer se é resíduo: melhor avisar do que calar
      .filter((parado) => parado.valor === null || parado.valor >= POEIRA_USDT)
      .sort((a, b) => (b.valor ?? 0) - (a.valor ?? 0));

    if (parados.length > 0) {
      const lista = parados
        .map(
          (parado) =>
            `${parado.quantidade.toLocaleString('pt-BR', { maximumFractionDigits: 8 })} ${parado.asset}`,
        )
        .join(', ');
      warnings.push(
        `Na conta há ${lista} — o painel opera em USDT e não conta ${parados.length > 1 ? 'esses saldos' : 'esse saldo'}. Converta na Binance para que ${parados.length > 1 ? 'entrem' : 'entre'} no capital`,
      );
    }

    /*
     * Nem toda recusa é do mesmo tipo.
     *
     * Umas são POLÍTICA: R/R mínimo, teto de exposição, limite de operações.
     * São réguas que o próprio usuário escolheu e que ele pode, sabendo o que
     * faz, atropelar numa ordem específica — testar o caminho da conta real
     * com cinco dólares é um motivo legítimo, e obrigá-lo a afrouxar a régua
     * de TODAS as ordens para fazer uma seria trocar um problema pequeno por
     * um permanente.
     *
     * Outras são REALIDADE: o mínimo de nocional da Binance, o par que parou
     * de negociar, o saldo que não existe, a liquidação que chega antes do
     * stop. Nenhuma confirmação muda essas — atropelá-las só mudaria o lugar
     * da recusa, do painel para a corretora, ou pior: deixaria passar uma
     * ordem que a corretora aceita e que não protege nada.
     *
     * O `override` só desarma as primeiras, uma ordem por vez, e fica gravado.
     */
    const duros = blockers.filter((motivo) => !cedeAConfirmacao(motivo));
    const negociaveis = blockers.filter((motivo) => cedeAConfirmacao(motivo));
    /*
     * Em SPOT manual, política é aviso por padrão.
     *
     * A etapa final de confirmação continua obrigatória e o token leva todas
     * as regras ignoradas para a auditoria. O robô nunca recebe esse atalho;
     * saldo e regras da Binance continuam em `duros`.
     */
    const manualPolicyOverride =
      !automatic && market === 'SPOT' && negociaveis.length > 0;
    const override = request.override === true || manualPolicyOverride;
    const impeditivos = override ? duros : blockers;

    const canExecute = impeditivos.length === 0 && filterErrors.length === 0 && sizing.quantity > 0;
    // só faz sentido oferecer o atalho quando é ELE que está no caminho
    const canOverride =
      !override &&
      negociaveis.length > 0 &&
      duros.length === 0 &&
      filterErrors.length === 0 &&
      sizing.quantity > 0;
    if (override && negociaveis.length > 0) {
      warnings.push(
        `${manualPolicyOverride ? 'ORDEM MANUAL' : 'ORDEM FORÇADA'} — regras internas mantidas como aviso nesta ordem: ${negociaveis.join('; ')}`,
      );
    }
    const expiresAt = canExecute ? Date.now() + CONFIRMATION_TTL_MS : null;

    return {
      // a tese que volta para a tela é a que a ordem vai executar
      setup: setupComAlvosReais,
      mode,
      market,
      side,
      leverage,
      margin,
      liquidationPrice: liquidation?.liquidationPrice ?? null,
      safeLeverage,
      entryPrice,
      currentPrice,
      capital: capitalView.capital,
      available: capitalView.available,
      brlRate: capitalView.brlRate,
      sizing,
      riskSizing: sized,
      filters,
      filterErrors,
      blockers: impeditivos,
      overridableBlockers: negociaveis,
      canOverride,
      overridden: override && negociaveis.length > 0,
      warnings: [...new Set(warnings)],
      netRiskReward: netRR,
      canExecute,
      confirmationToken: expiresAt
        ? this.signConfirmation({
            setupId: setup.id,
            quantity: sizing.quantity,
            entryPrice,
            quoteAmount: round(sizing.quantity * entryPrice, 2),
            stopLoss: setupComAlvosReais.stopLoss,
            target1: setupComAlvosReais.target1,
            target2: setupComAlvosReais.target2,
            target3: setupComAlvosReais.target3,
            mode,
            expiresAt,
            automatic,
            market,
            side,
            leverage,
            override,
            overrideReasons: override ? negociaveis : undefined,
          })
        : null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    };
  }

  private async collectBlockers(input: {
    setup: TradeSetup;
    mode: TradingMode;
    market: MarketKind;
    quoteAmount: number;
    available: number;
    sizingBlockers: string[];
  }): Promise<string[]> {
    const { setup, mode, market, quoteAmount, available } = input;
    const settings = this.settings.get();
    const policy = this.settings.forMode(mode, market);
    const blockers = [...input.sizingBlockers];

    // o interruptor geral vem antes de tudo: barrado, nenhuma ordem
    // alavancada sai nem por caminho interno que passe a modalidade na mão
    if (market === 'FUTURES' && !settings.futuresEnabled) {
      blockers.push('Futuros está barrado no painel — libere a modalidade nos ajustes');
    }
    // a tese e a modalidade têm de ser a mesma coisa: um setup de futuros não
    // se executa em spot, e vender a descoberto em spot não existe
    if (setup.market !== market) {
      blockers.push(
        `Este setup é de ${setup.market === 'FUTURES' ? 'futuros' : 'spot'} e a modalidade ativa é outra`,
      );
    }
    if (setup.side === 'SELL') {
      if (market !== 'FUTURES') {
        blockers.push('Venda a descoberto só existe em futuros');
      } else if (!policy.futures.allowShort) {
        blockers.push('A venda a descoberto não está liberada nos ajustes desta conta');
      }
    }

    if (quoteAmount > available) {
      // dizer só o disponível obrigava a adivinhar o que faltou; com os dois
      // números a frase se explica sozinha
      blockers.push(
        `Saldo insuficiente: a ordem precisa de ${quoteAmount.toFixed(2)} USDT e há ${available.toFixed(2)} disponíveis`,
      );
    }
    if (setup.status === 'INVALIDATED' || setup.status === 'EXPIRED') {
      blockers.push('Este setup não está mais válido');
    }

    const openTrades = this.paper
      .getOpenTrades()
      .filter((trade) => trade.mode === mode && trade.market === market);
    if (openTrades.length >= settings.risk.maxOpenTrades) {
      blockers.push(`Limite de ${settings.risk.maxOpenTrades} operações abertas atingido`);
    }
    if (openTrades.some((trade) => trade.setupId === setup.id)) {
      blockers.push('Já existe uma operação aberta para este setup');
    }

    if (mode !== 'PAPER') {
      const environment = environmentForMode(mode, market);
      if (!environment.hasCredentials) {
        blockers.push(missingCredentialsMessage(mode, market));
      }
      if (getActiveEnvironment().name !== environment.name) {
        blockers.push('O ambiente da Binance ainda está trocando — tente de novo em instantes');
      }
    }
    return blockers;
  }

  /**
   * Passo 2: só executa com o token da confirmação que o usuário aprovou.
   *
   * A modalidade é a da TESE, pela mesma razão do preview — e o token carrega
   * a modalidade aprovada, então divergir aqui invalidaria a confirmação em
   * vez de mandar a ordem para o lugar errado.
   */
  async execute(
    request: ExecuteRequest,
    setup: TradeSetup,
    mode: TradingMode = this.settings.get().mode,
    market: MarketKind = setup.market ?? this.settings.get().market,
  ): Promise<Trade> {
    const existing = this.inFlight.get(request.idempotencyKey);
    if (existing) return existing;

    const promise = this.runExecution(request, setup, mode, market);
    this.inFlight.set(request.idempotencyKey, promise);
    try {
      return await promise;
    } finally {
      setTimeout(() => this.inFlight.delete(request.idempotencyKey), 60_000).unref?.();
    }
  }

  /**
   * Compra automática.
   *
   * Em PAPER e TESTNET o robô age livre. Em conta real precisa das DUAS
   * chaves giradas: a variável do servidor e o armar do painel, que expira
   * sozinho. Trava só na interface é trava que um clique desfaz; trava só no
   * servidor é trava que ninguém consegue conferir na hora.
   */
  /**
   * Compra automática de UMA sessão.
   *
   * Recebe o modo e a decisão já tomada: quem decide é o AutoTrader, com a
   * função pura de decisão, e aqui só se executa. As checagens que sobraram
   * são defesa em profundidade — uma chamada futura que pule o AutoTrader não
   * pode contornar a estratégia validada nem a trava da conta real.
   */
  async executeAutomatic(
    setup: TradeSetup,
    mode: TradingMode = this.settings.get().mode,
    decision?: EntryDecision,
    market: MarketKind = setup.market ?? this.settings.get().market,
    /*
      Avisado quando a EXECUÇÃO recusa o que a decisão já tinha liberado.

      Existiam duas portas e só a primeira tinha voz. A decisão dizia ALLOWED,
      o painel escrevia "robô entraria", e aqui a ordem morria no teto de
      exposição ou no mínimo da corretora — com o motivo indo para o log de
      auditoria, onde ninguém procura. Foi assim que "por que não entrou?"
      ficou sem resposta em BABYUSDT no dia 26/08/2026: liberada às 22:46:35,
      recusada às 22:46:36, e a tela continuou prometendo a entrada.
    */
    onRefused?: (refusal: { blockers: string[]; warnings: string[] }) => void,
  ): Promise<Trade | null> {
    const policy = this.settings.forMode(mode, market);
    if (!policy.autoTrade.enabled) return null;

    const strategyRejection = automaticStrategyRejectionReason(setup);
    if (strategyRejection !== null) {
      this.audit.record({
        action: 'AUTO_TRADE_SKIPPED',
        mode,
        symbol: setup.symbol,
        setupId: setup.id,
        detail: { blockers: [strategyRejection] },
      });
      return null;
    }

    // nunca empilha: mesmo setup ou mesmo ativo já em carteira NESTA sessão
    const alreadyOpen = this.paper
      .getOpenTrades()
      .some(
        (trade) =>
          trade.mode === mode &&
          trade.market === market &&
          (trade.setupId === setup.id || trade.symbol === setup.symbol),
      );
    if (alreadyOpen) return null;

    if (mode === 'LIVE') {
      const denial = liveAutoTradeDenial(policy);
      if (denial !== null) {
        this.audit.record({
          action: 'AUTO_TRADE_BLOCKED_LIVE',
          mode,
          symbol: setup.symbol,
          setupId: setup.id,
          detail: { motivo: denial },
        });
        return null;
      }
    }

    // O tamanho sai do preview, que dimensiona pelo risco. Nada de calcular
    // aqui um valor a investir: era exatamente esse caminho paralelo que
    // deixava o risco por operação virar um aviso sem efeito.
    const preview = await this.preview({ setupId: setup.id }, setup, true, mode, market);
    if (!preview.canExecute || !preview.confirmationToken) {
      this.audit.record({
        action: 'AUTO_TRADE_SKIPPED',
        mode,
        symbol: setup.symbol,
        setupId: setup.id,
        detail: {
          blockers: preview.blockers,
          filterErrors: preview.filterErrors,
          risco: preview.riskSizing.blockReason,
        },
      });
      onRefused?.({
        blockers: [
          ...preview.blockers,
          ...preview.filterErrors,
          ...(preview.riskSizing.blockReason === null ? [] : [preview.riskSizing.blockReason]),
        ],
        warnings: preview.warnings,
      });
      return null;
    }

    const trade = await this.execute(
      {
        setupId: setup.id,
        confirmationToken: preview.confirmationToken,
        // a chave inclui o modo: a mesma oportunidade comprada em duas sessões
        // são duas ordens diferentes, e compartilhar a chave faria a segunda
        // devolver silenciosamente a operação da primeira
        // a chave inclui a modalidade pelo mesmo motivo do modo: a mesma
        // explosão comprada em spot e em futuros são duas ordens diferentes
        idempotencyKey: `auto${mode.slice(0, 2)}${market.slice(0, 1)}${setup.id.replace(/-/g, '').slice(0, 17)}`,
      },
      setup,
      mode,
      market,
    );

    this.audit.record({
      action: 'AUTO_TRADE_EXECUTED',
      mode,
      symbol: setup.symbol,
      setupId: setup.id,
      tradeId: trade.id,
      detail: {
        score: setup.score,
        riskRewardLiquido: preview.netRiskReward,
        quantidade: trade.requestedQuantity,
        valor: trade.notional,
        riscoNoStop: preview.riskSizing.riskAmount,
        riscoPercentDoPatrimonio: preview.riskSizing.riskPercentOfEquity,
        limitouOTamanho: preview.riskSizing.boundBy,
        decisao: decision?.code ?? 'ALLOWED',
      },
    });
    // o setup precisa sair do radar aqui também, senão ele expira sozinho mais
    // tarde e cancela a ordem que o próprio robô acabou de abrir
    if (this.onBought) await this.onBought(setup);
    return trade;
  }

  private async runExecution(
    request: ExecuteRequest,
    setup: TradeSetup,
    mode: TradingMode = this.settings.get().mode,
    market: MarketKind = setup.market ?? this.settings.get().market,
  ): Promise<Trade> {
    const settings = { ...this.settings.get(), ...this.settings.forMode(mode, market), mode, market };
    const side = setup.side;
    const clientOrderId = buildClientOrderId(request.idempotencyKey);

    // clique duplo: a operação já existe, devolve a mesma em vez de duplicar
    const trades = await this.repository.listTrades();
    const duplicate = trades.find(
      (trade) => trade.mode === mode && trade.clientOrderId === clientOrderId,
    );
    if (duplicate) {
      this.audit.record({
        action: 'ORDER_DUPLICATE_IGNORED',
        mode,
        symbol: setup.symbol,
        setupId: setup.id,
        tradeId: duplicate.id,
        detail: { clientOrderId },
      });
      return duplicate;
    }

    const payload = this.verifyConfirmation(request.confirmationToken);
    if (payload.setupId !== setup.id) {
      throw new ExecutionError('A confirmação é de outro setup');
    }
    if (payload.mode !== mode) {
      throw new ExecutionError('O modo de operação mudou depois da confirmação — refaça');
    }
    if ((payload.market ?? 'SPOT') !== market) {
      throw new ExecutionError('A modalidade mudou depois da confirmação — refaça');
    }
    if ((payload.side ?? 'BUY') !== side) {
      throw new ExecutionError('O lado da operação mudou depois da confirmação — refaça');
    }
    const approvedSetup: TradeSetup = {
      ...setup,
      stopLoss: payload.stopLoss,
      target1: payload.target1,
      target2: payload.target2 ?? null,
      target3: payload.target3 ?? null,
    };
    const planErrors = validateTradePlan(approvedSetup, side, payload.entryPrice);
    if (planErrors.length > 0) {
      throw new ExecutionError(`Plano aprovado deixou de ser válido: ${planErrors[0]}`, 400);
    }

    const leverage = market === 'FUTURES' ? Math.max(1, Math.round(payload.leverage ?? 1)) : 1;
    const capitalView = await this.getCapital(mode, market);
    const blockers = await this.collectBlockers({
      setup,
      mode,
      market,
      quoteAmount:
        market === 'FUTURES'
          ? round(marginRequired(payload.quoteAmount, leverage), 2)
          : payload.quoteAmount,
      available: capitalView.available,
      sizingBlockers: [],
    });
    /*
     * A reconferência na hora do envio.
     *
     * O token diz se o usuário aprovou uma ordem FORÇADA — e só as travas de
     * política cedem a isso. As de realidade continuam de pé aqui, que é o
     * ponto: entre a confirmação e o envio o saldo pode ter sumido, o par
     * pode ter parado, e nenhuma aprovação de trinta segundos atrás muda isso.
     *
     * O robô nunca chega aqui com override: `executeAutomatic` não oferece o
     * caminho, e o token que ele assina nasce sem a marca.
     */
    const forcada = payload.override === true && !payload.automatic;
    const impeditivos = forcada ? blockers.filter((motivo) => !cedeAConfirmacao(motivo)) : blockers;
    if (impeditivos.length > 0) throw new ExecutionError(impeditivos[0] as string);

    /*
     * O registro sai do TOKEN, não do que sobrou na reconferência.
     *
     * Boa parte das travas de política mora no porteiro de risco, que só roda
     * na prévia — na hora do envio elas nem reaparecem. Condicionar o registro
     * a "ainda estar bloqueado" deixaria a ordem forçada passar sem rastro
     * justamente no caso mais comum. O que precisa ficar gravado é o fato: o
     * usuário aprovou uma ordem forçada.
     */
    const ignoradas = forcada ? blockers.filter(cedeAConfirmacao) : [];
    if (forcada) {
      const regrasRegistradas =
        ignoradas.length > 0 ? ignoradas : payload.overrideReasons ?? [];
      // registro próprio, e não uma nota dentro do ORDER_CONFIRMED: uma ordem
      // que passou por cima das travas precisa ser encontrável sozinha depois
      await this.audit.recordNow({
        action: 'ORDER_OVERRIDE',
        mode,
        symbol: setup.symbol,
        setupId: setup.id,
        detail: {
          travasIgnoradas: regrasRegistradas,
          quantity: payload.quantity,
          quoteAmount: payload.quoteAmount,
          entryPrice: payload.entryPrice,
        },
      });
      logger.warn('Ordem enviada com travas de risco desarmadas pelo usuário', {
        symbol: setup.symbol,
        mode,
        travas: regrasRegistradas,
      });
    }

    const filters = await this.dependencies.loadFilters(setup.symbol, market);
    if (filters) {
      const validation = validateOrder(filters, payload.quantity, payload.entryPrice);
      if (!validation.valid) throw new ExecutionError(validation.errors[0] as string);
    }

    // este espera: é o registro de "aprovei esta ordem", e ele precisa estar
    // gravado antes de a ordem existir na corretora
    await this.audit.recordNow({
      action: payload.automatic ? 'AUTO_ORDER_CONFIRMED' : 'ORDER_CONFIRMED',
      mode,
      symbol: setup.symbol,
      setupId: setup.id,
      detail: {
        quantity: payload.quantity,
        entryPrice: payload.entryPrice,
        stopLoss: approvedSetup.stopLoss,
        target1: approvedSetup.target1,
        quoteAmount: payload.quoteAmount,
      },
    });

    // alvo que o mercado não entrega é o mesmo que não ter alvo: a parcela
    // ficaria pendurada para sempre. Descartado aqui, quem manda passa a ser
    // o stop que sobe.
    const targets = sanitizeTargets({
      entryPrice: payload.entryPrice,
      target1: approvedSetup.target1,
      target2: approvedSetup.target2,
      target3: approvedSetup.target3,
      maxTargetPercent: settings.guard.maxTargetPercent,
      side,
    });
    if (targets.dropped.length > 0) {
      this.audit.record({
        action: 'TARGETS_SANITIZED',
        mode,
        symbol: setup.symbol,
        setupId: setup.id,
        detail: { descartados: targets.dropped, teto: `${settings.guard.maxTargetPercent}%` },
      });
    }

    const now = new Date().toISOString();
    const notional = payload.quoteAmount;
    const margin = market === 'FUTURES' ? round(marginRequired(notional, leverage), 2) : notional;
    const liquidation =
      market === 'FUTURES'
        ? checkLiquidation({
            side,
            entryPrice: payload.entryPrice,
            quantity: payload.quantity,
            leverage,
            marginMode: settings.futures.marginMode,
            walletBalance: capitalView.capital,
            stopLoss: approvedSetup.stopLoss,
            minBufferPercent: settings.futures.minLiquidationBufferPercent,
          })
        : null;
    // a checagem já barrou isto no preview; aqui é defesa em profundidade,
    // porque entre aprovar e executar o preço (e a margem livre) mudaram
    if (liquidation?.stopBeyondLiquidation) {
      throw new ExecutionError(liquidation.blockReason ?? 'Liquidação antes do stop', 400);
    }

    const trade: Trade = {
      id: randomUUID(),
      setupId: setup.id,
      automatic: payload.automatic,
      symbol: setup.symbol,
      mode,
      market,
      side,
      setupType: setup.setupType,
      timeframe: setup.timeframe,
      score: setup.score,
      status: 'PENDING',
      outcome: 'OPEN',
      requestedQuantity: payload.quantity,
      filledQuantity: 0,
      remainingQuantity: 0,
      entryPrice: payload.entryPrice,
      averageFillPrice: null,
      stopLoss: approvedSetup.stopLoss,
      target1: targets.target1,
      target2: targets.target2,
      target3: targets.target3,
      notional,
      leverage,
      initialMargin: margin,
      marginMode: market === 'FUTURES' ? settings.futures.marginMode : undefined,
      liquidationPrice: liquidation?.liquidationPrice ?? null,
      riskAmount: round(
        payload.quantity * Math.max(-gainPerUnit(side, payload.entryPrice, approvedSetup.stopLoss), 0),
        2,
      ),
      realizedPnl: 0,
      realizedPnlPercent: 0,
      maxFavorablePercent: 0,
      maxAdversePercent: 0,
      feesPaid: 0,
      highWaterPrice: null,
      protectiveStop: null,
      closeReason: null,
      fills: [],
      exchangeOrderIds: [],
      clientOrderId,
      openedAt: now,
      closedAt: null,
      updatedAt: now,
    };

    if (mode === 'PAPER') {
      await this.repository.saveTrade(trade);
      this.paper.track(trade);
      this.bus.broadcast({ type: 'trade', payload: trade });
      this.audit.record({
        action: 'PAPER_TRADE_CREATED',
        mode,
        symbol: setup.symbol,
        setupId: setup.id,
        tradeId: trade.id,
        detail: { quantity: trade.requestedQuantity, entryPrice: trade.entryPrice },
      });
      // Uma operação recém-criada vira prioridade do fluxo ao vivo. Mesmo que
      // o ativo não esteja na watchlist, ele recebe o primeiro retrato agora e
      // continua acompanhado até encerrar.
      // Alguns testes e integrações enxutas fornecem apenas leitura de preço;
      // nesses casos não há um stream para reorganizar.
      if (
        typeof this.market.getSymbols === 'function' &&
        typeof this.market.setSymbols === 'function'
      ) {
        await this.market.setSymbols(
          prioritizedFocus(
            this.paper.getOpenTrades().map((item) => item.symbol),
            this.market.getSymbols(),
          ),
        );
      }
      // se o preço já está na zona, a ordem preenche na hora
      const price = this.market.getPrice(setup.symbol);
      if (price !== null) await this.paper.onPrice(setup.symbol, price);
      return this.paper.getOpenTrades().find((item) => item.id === trade.id) ?? trade;
    }

    return trade.market === 'FUTURES'
      ? this.sendToFutures(trade, setup, filters)
      : this.sendToBinance(trade, setup, filters);
  }

  /**
   * Entrada em futuros.
   *
   * Diferente do spot em três pontos que não são detalhe:
   *
   *  1. Antes da ordem é preciso ACERTAR A CONTA — margem e alavancagem são
   *     estado do par na corretora, não parâmetro da ordem. Sem isto a
   *     posição nasce com a alavancagem que sobrou da última vez.
   *  2. Não existe OTOCO. A entrada vai sozinha; alvo e stop só podem ser
   *     enviados depois, sobre uma posição que exista — quem os arma é o
   *     monitor, no instante em que a entrada preenche.
   *  3. Modo hedge é recusado. Neste modo cada ordem precisa declarar se abre
   *     ou fecha posição, e `reduceOnly` — a base de toda a proteção — deixa
   *     de significar o que o resto do sistema assume.
   */
  private async sendToFutures(
    trade: Trade,
    setup: TradeSetup,
    filters: SymbolFilters | null,
  ): Promise<Trade> {
    if (!filters) throw new ExecutionError('Filtros do par indisponíveis — ordem não enviada', 503);
    if (!readCredentials(environmentForMode(trade.mode, 'FUTURES').name)) {
      throw new ExecutionError(missingCredentialsMessage(trade.mode, 'FUTURES'), 401);
    }

    const quantity = formatQuantity(trade.requestedQuantity, filters);
    const entry = formatPrice(trade.entryPrice, filters);

    try {
      if (await isHedgeMode()) {
        throw new ExecutionError(
          'A conta de futuros está em modo hedge. Este painel opera uma posição por par (one-way) — troque em Preferências na Binance.',
          400,
        );
      }

      await setMarginMode(trade.symbol, trade.marginMode ?? 'ISOLATED');
      const applied = await setLeverage(trade.symbol, trade.leverage);
      if (applied !== trade.leverage) {
        // a corretora pode devolver menos que o pedido quando a faixa de
        // notional não permite: quem manda é o número dela
        this.audit.record({
          action: 'FUTURES_LEVERAGE_ADJUSTED',
          mode: trade.mode,
          symbol: trade.symbol,
          setupId: setup.id,
          tradeId: trade.id,
          detail: { pedida: trade.leverage, aplicada: applied },
        });
        trade.leverage = applied;
        trade.initialMargin = round(marginRequired(trade.notional, applied), 2);
      }

      const result = await futuresEntryOrder({
        symbol: trade.symbol,
        side: trade.side,
        quantity,
        price: entry,
        clientOrderId: trade.clientOrderId,
      });

      trade.exchangeOrderIds = [String(result.orderId)];
      trade.updatedAt = new Date().toISOString();
      await this.repository.saveTrade(trade);
      this.paper.track(trade);
      this.bus.broadcast({ type: 'trade', payload: trade });

      this.audit.record({
        action: 'FUTURES_ORDER_SENT',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: setup.id,
        tradeId: trade.id,
        detail: {
          lado: sideLabel(trade.side),
          alavancagem: trade.leverage,
          margem: trade.initialMargin,
          margemModo: trade.marginMode,
          liquidacaoEstimada: trade.liquidationPrice,
          ordem: result.orderId,
          // a proteção ainda NÃO está na corretora: futuros não aceita alvo e
          // stop antes de existir posição
          protecao: 'será armada quando a entrada preencher',
        },
      });
      return trade;
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      const message =
        error instanceof BinanceError
          ? `Binance recusou a ordem de futuros: ${error.message} (código ${error.code})`
          : (error as Error).message;
      this.audit.record({
        action: 'ORDER_FAILED',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: setup.id,
        tradeId: trade.id,
        detail: { message, mercado: 'FUTURES' },
      });
      logger.error('Falha ao enviar ordem de futuros', { symbol: trade.symbol, message });
      throw new ExecutionError(message, 502);
    }
  }

  private async sendToBinance(
    trade: Trade,
    setup: TradeSetup,
    filters: SymbolFilters | null,
  ): Promise<Trade> {
    if (!filters) throw new ExecutionError('Filtros do par indisponíveis — ordem não enviada', 503);
    if (!readCredentials(environmentForMode(trade.mode).name)) {
      throw new ExecutionError('Credenciais não configuradas para este modo', 401);
    }

    const quantity = formatQuantity(trade.requestedQuantity, filters);
    const entry = formatPrice(trade.entryPrice, filters);
    const takeProfit = formatPrice(trade.target1, filters);
    const stopTrigger = formatPrice(trade.stopLoss, filters);
    // preço limite do stop um tick abaixo do gatilho: reduz o risco de a ordem
    // ficar parada no livro quando o mercado desce rápido
    const stopLimit = formatPrice(trade.stopLoss - filters.tickSize, filters);

    try {
      /*
       * A pré-checagem saiu do caminho.
       *
       * Ela mandava um `order/test` de uma ordem LIMIT simples e, logo em
       * seguida, enviava um OTOCO — ou seja, testava uma coisa e mandava
       * outra. Custava uma viagem inteira à Binance (~340 ms medidos daqui)
       * para validar um formato que não é o que sai.
       *
       * E não protegia nada: ordem recusada não deixa resto na corretora, o
       * erro volta igual, e os filtros do par já são conferidos aqui do lado
       * de cá por `validateOrder` antes de chegar neste ponto.
       */
      const result = await newOtocoOrder({
        symbol: trade.symbol,
        listClientOrderId: trade.clientOrderId,
        workingQuantity: quantity,
        workingPrice: entry,
        pendingQuantity: quantity,
        takeProfitPrice: takeProfit,
        stopPrice: stopTrigger,
        stopLimitPrice: stopLimit,
      });

      trade.exchangeOrderIds = result.orders.map((order) => String(order.orderId));
      trade.updatedAt = new Date().toISOString();
      await this.repository.saveTrade(trade);
      this.paper.track(trade);
      this.bus.broadcast({ type: 'trade', payload: trade });

      this.audit.record({
        action: 'ORDER_SENT',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: setup.id,
        tradeId: trade.id,
        detail: {
          orderListId: result.orderListId,
          listStatus: result.listOrderStatus,
          orders: trade.exchangeOrderIds,
        },
      });
      return trade;
    } catch (error) {
      const message =
        error instanceof BinanceError
          ? `Binance recusou a ordem: ${error.message} (código ${error.code})`
          : (error as Error).message;
      this.audit.record({
        action: 'ORDER_FAILED',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: setup.id,
        tradeId: trade.id,
        detail: { message },
      });
      logger.error('Falha ao enviar ordem', { symbol: trade.symbol, message });
      throw new ExecutionError(message, 502);
    }
  }

  private signConfirmation(payload: ConfirmationPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', config.appSecret).update(body).digest('hex');
    return `${body}.${signature}`;
  }

  private verifyConfirmation(token: string): ConfirmationPayload {
    const [body, signature] = token.split('.');
    if (!body || !signature) throw new ExecutionError('Confirmação inválida — refaça a operação');

    const expected = createHmac('sha256', config.appSecret).update(body).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ExecutionError('Os valores da confirmação não conferem com o que foi aprovado');
    }

    let payload: ConfirmationPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ConfirmationPayload;
    } catch {
      throw new ExecutionError('Confirmação ilegível — refaça a operação');
    }
    if (Date.now() > payload.expiresAt) {
      throw new ExecutionError('A confirmação expirou — os preços mudaram, refaça a operação');
    }
    return payload;
  }
}

/**
 * Por que o robô não pode comprar na conta real agora. null = pode.
 * Ordem proposital: a trava do servidor é a primeira, porque é a única que a
 * interface não consegue desfazer sozinha.
 */
export function liveAutoTradeDenial(
  settings: { autoTrade: AppSettings['autoTrade'] },
): string | null {
  if (!config.allowLiveAutoTrade) {
    return 'ALLOW_LIVE_AUTOTRADE não está ligado no .env do servidor';
  }
  if (!settings.autoTrade.allowLive) {
    return 'a compra automática em conta real não foi liberada nos ajustes';
  }
  if (hasActiveLiveArm(settings.autoTrade)) return null;
  const armedUntil = settings.autoTrade.liveArmedUntil;
  if (armedUntil === null) return 'o robô não está armado para a conta real';
  if (new Date(armedUntil).getTime() <= Date.now()) {
    return `o armamento da conta real venceu em ${armedUntil}`;
  }
  return null;
}

/** Estado puro do armamento, separado das outras duas chaves de liberação. */
export function hasActiveLiveArm(
  autoTrade: Pick<AppSettings['autoTrade'], 'liveArmedUntil' | 'liveArmedIndefinitely'>,
  now = Date.now(),
): boolean {
  if (autoTrade.liveArmedIndefinitely) return true;
  if (autoTrade.liveArmedUntil === null) return false;
  return new Date(autoTrade.liveArmedUntil).getTime() > now;
}

/** Qual variável do .env falta para esta combinação de conta e modalidade. */
export function missingCredentialsMessage(mode: TradingMode, market: MarketKind): string {
  if (market === 'FUTURES') {
    return mode === 'LIVE'
      ? 'Configure BINANCE_FUTURES_API_KEY e BINANCE_FUTURES_API_SECRET (ou habilite futuros na chave do spot) para operar futuros em conta real'
      : 'Configure BINANCE_FUTURES_TESTNET_API_KEY e BINANCE_FUTURES_TESTNET_API_SECRET — o testnet de futuros tem cadastro próprio em testnet.binancefuture.com';
  }
  return mode === 'LIVE'
    ? 'Configure BINANCE_API_KEY e BINANCE_API_SECRET no servidor para operar em conta real'
    : 'Configure BINANCE_TESTNET_API_KEY e BINANCE_TESTNET_API_SECRET para usar o testnet';
}

/** O robô nunca sai da zona aprovada, mesmo com o preço correndo. */
function clampToZone(price: number, setup: TradeSetup): number {
  if (price < setup.entryLow) return setup.entryLow;
  if (price > setup.entryHigh) return setup.entryHigh;
  return price;
}

/**
 * Distância além da zona no sentido que piora a entrada.
 *
 * Comprar acima do teto e vender abaixo do piso são os dois casos em que o
 * preço correu contra quem vai entrar. O lado oposto continua no limite da
 * zona: tolerância não serve para antecipar sinal ainda não acionado.
 */
function unfavorableDistancePercent(price: number, setup: TradeSetup): number {
  if (setup.side === 'BUY' && price > setup.entryHigh) {
    return ((price - setup.entryHigh) / setup.entryHigh) * 100;
  }
  if (setup.side === 'SELL' && price < setup.entryLow) {
    return ((setup.entryLow - price) / setup.entryLow) * 100;
  }
  return 0;
}

/** Limite manual com folga curta; fora dela volta ao limite original da tese. */
export function manualLimitPrice(
  price: number,
  setup: TradeSetup,
  tolerancePercent: number,
): number {
  const distance = unfavorableDistancePercent(price, setup);
  if (distance > 0 && distance <= tolerancePercent) return price;
  return clampToZone(price, setup);
}

export function buildClientOrderId(idempotencyKey: string): string {
  const safe = idempotencyKey.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  return `csh${safe}`.slice(0, 36);
}

const LIMIT_LABEL: Record<RiskSizingResult['boundBy'], string> = {
  RISK_BUDGET: 'orçamento de risco por operação',
  MAX_POSITION_PERCENT: 'percentual máximo do capital por posição',
  MAX_NOTIONAL: 'teto absoluto por ordem',
  AVAILABLE_BALANCE: 'saldo disponível',
  REQUESTED: 'valor pedido',
  EXCHANGE_STEP: 'passo de lote da Binance',
  EXCHANGE_MINIMUM: 'valor mínimo por ordem da Binance',
};

/**
 * Adapta o dimensionamento por risco ao formato que a tela já consome.
 *
 * Repare que não existe mais um aviso de "risco acima do teto": com o tamanho
 * saindo DO orçamento, estourá-lo deixou de ser possível por construção. A
 * checagem que sobrou é defensiva — se algum dia alguém trocar a conta e o
 * risco passar do limite, isso vira bloqueio, não recado.
 */
function toSizingResult(
  sized: RiskSizingResult,
  setup: TradeSetup,
  entryPrice: number,
  capital: number,
  risk: AppSettings['risk'],
  side: Side = 'BUY',
): SizingResult {
  const profit = (target: number | null): number | null =>
    target === null ? null : round(sized.quantity * gainPerUnit(side, entryPrice, target), 2);

  const blockReasons: string[] = [];
  if (sized.blocked && sized.blockReason !== null) blockReasons.push(sized.blockReason);
  if (sized.riskPercentOfEquity > risk.riskPerTradePercent + 0.01) {
    blockReasons.push(
      `Risco de ${sized.riskPercentOfEquity.toFixed(2)}% do patrimônio acima do teto de ${risk.riskPerTradePercent}% por operação`,
    );
  }

  const warnings: string[] = [];
  if (!sized.blocked && sized.boundBy !== 'RISK_BUDGET') {
    warnings.push(
      `Tamanho limitado pelo ${LIMIT_LABEL[sized.boundBy]}, não pelo risco: a posição arrisca ${sized.riskPercentOfEquity.toFixed(2)}% do patrimônio`,
    );
  }

  return {
    quantity: sized.quantity,
    entryPrice: round(entryPrice, 8),
    notional: sized.notional,
    riskAmount: sized.riskAmount,
    riskPercentOfCapital: sized.riskPercentOfEquity,
    potentialProfitTarget1: profit(setup.target1) ?? 0,
    potentialProfitTarget2: profit(setup.target2),
    potentialProfitTarget3: profit(setup.target3),
    /*
     * O R/R DESTA ordem, no preço em que ela vai entrar.
     *
     * Antes vinha `setup.riskReward` — a conta feita quando a tese nasceu. O
     * preço anda: uma tese que valia 1:2,7 na entrada de 0,05199 vale 1:1,6
     * depois de o preço subir para 0,052715, porque o alvo ficou mais perto e
     * o stop mais longe. A tela mostrava 2,7 e o painel recusava a ordem
     * dizendo "R/R abaixo do mínimo" — dois números com o mesmo nome, e o
     * usuário sem como reconciliar os dois.
     */
    riskReward: computeRiskReward(entryPrice, setup.stopLoss, setup.target1, side),
    warnings,
    blocked: blockReasons.length > 0,
    blockReasons,
  };
}
