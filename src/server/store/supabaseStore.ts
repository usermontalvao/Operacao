import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AlertRecord,
  AppSettings,
  AuditEntry,
  AutoTradeSettings,
  DecisionRecord,
  RiskSettings,
  ScannerSettings,
  Trade,
  TradeSetup,
  TradingMode,
} from '../../core/types.ts';
import { logger } from '../logger.ts';
import { LIMITS, type Repository } from './repository.ts';
import { DEFAULT_GUARD } from '../../core/risk/governor.ts';

/**
 * Adaptador Postgres/Supabase. Usa a service role no servidor — o navegador
 * nunca fala com estas tabelas diretamente. RLS continua ligada para o caso
 * de leitura autenticada pelo cliente no futuro.
 */
export class SupabaseStore implements Repository {
  private client: SupabaseClient | null = null;
  private readonly url: string;
  private readonly serviceRoleKey: string;
  private readonly userId: string;

  constructor(url: string, serviceRoleKey: string, userId: string) {
    this.url = url;
    this.serviceRoleKey = serviceRoleKey;
    this.userId = userId;
  }

  async init(): Promise<void> {
    const { createClient } = await import('@supabase/supabase-js');
    this.client = createClient(this.url, this.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    logger.info('Persistência no Supabase ativa');
  }

  private db(): SupabaseClient {
    if (!this.client) throw new Error('SupabaseStore.init() não foi chamado');
    return this.client;
  }

  async loadSettings(): Promise<AppSettings | null> {
    const { data, error } = await this.db()
      .from('app_settings')
      .select('mode, risk, scanner, auto_trade, guard, updated_at')
      .eq('user_id', this.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      mode: data.mode as TradingMode,
      risk: data.risk as RiskSettings,
      scanner: data.scanner as ScannerSettings,
      autoTrade: data.auto_trade as AutoTradeSettings,
      // instalações antigas não têm a coluna: o padrão entra no lugar
      guard: (data.guard ?? { ...DEFAULT_GUARD }) as AppSettings['guard'],
      updatedAt: data.updated_at as string,
    };
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    const { error } = await this.db().from('app_settings').upsert(
      {
        user_id: this.userId,
        mode: settings.mode,
        risk: settings.risk,
        scanner: settings.scanner,
        guard: settings.guard,
        auto_trade: settings.autoTrade,
        updated_at: settings.updatedAt,
      },
      { onConflict: 'user_id' },
    );
    if (error) throw new Error(error.message);
  }

  async listSetups(): Promise<TradeSetup[]> {
    const { data, error } = await this.db()
      .from('trade_setups')
      .select('*')
      .eq('user_id', this.userId)
      .order('created_at', { ascending: false })
      .limit(LIMITS.setups);
    if (error) throw new Error(error.message);
    return (data ?? []).map(rowToSetup);
  }

  async saveSetup(setup: TradeSetup): Promise<void> {
    const { error } = await this.db()
      .from('trade_setups')
      .upsert({ ...setupToRow(setup), user_id: this.userId }, { onConflict: 'id' });
    if (error) throw new Error(error.message);
  }

  async listTrades(): Promise<Trade[]> {
    const { data, error } = await this.db()
      .from('trades')
      .select('*')
      .eq('user_id', this.userId)
      .order('opened_at', { ascending: false })
      .limit(LIMITS.trades);
    if (error) throw new Error(error.message);
    return (data ?? []).map(rowToTrade);
  }

  async saveTrade(trade: Trade): Promise<void> {
    const { error } = await this.db()
      .from('trades')
      .upsert({ ...tradeToRow(trade), user_id: this.userId }, { onConflict: 'id' });
    if (error) throw new Error(error.message);
  }

  async listAlerts(): Promise<AlertRecord[]> {
    const { data, error } = await this.db()
      .from('alerts')
      .select('*')
      .eq('user_id', this.userId)
      .order('created_at', { ascending: false })
      .limit(LIMITS.alerts);
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => ({
      id: row.id as string,
      setupId: row.setup_id as string,
      symbol: row.symbol as string,
      score: row.score as number,
      title: row.title as string,
      body: row.body as string,
      createdAt: row.created_at as string,
      readAt: (row.read_at as string | null) ?? null,
    }));
  }

  async saveAlert(alert: AlertRecord): Promise<void> {
    const { error } = await this.db().from('alerts').upsert(
      {
        id: alert.id,
        user_id: this.userId,
        setup_id: alert.setupId,
        symbol: alert.symbol,
        score: alert.score,
        title: alert.title,
        body: alert.body,
        created_at: alert.createdAt,
        read_at: alert.readAt,
      },
      { onConflict: 'id' },
    );
    if (error) throw new Error(error.message);
  }

