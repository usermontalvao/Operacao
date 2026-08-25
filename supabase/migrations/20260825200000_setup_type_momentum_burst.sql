-- O CHECK de setup_type ficou para trás do código.
--
-- `SetupType` em src/core/types.ts ganhou MOMENTUM_BURST (src/core/setups/
-- momentumBurst.ts), mas o banco continuou aceitando só os três originais.
-- Enquanto a persistência era arquivo isso não aparecia; no Postgres, todo
-- setup de rompimento por volume seria recusado — e o servidor apenas
-- registraria o erro e seguiria, então a falha seria silenciosa e o radar
-- perderia um tipo inteiro de oportunidade sem ninguém notar.
--
-- Ao acrescentar um tipo novo em SetupType, acrescente aqui também.

alter table public.trade_setups
  drop constraint if exists trade_setups_setup_type_check;

alter table public.trade_setups
  add constraint trade_setups_setup_type_check
  check (setup_type in ('PULLBACK', 'BREAKOUT_RETEST', 'SUPPORT_REVERSAL', 'MOMENTUM_BURST'));

comment on column public.trade_setups.setup_type is
  'espelha SetupType em src/core/types.ts — tipo novo lá exige migration aqui';

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- alter table public.trade_setups drop constraint if exists trade_setups_setup_type_check;
-- alter table public.trade_setups add constraint trade_setups_setup_type_check
--   check (setup_type in ('PULLBACK', 'BREAKOUT_RETEST', 'SUPPORT_REVERSAL'));
