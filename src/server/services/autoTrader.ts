import { randomUUID } from 'node:crypto';
import type { EntryDecision, TradeSetup, TradingMode } from '../../core/types.ts';
import { evaluateEntryDecision } from '../../core/decision/entryDecision.ts';
import { symbolCooldownUntil } from '../../core/decision/cooldown.ts';
import {
  DECISION_DEDUP_WINDOW_MS,
  buildDecisionRecord,
  mergeRepeatedDecision,
} from '../../core/decision/record.ts';
import type { EntryDecisionRecord } from '../../core/decision/record.ts';
import { reason, type DecisionReason } from '../../core/decision/types.ts';
import { capturePolicySnapshot } from '../../core/policy/snapshot.ts';
import { evaluateFreshness, TICK_THRESHOLDS } from '../../core/health/freshness.ts';
import { activeSessionModes } from '../../core/session/sessions.ts';
import { logger } from '../logger.ts';
import type { AuditService } from './auditService.ts';
import { liveAutoTradeDenial, type ExecutionService } from './executionService.ts';
import type { MarketDataService } from './marketDataService.ts';
import type { PaperTradingEngine } from './paperTradingEngine.ts';
import type { Repository } from '../store/index.ts';
import type { SettingsService } from './settingsService.ts';

/**
 * Robô de compra.
 *
 * Duas mudanças de fundo em relação à versão anterior.
 *
 * A primeira: o robô não é mais um só. Cada modo é uma SESSÃO independente —
 * o robô do demo continua trabalhando enquanto o usuário examina a conta real,
 * com o seu próprio capital, o seu descanso por ativo e o seu disjuntor. O
 * modo em exibição só decide qual janela está aberta.
 *
 * A segunda: nenhuma recusa é silenciosa. Antes havia doze saídas antecipadas
 * que devolviam null sem gravar nada, e o painel mostrava apenas SETUP_CREATED.
 * Agora toda consideração produz uma decisão com código, motivos e retrato da
 * política — e ela vai para o disco, deduplicada por situação.
 */
export class AutoTrader {
  private readonly settings: SettingsService;
  private readonly execution: ExecutionService;
  private readonly paper: PaperTradingEngine;
  private readonly audit: AuditService;
  private readonly repository: Repository;
  private readonly market: MarketDataService;
  /** última decisão gravada por assinatura, para não regravar o mesmo a cada tick */
  private readonly lastRecorded = new Map<string, EntryDecisionRecord>();
  private readonly considering = new Set<string>();
  private persistenceAvailable = true;

  constructor(
    settings: SettingsService,
    execution: ExecutionService,
    paper: PaperTradingEngine,
    audit: AuditService,
    repository: Repository,
    market: MarketDataService,
  ) {
    this.settings = settings;
    this.execution = execution;
    this.paper = paper;
    this.audit = audit;
    this.repository = repository;
    this.market = market;
  }

  setPersistenceAvailable(available: boolean): void {
    this.persistenceAvailable = available;
  }

  /** Sessões que operam agora, dado o modo em exibição. */
  activeModes(): TradingMode[] {
    return activeSessionModes(this.settings.get().mode);
  }

  /**
   * Avalia o setup em TODAS as sessões ativas.
   *
   * Um setup nasce uma vez — o mercado é o mesmo para as duas contas — mas é
   * julgado separadamente por cada sessão, porque o capital, o descanso e os
   * limites são de cada uma. É por isso que o mesmo sinal pode ser comprado no
   * demo e recusado no real no mesmo instante, e as duas decisões ficam
   * gravadas lado a lado.
   */
  async consider(setup: TradeSetup): Promise<void> {
    for (const mode of this.activeModes()) {
      await this.considerForMode(setup, mode).catch((error) => {
        logger.warn('Falha ao considerar setup', {
          symbol: setup.symbol,
          mode,
          error: (error as Error).message,
        });
      });
    }
  }

