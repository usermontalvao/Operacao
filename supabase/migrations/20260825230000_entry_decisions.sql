-- Decisões de entrada: por que o robô entrou, e sobretudo por que NÃO entrou.
--
-- Antes, uma recusa não deixava rastro: o painel mostrava SETUP_CREATED e o
-- usuário ficava com a pergunta certa e nenhuma resposta. Agora toda
-- consideração do robô produz uma linha.
--
-- A chave única (user_id, fingerprint) é o coração da deduplicação: a mesma
-- situação vista de novo ATUALIZA a linha e incrementa occurrences, em vez de
-- criar outra. Sem isso a tabela viraria um diário de ticks e esconderia
-- justamente o que interessa — quando a situação mudou.
--
-- Aditiva e reversível: o rollback está no fim.

create table if not exists public.entry_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  setup_id uuid not null,
  symbol text not null,
  timeframe text not null,
  setup_type text not null,
  mode text not null check (mode in ('PAPER', 'TESTNET', 'LIVE')),
  score numeric not null default 0,
  allowed boolean not null default false,
  code text not null,
  stage text not null,
  blockers jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  current_price numeric not null default 0,
  entry_low numeric not null default 0,
  entry_high numeric not null default 0,
  distance_to_entry_percent numeric not null default 0,
  fingerprint text not null,
  occurrences integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- retrato imutável da política que decidiu; nulo nas linhas anteriores ao
  -- versionamento, e nulo é o valor honesto: preencher com a política de hoje
  -- faria uma decisão antiga parecer ter sido tomada por critérios atuais
  policy jsonb,
  unique (user_id, fingerprint)
);

create index if not exists entry_decisions_user_seen_idx
  on public.entry_decisions (user_id, last_seen_at desc);
create index if not exists entry_decisions_setup_idx
  on public.entry_decisions (user_id, setup_id);
create index if not exists entry_decisions_code_idx
  on public.entry_decisions (user_id, code);
create index if not exists entry_decisions_mode_idx
  on public.entry_decisions (user_id, mode, last_seen_at desc);

alter table public.entry_decisions enable row level security;

drop policy if exists entry_decisions_owner_select on public.entry_decisions;
create policy entry_decisions_owner_select on public.entry_decisions
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists entry_decisions_owner_write on public.entry_decisions;
create policy entry_decisions_owner_write on public.entry_decisions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Versionamento da política também nas operações e nos setups, para que uma
-- operação antiga continue legível depois que as configurações mudarem.
alter table if exists public.trades
  add column if not exists policy jsonb,
  add column if not exists decision jsonb;

alter table if exists public.trade_setups
  add column if not exists policy jsonb;

comment on column public.trades.policy is
  'retrato imutável da política no instante da decisão: versões, risco, disjuntor, custos e regime';
comment on column public.trades.decision is
  'a decisão de entrada que autorizou esta operação, com os avisos que ela carregava';

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- drop table if exists public.entry_decisions;
-- alter table public.trades drop column if exists policy, drop column if exists decision;
-- alter table public.trade_setups drop column if exists policy;
