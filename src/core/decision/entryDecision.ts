import type { FreshnessReport } from '../health/freshness.ts';
import { automaticStrategyRejectionReason, maxSignalAgeMs } from '../strategy/automationPolicy.ts';
import { MIN_VALIDATED_AUTOMATIC_SCORE } from '../strategy/automationPolicy.ts';
import type { AutoTradeSettings, TradeSetup } from '../types.ts';
import {
  distanceToEntryPercent,
  reason,
  stageForCode,
  type DecisionReason,
  type EntryDecision,
} from './types.ts';

/**
 * Por que o robô entra — ou não — neste setup.
 *
 * Função pura e única. Antes cada trecho do caminho tinha as suas próprias
 * saídas antecipadas: o AutoTrader recusava por doze motivos sem gravar nada,
 * o ExecutionService recusava por mais dois, e o painel só via SETUP_CREATED.
 * O usuário ficava com a pergunta certa e nenhuma resposta: "score 95, R/R 3,
 * por que não comprou?".
 *
 * Aqui todas as regras produzem um motivo com código. Nada retorna cedo: a
 * avaliação junta TODOS os bloqueios, porque saber que faltou uma coisa é
 * pouco quando faltavam três.
 */

export interface EntryDecisionInput {
  setup: TradeSetup;
  now: Date;
  /** preço vivo; null quando não há cotação para o par */
  currentPrice: number | null;
  priceFreshness: FreshnessReport;
  robotEnabled: boolean;
  /** motivo pelo qual a conta real não está liberada; null = liberada ou não é LIVE */
  liveDenial: string | null;
  persistenceAvailable: boolean;
  autoTrade: AutoTradeSettings;
  /** posições automáticas abertas no modo atual */
  openAutomatic: Array<{ symbol: string; setupId: string }>;
  /** até quando este ativo está em descanso, vindo do histórico gravado */
  symbolCooldownUntil: number | null;
  /**
   * Bloqueios e avisos que vêm do disjuntor e do dimensionamento. Entram
   * prontos porque dependem de saldo e de corretora — coisas que uma função
   * pura não deve ir buscar.
   */
  externalBlockers?: DecisionReason[];
  externalWarnings?: DecisionReason[];
  sizeFactor?: number;
}