  /** A decisão desta sessão, sem executar nada — é o que o painel consulta. */
  async decide(setup: TradeSetup, mode: TradingMode): Promise<EntryDecision> {
    // a modalidade é a do SETUP, não a da tela: o setup nasceu numa varredura
    // de uma modalidade e é lá que ele seria executado
    const policy = this.settings.forMode(mode, setup.market);
    const trades = this.persistenceAvailable ? await this.repository.listTrades() : [];

    const openAutomatic = this.paper
      .getOpenTrades()
      .filter(
        (trade) =>
          trade.automatic === true && trade.mode === mode && trade.market === setup.market,
      )
      .map((trade) => ({ symbol: trade.symbol, setupId: trade.setupId }));

    const liveDenial = mode === 'LIVE' ? liveAutoTradeDenial(policy) : null;

    return evaluateEntryDecision({
      setup,
      now: new Date(),
      currentPrice: this.market.getPrice(setup.symbol),
      priceFreshness: evaluateFreshness(this.market.lastTickAt(), TICK_THRESHOLDS),
      robotEnabled: policy.autoTrade.enabled,
      liveDenial,
      persistenceAvailable: this.persistenceAvailable,
      autoTrade: policy.autoTrade,
      openAutomatic,
      symbolCooldownUntil: symbolCooldownUntil({
        trades,
        symbol: setup.symbol,
        mode,
        cooldownMinutes: policy.autoTrade.cooldownMinutes,
      }),
    });
  }

  private async considerForMode(setup: TradeSetup, mode: TradingMode): Promise<void> {
    const key = `${mode}:${setup.id}`;
    if (this.considering.has(key)) return;
    this.considering.add(key);

    try {
      const decision = await this.decide(setup, mode);
      await this.record(decision, setup, mode);
      if (!decision.allowed) return;

      const trade = await this.execution.executeAutomatic(setup, mode, decision, setup.market);
      if (trade) {
        logger.info('Compra automática executada', {
          symbol: setup.symbol,
          score: setup.score,
          modo: trade.mode,
          valor: trade.notional,
        });
      }
    } catch (error) {
      this.audit.record({
        action: 'AUTO_TRADE_FAILED',
        mode,
        symbol: setup.symbol,
        setupId: setup.id,
        detail: { message: (error as Error).message },
      });
      logger.warn('Compra automática falhou', {
        symbol: setup.symbol,
        mode,
        error: (error as Error).message,
      });
    } finally {
      this.considering.delete(key);
    }
  }

  /**
   * Grava a decisão, deduplicada.
   *
   * A mesma recusa repetida a cada varredura atualiza a linha existente e
   * incrementa o contador. Só volta ao disco quando a situação muda ou quando
   * a janela de dedução vence — senão a tabela viraria um diário de ticks e
   * esconderia exatamente o que se procura nela.
   */
  private async record(
    decision: EntryDecision,
    setup: TradeSetup,
    mode: TradingMode,
  ): Promise<void> {
    if (!this.persistenceAvailable) return;

    const policy = this.settings.forMode(mode, setup.market);
    const snapshot = capturePolicySnapshot({
      mode,
      autoTrade: policy.autoTrade,
      risk: policy.risk,
      guard: policy.guard,
      btcContext: setup.btcContext,
    });
    const fresh = buildDecisionRecord({
      decision,
      setupType: setup.setupType,
      timeframe: setup.timeframe,
      mode,
      score: setup.score,
      policy: snapshot,
      id: randomUUID(),
    });

    const cacheKey = `${mode}:${setup.id}`;
    const previous = this.lastRecorded.get(cacheKey);
    const toSave =
      previous === undefined
        ? fresh
        : mergeRepeatedDecision(previous, fresh, DECISION_DEDUP_WINDOW_MS);
    if (toSave === null) return;

    this.lastRecorded.set(cacheKey, toSave);
    await this.repository.saveEntryDecision(toSave).catch((error) => {
      logger.warn('Não foi possível gravar a decisão de entrada', {
        error: (error as Error).message,
      });
    });
  }

