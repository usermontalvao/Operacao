import type { TradeSetup } from '../../core/types.ts';
import { automaticStrategyRejectionReason } from '../../core/strategy/automationPolicy.ts';
import { logger } from '../logger.ts';
import type { AuditService } from './auditService.ts';
import { liveAutoTradeDenial, type ExecutionService } from './executionService.ts';
import type { PaperTradingEngine } from './paperTradingEngine.ts';
import type { SettingsService } from './settingsService.ts';

/**
 * Robô de compra.
 *
 * Aqui ficam apenas os filtros baratos — os que dizem "este setup não me
 * interessa" sem consultar saldo nem corretora. Tudo que envolve dinheiro
 * (disjuntor, exposição, R/R líquido, permissão da conta real) vive no
 * ExecutionService: um filtro de tela nunca deve ser a última linha de defesa.
 */
export class AutoTrader {
  private readonly settings: SettingsService;
  private readonly execution: ExecutionService;
  private readonly paper: PaperTradingEngine;
  private readonly audit: AuditService;
  private readonly lastTradeBySymbol = new Map<string, number>();
  private readonly considering = new Set<string>();

  constructor(
    settings: SettingsService,
    execution: ExecutionService,
    paper: PaperTradingEngine,
    audit: AuditService,
  ) {
    this.settings = settings;
    this.execution = execution;
    this.paper = paper;
    this.audit = audit;
  }

  /** Motivo pelo qual o robô não compra este setup agora (null = pode comprar). */
  rejectionReason(setup: TradeSetup): string | null {
    const settings = this.settings.get();
    const auto = settings.autoTrade;

    if (!auto.enabled) return 'robô desligado';
    if (settings.mode === 'LIVE') {
      const denial = liveAutoTradeDenial(settings);
      if (denial !== null) return denial;
    }
    if (setup.ignoredAt !== null) return 'setup ignorado pelo usuário';
    if (setup.status === 'BOUGHT') return 'setup já comprado';
    if (setup.status === 'INVALIDATED' || setup.status === 'EXPIRED') return 'setup encerrado';
    if (setup.extended) return 'preço esticado';
    const strategyRejection = automaticStrategyRejectionReason(setup);
    if (strategyRejection !== null) return strategyRejection;
    if (setup.score < auto.minimumScore) return `score ${setup.score} abaixo de ${auto.minimumScore}`;
    if (setup.riskReward < auto.minimumRiskReward) {
      return `R/R ${setup.riskReward} abaixo de ${auto.minimumRiskReward}`;
    }
    if (auto.requireInsideEntryZone && setup.visualState !== 'COMPRAVEL') {
      return 'preço fora da zona de entrada';
    }

    const openAutomatic = this.paper
      .getOpenTrades()
      .filter((trade) => trade.automatic === true && trade.mode === settings.mode);
    if (openAutomatic.length >= auto.maxConcurrentTrades) {
      return `limite de ${auto.maxConcurrentTrades} operações automáticas abertas`;
    }
    if (openAutomatic.some((trade) => trade.symbol === setup.symbol)) {
      return 'já existe operação automática neste ativo';
    }

    const last = this.lastTradeBySymbol.get(setup.symbol);
    if (last && Date.now() - last < auto.cooldownMinutes * 60_000) {
      return `descanso de ${auto.cooldownMinutes} min neste ativo`;
    }
    return null;
  }

  async consider(setup: TradeSetup): Promise<void> {
    if (this.rejectionReason(setup) !== null) return;
    if (this.considering.has(setup.id)) return;
    this.considering.add(setup.id);

    try {
      const trade = await this.execution.executeAutomatic(setup);
      if (trade) {
        this.lastTradeBySymbol.set(setup.symbol, Date.now());
        logger.info('Compra automática executada', {
          symbol: setup.symbol,
          score: setup.score,
          modo: trade.mode,
          valor: trade.notional,
        });
      }
    } catch (error) {
      await this.audit.record({
        action: 'AUTO_TRADE_FAILED',
        mode: this.settings.get().mode,
        symbol: setup.symbol,
        setupId: setup.id,
        detail: { message: (error as Error).message },
      });
      logger.warn('Compra automática falhou', {
        symbol: setup.symbol,
        error: (error as Error).message,
      });
    } finally {
      this.considering.delete(setup.id);
    }
  }
}