  async saveDecision(decision: DecisionRecord): Promise<void> {
    const { error } = await this.db()
      .from('decisions')
      .upsert(
        {
          id: decision.id,
          user_id: this.userId,
          trade_id: decision.tradeId,
          setup_id: decision.setupId,
          symbol: decision.symbol,
          mode: decision.mode,
          setup_type: decision.setupType,
          timeframe: decision.timeframe,
          anchor_timeframe: decision.anchorTimeframe,
          score: decision.score,
          classification: decision.classification,
          risk_reward: decision.riskReward,
          automatic: decision.automatic,
          components: decision.components,
          penalties: decision.penalties,
          reasons: decision.reasons,
          evidence: decision.evidence,
          btc_context: decision.btcContext,
          extended: decision.extended,
          entry_price: decision.entryPrice,
          stop_loss: decision.stopLoss,
          target1: decision.target1,
          outcome: decision.outcome,
          realized_pnl: decision.realizedPnl,
          realized_pnl_percent: decision.realizedPnlPercent,
          max_favorable_percent: decision.maxFavorablePercent,
          max_adverse_percent: decision.maxAdversePercent,
          duration_minutes: decision.durationMinutes,
          opened_at: decision.openedAt,
          closed_at: decision.closedAt,
        },
        { onConflict: 'id' },
      );
    if (error) throw new Error(error.message);
  }

  async listDecisions(): Promise<DecisionRecord[]> {
    const { data, error } = await this.db()
      .from('decisions')
      .select('*')
      .eq('user_id', this.userId)
      .order('closed_at', { ascending: false })
      .limit(LIMITS.decisions);
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => ({
      id: row.id as string,
      tradeId: row.trade_id as string,
      setupId: row.setup_id as string,
      symbol: row.symbol as string,
      mode: row.mode as DecisionRecord['mode'],
      setupType: row.setup_type as DecisionRecord['setupType'],
      timeframe: row.timeframe as DecisionRecord['timeframe'],
      anchorTimeframe: row.anchor_timeframe as DecisionRecord['anchorTimeframe'],
      score: Number(row.score),
      classification: row.classification as DecisionRecord['classification'],
      riskReward: Number(row.risk_reward),
      automatic: Boolean(row.automatic),
      components: (row.components as DecisionRecord['components']) ?? [],
      penalties: (row.penalties as DecisionRecord['penalties']) ?? [],
      reasons: (row.reasons as string[]) ?? [],
      evidence: row.evidence as DecisionRecord['evidence'],
      btcContext: row.btc_context as DecisionRecord['btcContext'],
      extended: Boolean(row.extended),
      entryPrice: Number(row.entry_price),
      stopLoss: Number(row.stop_loss),
      target1: Number(row.target1),
      outcome: row.outcome as DecisionRecord['outcome'],
      realizedPnl: Number(row.realized_pnl),
      realizedPnlPercent: Number(row.realized_pnl_percent),
      maxFavorablePercent: Number(row.max_favorable_percent),
      maxAdversePercent: Number(row.max_adverse_percent),
      durationMinutes: Number(row.duration_minutes),
      openedAt: row.opened_at as string,
      closedAt: row.closed_at as string,
    }));
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    const { error } = await this.db().from('audit_logs').insert({
      id: entry.id,
      user_id: this.userId,
      action: entry.action,
      mode: entry.mode,
      symbol: entry.symbol,
      setup_id: entry.setupId,
      trade_id: entry.tradeId,
      detail: entry.detail,
      created_at: entry.createdAt,
    });
    if (error) throw new Error(error.message);
  }

  async listAudit(limit: number): Promise<AuditEntry[]> {
    const { data, error } = await this.db()
      .from('audit_logs')
      .select('*')
      .eq('user_id', this.userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []).map((row) => ({
      id: row.id as string,
      action: row.action as string,
      mode: row.mode as TradingMode,
      symbol: (row.symbol as string | null) ?? null,
      setupId: (row.setup_id as string | null) ?? null,
      tradeId: (row.trade_id as string | null) ?? null,
      detail: (row.detail as Record<string, unknown>) ?? {},
      createdAt: row.created_at as string,
    }));
  }
}

type Row = Record<string, unknown>;

function setupToRow(setup: TradeSetup): Row {
  return {
    id: setup.id,
    symbol: setup.symbol,
    side: setup.side,
    timeframe: setup.timeframe,
    anchor_timeframe: setup.anchorTimeframe,
    setup_type: setup.setupType,
    current_price: setup.currentPrice,
    entry_low: setup.entryLow,
    entry_high: setup.entryHigh,
    stop_loss: setup.stopLoss,
    target1: setup.target1,
    target2: setup.target2,
    target3: setup.target3,
    risk_reward: setup.riskReward,
    score: setup.score,
    classification: setup.classification,
    score_breakdown: setup.scoreBreakdown,
    reasons: setup.reasons,
    btc_context: setup.btcContext,
    status: setup.status,
    visual_state: setup.visualState,
    extended: setup.extended,
    extension_reasons: setup.extensionReasons,
    evidence: setup.evidence,
    fingerprint: setup.fingerprint,
    invalidation_note: setup.invalidationNote,
    created_at: setup.createdAt,
    updated_at: setup.updatedAt,
    expires_at: setup.expiresAt,
    ignored_at: setup.ignoredAt,
  };
}