export function evaluateEntryDecision(input: EntryDecisionInput): EntryDecision {
  const { setup, now, autoTrade } = input;
  const blockers: DecisionReason[] = [];
  const warnings: DecisionReason[] = [];

  const price = input.currentPrice ?? setup.currentPrice;
  const distance = distanceToEntryPercent(price, setup.entryLow, setup.entryHigh);

  /*
   * O robô não opera vendido.
   *
   * A recusa já existia na execução, mas chegava tarde demais para a tela: o
   * painel dizia "o robô compraria este setup" numa tese de VENDA e só depois
   * a ordem era negada, num registro de auditoria que ninguém abre. O motivo
   * mora aqui porque é aqui que a decisão vira texto, funil e diário.
   */
  if (setup.side === 'SELL') {
    blockers.push(
      reason(
        'SHORT_NOT_AUTOMATED',
        'automationPolicy',
        'O robô não opera vendido: o laboratório mediu apenas o lado comprado. Esta tese é entrada manual',
      ),
    );
  }

  // --- plataforma -----------------------------------------------------------
  if (!input.persistenceAvailable) {
    blockers.push(
      reason(
        'PERSISTENCE_UNAVAILABLE',
        'persistence',
        'Persistência principal indisponível: nenhuma decisão pode ser gravada, então nenhuma ordem é criada',
      ),
    );
  }
  if (!input.robotEnabled) {
    blockers.push(reason('ROBOT_DISABLED', 'autoTrader', 'O robô está desligado'));
  }
  if (input.liveDenial !== null) {
    blockers.push(
      reason('LIVE_NOT_ARMED', 'autoTrader', `Conta real não liberada: ${input.liveDenial}`, {
        motivo: input.liveDenial,
      }),
    );
  }
  if (input.priceFreshness.blocksTrading) {
    blockers.push(
      reason(
        'MARKET_DATA_STALE',
        'marketData',
        `Preço ${input.priceFreshness.level === 'SEM_DADO' ? 'inexistente' : 'atrasado'} — comprar com cotação velha é comprar às cegas`,
        { nivel: input.priceFreshness.level, idadeMs: input.priceFreshness.ageMs },
      ),
    );
  }

  // --- estratégia e evidência ----------------------------------------------
  const strategyRejection = automaticStrategyRejectionReason(setup);
  if (strategyRejection !== null) {
    const code =
      setup.score < MIN_VALIDATED_AUTOMATIC_SCORE &&
      !strategyRejection.includes('observação')
        ? 'SCORE_BELOW_VALIDATED_FLOOR'
        : 'STRATEGY_NOT_VALIDATED';
    blockers.push(
      reason(code, 'automationPolicy', strategyRejection, {
        estrategia: setup.setupType,
        score: setup.score,
        pisoValidado: MIN_VALIDATED_AUTOMATIC_SCORE,
      }),
    );
  }
  if (setup.score < autoTrade.minimumScore) {
    blockers.push(
      reason(
        'SCORE_BELOW_CONFIGURED_MINIMUM',
        'autoTrader',
        `Score ${setup.score} abaixo do mínimo configurado de ${autoTrade.minimumScore}`,
        { score: setup.score, minimo: autoTrade.minimumScore },
      ),
    );
  }
  if (setup.riskReward < autoTrade.minimumRiskReward) {
    blockers.push(
      reason(
        'RISK_REWARD_BELOW_MINIMUM',
        'autoTrader',
        `R/R de ${setup.riskReward} abaixo do mínimo de ${autoTrade.minimumRiskReward}`,
        { riskReward: setup.riskReward, minimo: autoTrade.minimumRiskReward },
      ),
    );
  }

  // --- estado do setup ------------------------------------------------------
  if (setup.status === 'BOUGHT') {
    blockers.push(reason('SETUP_ALREADY_BOUGHT', 'autoTrader', 'Este setup já foi comprado'));
  }
  if (setup.status === 'EXPIRED') {
    blockers.push(reason('SETUP_EXPIRED', 'autoTrader', 'Setup expirado'));
  }
  if (setup.status === 'INVALIDATED') {
    blockers.push(
      reason('SETUP_INVALIDATED', 'autoTrader', 'Setup invalidado pelo preço', {
        nota: setup.invalidationNote,
      }),
    );
  }
  if (setup.ignoredAt !== null) {
    blockers.push(reason('SETUP_IGNORED', 'autoTrader', 'Setup dispensado pelo usuário'));
  }
  if (new Date(setup.expiresAt).getTime() <= now.getTime()) {
    blockers.push(
      reason('SETUP_EXPIRED', 'autoTrader', 'A validade do setup terminou', {
        expiraEm: setup.expiresAt,
      }),
    );
  }

  // Frescor do SINAL, que é diferente da validade do card. Uma explosão de
  // três horas atrás continua listada, mas já não é a operação que o
  // laboratório mediu — e é exatamente esta regra que impede que ligar o robô
  // ressuscite uma fila de sinais velhos.
  const signalAge = now.getTime() - new Date(setup.createdAt).getTime();
  const maxAge = maxSignalAgeMs(setup.setupType);
  if (signalAge > maxAge) {
    blockers.push(
      reason(
        'SETUP_STALE',
        'automationPolicy',
        `Sinal de ${formatAge(signalAge)} atrás — acima do limite de ${formatAge(maxAge)} para ${setup.setupType}`,
        { idadeMs: signalAge, limiteMs: maxAge, estrategia: setup.setupType },
      ),
    );
  }

  // --- preço ----------------------------------------------------------------
  if (autoTrade.requireInsideEntryZone && distance !== 0) {
    const acima = distance > 0;
    blockers.push(
      reason(
        'PRICE_OUTSIDE_ENTRY_ZONE',
        'autoTrader',
        acima
          ? `Preço ${Math.abs(distance).toFixed(2)}% acima da zona máxima. A estratégia proíbe perseguir o movimento.`
          : `Preço ${Math.abs(distance).toFixed(2)}% abaixo da zona de entrada — o sinal ainda não acionou.`,
        {
          preco: price,
          zonaMinima: setup.entryLow,
          zonaMaxima: setup.entryHigh,
          distanciaPercent: distance,
          lado: acima ? 'ACIMA' : 'ABAIXO',
        },
      ),
    );
  }
  if (setup.extended) {
    warnings.push(
      reason('PRICE_EXTENDED', 'autoTrader', 'Preço esticado em relação ao ponto de invalidação', {
        motivos: setup.extensionReasons,
      }),
    );
  }

  // --- concorrência ---------------------------------------------------------
  const mesmoAtivo = input.openAutomatic.filter((trade) => trade.symbol === setup.symbol);
  if (mesmoAtivo.length > 0) {
    blockers.push(
      reason('SYMBOL_ALREADY_OPEN', 'autoTrader', `Já existe operação automática em ${setup.symbol}`),
    );
  }
  if (input.openAutomatic.length >= autoTrade.maxConcurrentTrades) {
    blockers.push(
      reason(
        'MAX_CONCURRENT_TRADES',
        'autoTrader',
        `Limite de ${autoTrade.maxConcurrentTrades} operação(ões) automática(s) simultânea(s) atingido`,
        { abertas: input.openAutomatic.length, limite: autoTrade.maxConcurrentTrades },
      ),
    );
  }
  if (input.symbolCooldownUntil !== null && input.symbolCooldownUntil > now.getTime()) {
    const faltam = Math.ceil((input.symbolCooldownUntil - now.getTime()) / 60_000);
    blockers.push(
      reason(
        'SYMBOL_COOLDOWN',
        'autoTrader',
        `Descanso em ${setup.symbol}: faltam ${faltam} min`,
        { liberaEm: new Date(input.symbolCooldownUntil).toISOString(), faltamMinutos: faltam },
      ),
    );
  }

  blockers.push(...(input.externalBlockers ?? []));
  warnings.push(...(input.externalWarnings ?? []));

  const code = blockers[0]?.code ?? 'ALLOWED';
  return {
    allowed: blockers.length === 0,
    code,
    blockers,
    warnings,
    sizeFactor: input.sizeFactor ?? 1,
    stage: stageForCode(code),
    evaluatedAt: now.toISOString(),
    setupId: setup.id,
    symbol: setup.symbol,
    currentPrice: price,
    entryLow: setup.entryLow,
    entryHigh: setup.entryHigh,
    distanceToEntryPercent: distance,
  };
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours}h`;
}
