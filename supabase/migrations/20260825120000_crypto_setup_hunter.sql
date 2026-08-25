-- Crypto Setup Hunter — estrutura inicial (MVP)
-- Reversível: o rollback está no fim do arquivo, comentado.
-- Nada aqui guarda segredo de corretora. A tabela exchange_connections
-- registra apenas ONDE a credencial está (variável de ambiente / vault),
-- nunca a chave em si.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Configurações (risco + scanner + modo). Uma linha por usuário.
-- A watchlist vive dentro de `scanner` de propósito: em um produto de um
-- usuário só, uma tabela separada de watchlists seria duplicação de estado.
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  mode text not null default 'PAPER' check (mode in ('PAPER', 'TESTNET', 'LIVE')),
  risk jsonb not null default '{}'::jsonb,
  scanner jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Conexões com corretoras — metadados, sem segredo
-- ---------------------------------------------------------------------------
create table if not exists public.exchange_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  exchange text not null default 'BINANCE',
  environment text not null default 'production' check (environment in ('production', 'testnet')),
  paper_mode boolean not null default true,
  label text,
  -- ex.: 'env:BINANCE_API_KEY' ou 'vault:binance/spot'. Jamais a chave.
  credentials_ref text not null,
  withdrawals_disabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, exchange, environment)
);

-- ---------------------------------------------------------------------------
-- Setups detectados
-- ---------------------------------------------------------------------------
create table if not exists public.trade_setups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  symbol text not null,
  side text not null default 'BUY' check (side = 'BUY'),
  timeframe text not null,
  anchor_timeframe text not null,
  setup_type text not null check (setup_type in ('PULLBACK', 'BREAKOUT_RETEST', 'SUPPORT_REVERSAL')),
  current_price numeric not null,
  entry_low numeric not null,
  entry_high numeric not null,
  stop_loss numeric not null,
  target1 numeric not null,
  target2 numeric,
  target3 numeric,
  risk_reward numeric not null,
  score integer not null check (score between 0 and 100),
  classification text not null,
  score_breakdown jsonb not null default '{}'::jsonb,
  reasons jsonb not null default '[]'::jsonb,
  btc_context text not null,
  status text not null check (status in ('WATCHING','ACTIVE','TRIGGERED','BOUGHT','INVALIDATED','EXPIRED')),
  visual_state text not null,
  extended boolean not null default false,
  extension_reasons jsonb not null default '[]'::jsonb,
  fingerprint text not null,
  invalidation_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ignored_at timestamptz
);

create index if not exists trade_setups_user_status_idx on public.trade_setups (user_id, status, score desc);
create index if not exists trade_setups_symbol_idx on public.trade_setups (user_id, symbol, created_at desc);
create index if not exists trade_setups_fingerprint_idx on public.trade_setups (user_id, fingerprint, created_at desc);

-- ---------------------------------------------------------------------------
-- Alertas gerados a partir dos setups
-- ---------------------------------------------------------------------------
create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  setup_id uuid references public.trade_setups (id) on delete cascade,
  symbol text not null,
  score integer not null,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists alerts_user_created_idx on public.alerts (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Operações (papel e real)
-- ---------------------------------------------------------------------------
create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  setup_id uuid references public.trade_setups (id) on delete set null,
  symbol text not null,
  mode text not null check (mode in ('PAPER', 'TESTNET', 'LIVE')),
  side text not null default 'BUY' check (side = 'BUY'),
  setup_type text not null,
  timeframe text not null,
  score integer not null,
  status text not null check (status in ('PENDING', 'OPEN', 'CLOSED', 'CANCELLED')),
  outcome text not null default 'OPEN',
  requested_quantity numeric not null,
  filled_quantity numeric not null default 0,
  remaining_quantity numeric not null default 0,
  entry_price numeric not null,
  average_fill_price numeric,
  stop_loss numeric not null,
  target1 numeric not null,
  target2 numeric,
  target3 numeric,
  notional numeric not null,
  risk_amount numeric not null,
  realized_pnl numeric not null default 0,
  realized_pnl_percent numeric not null default 0,
  max_favorable_percent numeric not null default 0,
  max_adverse_percent numeric not null default 0,
  fills jsonb not null default '[]'::jsonb,
  exchange_order_ids jsonb not null default '[]'::jsonb,
  -- idempotência: dois cliques no mesmo setup não viram duas ordens
  client_order_id text not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, client_order_id)
);

create index if not exists trades_user_status_idx on public.trades (user_id, status, opened_at desc);

-- ---------------------------------------------------------------------------
-- Ordens enviadas à corretora (uma linha por ordem do bracket)
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trade_id uuid references public.trades (id) on delete cascade,
  exchange text not null default 'BINANCE',
  environment text not null,
  symbol text not null,
  role text not null check (role in ('ENTRY', 'TAKE_PROFIT', 'STOP', 'MANUAL')),
  exchange_order_id text,
  order_list_id text,
  client_order_id text not null,
  type text not null,
  side text not null,
  price numeric,
  stop_price numeric,
  quantity numeric not null,
  status text not null,
  raw_response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_order_id)
);

-- ---------------------------------------------------------------------------
-- Auditoria: tudo que o usuário e o sistema fizeram, sem segredos
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  mode text not null,
  symbol text,
  setup_id uuid,
  trade_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_user_created_idx on public.audit_logs (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS: cada usuário só enxerga o que é dele. O servidor usa service role,
-- que ignora RLS por design — o navegador nunca fala direto com estas tabelas
-- em modo de escrita.
-- ---------------------------------------------------------------------------
alter table public.app_settings enable row level security;
alter table public.exchange_connections enable row level security;
alter table public.trade_setups enable row level security;
alter table public.alerts enable row level security;
alter table public.trades enable row level security;
alter table public.orders enable row level security;
alter table public.audit_logs enable row level security;

do $$
declare
  target text;
begin
  foreach target in array array[
    'app_settings', 'exchange_connections', 'trade_setups', 'alerts', 'trades', 'orders', 'audit_logs'
  ] loop
    execute format(
      'drop policy if exists %I on public.%I', target || '_owner_select', target
    );
    execute format(
      'create policy %I on public.%I for select to authenticated using (user_id = (select auth.uid()))',
      target || '_owner_select', target
    );
    execute format(
      'drop policy if exists %I on public.%I', target || '_owner_write', target
    );
    execute format(
      'create policy %I on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',
      target || '_owner_write', target
    );
  end loop;
end $$;

-- Auditoria não se apaga nem se reescreve, nem pelo dono.
drop policy if exists audit_logs_owner_write on public.audit_logs;
create policy audit_logs_owner_insert on public.audit_logs
  for insert to authenticated with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- ROLLBACK (descomente para desfazer)
-- ---------------------------------------------------------------------------
-- drop table if exists public.audit_logs;
-- drop table if exists public.orders;
-- drop table if exists public.trades;
-- drop table if exists public.alerts;
-- drop table if exists public.trade_setups;
-- drop table if exists public.exchange_connections;
-- drop table if exists public.app_settings;