function rowToSetup(row: Row): TradeSetup {
  return {
    id: row.id as string,
    symbol: row.symbol as string,
    side: 'BUY',
    timeframe: row.timeframe as TradeSetup['timeframe'],
    anchorTimeframe: row.anchor_timeframe as TradeSetup['anchorTimeframe'],
    setupType: row.setup_type as TradeSetup['setupType'],
    currentPrice: Number(row.current_price),
    entryLow: Number(row.entry_low),
    entryHigh: Number(row.entry_high),
    stopLoss: Number(row.stop_loss),
    target1: Number(row.target1),
    target2: row.target2 === null ? null : Number(row.target2),
    target3: row.target3 === null ? null : Number(row.target3),
    riskReward: Number(row.risk_reward),
    score: Number(row.score),
    classification: row.classification as TradeSetup['classification'],
    scoreBreakdown: row.score_breakdown as TradeSetup['scoreBreakdown'],
    reasons: (row.reasons as string[]) ?? [],
    btcContext: row.btc_context as TradeSetup['btcContext'],
    status: row.status as TradeSetup['status'],
    visualState: row.visual_state as TradeSetup['visualState'],
    extended: Boolean(row.extended),
    extensionReasons: (row.extension_reasons as string[]) ?? [],
    evidence: row.evidence as TradeSetup['evidence'],
    fingerprint: row.fingerprint as string,
    invalidationNote: (row.invalidation_note as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    expiresAt: row.expires_at as string,
    ignoredAt: (row.ignored_at as string | null) ?? null,
  };
}

function tradeToRow(trade: Trade): Row {
  return {
    id: trade.id,
    setup_id: trade.setupId,
    symbol: trade.symbol,
    mode: trade.mode,
    side: trade.side,
    setup_type: trade.setupType,
    timeframe: trade.timeframe,
    score: trade.score,
    status: trade.status,
    outcome: trade.outcome,
    requested_quantity: trade.requestedQuantity,
    filled_quantity: trade.filledQuantity,
    remaining_quantity: trade.remainingQuantity,
    entry_price: trade.entryPrice,
    average_fill_price: trade.averageFillPrice,
    stop_loss: trade.stopLoss,
    target1: trade.target1,
    target2: trade.target2,
    target3: trade.target3,
    notional: trade.notional,
    risk_amount: trade.riskAmount,
    realized_pnl: trade.realizedPnl,
    realized_pnl_percent: trade.realizedPnlPercent,
    max_favorable_percent: trade.maxFavorablePercent,
    max_adverse_percent: trade.maxAdversePercent,
    fills: trade.fills,
    exchange_order_ids: trade.exchangeOrderIds,
    client_order_id: trade.clientOrderId,
    automatic: trade.automatic ?? false,
    fees_paid: trade.feesPaid,
    high_water_price: trade.highWaterPrice,
    protective_stop: trade.protectiveStop,
    close_reason: trade.closeReason,
    opened_at: trade.openedAt,
    closed_at: trade.closedAt,
    updated_at: trade.updatedAt,
  };
}

function rowToTrade(row: Row): Trade {
  return {
    id: row.id as string,
    setupId: row.setup_id as string,
    symbol: row.symbol as string,
    mode: row.mode as Trade['mode'],
    side: 'BUY',
    setupType: row.setup_type as Trade['setupType'],
    timeframe: row.timeframe as Trade['timeframe'],
    score: Number(row.score),
    status: row.status as Trade['status'],
    outcome: row.outcome as Trade['outcome'],
    requestedQuantity: Number(row.requested_quantity),
    filledQuantity: Number(row.filled_quantity),
    remainingQuantity: Number(row.remaining_quantity),
    feesPaid: row.fees_paid === null || row.fees_paid === undefined ? 0 : Number(row.fees_paid),
    highWaterPrice:
      row.high_water_price === null || row.high_water_price === undefined
        ? null
        : Number(row.high_water_price),
    protectiveStop:
      row.protective_stop === null || row.protective_stop === undefined
        ? null
        : Number(row.protective_stop),
    closeReason: (row.close_reason as string | null | undefined) ?? null,
    entryPrice: Number(row.entry_price),
    averageFillPrice: row.average_fill_price === null ? null : Number(row.average_fill_price),
    stopLoss: Number(row.stop_loss),
    target1: Number(row.target1),
    target2: row.target2 === null ? null : Number(row.target2),
    target3: row.target3 === null ? null : Number(row.target3),
    notional: Number(row.notional),
    riskAmount: Number(row.risk_amount),
    realizedPnl: Number(row.realized_pnl),
    realizedPnlPercent: Number(row.realized_pnl_percent),
    maxFavorablePercent: Number(row.max_favorable_percent),
    maxAdversePercent: Number(row.max_adverse_percent),
    fills: (row.fills as Trade['fills']) ?? [],
    exchangeOrderIds: (row.exchange_order_ids as string[]) ?? [],
    clientOrderId: row.client_order_id as string,
    automatic: Boolean(row.automatic),
    openedAt: row.opened_at as string,
    closedAt: (row.closed_at as string | null) ?? null,
    updatedAt: row.updated_at as string,
  };
}
