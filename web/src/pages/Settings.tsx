import { useEffect, useState } from 'react';
import { api, type RiskResponse, type SettingsResponse } from '../lib/api.ts';
import { SymbolButton } from '../components/SymbolButton.tsx';
import type {
  AutoTradeSettings,
  GuardSettings,
  RiskSettings,
  TradingMode,
  UniverseMode,
} from '../lib/types.ts';
import { brl, usd } from '../lib/format.ts';

const RISK_FIELDS: Array<{ key: keyof RiskSettings; label: string; hint: string; step: number }> = [
  { key: 'maxPositionPercent', label: 'Máximo por operação (%)', hint: 'Teto do capital em um único trade', step: 1 },
  { key: 'riskPerTradePercent', label: 'Risco por operação (%)', hint: 'Perda aceita até o stop', step: 0.1 },
  { key: 'maxOpenTrades', label: 'Operações abertas ao mesmo tempo', hint: 'Trava de exposição', step: 1 },
  { key: 'dailyLossLimitPercent', label: 'Limite de perda diária (%)', hint: 'Bloqueia novas compras no dia', step: 0.5 },
  { key: 'minimumRiskReward', label: 'R/R mínimo', hint: 'Abaixo disso o setup é descartado', step: 0.1 },
  { key: 'minimumScoreToAlert', label: 'Score mínimo para alertar', hint: 'Evita alerta demais', step: 1 },
  { key: 'minimumScoreToShow', label: 'Score mínimo para exibir', hint: 'Setups abaixo nem aparecem', step: 1 },
];

const GUARD_FIELDS: Array<{ key: keyof GuardSettings; label: string; hint: string; step: number }> = [
  { key: 'feePercent', label: 'Taxa por lado (%)', hint: 'Corretagem da Binance; entra em todo resultado', step: 0.01 },
  { key: 'stopSlippagePercent', label: 'Escorregamento do stop (%)', hint: 'Quanto o stop preenche abaixo do gatilho', step: 0.05 },
  { key: 'exitSlippagePercent', label: 'Escorregamento a mercado (%)', hint: 'Custo de sair correndo', step: 0.05 },
  { key: 'minNetRiskReward', label: 'R/R líquido mínimo', hint: 'Já descontadas taxa e escorregamento', step: 0.1 },
  { key: 'maxConsecutiveLosses', label: 'Perdas seguidas até parar', hint: 'Trava o robô depois da sequência ruim', step: 1 },
  { key: 'maxDrawdownPercent', label: 'Queda máxima do topo (%)', hint: 'Para quando a carteira recua demais', step: 1 },
  { key: 'maxDailyTrades', label: 'Operações por dia', hint: 'Impede metralhar o mercado', step: 1 },
  { key: 'maxTotalExposurePercent', label: 'Exposição total máxima (%)', hint: 'Soma de tudo que está aberto', step: 5 },
  { key: 'maxAltExposurePercent', label: 'Exposição em altcoins (%)', hint: 'Altcoin cai junto quando o BTC cai', step: 5 },
  { key: 'lossCooldownMinutes', label: 'Descanso após perda (min)', hint: 'Silêncio obrigatório depois de perder', step: 15 },
  { key: 'trailingStopPercent', label: 'Stop que sobe (%)', hint: '0 desliga; segue o topo alcançado', step: 0.5 },
  { key: 'maxTargetPercent', label: 'Alvo máximo aceito (%)', hint: 'Alvo mais distante que isso é descartado', step: 5 },
  { key: 'minQuoteVolume24h', label: 'Volume mínimo para operar', hint: 'Sair de par ilíquido custa caro', step: 1_000_000 },
];

const AUTO_FIELDS: Array<{ key: keyof AutoTradeSettings; label: string; hint: string; step: number }> = [
  { key: 'minimumScore', label: 'Score mínimo para comprar', hint: 'O robô só entra acima disto', step: 1 },
  { key: 'minimumRiskReward', label: 'R/R mínimo do robô', hint: 'Costuma ser mais exigente que o do radar', step: 0.1 },
  { key: 'percentOfCapital', label: 'Percentual do capital por compra', hint: 'Tamanho de cada posição automática', step: 1 },
  { key: 'maxConcurrentTrades', label: 'Posições automáticas simultâneas', hint: 'Teto de exposição do robô', step: 1 },
  { key: 'cooldownMinutes', label: 'Descanso por ativo (min)', hint: 'Evita recomprar o mesmo ativo em sequência', step: 15 },
  { key: 'maxNotionalPerTrade', label: 'Teto por ordem (USDT)', hint: 'Vale mesmo que o percentual peça mais', step: 5 },
];