  /**
   * Reavalia os setups que já existem — usado quando o robô é LIGADO.
   *
   * Um sinal pode nascer com o robô desligado. Sem esta passagem, o robô só o
   * consideraria de novo se o estado visual mudasse, e um sinal parado dentro
   * da zona nunca muda de estado: ficaria ali, elegível e ignorado.
   *
   * O cuidado é o oposto do óbvio: NÃO ressuscitar. Quem decide continua sendo
   * a mesma função pura, com as mesmas regras — validade, frescor do sinal por
   * estratégia, zona de entrada, descanso e risco. Ligar o robô não é um
   * perdão para a fila de sinais velhos; é só uma nova avaliação, com os
   * critérios de sempre e a decisão de cada uma gravada.
   */
  async reconsiderExisting(setups: TradeSetup[], mode: TradingMode): Promise<number> {
    let comprados = 0;
    for (const setup of setups) {
      // o que já morreu nem chega a ser avaliado — poupa uma decisão inútil
      // por setup expirado num radar que pode ter centenas
      if (setup.status === 'EXPIRED' || setup.status === 'INVALIDATED') continue;
      if (setup.status === 'BOUGHT' || setup.ignoredAt !== null) continue;

      const antes = this.paper.getOpenTrades().length;
      await this.considerForMode(setup, mode);
      if (this.paper.getOpenTrades().length > antes) comprados += 1;
    }
    return comprados;
  }

  /** Limpa a lembrança de dedução de um setup que saiu de cena. */
  forget(setupId: string): void {
    for (const key of this.lastRecorded.keys()) {
      if (key.endsWith(`:${setupId}`)) this.lastRecorded.delete(key);
    }
  }
}

/** Converte bloqueios do disjuntor em motivos com código. */
export function gateReasonsToDecision(
  blockers: string[],
  warnings: string[],
): { blockers: DecisionReason[]; warnings: DecisionReason[] } {
  return {
    blockers: blockers.map((message) => reason(codeForGateMessage(message), 'governor', message)),
    warnings: warnings.map((message) => reason(codeForGateMessage(message), 'governor', message)),
  };
}

/**
 * O disjuntor ainda fala em frases. Em vez de reescrevê-lo agora — o que
 * mexeria em regras testadas e de dinheiro — a frase é traduzida para código
 * aqui, num único lugar, com o texto original preservado.
 */
function codeForGateMessage(message: string): DecisionReason['code'] {
  const texto = message.toLowerCase();
  if (texto.includes('disjuntor')) return 'CIRCUIT_BREAKER';
  if (texto.includes('r/r líquido')) return 'NET_RISK_REWARD_BELOW_MINIMUM';
  if (texto.includes('posição aberta')) return 'SYMBOL_ALREADY_OPEN';
  if (texto.includes('exposição em altcoins')) return 'ALT_EXPOSURE_EXCEEDED';
  if (texto.includes('exposição total')) return 'TOTAL_EXPOSURE_EXCEEDED';
  if (texto.includes('descanso pós-perda')) return 'LOSS_COOLDOWN';
  if (texto.includes('volume')) return 'QUOTE_VOLUME_TOO_LOW';
  if (texto.includes('btc vendedor')) return 'BTC_BEARISH';
  if (texto.includes('btc volátil')) return 'BTC_HIGH_VOLATILITY';
  if (texto.includes('evento de mercado')) return 'MARKET_EVENT_BLOCK';
  if (texto.includes('perda diária')) return 'DAILY_LOSS_LIMIT';
  if (texto.includes('saldo')) return 'INSUFFICIENT_BALANCE';
  if (texto.includes('operações abertas')) return 'MAX_OPEN_TRADES';
  return 'CIRCUIT_BREAKER';
}
