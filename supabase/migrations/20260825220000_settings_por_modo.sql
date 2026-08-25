-- Configurações separadas por modo.
--
-- Antes existia um conjunto só: trocar de PAPER para LIVE levava junto o robô
-- ligado, o capital e o disjuntor da conta de teste. Agora cada modo guarda o
-- que é seu em by_mode; a varredura (scanner) continua comum, porque escolher
-- quais moedas olhar não move dinheiro.
--
-- Aditiva: as colunas risk, auto_trade e guard continuam existindo e recebem o
-- conjunto do modo ativo a cada gravação. Voltar à versão anterior do código
-- não encontra a linha vazia.

alter table if exists public.app_settings
  add column if not exists by_mode jsonb;

comment on column public.app_settings.by_mode is
  'um conjunto {risk, autoTrade, guard} por modo (PAPER/TESTNET/LIVE); quando preenchido, é a fonte da verdade e as colunas risk/auto_trade/guard passam a ser apenas o espelho do modo ativo';

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- alter table public.app_settings drop column if exists by_mode;
