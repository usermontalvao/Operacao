-- Futuros USD-M: modalidade, alavancagem e o lado vendido.
--
-- Três coisas que o banco impedia hoje, e nenhuma delas dava erro visível na
-- tela — dariam 400 do PostgREST no meio de uma execução:
--
--   1. `check (side = 'BUY')` em trade_setups e trades. A tese vendida existe
--      no motor desde esta versão; sem soltar o check, TODA venda seria
--      recusada na gravação, depois de a ordem já ter ido para a corretora.
--   2. Não havia onde dizer de qual mercado a linha é. Spot e futuros usam os
--      mesmos símbolos e os mesmos modos: sem a coluna, o histórico das duas
--      modalidades vira um só, e o desempenho medido não seria de nenhuma.
--   3. Alavancagem, margem e preço de liquidação não tinham coluna. Sem eles
--      não dá para auditar depois se o stop estava do lado certo da linha de
--      liquidação — que é a pergunta que importa quando uma posição some.
--
-- Aditiva: tudo que já está gravado é spot, comprado e sem alavancagem, e é
-- exatamente isso que os defaults dizem.

-- ---------------------------------------------------------------------------
-- Configurações: modalidade ativa e um conjunto por modalidade
-- ---------------------------------------------------------------------------
alter table if exists public.app_settings
  add column if not exists market text not null default 'SPOT',
  add column if not exists by_market jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_settings_market_check'
  ) then
    alter table public.app_settings
      add constraint app_settings_market_check check (market in ('SPOT', 'FUTURES'));
  end if;
end $$;

comment on column public.app_settings.by_market is
  'um conjunto {risk, autoTrade, guard, futures} por modalidade e por modo; quando preenchido, é a fonte da verdade e by_mode passa a ser o espelho do spot';

-- ---------------------------------------------------------------------------
-- Setups: lado e modalidade
-- ---------------------------------------------------------------------------
alter table if exists public.trade_setups
  add column if not exists market text not null default 'SPOT';

alter table if exists public.trade_setups
  drop constraint if exists trade_setups_side_check;

alter table if exists public.trade_setups
  add constraint trade_setups_side_check check (side in ('BUY', 'SELL'));

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'trade_setups_market_check'
  ) then
    alter table public.trade_setups
      add constraint trade_setups_market_check check (market in ('SPOT', 'FUTURES'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Operações: lado, modalidade e a conta que só existe em futuros
-- ---------------------------------------------------------------------------
alter table if exists public.trades
  add column if not exists market text not null default 'SPOT',
  add column if not exists leverage numeric not null default 1,
  add column if not exists initial_margin numeric not null default 0,
  add column if not exists margin_mode text,
  add column if not exists liquidation_price numeric;

alter table if exists public.trades
  drop constraint if exists trades_side_check;

alter table if exists public.trades
  add constraint trades_side_check check (side in ('BUY', 'SELL'));

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'trades_market_check'
  ) then
    alter table public.trades
      add constraint trades_market_check check (market in ('SPOT', 'FUTURES'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'trades_margin_mode_check'
  ) then
    alter table public.trades
      add constraint trades_margin_mode_check
      check (margin_mode is null or margin_mode in ('ISOLATED', 'CROSSED'));
  end if;
end $$;

comment on column public.trades.liquidation_price is
  'preço estimado de liquidação na abertura; null em spot. Serve para auditar, depois, se o stop estava antes ou depois da linha da corretora';

-- ---------------------------------------------------------------------------
-- Conexões: o ambiente agora inclui a modalidade
-- ---------------------------------------------------------------------------
alter table if exists public.exchange_connections
  drop constraint if exists exchange_connections_environment_check;

alter table if exists public.exchange_connections
  add constraint exchange_connections_environment_check
  check (environment in ('production', 'testnet', 'futures-production', 'futures-testnet'));

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Atenção: voltar atrás com posição vendida gravada faz o check de side
-- falhar. Apague ou converta essas linhas antes.
--
-- alter table public.trades drop constraint if exists trades_side_check;
-- alter table public.trades add constraint trades_side_check check (side = 'BUY');
-- alter table public.trades drop column if exists market, drop column if exists leverage,
--   drop column if exists initial_margin, drop column if exists margin_mode,
--   drop column if exists liquidation_price;
-- alter table public.trade_setups drop constraint if exists trade_setups_side_check;
-- alter table public.trade_setups add constraint trade_setups_side_check check (side = 'BUY');
-- alter table public.trade_setups drop column if exists market;
-- alter table public.app_settings drop column if exists market, drop column if exists by_market;
