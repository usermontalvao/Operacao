-- Cole no SQL Editor do projeto mofqebcmsuxsqqsjxbao
-- (Supabase > SQL Editor > New query). Roda inteiro, de uma vez.

create table if not exists public.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

begin;

-- Micro scalp de 1 minuto (RANGE_FADE).
--
-- Três coisas que o banco recusaria hoje, e nenhuma delas com erro visível na
-- tela — todas dariam 400 do PostgREST no meio de uma varredura, registradas
-- no log do servidor e em lugar nenhum mais:
--
--   1. `check (setup_type in (...))` não conhece RANGE_FADE. TODO setup de
--      micro scalp seria recusado na gravação. O radar mostraria a tese em
--      memória, ela sumiria no reinício, e ninguém saberia por quê. Já
--      aconteceu uma vez neste projeto, com MOMENTUM_BURST.
--   2. Não há onde guardar o laudo do micro scalp (scalpabilidade, regime e a
--      conta de custo). Sem ele, medir depois se o 1m teve borda líquida
--      positiva seria impossível: o resultado estaria gravado, mas não as
--      condições que autorizaram a entrada.
--   3. `timeframe` é text livre e aceita '1m' sem alteração — mas nada dizia
--      qual conjunto ele espelha. O comentário abaixo passa a dizer.
--
-- (`trades.setup_type` já existia e já era gravado; aqui ele só ganha índice.)
--
-- Aditiva e retrocompatível: nada do que já está gravado muda de significado.
-- Toda linha existente fica com micro = null, que é exatamente o que ela é.

-- ---------------------------------------------------------------------------
-- 1. O tipo de setup
-- ---------------------------------------------------------------------------
alter table public.trade_setups
  drop constraint if exists trade_setups_setup_type_check;

alter table public.trade_setups
  add constraint trade_setups_setup_type_check
  check (setup_type in (
    'PULLBACK',
    'BREAKOUT_RETEST',
    'SUPPORT_REVERSAL',
    'MOMENTUM_BURST',
    'RANGE_FADE'
  ));

comment on column public.trade_setups.setup_type is
  'espelha SetupType em src/core/types.ts — tipo novo lá exige migration aqui';

-- ---------------------------------------------------------------------------
-- 2. O laudo do micro scalp
-- ---------------------------------------------------------------------------
alter table if exists public.trade_setups
  add column if not exists micro jsonb;

comment on column public.trade_setups.micro is
  'laudo do micro scalp: {scalpability, regime, economics}. null em todo setup que não é RANGE_FADE. Guarda as CONDIÇÕES que autorizaram a entrada (spread e book medidos, faixa, custo real) — sem isso não dá para auditar depois se o 1m teve expectativa líquida positiva';

comment on column public.trade_setups.timeframe is
  'espelha Timeframe em src/core/types.ts: 1m, 15m, 1h, 4h, 1d. 1m só é gerado pelo micro scalp, que nasce desligado';

-- ---------------------------------------------------------------------------
-- 3. Ler o desempenho POR ESTRATÉGIA sem varrer a tabela
-- ---------------------------------------------------------------------------
-- `trades.setup_type` já existe desde a primeira migration e já é gravado —
-- o que falta é poder consultá-lo barato. Sem índice, medir o micro scalp
-- separado exigiria varrer o histórico inteiro, e essa é a consulta que a
-- aba de desempenho vai fazer com mais frequência: uma estratégia que opera
-- dezenas de vezes por hora produz muito mais linhas que todas as outras
-- juntas, e sem separá-las nenhuma das duas médias fica legível.
create index if not exists trades_setup_type_idx
  on public.trades (user_id, setup_type, closed_at desc);

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Atenção: voltar atrás com setup RANGE_FADE gravado faz o check falhar.
-- Apague essas linhas antes:
--   delete from public.trade_setups where setup_type = 'RANGE_FADE';
--
-- alter table public.trade_setups drop constraint if exists trade_setups_setup_type_check;
-- alter table public.trade_setups add constraint trade_setups_setup_type_check
--   check (setup_type in ('PULLBACK','BREAKOUT_RETEST','SUPPORT_REVERSAL','MOMENTUM_BURST'));
-- alter table public.trade_setups drop column if exists micro;
-- drop index if exists trades_setup_type_idx;

insert into public.schema_migrations (name)
  values ('20260826150000_micro_scalp_1m.sql')
  on conflict (name) do nothing;

commit;
