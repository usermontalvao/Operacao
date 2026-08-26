import type { MarketKind, SymbolFilters, Trade } from '../../core/types.ts';
import { formatPrice, round } from '../../core/risk/index.ts';
import {
  validateTradePlan,
  type EditableTradePlan,
} from '../../core/risk/tradePlan.ts';
import { getSymbolFilters } from '../binance/rest.ts';
import type { EventBus } from '../events.ts';
import type { Repository } from '../store/index.ts';
import type { AuditService } from './auditService.ts';
import { ExecutionError } from './executionService.ts';
import type { ProtectionResult } from './liveProtection.ts';
import type { MarketDataService } from './marketDataService.ts';
import type { PaperTradingEngine } from './paperTradingEngine.ts';
import type { SettingsService } from './settingsService.ts';

export interface TradePlanPatch {
  stopLoss?: number;
  target1?: number;
  target2?: number | null;
  target3?: number | null;
}

interface ProtectionManager {
  rearm(
    trade: Trade,
    filters: SymbolFilters,
    stopPrice: number,
    why: string,
  ): Promise<ProtectionResult>;
  panicSell(trade: Trade, filters: SymbolFilters, why: string): Promise<boolean>;
}

interface TradePlanDependencies {
  loadFilters(symbol: string, market: MarketKind): Promise<SymbolFilters | null>;
}

const dependencies: TradePlanDependencies = {
  async loadFilters(symbol, market) {
    return (await getSymbolFilters([symbol], market)).get(symbol) ?? null;
  },
};

/**
 * Altera o plano de uma posição sem permitir que a tela minta sobre a ordem.
 *
 * Em PAPER a troca é uma gravação. Em TESTNET/LIVE ela só é confirmada depois
 * de a proteção nova existir na Binance. Se o novo bracket falhar, o plano
 * anterior é rearmado; se nem isso for possível, entra a saída de emergência
 * já usada pelo monitor.
 */
export class TradePlanService {
  private readonly inFlight = new Map<string, Promise<Trade>>();
  private readonly repository: Repository;
  private readonly paper: PaperTradingEngine;
  private readonly market: MarketDataService;
  private readonly settings: SettingsService;
  private readonly audit: AuditService;
  private readonly bus: EventBus;
  private readonly protection: ProtectionManager;
  private readonly deps: TradePlanDependencies;

  constructor(
    repository: Repository,
    paper: PaperTradingEngine,
    market: MarketDataService,
    settings: SettingsService,
    audit: AuditService,
    bus: EventBus,
    protection: ProtectionManager,
    deps: TradePlanDependencies = dependencies,
  ) {
    this.repository = repository;
    this.paper = paper;
    this.market = market;
    this.settings = settings;
    this.audit = audit;
    this.bus = bus;
    this.protection = protection;
    this.deps = deps;
  }

  update(tradeId: string, patch: TradePlanPatch): Promise<Trade> {
    const existing = this.inFlight.get(tradeId);
    if (existing) return existing;
    const running = this.apply(tradeId, patch).finally(() => this.inFlight.delete(tradeId));
    this.inFlight.set(tradeId, running);
    return running;
  }

