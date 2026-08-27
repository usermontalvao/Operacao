import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type BinanceBalanceSummary,
  type RiskResponse,
  type SettingsResponse,
} from '../lib/api.ts';
import { SymbolButton } from '../components/SymbolButton.tsx';
import type {
  AutoTradeSettings,
  GuardSettings,
  MarginMode,
  MarketKind,
  MicroScalpSettings,
  ModeSettings,
  RiskSettings,
  SetupType,
  Timeframe,
  TradingMode,
  UniverseMode,
} from '../lib/types.ts';
import { brl, quantity, usd } from '../lib/format.ts';
import { logout, readSession, type SessionState } from '../lib/auth.ts';
import { useResource } from '../lib/resource.ts';
import { buscarAjustes, chaveAjustes } from '../lib/telas.ts';
import { PageSkeleton } from '../components/Skeleton.tsx';
import { rotuloDoEstado, useAutoSave } from '../lib/autoSave.ts';

const RISK_FIELDS: Array<{ key: keyof RiskSettings; label: string; hint: string; step: number }> = [
  { key: 'maxPositionPercent', label: 'Máximo por operação (%)', hint: 'Teto do capital em um único trade', step: 1 },
  { key: 'riskPerTradePercent', label: 'Risco por operação (%)', hint: 'Perda aceita até o stop', step: 0.1 },
  { key: 'maxOpenTrades', label: 'Operações abertas ao mesmo tempo', hint: 'Trava de exposição', step: 1 },
  { key: 'dailyLossLimitPercent', label: 'Alerta de perda diária (%)', hint: 'Somente informa; não bloqueia entradas', step: 0.5 },
  { key: 'minimumRiskReward', label: 'R/R mínimo', hint: 'Abaixo disso o setup é descartado', step: 0.1 },
  { key: 'minimumScoreToAlert', label: 'Score mínimo para alertar', hint: 'Evita alerta demais', step: 1 },
  { key: 'minimumScoreToShow', label: 'Score mínimo para exibir', hint: 'Setups abaixo nem aparecem', step: 1 },
];

/**
 * Os gatilhos de tendência, na ordem em que fazem sentido ler.
 *
 * Ficam fora do estado porque não são preferência de tela: são os quatro
 * timeframes que o motor aceita como gatilho. O 1m NÃO está aqui — ele não é
 * mais um item desta lista, é outro modo de operar, com detector e conta de
 * custo próprios, e ganha o bloco separado logo abaixo.
 */
const TREND_TIMEFRAMES: Array<{ id: Timeframe; hint: string }> = [
  { id: '3m', hint: 'gatilho muito curto · exige custo baixo' },
  { id: '5m', hint: 'intraday rápido · contexto de 15m' },
  { id: '15m', hint: 'giro curto · pullback e reteste' },
  { id: '1h', hint: 'tendência · pullback, rompimento, explosão' },
  { id: '4h', hint: 'tendência larga · menos sinais, mais folga' },
  { id: '1d', hint: 'posição · o mais lento' },
];

const GUARD_FIELDS: Array<{
  key: keyof GuardSettings;
  label: string;
  hint: string;
  step: number;
  min?: number;
  max?: number;
}> = [
  { key: 'feePercent', label: 'Taxa por lado (%)', hint: 'Corretagem da Binance; entra em todo resultado', step: 0.01 },
  { key: 'stopSlippagePercent', label: 'Escorregamento do stop (%)', hint: 'Quanto o stop preenche abaixo do gatilho', step: 0.05 },
  { key: 'exitSlippagePercent', label: 'Escorregamento a mercado (%)', hint: 'Custo de sair correndo', step: 0.05 },
  {
    key: 'manualEntryTolerancePercent',
    label: 'Tolerância da entrada manual (%)',
    hint: 'Conta real/testnet; 0 desliga, o robô continua preso à zona',
    step: 0.1,
    min: 0,
    max: 2,
  },
  { key: 'minNetRiskReward', label: 'R/R líquido mínimo', hint: 'Já descontadas taxa e escorregamento', step: 0.1 },
  { key: 'maxConsecutiveLosses', label: 'Alerta após perdas seguidas', hint: 'Somente informa; não pausa o robô', step: 1 },
  { key: 'maxDrawdownPercent', label: 'Alerta de queda do topo (%)', hint: 'Somente informa; não pausa o robô', step: 1 },
  { key: 'maxDailyTrades', label: 'Alerta de operações por dia', hint: 'Somente informa; não pausa o robô', step: 1 },
  { key: 'maxTotalExposurePercent', label: 'Exposição total máxima (%)', hint: 'Soma de tudo que está aberto', step: 5 },
  { key: 'maxAltExposurePercent', label: 'Exposição em altcoins (%)', hint: 'Altcoin cai junto quando o BTC cai', step: 5 },
  { key: 'lossCooldownMinutes', label: 'Descanso após perda (min)', hint: 'Silêncio obrigatório depois de perder', step: 15 },
  { key: 'trailingStopPercent', label: 'Stop que sobe (%)', hint: '0 desliga; segue o topo alcançado', step: 0.5 },
  { key: 'maxTargetPercent', label: 'Alvo máximo aceito (%)', hint: 'Alvo mais distante que isso é descartado', step: 5 },
  { key: 'minQuoteVolume24h', label: 'Volume mínimo para operar', hint: 'Sair de par ilíquido custa caro', step: 1_000_000 },
];

/*
 * Os limites vão declarados junto com o campo.
 *
 * O servidor já os aplicava, mas só na hora de salvar — e o formulário do robô
 * manda os seis números de uma vez, então um valor recusado travava todos sem
 * dizer qual. Com min/max no próprio input, o navegador avisa enquanto se
 * digita, e o servidor continua sendo a palavra final.
 */
const AUTO_FIELDS: Array<{
  key: keyof AutoTradeSettings;
  label: string;
  hint: string;
  step: number;
  min: number;
  max: number;
}> = [
  {
    key: 'minimumScore',
    label: 'Score mínimo para comprar',
    hint: 'Fallback para ajustes antigos; cada estratégia tem sua régua abaixo',
    step: 1,
    min: 50,
    max: 100,
  },
  { key: 'minimumRiskReward', label: 'R/R mínimo do robô', hint: 'Costuma ser mais exigente que o do radar', step: 0.1, min: 1, max: 10 },
  { key: 'percentOfCapital', label: 'Percentual do capital por compra', hint: 'Teto de tamanho — quem manda é o risco por operação', step: 1, min: 1, max: 100 },
  { key: 'maxConcurrentTrades', label: 'Posições automáticas simultâneas', hint: 'Teto de exposição do robô', step: 1, min: 1, max: 20 },
  { key: 'cooldownMinutes', label: 'Descanso por ativo (min)', hint: 'Evita recomprar o mesmo ativo em sequência', step: 15, min: 5, max: 1440 },
  { key: 'maxNotionalPerTrade', label: 'Teto por ordem (USDT)', hint: 'Vale mesmo que o percentual peça mais', step: 5, min: 5, max: 1000000 },
];

const AUTOMATIC_STRATEGIES: Array<{
  id: SetupType;
  label: string;
  hint: string;
}> = [
  { id: 'MOMENTUM_BURST', label: 'Breakout / momentum', hint: 'explosão com força e volume' },
  { id: 'BREAKOUT_RETEST', label: 'Reteste de rompimento', hint: 'rompe, volta ao nível e confirma' },
  { id: 'PULLBACK', label: 'Pullback de tendência', hint: 'correção curta na direção principal' },
  { id: 'SUPPORT_REVERSAL', label: 'Reversão em suporte', hint: 'defesa confirmada de zona' },
  { id: 'RANGE_FADE', label: 'Scalp lateral 1m', hint: 'retorno da borda para o meio da faixa' },
];