export function Settings({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [risk, setRisk] = useState<RiskSettings | null>(null);
  const [auto, setAuto] = useState<AutoTradeSettings | null>(null);
  const [guard, setGuard] = useState<GuardSettings | null>(null);
  const [riskState, setRiskState] = useState<RiskResponse | null>(null);
  const [symbolTerm, setSymbolTerm] = useState('');
  const [results, setResults] = useState<Array<{ symbol: string; baseAsset: string }>>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (): void => {
    api
      .settings()
      .then((value) => {
        setSettings(value);
        setRisk(value.risk);
        setAuto(value.autoTrade);
        setGuard(value.guard);
      })
      .catch((failure: Error) => setError(failure.message));
    api.risk().then(setRiskState).catch(() => setRiskState(null));
  };

  useEffect(load, []);

  if (error && !settings) return <p className="text-sm text-bear">{error}</p>;
  if (!settings || !risk || !auto || !guard) {
    return <p className="text-sm text-terminal-muted">Carregando…</p>;
  }

  const run = async (action: () => Promise<unknown>, successMessage: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMessage(successMessage);
      onChanged();
      load();
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

  return (
    <div className="space-y-5 pb-6">
      {error ? <p className="rounded-lg border border-bear/40 bg-bear/10 p-3 text-sm text-bear">{error}</p> : null}
      {message ? <p className="rounded-lg border border-bull/40 bg-bull/10 p-3 text-sm text-bull">{message}</p> : null}

      <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
        <h2 className="text-sm font-semibold">Conta e modo de operação</h2>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {(['PAPER', 'TESTNET', 'LIVE'] as TradingMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={busy}
              onClick={() => void run(() => api.updateSettings({ mode }), `Modo ${mode} ativo`)}
              className={`rounded-xl border px-3 py-3 text-xs font-bold ${
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
            </button>
          ))}
        </div>
        <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
          <Info label="Ambiente ativo" value={settings.binance.activeEnvironment} />
          <Info
            label="Chaves de produção"
            value={settings.binance.production.credentialsConfigured ? 'configuradas' : 'ausentes'}
            tone={settings.binance.production.credentialsConfigured ? 'text-bull' : 'text-terminal-muted'}
          />
          <Info
            label="Chaves do testnet"
            value={settings.binance.testnet.credentialsConfigured ? 'configuradas' : 'ausentes'}
            tone={settings.binance.testnet.credentialsConfigured ? 'text-bull' : 'text-terminal-muted'}
          />
        </dl>
        <p className="mt-3 text-[11px] leading-relaxed text-terminal-muted">
          As chaves ficam apenas no arquivo <code>.env</code> do servidor — a interface nunca as recebe e
          elas nunca aparecem em log. Para o testnet, gere um par em{' '}
          <a className="text-info" href="https://testnet.binance.vision" target="_blank" rel="noreferrer">
            testnet.binance.vision
          </a>{' '}
          e preencha <code>BINANCE_TESTNET_API_KEY</code> e <code>BINANCE_TESTNET_API_SECRET</code>.
          Em conta real, habilite apenas spot e leitura, mantenha o saque desabilitado e use whitelist de IP.
        </p>
      </section>

      <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Compra automática</h2>
            <p className="mt-0.5 text-[11px] text-terminal-muted">
              Nas contas demo o robô opera livre. Na conta real ele precisa de duas chaves ao mesmo
              tempo: a liberação no servidor e o armamento aqui — que vence sozinho.
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
              {auto.liveArmedUntil && new Date(auto.liveArmedUntil).getTime() > Date.now() ? (
                <>
                  <span className="rounded border border-bull/50 bg-bull/10 px-2 py-1 text-[11px] font-semibold text-bull">
                    Armado até{' '}
                    {new Date(auto.liveArmedUntil).toLocaleTimeString('pt-BR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
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
                  {[30, 60, 240].map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Armar o robô na conta REAL por ${minutes} minutos?\n\nEle vai enviar ordens com dinheiro de verdade, respeitando o teto por ordem e o disjuntor.`,
                          )
                        ) {
                          return;
                        }
                        void run(() => api.armRobot(minutes), `Robô armado por ${minutes} min`);
                      }}
                      className="rounded-lg border border-bear/50 bg-bear/10 px-3 py-1 text-[11px] font-semibold text-bear"
                    >
                      {minutes} min
                    </button>
                  ))}
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
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {AUTO_FIELDS.map((field) => (
            <label key={field.key} className="block">
              <span className="text-xs text-terminal-muted">{field.label}</span>
              <input
                type="number"
                step={field.step}
                value={auto[field.key] as number}
                onChange={(event) =>
                  setAuto({ ...auto, [field.key]: Number(event.target.value) } as AutoTradeSettings)
                }
                className="mt-1 w-full rounded-lg border border-terminal-border bg-terminal-panel-soft px-3 py-2 text-sm tabular outline-none"
              />
              <span className="text-[10px] text-terminal-muted">{field.hint}</span>
            </label>
          ))}
          <label className="flex items-center gap-2 self-end pb-6 text-xs text-terminal-muted">
            <input
              type="checkbox"
              checked={auto.requireInsideEntryZone}
              onChange={(event) => setAuto({ ...auto, requireInsideEntryZone: event.target.checked })}
            />
            Só comprar dentro da zona de entrada
          </label>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => api.updateSettings({ autoTrade: auto }), 'Robô atualizado')}
          className="mt-4 rounded-lg bg-bull px-4 py-2 text-sm font-bold text-black disabled:opacity-40"
        >
          Salvar robô
        </button>
      </section>

      <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
        <h2 className="text-sm font-semibold">Cobertura do mercado</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {(
            [
              { id: 'WATCHLIST', label: 'Só a watchlist', hint: 'tempo real, poucos pares' },
              { id: 'ALL_USDT', label: 'Todo o spot USDT', hint: 'varredura completa por lotes' },
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
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
          <Info label="Pares do universo" value={String(settings.universe.total)} />
          <Info label="Com volume suficiente" value={String(settings.universe.liquid)} />
          <Info
            label="Última volta completa"
            value={settings.universe.lastCycleSeconds ? `${settings.universe.lastCycleSeconds}s` : '—'}
          />
        </div>
        <label className="mt-3 block max-w-xs">
          <span className="text-xs text-terminal-muted">Volume mínimo em 24h (USDT)</span>
          <input
            type="number"
            step={1_000_000}
            defaultValue={settings.scanner.minQuoteVolume24h}
            onBlur={(event) =>
              void run(
                () => api.updateSettings({ scanner: { minQuoteVolume24h: Number(event.target.value) } }),
                'Filtro de volume atualizado',
              )
            }
            className="mt-1 w-full rounded-lg border border-terminal-border bg-terminal-panel-soft px-3 py-2 text-sm tabular outline-none"
          />
        </label>
      </section>

      <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">
            Watchlist em tempo real ({settings.scanner.watchlist.length})
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

      <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Disjuntor de risco</h2>
            <p className="mt-0.5 text-[11px] text-terminal-muted">
              Quando parar, decidido antes de precisar. Estes limites valem para o robô e para a
              compra manual — e sobrevivem a reinício do servidor.
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
            <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-5">
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

            {riskState.halted ? (
              <div className="mt-3 rounded-lg border border-bear/50 bg-bear/10 p-3">
                <p className="text-xs font-semibold text-bear">
                  Disjuntor acionado — nenhuma compra nova sai daqui.
                </p>
                <ul className="mt-1 list-inside list-disc text-[11px] text-bear/90">
                  {riskState.haltReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.acknowledgeRisk(60), 'Disjuntor reconhecido por 60 min')
                  }
                  className="mt-2 rounded-lg border border-warn/50 bg-warn/10 px-3 py-1.5 text-[11px] font-semibold text-warn"
                >
                  Estou ciente — retomar por 60 min
                </button>
              </div>
            ) : null}

            {riskState.mutedReasons.length > 0 ? (
              <p className="mt-3 rounded-lg border border-warn/40 bg-warn/10 p-2 text-[11px] text-warn">
                Operando com o disjuntor reconhecido: {riskState.mutedReasons.join('; ')}.
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
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => api.updateSettings({ guard }), 'Disjuntor salvo')}
          className="mt-4 rounded-lg bg-bull px-4 py-2 text-sm font-bold text-black disabled:opacity-40"
        >
          Salvar disjuntor
        </button>
      </section>

      <section className="rounded-xl border border-terminal-border bg-terminal-panel p-5">
        <h2 className="text-sm font-semibold">Capital e controle de risco</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block">
            <span className="text-xs text-terminal-muted">Capital da carteira de teste</span>
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
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => api.updateSettings({ risk }), 'Controle de risco salvo')}
          className="mt-4 rounded-lg bg-bull px-4 py-2 text-sm font-bold text-black disabled:opacity-40"
        >
          Salvar risco
        </button>
      </section>
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