  private async apply(tradeId: string, patch: TradePlanPatch): Promise<Trade> {
    const trade =
      this.paper.getTrade(tradeId) ??
      (await this.repository.listTrades()).find((item) => item.id === tradeId) ??
      null;
    if (!trade) throw new ExecutionError('Operação não encontrada', 404);
    if (trade.mode !== this.settings.get().mode) {
      throw new ExecutionError(
        'Esta operação pertence a outra conta. Selecione a conta correta para alterar o plano.',
        409,
      );
    }
    if (trade.status !== 'OPEN' || trade.remainingQuantity <= 0) {
      throw new ExecutionError('Só é possível alterar stop e alvos de uma posição aberta', 409);
    }

    const currentPrice = this.market.getPrice(trade.symbol);
    if (currentPrice === null || currentPrice <= 0) {
      throw new ExecutionError('Preço vivo indisponível — o plano não foi alterado', 503);
    }

    const requested: EditableTradePlan = {
      stopLoss: patch.stopLoss ?? trade.stopLoss,
      target1: patch.target1 ?? trade.target1,
      target2: patch.target2 === undefined ? trade.target2 : patch.target2,
      target3: patch.target3 === undefined ? trade.target3 : patch.target3,
    };
    const errors = validateTradePlan(requested, trade.side, currentPrice);
    if (errors.length > 0) throw new ExecutionError(errors[0] as string, 400);

    let filters: SymbolFilters | null = null;
    if (trade.mode !== 'PAPER') {
      filters = await this.deps.loadFilters(trade.symbol, trade.market);
      if (!filters) throw new ExecutionError('Filtros do par indisponíveis — plano preservado', 503);
    }
    const next = normalizePlan(requested, filters);
    const normalizedErrors = validateTradePlan(next, trade.side, currentPrice);
    if (normalizedErrors.length > 0) {
      throw new ExecutionError(`O tique de preço da Binance torna o plano inválido: ${normalizedErrors[0]}`, 400);
    }

    const previous: EditableTradePlan = {
      stopLoss: trade.stopLoss,
      target1: trade.target1,
      target2: trade.target2,
      target3: trade.target3,
    };
    if (samePlan(previous, next)) return trade;

    await this.audit.recordNow({
      action: 'TRADE_PLAN_CHANGE_REQUESTED',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: { de: previous, para: next, precoAtual: currentPrice },
    });

    assignPlan(trade, next);
    if (trade.mode !== 'PAPER' && filters) {
      const result = await this.tryRearm(trade, filters, 'plano alterado manualmente no gráfico');
      if (!result?.armed) {
        assignPlan(trade, previous);
        const restored = await this.tryRearm(
          trade,
          filters,
          'restauração do plano anterior depois de uma alteração recusada',
        );
        await this.persist(trade);
        if (restored?.armed) {
          throw new ExecutionError(
            'A Binance recusou o novo plano. O stop e os alvos anteriores foram restaurados.',
            502,
          );
        }
        await this.protection.panicSell(
          trade,
          filters,
          'novo plano e restauração do plano anterior falharam',
        );
        await this.persist(trade);
        throw new ExecutionError(
          'A proteção não pôde ser recriada. O sistema acionou o encerramento de emergência.',
          502,
        );
      }
      trade.protectiveStop = trade.stopLoss;
    }

    await this.persist(trade);
    this.audit.record({
      action: 'TRADE_PLAN_CHANGED',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: { de: previous, para: next, origem: 'gráfico' },
    });
    return trade;
  }

  private async tryRearm(
    trade: Trade,
    filters: SymbolFilters,
    why: string,
  ): Promise<ProtectionResult | null> {
    try {
      return await this.protection.rearm(trade, filters, trade.stopLoss, why);
    } catch {
      return null;
    }
  }

  private async persist(trade: Trade): Promise<void> {
    trade.updatedAt = new Date().toISOString();
    await this.repository.saveTrade(trade);
    this.paper.track(trade);
    this.bus.broadcast({ type: 'trade', payload: trade });
  }
}

function normalizePlan(plan: EditableTradePlan, filters: SymbolFilters | null): EditableTradePlan {
  const normalize = (value: number): number =>
    filters ? Number(formatPrice(value, filters)) : round(value, 8);
  return {
    stopLoss: normalize(plan.stopLoss),
    target1: normalize(plan.target1),
    target2: plan.target2 === null ? null : normalize(plan.target2),
    target3: plan.target3 === null ? null : normalize(plan.target3),
  };
}

function assignPlan(trade: Trade, plan: EditableTradePlan): void {
  trade.stopLoss = plan.stopLoss;
  trade.target1 = plan.target1;
  trade.target2 = plan.target2;
  trade.target3 = plan.target3;
}

function samePlan(a: EditableTradePlan, b: EditableTradePlan): boolean {
  return (
    a.stopLoss === b.stopLoss &&
    a.target1 === b.target1 &&
    a.target2 === b.target2 &&
    a.target3 === b.target3
  );
}