export function Settings({ onChanged, onLoggedOut }: { onChanged: () => void; onLoggedOut: () => void }) {
  const [symbolTerm, setSymbolTerm] = useState('');
  const [results, setResults] = useState<Array<{ symbol: string; baseAsset: string }>>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armMinutes, setArmMinutes] = useState('60');

  const {
    dados,
    erro: loadError,
    primeiraVez,
    recarregar: load,
  } = useResource(chaveAjustes, buscarAjustes);

  const settings: SettingsResponse | null = dados?.settings ?? null;
  const riskState: RiskResponse | null = dados?.riskState ?? null;

  /*
   * Três grupos que salvam sozinhos.
   *
   * Antes eles tinham botão "Salvar" e o resto da tela gravava no clique — dois
   * modelos convivendo, sem nada indicando qual valia para o campo em que se
   * estava mexendo. Agora todos salvam sozinhos; o cabeçalho mostra o estado
   * para que "sozinho" não signifique "sem confirmação".
   */
  const aoSalvar = useCallback(() => {
    onChanged();
    void load();
  }, [onChanged, load]);

  const riskAuto = useAutoSave<RiskSettings>({
    remoto: settings?.risk ?? null,
    versao: settings?.updatedAt,
    salvar: (valor) => api.updateSettings({ risk: valor }),
    aoSalvar,
  });
  const autoTradeAuto = useAutoSave<AutoTradeSettings>({
    remoto: settings?.autoTrade ?? null,
    versao: settings?.updatedAt,
    salvar: (valor) => api.updateSettings({ autoTrade: valor }),
    aoSalvar,
  });
  const guardAuto = useAutoSave<GuardSettings>({
    remoto: settings?.guard ?? null,
    versao: settings?.updatedAt,
    salvar: (valor) => api.updateSettings({ guard: valor }),
    aoSalvar,
  });

  if (primeiraVez) return <PageSkeleton blocos={4} />;
  const failure = error ?? loadError;
  if (failure && !settings) return <p className="text-sm text-bear">{failure}</p>;
  const risk = riskAuto.valor;
  const auto = autoTradeAuto.valor;
  const guard = guardAuto.valor;
  if (!settings || !risk || !auto || !guard) return <PageSkeleton blocos={4} />;

  const setRisk = (valor: RiskSettings): void => riskAuto.alterar(valor);
  const setAuto = (valor: AutoTradeSettings): void => autoTradeAuto.alterar(valor);
  const setGuard = (valor: GuardSettings): void => guardAuto.alterar(valor);

  /* O estado de salvamento mais "quente" entre os três é o que o topo mostra. */
  const estadoSalvamento =
    [riskAuto, autoTradeAuto, guardAuto].find((item) => item.estado === 'erro') ??
    [riskAuto, autoTradeAuto, guardAuto].find((item) => item.estado === 'salvando') ??
    [riskAuto, autoTradeAuto, guardAuto].find((item) => item.estado === 'pendente') ??
    [riskAuto, autoTradeAuto, guardAuto].find((item) => item.estado === 'salvo');

  const run = async (action: () => Promise<unknown>, successMessage: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMessage(successMessage);
      onChanged();
      void load();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
      setTimeout(() => setMessage(null), 3500);
    }
  };

  const search = async (term: string): Promise<void> => {
    setSymbolTerm(term);
    if (term.trim().length < 2) {
      setResults([]);
      return;
    }
    try {
      setResults(await api.searchSymbols(term.trim()));
    } catch {
      setResults([]);
    }
  };

  const capitalHint =
    risk.paperCapitalCurrency === 'BRL'
      ? `${brl(risk.paperCapital)} — convertido para USDT pela cotação do par USDTBRL`
      : 'Valor em USDT';
  const futuros = settings.market === 'FUTURES';
  const contas = futuros
    ? { producao: settings.binance.futuresProduction, teste: settings.binance.futuresTestnet }
    : { producao: settings.binance.production, teste: settings.binance.testnet };
  const activeBinanceBalance =
    settings.mode === 'LIVE'
      ? contas.producao.balance
      : settings.mode === 'TESTNET'
        ? contas.teste.balance
        : null;

  const rotulo = estadoSalvamento ? rotuloDoEstado(estadoSalvamento.estado) : null;

  return (
    <div className="space-y-5 pb-6">
      {/*
        A tela salva sozinha — e por isso precisa DIZER que salvou.
        Autosave silencioso troca um problema por outro: some a dúvida "cliquei
        em salvar?" e entra "será que foi?". A faixa fica no topo, fixa, e é o
        único lugar em que o estado aparece.
      */}
      <div className="sticky top-0 z-10 -mx-1 flex items-center justify-between gap-3 rounded-lg border border-terminal-border bg-terminal-panel/95 px-3 py-2 backdrop-blur">
        <span className="text-xs text-terminal-muted">
          As alterações são salvas automaticamente.
        </span>
        {rotulo ? (
          <span
            className={`text-xs font-semibold ${
              estadoSalvamento?.estado === 'erro'
                ? 'text-bear'
                : estadoSalvamento?.estado === 'salvo'
                  ? 'text-bull'
                  : 'text-terminal-muted'
            }`}
          >
            {estadoSalvamento?.estado === 'salvo' ? '✓ ' : ''}
            {rotulo}
          </span>
        ) : null}
      </div>

      {error ? <p className="rounded-lg border border-bear/40 bg-bear/10 p-3 text-sm text-bear">{error}</p> : null}
      {[riskAuto, autoTradeAuto, guardAuto].map((item) =>
        item.erro ? (
          <p key={item.erro} className="rounded-lg border border-bear/40 bg-bear/10 p-3 text-sm text-bear">
            Não foi possível salvar: {item.erro}
          </p>
        ) : null,
      )}
      {message ? <p className="rounded-lg border border-bull/40 bg-bull/10 p-3 text-sm text-bull">{message}</p> : null}

      <div className="pt-1">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-terminal-muted">1 · Onde você está operando</h3>
        <p className="mt-0.5 text-[11px] text-terminal-muted">Conta, dinheiro em jogo e modalidade. Tudo abaixo depende destas duas escolhas.</p>
      </div>

      <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
        <h2 className="text-sm font-semibold">Conta e modo de operação</h2>
        {/*
          Três colunas num celular dão 110 px cada, e "simulação com preço
          real" vira quatro linhas dentro do botão — a escolha mais importante
          do painel lida em pedaços. Empilhado, cada conta ocupa a largura toda
          e diz de uma vez o que é; da tela de tablet para cima voltam a ser
          três, lado a lado, como sempre foram.
        */}
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {(['PAPER', 'TESTNET', 'LIVE'] as TradingMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={busy}
              onClick={() => void run(() => api.updateSettings({ mode }), `Modo ${mode} ativo`)}
              className={`rounded-xl border px-3 py-3 text-left text-xs font-bold sm:text-center ${
                settings.mode === mode
                  ? mode === 'LIVE'
                    ? 'border-bear/60 bg-bear/10 text-bear'
                    : 'border-bull/60 bg-bull/10 text-bull'
                  : 'border-terminal-border text-terminal-muted'
              }`}
            >
              {mode}
              <span className="mt-1 block text-[10px] font-normal opacity-70">
                {mode === 'PAPER' ? 'simulação com preço real' : mode === 'TESTNET' ? 'conta de teste da Binance' : 'dinheiro de verdade'}
              </span>
              <ModoResumo
                mode={mode}
                settings={settings.byMode?.[mode]}
                balance={
                  mode === 'LIVE'
                    ? contas.producao.balance
                    : mode === 'TESTNET'
                      ? contas.teste.balance
                      : null
                }
              />
            </button>
          ))}
        </div>
        {/*
          Chave que lê mas não negocia.

          Ela mostra saldo, mostra ordem, mostra tudo — e recusa a única coisa
          que importa, com um -2015 que só chega depois de o usuário atravessar
          todas as travas do painel e confirmar a ordem. O aviso mora aqui, em
          repouso, onde as chaves são configuradas.
        */}
        {(futuros ? settings.binance.futuresProduction : settings.binance.production).keyWarning ? (
          <p className="mt-3 rounded-lg border border-warn/50 bg-warn/10 p-3 text-[11px] leading-relaxed text-warn">
            {(futuros ? settings.binance.futuresProduction : settings.binance.production).keyWarning}
          </p>
        ) : null}

        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
          <Info label="Ambiente ativo" value={settings.binance.activeEnvironment} />
          <Info
            label={futuros ? 'Chaves de futuros (produção)' : 'Chaves de produção'}
            value={contas.producao.credentialsConfigured ? 'configuradas' : 'ausentes'}
            tone={contas.producao.credentialsConfigured ? 'text-bull' : 'text-terminal-muted'}
          />
          <Info
            label={futuros ? 'Chaves de futuros (testnet)' : 'Chaves do testnet'}
            value={contas.teste.credentialsConfigured ? 'configuradas' : 'ausentes'}
            tone={contas.teste.credentialsConfigured ? 'text-bull' : 'text-terminal-muted'}
          />
        </dl>
        {futuros ? (
          <p className="mt-3 text-[11px] leading-relaxed text-terminal-muted">
            Futuros tem chaves próprias. Em produção, a chave do spot serve desde que futuros esteja
            habilitado nela — ou preencha <code>BINANCE_FUTURES_API_KEY</code> e{' '}
            <code>BINANCE_FUTURES_API_SECRET</code>. O testnet de futuros é OUTRO cadastro, em{' '}
            <a className="text-info" href="https://testnet.binancefuture.com" target="_blank" rel="noreferrer">
              testnet.binancefuture.com
            </a>
            : preencha <code>BINANCE_FUTURES_TESTNET_API_KEY</code> e{' '}
            <code>BINANCE_FUTURES_TESTNET_API_SECRET</code>. A chave do testnet spot NÃO funciona lá.
            A conta precisa estar em modo de posição única (one-way); em modo hedge o painel recusa a
            ordem em vez de mandar sem proteção.
          </p>
        ) : (
          <p className="mt-3 text-[11px] leading-relaxed text-terminal-muted">
            As chaves ficam apenas no arquivo <code>.env</code> do servidor — a interface nunca as recebe e
            elas nunca aparecem em log. Para o testnet, gere um par em{' '}
            <a className="text-info" href="https://testnet.binance.vision" target="_blank" rel="noreferrer">
              testnet.binance.vision
            </a>{' '}
            e preencha <code>BINANCE_TESTNET_API_KEY</code> e <code>BINANCE_TESTNET_API_SECRET</code>.
            Para consultar saldo, a permissão de leitura basta. Para o robô enviar ordens no LIVE,
            habilite somente negociação Spot; mantenha saque desabilitado e use whitelist de IP.
          </p>
        )}
      </section>
      <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Modalidade</h2>
            <p className="mt-1 text-[11px] text-terminal-muted">
              {settings.futuresEnabled
                ? 'Futuros liberado — a modalidade pode ser escolhida abaixo.'
                : 'Futuros barrado. O painel opera só spot: nenhuma tese vendida nasce e nenhuma ordem alavancada sai.'}
            </p>
          </div>
          {/*
            O interruptor geral vem antes da escolha, e não dentro dela, porque
            é outra pergunta: "esta casa opera futuros?" não é "o que estou
            olhando agora?". Barrado, o painel não é só uma tela escondida — o
            servidor recusa a ordem alavancada mesmo que ela chegue por outro
            caminho.
          */}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(
                () => api.updateSettings({ futuresEnabled: !settings.futuresEnabled }),
                settings.futuresEnabled
                  ? 'Futuros barrado — o painel voltou para spot'
                  : 'Futuros liberado',
              )
            }
            className={`shrink-0 rounded-lg border px-3 py-2 text-[11px] font-bold ${
              settings.futuresEnabled
                ? 'border-info/60 bg-info/10 text-info'
                : 'border-terminal-border text-terminal-muted'
            }`}
          >
            {settings.futuresEnabled ? 'LIBERADO' : 'BARRADO'}
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {(['SPOT', 'FUTURES'] as MarketKind[]).map((market) => {
            const barrado = market === 'FUTURES' && !settings.futuresEnabled;
            return (
              <button
                key={market}
                type="button"
                disabled={busy || barrado}
                onClick={() =>
                  void run(
                    () => api.updateSettings({ market }),
                    market === 'FUTURES' ? 'Futuros USD-M ativo' : 'Spot ativo',
                  )
                }
                className={`rounded-xl border px-3 py-3 text-xs font-bold ${
                  settings.market === market
                    ? 'border-info/60 bg-info/10 text-info'
                    : 'border-terminal-border text-terminal-muted'
                } ${barrado ? 'opacity-40' : ''}`}
              >
                {market === 'SPOT' ? 'SPOT' : 'FUTUROS USD-M'}
                <span className="mt-1 block text-[10px] font-normal opacity-70">
                  {market === 'SPOT'
                    ? 'compra a moeda, sem alavancagem'
                    : barrado
                      ? 'barrado no interruptor acima'
                      : 'contrato perpétuo, alavancado, com venda a descoberto'}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-terminal-muted">
          A modalidade organiza o radar e os ajustes: cada uma tem carteira, risco, robô e disjuntor
          próprios, e trocar aqui não leva junto o que foi ajustado na outra. O que ela NÃO esconde é
          posição aberta — a aba Operações continua mostrando as duas modalidades juntas, porque
          dinheiro exposto agora não pode depender de qual aba está selecionada.
        </p>
      </section>
      {/* alavancagem e margem só existem em futuros, e pertencem à escolha da
          modalidade: são o que muda o significado do tamanho da posição */}
      {futuros ? <FuturosSection settings={settings} busy={busy} run={run} /> : null}

      <div className="pt-1">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-terminal-muted">2 · O que o radar procura</h3>
        <p className="mt-0.5 text-[11px] text-terminal-muted">Quais tempos gráficos geram tese, em quais moedas, e com que cobertura de mercado.</p>
      </div>

      <MicroScalpSection settings={settings} busy={busy} run={run} />
      <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
        <h2 className="text-sm font-semibold">Cobertura do mercado</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {(
            [
              { id: 'WATCHLIST', label: 'Só a watchlist', hint: 'tempo real, poucos pares' },
              { id: 'ALL_USDT', label: 'Todo o spot USDT', hint: 'todos os pares negociáveis, por lotes' },
            ] as Array<{ id: UniverseMode; label: string; hint: string }>
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.updateSettings({ scanner: { universe: option.id } }),
                  `Cobertura: ${option.label}`,
                )
              }
              className={`rounded-xl border px-3 py-3 text-xs font-semibold ${
                settings.scanner.universe === option.id
                  ? 'border-bull/60 bg-bull/10 text-bull'
                  : 'border-terminal-border text-terminal-muted'
              }`}
            >
              {option.label}
              <span className="mt-1 block text-[10px] font-normal opacity-70">{option.hint}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
          <Info label="Pares do universo" value={String(settings.universe.total)} />
          <Info label="Na varredura por lotes" value={String(settings.universe.liquid)} />
          <Info
            label="Última volta completa"
            value={settings.universe.lastCycleSeconds ? `${settings.universe.lastCycleSeconds}s` : '—'}
          />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-terminal-muted">
          A watchlist recebe preço em tempo real. Todos os demais pares Spot/USDT são analisados em
          lotes; quando surge uma oportunidade, ela entra no Radar e passa a receber acompanhamento
          em tempo real. O volume mínimo para autorizar uma operação continua nas travas de risco.
        </p>
      </section>
      <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">
            Watchlist em tempo real ({settings.scanner.watchlist.length}){' '}
            <span className="rounded bg-terminal-panel-soft px-1.5 py-0.5 align-middle text-[10px] font-normal text-terminal-muted">
              vale nas três contas
            </span>
          </h2>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() => api.curatedWatchlist(30), 'Watchlist preenchida com os pares mais líquidos')
            }
            className="rounded-lg border border-terminal-border px-3 py-1.5 text-xs text-terminal-muted hover:text-terminal-text"
          >
            Preencher com as melhores moedas
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {settings.scanner.watchlist.map((symbol) => (
            <span
              key={symbol}
              className="flex items-center gap-2 rounded-lg border border-terminal-border bg-terminal-panel-soft px-2 py-1 text-xs"
            >
              <SymbolButton symbol={symbol} note="ativo acompanhado" />
              <button
                type="button"
                onClick={() => void run(() => api.removeFromWatchlist(symbol), `${symbol} removido`)}
                className="text-terminal-muted hover:text-bear"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        <div className="mt-3 max-w-sm">
          <input
            value={symbolTerm}
            onChange={(event) => void search(event.target.value)}
            placeholder="+ Adicionar ativo (ex.: SOL)"
            className="w-full rounded-lg border border-terminal-border bg-terminal-panel-soft px-3 py-2 text-sm outline-none"
          />
          {results.length > 0 ? (
            <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-terminal-border">
              {results.map((result) => (
                <button
                  key={result.symbol}
                  type="button"
                  onClick={() =>
                    void run(() => api.addToWatchlist(result.symbol), `${result.symbol} adicionado`).then(
                      () => {
                        setSymbolTerm('');
                        setResults([]);
                      },
                    )
                  }
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-terminal-panel-soft"
                >
                  {result.symbol}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </section>
      <div className="pt-1">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-terminal-muted">3 · Quanto arriscar</h3>
        <p className="mt-0.5 text-[11px] text-terminal-muted">O tamanho de cada posição e os limites da carteira. Vale por conta e por modalidade.</p>
      </div>

      <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
        <h2 className="text-sm font-semibold">
          {settings.mode === 'PAPER' ? 'Capital e controle de risco' : 'Saldo e controle de risco'}{' '}
          <EscopoDoModo mode={settings.mode} />
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {settings.mode === 'PAPER' ? (
            <label className="block">
              <span className="text-xs text-terminal-muted">Capital da carteira simulada</span>
              <div className="mt-1 flex gap-2">
                <input
                  type="number"
                  step={100}
                  value={risk.paperCapital}
                  onChange={(event) => setRisk({ ...risk, paperCapital: Number(event.target.value) })}
                  className="w-full rounded-lg border border-terminal-border bg-terminal-panel-soft px-3 py-2 text-sm tabular outline-none"
                />
                <select
                  value={risk.paperCapitalCurrency}
                  onChange={(event) =>
                    setRisk({ ...risk, paperCapitalCurrency: event.target.value as 'USDT' | 'BRL' })
                  }
                  className="rounded-lg border border-terminal-border bg-terminal-panel-soft px-2 text-sm outline-none"
                >
                  <option value="BRL">R$</option>
                  <option value="USDT">USDT</option>
                </select>
              </div>
              <span className="text-[10px] text-terminal-muted">{capitalHint}</span>
            </label>
          ) : (
            <div className="rounded-lg border border-terminal-border bg-terminal-panel-soft px-3 py-2">
              <span className="block text-xs text-terminal-muted">
                Saldo {settings.mode === 'LIVE' ? 'Spot real' : 'Spot de teste'}
              </span>
              <strong className="mt-1 block text-sm tabular">
                {formatUsdtBalance(activeBinanceBalance)}
              </strong>
              <span className="text-[10px] text-terminal-muted">
                Lido automaticamente da Binance; não é configurado neste painel.
              </span>
            </div>
          )}
          {RISK_FIELDS.map((field) => (
            <label key={field.key} className="block">
              <span className="text-xs text-terminal-muted">{field.label}</span>
              <input
                type="number"
                step={field.step}
                value={risk[field.key] as number}
                onChange={(event) =>
                  setRisk({ ...risk, [field.key]: Number(event.target.value) } as RiskSettings)
                }
                className="mt-1 w-full rounded-lg border border-terminal-border bg-terminal-panel-soft px-3 py-2 text-sm tabular outline-none"
              />
              <span className="text-[10px] text-terminal-muted">{field.hint}</span>
            </label>
          ))}
        </div>
      </section>
      <div className="pt-1">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-terminal-muted">4 · Quem puxa o gatilho</h3>
        <p className="mt-0.5 text-[11px] text-terminal-muted">A compra automática. Desligada, toda entrada é sua.</p>
      </div>

      <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">
              Compra automática <EscopoDoModo mode={settings.mode} />
            </h2>
            <p className="mt-0.5 text-[11px] text-terminal-muted">
              Nas contas demo o robô opera livre. Na conta real ele precisa de duas chaves ao mesmo
              tempo: a liberação no servidor e o armamento aqui, com prazo ou até você desarmar.
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(
                () => api.updateSettings({ autoTrade: { enabled: !auto.enabled } }),
                auto.enabled ? 'Robô desligado' : 'Robô ligado',
              )
            }
            className={`shrink-0 rounded-xl border px-4 py-2 text-xs font-bold ${
              auto.enabled ? 'border-bull/60 bg-bull/10 text-bull' : 'border-terminal-border text-terminal-muted'
            }`}
          >
            {auto.enabled ? 'LIGADO' : 'DESLIGADO'}
          </button>
        </div>
        <div className="mt-4 rounded-lg border border-terminal-border bg-terminal-panel-soft p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-xs font-semibold">Conta real</h3>
              <p className="text-[11px] text-terminal-muted">
                {riskState?.robot.serverAllowsLive
                  ? 'Servidor liberado (ALLOW_LIVE_AUTOTRADE=true).'
                  : 'Servidor bloqueado: ligue ALLOW_LIVE_AUTOTRADE=true no .env e reinicie.'}
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={auto.allowLive}
                disabled={busy || !riskState?.robot.serverAllowsLive}
                onChange={(event) =>
                  void run(
                    () => api.updateSettings({ autoTrade: { allowLive: event.target.checked } }),
                    event.target.checked
                      ? 'Compra automática liberada para a conta real'
                      : 'Compra automática da conta real bloqueada',
                  )
                }
              />
              Liberar robô na conta real
            </label>
          </div>

          {auto.allowLive ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {auto.liveArmedIndefinitely ||
              (auto.liveArmedUntil && new Date(auto.liveArmedUntil).getTime() > Date.now()) ? (
                <>
                  <span className="rounded border border-bull/50 bg-bull/10 px-2 py-1 text-[11px] font-semibold text-bull">
                    {auto.liveArmedIndefinitely
                      ? 'Armado sem prazo'
                      : `Armado até ${new Date(auto.liveArmedUntil as string).toLocaleTimeString('pt-BR', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}`}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => api.disarmRobot(), 'Robô desarmado')}
                    className="rounded-lg border border-terminal-border px-3 py-1 text-[11px] text-terminal-muted"
                  >
                    Desarmar
                  </button>
                </>
              ) : (
                <>
                  <span className="text-[11px] text-terminal-muted">Desarmado. Armar por:</span>
                  <input
                    type="number"
                    min={5}
                    max={10_080}
                    step={5}
                    value={armMinutes}
                    disabled={busy}
                    onChange={(event) => setArmMinutes(event.target.value)}
                    aria-label="Minutos de armamento do robô real"
                    className="w-24 rounded-lg border border-terminal-border bg-terminal-bg px-2 py-1 text-xs"
                  />
                  <span className="text-[11px] text-terminal-muted">min</span>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !Number.isInteger(Number(armMinutes)) ||
                      Number(armMinutes) < 5 ||
                      Number(armMinutes) > 10_080
                    }
                    onClick={() => {
                      const minutes = Number(armMinutes);
                      if (
                        !window.confirm(
                          `Armar o robô na conta REAL por ${minutes} minutos?\n\nEle vai enviar ordens com dinheiro de verdade, respeitando o teto por ordem e o disjuntor.`,
                        )
                      ) {
                        return;
                      }
                      void run(() => api.armRobot(minutes), `Robô armado por ${minutes} min`);
                    }}
                    className="rounded-lg border border-bear/50 bg-bear/10 px-3 py-1 text-[11px] font-semibold text-bear disabled:opacity-40"
                  >
                    Armar com prazo
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (
                        !window.confirm(
                          'Armar o robô na conta REAL sem prazo?\n\nEle continuará enviando ordens com dinheiro de verdade até você desarmar manualmente. As travas de risco permanecem ativas.',
                        )
                      ) {
                        return;
                      }
                      void run(() => api.armRobot(null), 'Robô armado sem prazo');
                    }}
                    className="rounded-lg border border-bear/50 bg-bear/10 px-3 py-1 text-[11px] font-semibold text-bear"
                  >
                    Sem prazo
                  </button>
                </>
              )}
            </div>
          ) : null}

          {riskState?.robot.liveDenial ? (
            <p className="mt-2 text-[11px] text-warn">
              Agora o robô NÃO compraria na conta real: {riskState.robot.liveDenial}.
            </p>
          ) : null}
        </div>
        <div className="mt-4 rounded-lg border border-terminal-border bg-terminal-panel-soft p-3">
          <h3 className="text-xs font-semibold">Estratégias autorizadas nesta conta</h3>
          <p className="mt-0.5 text-[10px] text-terminal-muted">
            Desligar mantém os sinais no radar. Ligar autoriza a ordem automática depois de score,
            R/R, zona, saldo, exposição e filtros da corretora. Sinais no piso usam metade do
            tamanho; a partir de +10 pontos usam o tamanho integral.
          </p>
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {AUTOMATIC_STRATEGIES.map((item) => {
              const policy = auto.strategies[item.id];
              return (
                <div key={item.id} className="rounded-lg border border-terminal-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold">{item.label}</p>
                      <p className="text-[10px] text-terminal-muted">{item.hint}</p>
                    </div>
                    <label className="flex items-center gap-2 text-[11px]">
                      <input
                        type="checkbox"
                        checked={policy.enabled}
                        onChange={(event) =>
                          setAuto({
                            ...auto,
                            strategies: {
                              ...auto.strategies,
                              [item.id]: { ...policy, enabled: event.target.checked },
                            },
                          })
                        }
                      />
                      {policy.enabled ? 'automática' : 'só radar'}
                    </label>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="text-[10px] text-terminal-muted">
                      Score mínimo
                      <input
                        type="number"
                        min={50}
                        max={100}
                        step={1}
                        value={policy.minimumScore}
                        onChange={(event) =>
                          setAuto({
                            ...auto,
                            strategies: {
                              ...auto.strategies,
                              [item.id]: { ...policy, minimumScore: Number(event.target.value) },
                            },
                          })
                        }
                        className="mt-1 w-full rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-xs tabular"
                      />
                    </label>
                    <label className="text-[10px] text-terminal-muted">
                      R/R mínimo
                      <input
                        type="number"
                        min={1}
                        max={10}
                        step={0.1}
                        value={policy.minimumRiskReward}
                        onChange={(event) =>
                          setAuto({
                            ...auto,
                            strategies: {
                              ...auto.strategies,
                              [item.id]: {
                                ...policy,
                                minimumRiskReward: Number(event.target.value),
                              },
                            },
                          })
                        }
                        className="mt-1 w-full rounded border border-terminal-border bg-terminal-bg px-2 py-1 text-xs tabular"
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {AUTO_FIELDS.map((field) => {
            const valor = auto[field.key] as number;
            const foraDoLimite = valor < field.min || valor > field.max;
            return (
            <label key={field.key} className="block">
              <span className="text-xs text-terminal-muted">{field.label}</span>
              <input
                type="number"
                step={field.step}
                min={field.min}
                max={field.max}
                value={valor}
                onChange={(event) =>
                  setAuto({ ...auto, [field.key]: Number(event.target.value) } as AutoTradeSettings)
                }
                className={`mt-1 w-full rounded-lg border bg-terminal-panel-soft px-3 py-2 text-sm tabular outline-none ${
                  foraDoLimite ? 'border-bear' : 'border-terminal-border'
                }`}
              />
              {/* o aviso aparece enquanto se digita, não só depois de salvar */}
              <span className={`text-[10px] ${foraDoLimite ? 'text-bear' : 'text-terminal-muted'}`}>
                {foraDoLimite
                  ? `Aceito entre ${field.min} e ${field.max}. ${field.hint}`
                  : field.hint}
              </span>
            </label>
            );
          })}
          <label className="flex items-center gap-2 self-end pb-6 text-xs text-terminal-muted">
            <input
              type="checkbox"
              checked={auto.requireInsideEntryZone}
              onChange={(event) => setAuto({ ...auto, requireInsideEntryZone: event.target.checked })}
            />
            Só comprar dentro da zona de entrada
          </label>
        </div>
      </section>
      <div className="pt-1">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-terminal-muted">5 · Controle e leitura de risco</h3>
        <p className="mt-0.5 text-[11px] text-terminal-muted">Custos reais, R/R líquido e alertas que não desligam o robô.</p>
      </div>

      <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">
              Monitor de risco <EscopoDoModo mode={settings.mode} />
            </h2>
            <p className="mt-0.5 text-[11px] text-terminal-muted">
              Perda diária, drawdown e sequência ruim continuam visíveis, mas não interrompem
              entradas automáticas nem manuais.
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Encerrar TODAS as posições agora e desligar o robô?')) return;
              void run(() => api.closeAll(), 'Tudo encerrado e robô desligado');
            }}
            className="rounded-lg border border-bear/60 bg-bear/10 px-4 py-2 text-xs font-bold text-bear disabled:opacity-40"
          >
            Pânico: encerrar tudo
          </button>
        </div>

        {riskState ? (
          <>
            <dl className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 lg:grid-cols-5">
              <Info
                label="Resultado do dia"
                value={usd(riskState.dailyRealizedPnl)}
                tone={riskState.dailyRealizedPnl >= 0 ? 'text-bull' : 'text-bear'}
              />
              <Info label="Limite de perda do dia" value={usd(-riskState.dailyLossLimit)} />
              <Info
                label="Queda desde o topo"
                value={`${riskState.drawdownPercent.toFixed(2)}%`}
                tone={riskState.drawdownPercent >= guard.maxDrawdownPercent ? 'text-bear' : undefined}
              />
              <Info
                label="Perdas seguidas"
                value={`${riskState.consecutiveLosses} de ${guard.maxConsecutiveLosses}`}
                tone={riskState.consecutiveLosses > 0 ? 'text-warn' : undefined}
              />
              <Info
                label="Exposição"
                value={`${riskState.exposurePercent.toFixed(1)}% · alt ${riskState.altExposurePercent.toFixed(1)}%`}
              />
            </dl>

            {riskState.mutedReasons.length > 0 ? (
              <p className="mt-3 rounded-lg border border-warn/40 bg-warn/10 p-2 text-[11px] text-warn">
                Alerta de risco — o robô continua operando: {riskState.mutedReasons.join('; ')}.
              </p>
            ) : null}
          </>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {GUARD_FIELDS.map((field) => (
            <label key={field.key} className="block">
              <span className="text-xs text-terminal-muted">{field.label}</span>
              <input
                type="number"
                step={field.step}
                min={field.min}
                max={field.max}
                value={guard[field.key] as number}
                onChange={(event) =>
                  setGuard({ ...guard, [field.key]: Number(event.target.value) } as GuardSettings)
                }
                className="mt-1 w-full rounded-lg border border-terminal-border bg-terminal-panel-soft px-3 py-2 text-sm tabular outline-none"
              />
              <span className="text-[10px] text-terminal-muted">{field.hint}</span>
            </label>
          ))}
          <label className="flex items-center gap-2 self-end pb-6 text-xs text-terminal-muted">
            <input
              type="checkbox"
              checked={guard.breakevenAfterTarget1}
              onChange={(event) => setGuard({ ...guard, breakevenAfterTarget1: event.target.checked })}
            />
            Levar o stop ao empate após o alvo 1
          </label>
          <label className="flex items-center gap-2 self-end pb-6 text-xs text-terminal-muted">
            <input
              type="checkbox"
              checked={guard.blockWhenBtcBearish}
              onChange={(event) => setGuard({ ...guard, blockWhenBtcBearish: event.target.checked })}
            />
            Não comprar com o BTC vendedor
          </label>
          <label className="flex items-center gap-2 self-end pb-6 text-xs text-terminal-muted">
            <input
              type="checkbox"
              checked={guard.manageLiveStops}
              onChange={(event) => setGuard({ ...guard, manageLiveStops: event.target.checked })}
            />
            Remanejar o stop também na corretora
          </label>
        </div>
      </section>
      <div className="pt-1">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-terminal-muted">6 · Acesso</h3>
        <p className="mt-0.5 text-[11px] text-terminal-muted">Quem está nesta sessão.</p>
      </div>

      <Acesso onLoggedOut={onLoggedOut} />
    </div>
  );
}

/**
 * Quem está dentro e como sair. Fica no fim dos Ajustes de propósito: sair é
 * ação rara, e um botão de sair no cabeçalho, ao lado do que liga o robô, é
 * clique errado esperando acontecer.
 */
/**
 * Os ajustes que só existem em futuros.
 *
 * Alavancagem NÃO é "quanto arriscar": o tamanho continua saindo do prejuízo
 * no stop. Ela decide quanta margem a mesma posição prende — e, junto com o
 * stop, onde fica a linha de liquidação. Por isso os dois campos moram lado a
 * lado: mexer num sem olhar o outro é como o painel deixa de proteger.
 */
function FuturosSection({
  settings,
  busy,
  run,
}: {
  settings: SettingsResponse;
  busy: boolean;
  run: (action: () => Promise<unknown>, message: string) => void;
}) {
  const futures = settings.futures;
  return (
    <section className="rounded-xl border border-info/40 bg-terminal-panel p-5">
      <h2 className="text-sm font-semibold">
        Futuros USD-M <EscopoDoModo mode={settings.mode} />
      </h2>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <label className="block text-xs">
          <span className="text-terminal-muted">Alavancagem</span>
          <div className="mt-1 flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={futures.maxLeverage}
              step={1}
              value={futures.leverage}
              disabled={busy}
              onChange={(event) =>
                run(
                  () => api.updateSettings({ futures: { leverage: Number(event.target.value) } }),
                  `Alavancagem ${event.target.value}x`,
                )
              }
              className="w-full"
            />
            <span className="w-12 text-right font-mono text-sm font-bold text-info">
              {futures.leverage}x
            </span>
          </div>
          <span className="mt-1 block text-[10px] text-terminal-muted">
            Com {futures.leverage}x, uma posição prende {Math.round(100 / futures.leverage)}% do valor
            dela em margem. O risco por operação continua vindo do stop.
          </span>
        </label>

        <label className="block text-xs">
          <span className="text-terminal-muted">Teto de alavancagem</span>
          <input
            type="number"
            min={1}
            max={10}
            step={1}
            defaultValue={futures.maxLeverage}
            disabled={busy}
            onBlur={(event) =>
              run(
                () => api.updateSettings({ futures: { maxLeverage: Number(event.target.value) } }),
                'Teto de alavancagem salvo',
              )
            }
            className="mt-1 w-full rounded-lg border border-terminal-border bg-terminal-bg px-3 py-2 font-mono text-sm"
          />
          <span className="mt-1 block text-[10px] text-terminal-muted">
            O painel não aceita mais que 10x. Alavancagem alta não aumenta o lucro esperado — encurta
            a distância até a liquidação.
          </span>
        </label>

        <label className="block text-xs">
          <span className="text-terminal-muted">Tipo de margem</span>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {(['ISOLATED', 'CROSSED'] as MarginMode[]).map((marginMode) => (
              <button
                key={marginMode}
                type="button"
                disabled={busy}
                onClick={() =>
                  run(
                    () => api.updateSettings({ futures: { marginMode } }),
                    marginMode === 'ISOLATED' ? 'Margem isolada' : 'Margem cruzada',
                  )
                }
                className={`rounded-lg border px-3 py-2 text-[11px] font-semibold ${
                  futures.marginMode === marginMode
                    ? 'border-info/60 bg-info/10 text-info'
                    : 'border-terminal-border text-terminal-muted'
                }`}
              >
                {marginMode === 'ISOLATED' ? 'Isolada' : 'Cruzada'}
              </button>
            ))}
          </div>
          <span className="mt-1 block text-[10px] text-terminal-muted">
            Isolada arrisca só a margem daquela posição. Cruzada usa a carteira inteira como
            garantia: a liquidação fica bem mais longe, e quando ela chega leva tudo.
          </span>
        </label>

        <label className="block text-xs">
          <span className="text-terminal-muted">Folga mínima até a liquidação (%)</span>
          <input
            type="number"
            min={0}
            max={50}
            step={0.5}
            defaultValue={futures.minLiquidationBufferPercent}
            disabled={busy}
            onBlur={(event) =>
              run(
                () =>
                  api.updateSettings({
                    futures: { minLiquidationBufferPercent: Number(event.target.value) },
                  }),
                'Folga de liquidação salva',
              )
            }
            className="mt-1 w-full rounded-lg border border-terminal-border bg-terminal-bg px-3 py-2 font-mono text-sm"
          />
          <span className="mt-1 block text-[10px] text-terminal-muted">
            Distância que o stop precisa ter da liquidação. Abaixo disso a ordem é recusada e o
            painel diz qual alavancagem ainda serve.
          </span>
        </label>
      </div>

      <div className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-terminal-border p-3">
        <div>
          <p className="text-xs font-semibold">Venda a descoberto</p>
          <p className="mt-1 text-[10px] leading-relaxed text-terminal-muted">
            Libera as teses vendidas no radar e a execução delas. O ROBÔ continua só comprando: o
            laboratório mediu apenas o lado comprado, e o lado de baixo é entrada manual até ter
            treino e teste próprios.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(
              () => api.updateSettings({ futures: { allowShort: !futures.allowShort } }),
              futures.allowShort ? 'Venda a descoberto desligada' : 'Venda a descoberto liberada',
            )
          }
          className={`shrink-0 rounded-lg border px-3 py-2 text-[11px] font-bold ${
            futures.allowShort
              ? 'border-bear/60 bg-bear/10 text-bear'
              : 'border-terminal-border text-terminal-muted'
          }`}
        >
          {futures.allowShort ? 'LIBERADA' : 'DESLIGADA'}
        </button>
      </div>
    </section>
  );
}

function Acesso({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [sessao, setSessao] = useState<SessionState | null>(null);
  const [saindo, setSaindo] = useState(false);

  useEffect(() => {
    void readSession()
      .then(setSessao)
      .catch(() => setSessao(null));
  }, []);

  const sair = async (): Promise<void> => {
    setSaindo(true);
    try {
      await logout();
      onLoggedOut();
    } finally {
      setSaindo(false);
    }
  };

  const vence = sessao?.expiresAt ? new Date(sessao.expiresAt) : null;

  return (
    <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
      <h2 className="text-sm font-semibold">Acesso</h2>
      <p className="mt-1 text-xs text-terminal-muted">
        {sessao?.backend === 'supabase'
          ? 'A senha é conferida no Supabase Auth.'
          : 'A senha é conferida neste computador, pelo hash gravado no .env.'}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
        <Info label="Entrou como" value={sessao?.user ?? '—'} />
        <Info
          label="Sessão vence"
          value={
            vence
              ? vence.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
              : '—'
          }
        />
      </dl>
      <button
        type="button"
        disabled={saindo}
        onClick={() => void sair()}
        className="mt-4 rounded-lg border border-terminal-border px-4 py-2 text-sm font-medium disabled:opacity-40"
      >
        {saindo ? 'Saindo…' : 'Sair do painel'}
      </button>
    </section>
  );
}

/**
 * TIMEFRAMES / TIPOS DE NEGOCIAÇÃO — onde o micro scalp é ligado.
 *
 * A seção mostra os gatilhos de tendência como leitura (eles se ajustam pelo
 * resto do painel) e o 1 minuto como interruptor, porque ele é a única
 * modalidade que muda o COMPORTAMENTO do sistema e não apenas um parâmetro.
 *
 * A lista de reprovados fica visível de propósito. Um universo de scalp vazio
 * é a situação normal na maior parte do tempo — a maioria dos pares não tem
 * amplitude para pagar o custo em 1 minuto — e sem os motivos essa tela seria
 * indistinguível de um módulo quebrado.
 */
function MicroScalpSection({
  settings,
  busy,
  run,
}: {
  settings: SettingsResponse;
  busy: boolean;
  run: (action: () => Promise<unknown>, message: string) => Promise<unknown>;
}) {
  const micro = settings.scanner.microScalp;
  const scalp = settings.scalpUniverse;
  const aprovados = scalp.reports.filter((item) => !item.blocked);
  const reprovados = scalp.reports.filter((item) => item.blocked);

  return (
    <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
      <h2 className="text-sm font-semibold">Timeframes ativos / tipos de negociação</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-terminal-muted">
        Cada timeframe é um interruptor independente: os marcados se somam. Ligar 15m não desliga
        1h ou 4h; o Radar permite filtrar a mesa por um timeframe de cada vez.
      </p>

      <div className="mt-3 space-y-2">
        {TREND_TIMEFRAMES.map((item) => {
          const ligado = settings.scanner.triggerTimeframes.includes(item.id);
          /*
           * Desligar o último gatilho de tendência só é permitido com o micro
           * scalp ligado. Sem isso o radar ficaria sem NADA procurando — e o
           * painel continuaria de pé, com preço atualizando, parecendo vivo.
           * O servidor recusa de qualquer forma; o botão desabilitado é para
           * a recusa não chegar como surpresa depois do clique.
           */
          const ultimo = ligado && settings.scanner.triggerTimeframes.length === 1;
          const travado = ultimo && !micro.enabled;
          return (
            <button
              key={item.id}
              type="button"
              disabled={busy || travado}
              title={
                travado
                  ? 'É o último timeframe ligado. Ligue o micro scalp de 1 minuto para poder desligá-lo.'
                  : undefined
              }
              onClick={() =>
                void run(
                  () =>
                    api.updateSettings({
                      scanner: {
                        triggerTimeframes: ligado
                          ? settings.scanner.triggerTimeframes.filter((tf) => tf !== item.id)
                          : [...settings.scanner.triggerTimeframes, item.id],
                      },
                    }),
                  `${item.id} ${ligado ? 'desligado' : 'ligado'}`,
                )
              }
              className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs disabled:opacity-40 ${
                ligado
                  ? 'border-bull/60 bg-bull/5'
                  : 'border-terminal-border bg-terminal-panel-soft'
              }`}
            >
              <span className={ligado ? 'text-bull' : 'text-terminal-muted'}>
                {ligado ? '✓' : '○'}
              </span>
              <span className="font-semibold">{item.id}</span>
              <span className="text-terminal-muted">{item.hint}</span>
            </button>
          );
        })}

        <div
          className={`rounded-lg border px-3 py-3 ${
            micro.enabled ? 'border-bull/60 bg-bull/5' : 'border-terminal-border bg-terminal-panel-soft'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-xs">
                <span className={micro.enabled ? 'text-bull' : 'text-terminal-muted'}>
                  {micro.enabled ? '✓' : '○'}
                </span>
                <span className="font-semibold">1 minuto — Micro Scalp</span>
              </div>
              <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-terminal-muted">
                Opera faixas laterais em moedas com liquidez suficiente, comprando perto do suporte
                e realizando perto da resistência. Só entra quando o movimento esperado paga pelo
                menos {micro.regime.minCostMultiple}× o custo total da viagem. Sem validação de
                laboratório — o robô não opera este tipo, a entrada é manual.
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    api.updateSettings({
                      scanner: { microScalp: { enabled: !micro.enabled } },
                    }),
                  micro.enabled ? 'Micro scalp desligado' : 'Micro scalp ligado',
                )
              }
              className={`rounded-lg px-4 py-2 text-xs font-bold ${
                micro.enabled ? 'bg-bull text-black' : 'border border-terminal-border text-terminal-muted'
              } disabled:opacity-40`}
            >
              {micro.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      </div>

      {micro.enabled ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-terminal-border px-3 py-2">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold">
              {micro.enforceFilters ? 'Filtros barrando' : 'Filtros só avisando'}
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-terminal-muted">
              {micro.enforceFilters
                ? 'Par sem liquidez ou sem amplitude para cobrir o custo não entra, e tese sem margem não nasce.'
                : 'Todos os pares medidos entram no ranking e as teses nascem mesmo sem margem — com o motivo colado nelas. Os números não mudam: o lucro líquido continua sendo o real, e aparece em vermelho quando é negativo. O robô segue sem operar micro scalp.'}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(
                () =>
                  api.updateSettings({
                    scanner: { microScalp: { enforceFilters: !micro.enforceFilters } },
                  }),
                micro.enforceFilters ? 'Filtros passam a só avisar' : 'Filtros voltam a barrar',
              )
            }
            className={`rounded-lg px-3 py-1.5 text-xs font-bold ${
              micro.enforceFilters
                ? 'border border-terminal-border text-terminal-muted'
                : 'bg-bear/20 text-bear'
            } disabled:opacity-40`}
          >
            {micro.enforceFilters ? 'Não bloquear' : 'Voltar a bloquear'}
          </button>
        </div>
      ) : null}

      {settings.scanner.triggerTimeframes.length === 0 ? (
        <p className="mt-3 rounded-lg border border-bull/40 bg-bull/5 px-3 py-2 text-[11px] leading-relaxed">
          <span className="font-semibold text-bull">Modo só 1 minuto.</span>{' '}
          Nenhum gatilho de tendência está ligado: pullback, rompimento, reversão e explosão não
          serão procurados, e a varredura por lotes do mercado inteiro fica parada. O radar mostra
          apenas as teses de micro scalp dos {settings.scalpUniverse.active.length} pares aptos. O
          gráfico de 15 minutos continua sendo carregado — é ele que serve de âncora para o 1m.
        </p>
      ) : null}

      {micro.enabled ? (
        <>
          <div className="mt-4 grid gap-2 text-xs sm:grid-cols-4">
            <Info label="Pares aptos" value={String(scalp.active.length)} />
            <Info label="Medidos na volta" value={String(scalp.candidatesMeasured)} />
            <Info label="Teto do universo" value={String(micro.maxUniverseSize)} />
            <Info
              label="Última medição"
              value={scalp.lastCycleSeconds !== null ? `${scalp.lastCycleSeconds}s` : '—'}
            />
          </div>

          {scalp.lastError ? (
            <p className="mt-2 text-xs text-bear">Falha ao medir liquidez: {scalp.lastError}</p>
          ) : null}

          {aprovados.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-xs font-semibold text-terminal-muted">
                Acompanhados em 1 minuto
              </h3>
              <div className="mt-2 space-y-1">
                {aprovados.map((item) => (
                  <div
                    key={item.symbol}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-terminal-border bg-terminal-panel-soft px-3 py-2 text-[11px]"
                  >
                    <SymbolButton symbol={item.symbol} note="apto para micro scalp" />
                    <span className="font-bold text-bull">{item.score}/100</span>
                    <span className="text-terminal-muted">{item.grade}</span>
                    <span className="text-terminal-muted">
                      spread {item.liquidity.spreadPercent.toFixed(3)}%
                    </span>
                    <span className="text-terminal-muted">
                      amplitude {item.microAtrPercent?.toFixed(3) ?? '—'}%
                    </span>
                    <span className="text-terminal-muted">
                      custo {item.allInCostPercent.toFixed(3)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="mt-4 rounded-lg border border-terminal-border bg-terminal-panel-soft px-3 py-2 text-[11px] leading-relaxed text-terminal-muted">
              Nenhum par apto no momento. Isso é o resultado esperado na maior parte do tempo: a
              maioria das moedas não oscila o suficiente em 1 minuto para pagar taxa, spread e
              escorregamento. Os motivos par a par estão abaixo.
            </p>
          )}

          <MicroLimiares micro={micro} run={run} busy={busy} />

          {scalp.blocks.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-xs font-semibold text-terminal-muted">
                Aptos, mas sem tese agora — em que estágio cada um parou
              </h3>
              <div className="mt-2 space-y-1">
                {scalp.blocks.map((item) => (
                  <div
                    key={item.symbol}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-terminal-border px-3 py-2 text-[11px]"
                  >
                    <span className="w-24 font-semibold">{item.symbol}</span>
                    {item.verdict ? (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          item.verdict === 'RANGE'
                            ? 'bg-bull/15 text-bull'
                            : 'bg-terminal-panel-soft text-terminal-muted'
                        }`}
                      >
                        {item.verdict}
                      </span>
                    ) : null}
                    {item.amplitudePercent !== null ? (
                      <span className="text-terminal-muted">
                        faixa {item.amplitudePercent.toFixed(3)}%
                      </span>
                    ) : null}
                    {item.position !== null ? (
                      <span className="text-terminal-muted">
                        preço a {(item.position * 100).toFixed(0)}% dela
                      </span>
                    ) : null}
                    <span className="text-terminal-muted">{item.reason}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-terminal-muted">
                A faixa continua sendo condição mesmo com os filtros só avisando — ela não é uma
                trava de risco, é a definição da estratégia. Comprar a borda de baixo de uma faixa
                que não existe não é operar arriscado, é operar sem tese.
              </p>
            </div>
          ) : null}

          {!micro.enforceFilters ? (
            <div className="mt-4">
              <h3 className="text-xs font-semibold text-terminal-muted">
                Todos os pares medidos ({scalp.reports.length}) — nenhum barrado
              </h3>
              <div className="mt-2 max-h-96 space-y-1 overflow-y-auto pr-1">
                {scalp.reports.map((item) => (
                  <div
                    key={item.symbol}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-terminal-border px-3 py-2 text-[11px]"
                  >
                    <span className="w-24 font-semibold">{item.symbol}</span>
                    <span className={`font-bold ${item.blockers.length > 0 ? 'text-terminal-muted' : 'text-bull'}`}>
                      {item.score}/100
                    </span>
                    <span className="text-terminal-muted">
                      spread {item.liquidity.spreadPercent.toFixed(3)}%
                    </span>
                    <span className="text-terminal-muted">
                      ATR {item.microAtrPercent?.toFixed(3) ?? '—'}%
                    </span>
                    <span className="text-terminal-muted">
                      custo {item.allInCostPercent.toFixed(3)}%
                    </span>
                    {item.blockers[0] ? (
                      <span className="text-bear">⚠ {item.blockers[0]}</span>
                    ) : (
                      <span className="text-bull">sem ressalvas</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {reprovados.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-xs font-semibold text-terminal-muted">
                Bloqueados — e por quê ({reprovados.length})
              </h3>
              <div className="mt-2 space-y-1">
                {reprovados.map((item) => (
                  <div
                    key={item.symbol}
                    className="flex flex-wrap items-baseline gap-x-2 rounded-lg border border-terminal-border px-3 py-2 text-[11px]"
                  >
                    <span className="font-semibold">{item.symbol}</span>
                    <span className="rounded bg-bear/10 px-1.5 py-0.5 text-[10px] font-semibold text-bear">
                      1M BLOQUEADO
                    </span>
                    <span className="text-terminal-muted">{item.blockers[0]}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * Os limiares do micro scalp, editáveis.
 *
 * Estavam no código desde o início e a tela não os mostrava — "configurável"
 * que só existe no arquivo é configurável para uma pessoa só. Aqui eles ficam
 * à mão, com o efeito visível na lista de bloqueados logo abaixo: baixar um
 * número e ver quem passa a entrar é a única forma honesta de calibrar.
 *
 * O aviso sobre o piso de amplitude não é decoração. Ele é o único campo em
 * que afrouxar não produz mais oportunidade: o par entra no universo e é
 * recusado três estágios depois, pela conta de custo, que usa o mesmo número.
 */
function MicroLimiares({
  micro,
  run,
  busy,
}: {
  micro: MicroScalpSettings;
  run: (action: () => Promise<unknown>, message: string) => Promise<unknown>;
  busy: boolean;
}) {
  const [aberto, setAberto] = useState(false);

  const campo = (
    rotulo: string,
    valor: number,
    step: number,
    aplicar: (v: number) => Parameters<typeof api.updateSettings>[0],
    dica: string,
  ) => (
    <label key={rotulo} className="block">
      <span className="text-[10px] text-terminal-muted">{rotulo}</span>
      <input
        type="number"
        step={step}
        defaultValue={valor}
        disabled={busy}
        onBlur={(event) => {
          const proximo = Number(event.target.value);
          if (!Number.isFinite(proximo) || proximo === valor) return;
          void run(() => api.updateSettings(aplicar(proximo)), `${rotulo}: ${proximo}`);
        }}
        className="mt-0.5 w-full rounded-lg border border-terminal-border bg-terminal-panel-soft px-2 py-1.5 text-xs tabular outline-none"
      />
      <span className="text-[10px] text-terminal-muted">{dica}</span>
    </label>
  );

  return (
    <div className="mt-4 rounded-lg border border-terminal-border">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold text-terminal-muted"
      >
        <span>Limiares do micro scalp — o que bloqueia um par</span>
        <span>{aberto ? '−' : '+'}</span>
      </button>
      {aberto ? (
        <div className="border-t border-terminal-border px-3 py-3">
          <p className="mb-3 text-[11px] leading-relaxed text-terminal-muted">
            <span className="font-semibold text-terminal-text">Antes de afrouxar:</span> o piso de
            amplitude não é um número escolhido — ele é calculado a partir do custo real de cada
            par (<span className="tabular">ATR ≥ custo × {micro.regime.minCostMultiple} ÷ 2</span>).
            Baixá-lo faz o par entrar no universo e ser recusado depois, pela mesma conta. O único
            jeito de um par de baixa amplitude passar de verdade é o custo cair: taxa de futuros
            (0,05% por lado) ou desconto de BNB.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {campo('Nota mínima', micro.filters.minScore, 1, (v) => ({
              scanner: { microScalp: { filters: { minScore: v } } },
            }), 'abaixo disso o par não entra')}
            {campo('Alvo paga o custo (x)', micro.regime.minCostMultiple, 0.5, (v) => ({
              scanner: { microScalp: { regime: { minCostMultiple: v } } },
            }), 'mínimo 1,5 — em 1,0 acertar já empata')}
            {campo('Volume em 15 min (US$)', micro.filters.minRecentQuoteVolume, 10_000, (v) => ({
              scanner: { microScalp: { filters: { minRecentQuoteVolume: v } } },
            }), 'par parado agora é par sem contraparte')}
            {campo('Volume 24h (US$)', micro.filters.minQuoteVolume24h, 1_000_000, (v) => ({
              scanner: { microScalp: { filters: { minQuoteVolume24h: v } } },
            }), 'corte grosso, antes de medir o book')}
            {campo('Spread máximo (%)', micro.filters.maxSpreadPercent, 0.01, (v) => ({
              scanner: { microScalp: { filters: { maxSpreadPercent: v } } },
            }), 'atravessar o book custa metade disto')}
            {campo('Escorregamento máx. (%)', micro.filters.maxSlippagePercent, 0.01, (v) => ({
              scanner: { microScalp: { filters: { maxSlippagePercent: v } } },
            }), 'medido varrendo o book de verdade')}
            {campo('Piso de amplitude (%)', micro.filters.minMicroAtrPercent, 0.01, (v) => ({
              scanner: { microScalp: { filters: { minMicroAtrPercent: v } } },
            }), 'só vale se for MAIOR que o piso do custo')}
            {campo('ADX máximo', micro.regime.maxAdx, 1, (v) => ({
              scanner: { microScalp: { regime: { maxAdx: v } } },
            }), 'acima disso há tendência, não faixa')}
            {campo('Pares no universo', micro.maxUniverseSize, 1, (v) => ({
              scanner: { microScalp: { maxUniverseSize: v } },
            }), 'cada par abre um stream de 1m')}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Info({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-terminal-border bg-terminal-panel-soft px-3 py-2">
      <dt className="text-[10px] uppercase tracking-wide text-terminal-muted">{label}</dt>
      <dd className={`font-medium ${tone ?? ''}`}>{value}</dd>
    </div>
  );
}

/**
 * Etiqueta de escopo. Risco, robô e disjuntor são de UMA conta — sem dizer de
 * qual, a tela parecia falar do programa inteiro, e era assim que se mexia no
 * demo achando que valia no real.
 */
function EscopoDoModo({ mode }: { mode: TradingMode }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 align-middle text-[10px] font-semibold ${
        mode === 'LIVE' ? 'bg-bear/15 text-bear' : 'bg-bull/15 text-bull'
      }`}
    >
      só no {mode}
    </span>
  );
}

/**
 * O que o outro modo tem guardado, lido antes de trocar de conta. Aqui só
 * aparece o que assusta na hora errada: se o robô daquela conta está ligado e
 * com quanto ele opera.
 */
function ModoResumo({
  mode,
  settings,
  balance,
}: {
  mode: TradingMode;
  settings: ModeSettings | undefined;
  balance: BinanceBalanceSummary | null;
}) {
  if (!settings) return null;
  const ligado = settings.autoTrade.enabled;
  return (
    <span className="mt-1.5 block text-[10px] font-normal">
      <span className={ligado ? 'text-bull' : 'text-terminal-muted'}>
        {ligado ? '● robô ligado' : '○ robô desligado'}
      </span>
      <span className="block opacity-60">
        {mode === 'PAPER'
          ? `capital simulado: ${
              settings.risk.paperCapitalCurrency === 'BRL'
                ? brl(settings.risk.paperCapital)
                : usd(settings.risk.paperCapital)
            }`
          : formatUsdtBalance(balance)}
      </span>
      {mode === 'LIVE' && balance?.status === 'AVAILABLE' && balance.total !== null && balance.brlRate ? (
        <span className="block opacity-60">≈ {brl(balance.total * balance.brlRate)}</span>
      ) : null}
    </span>
  );
}

function formatUsdtBalance(balance: BinanceBalanceSummary | null): string {
  if (!balance || balance.status === 'UNAVAILABLE') return 'saldo indisponível';
  if (balance.status === 'NOT_CONFIGURED') return 'saldo: chaves ausentes';
  return `saldo: ${quantity(balance.total ?? 0)} USDT`;
}
