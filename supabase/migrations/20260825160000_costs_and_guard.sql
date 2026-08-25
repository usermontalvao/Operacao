-- Custos reais e disjuntor de risco.
--
-- O P&L passa a nascer líquido de corretagem, a posição guarda o topo que
-- alcançou (para o stop que sobe) e o motivo do encerramento quando não foi
-- alvo nem stop. Linhas antigas ficam com taxa zero: elas foram gravadas por
-- um motor que não cobrava taxa, e inventar um valor retroativo mentiria no
-- histórico.

alter table if exists public.app_settings
  add column if not exists guard jsonb;

alter table if exists public.trades
  add column if not exists fees_paid numeric not null default 0,
  add column if not exists high_water_price numeric,
  add column if not exists protective_stop numeric,
  add column if not exists close_reason text;

comment on column public.trades.fees_paid is
  'corretagem paga nas duas pontas; realized_pnl já sai líquido dela';
comment on column public.trades.high_water_price is
  'maior preço visto desde a entrada — base do stop que acompanha o preço';
comment on column public.trades.close_reason is
  'motivo do encerramento quando não foi alvo nem stop (manual, pânico, proteção)';
