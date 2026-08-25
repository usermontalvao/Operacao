-- Compra automática (contas de teste) e diário de decisões.
-- Aditiva e reversível: o rollback está comentado no fim.

alter table public.app_settings
  add column if not exists auto_trade jsonb not null default '{}'::jsonb;

alter table public.trade_setups
  add column if not exists evidence jsonb not null default '{}'::jsonb;

alter table public.trades
  add column if not exists automatic boolean not null default false;

-- ---------------------------------------------------------------------------
-- Diário de decisões: liga o que o sistema viu ao resultado que veio depois.
-- É a base para responder "quais indicadores acertaram?".
-- ---------------------------------------------------------------------------
create table if not exists public.decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trade_id uuid references public.trades (id) on delete cascade,
  setup_id uuid references public.trade_setups (id) on delete set null,
  symbol text not null,
  mode text not null,
  setup_type text not null,
  timeframe text not null,
  anchor_timeframe text not null,
  score integer not null,
  classification text not null,
  risk_reward numeric not null,
  automatic boolean not null default false,
  components jsonb not null default '[]'::jsonb,
  penalties jsonb not null default '[]'::jsonb,
  reasons jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  btc_context text not null,
  extended boolean not null default false,
  entry_price numeric not null,
  stop_loss numeric not null,
  target1 numeric not null,
  outcome text not null,
  realized_pnl numeric not null,
  realized_pnl_percent numeric not null,
  max_favorable_percent numeric not null,
  max_adverse_percent numeric not null,
  duration_minutes numeric not null,
  opened_at timestamptz not null,
  closed_at timestamptz not null,
  unique (user_id, trade_id)
);

create index if not exists decisions_user_closed_idx on public.decisions (user_id, closed_at desc);
create index if not exists decisions_outcome_idx on public.decisions (user_id, outcome);

alter table public.decisions enable row level security;

drop policy if exists decisions_owner_select on public.decisions;
create policy decisions_owner_select on public.decisions
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists decisions_owner_write on public.decisions;
create policy decisions_owner_write on public.decisions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- drop table if exists public.decisions;
-- alter table public.trades drop column if exists automatic;
-- alter table public.trade_setups drop column if exists evidence;
-- alter table public.app_settings drop column if exists auto_trade;
