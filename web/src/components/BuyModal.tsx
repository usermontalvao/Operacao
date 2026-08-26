import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { api, type PreviewResponse } from '../lib/api.ts';
import type { Trade, TradeSetup } from '../lib/types.ts';
import { PriceChart, type EditableChartLevel } from './PriceChart.tsx';
import {
  MARKET_LABEL,
  SETUP_LABEL,
  SIDE_LABEL,
  SIDE_VERB,
  percent,
  price,
  quantity,
  sideButton,
  sideTone,
  usd,
  usdWithBrl,
} from '../lib/format.ts';

interface BuyModalProps {
  setup: TradeSetup;
  onClose: () => void;
  onExecuted: (trade: Trade) => void;
}

const PERCENT_OPTIONS = [10, 25, 50];

/**
 * As estratégias que o laboratório reprovou.
 *
 * Espelha `VALIDATED_AUTOMATIC_SETUP_TYPES` do servidor pelo avesso: tudo que
 * não é MOMENTUM_BURST mediu expectativa negativa em treino e teste. Elas
 * continuam no radar para pesquisa e para entrada manual consciente — mas
 * "consciente" exige que a tela diga, e até agora ela não dizia.
 */
const OBSERVACIONAL = new Set<TradeSetup['setupType']>([
  'PULLBACK',
  'BREAKOUT_RETEST',
  'SUPPORT_REVERSAL',
]);

/**
 * Duas etapas obrigatórias: dimensionar e confirmar. O token devolvido no
 * preview é o que autoriza a ordem — se qualquer número mudar, o servidor
 * recusa e o usuário refaz. Nada é enviado antes do botão final.
 *
 * O lado atravessa a tela inteira: verbo, cor e a frase da confirmação saem
 * dele. Em futuros entram três números que em spot não existem — alavancagem,
 * margem prendida e o preço em que a corretora liquida a posição. O último é
 * o mais importante da tela: é a saída que não é sua.
 */
export function BuyModal({ setup: clicado, onClose, onExecuted }: BuyModalProps) {
  const side = clicado.side;
  const verbo = SIDE_VERB[side];
  const futuros = clicado.market === 'FUTURES';
  const [step, setStep] = useState<'SIZE' | 'CONFIRM'>('SIZE');
  const [amount, setAmount] = useState<number | null>(null);
  const [percentChoice, setPercentChoice] = useState<number | null>(25);
  /*
    Alavancagem desta ordem.

    Null = a dos ajustes, que é o padrão e o que a maioria das ordens usa.
    Existe seletor porque alavancagem é decisão de OPERAÇÃO: o stop de uma
    tese aceita 5x com folga e o da seguinte liquida antes do stop em 3x. Todo
    ajuste refaz o preview — margem e preço de liquidação mudam junto, e o
    token da confirmação carrega a alavancagem aprovada.
  */
  const [leverage, setLeverage] = useState<number | null>(null);
  const [draftPlan, setDraftPlan] = useState(() => ({
    stopLoss: clicado.stopLoss,
    target1: clicado.target1,
    target2: clicado.target2,
    target3: clicado.target3,
  }));
  const draftPlanRef = useRef(draftPlan);
  /*
    Ordem forçada.

    Estado da SESSÃO do modal, nunca configuração: fecha a janela, some. As
    travas de política que ela desarma valem para todas as outras ordens no
    segundo seguinte — é essa a diferença entre atropelar uma régua e afrouxá-la.
  */
  const [forcar, setForcar] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  /**
   * O menor valor que a Binance aceita neste par, com uma folga de 2%.
   *
   * A folga não é superstição: a quantidade é arredondada PARA BAIXO no passo
   * de lote, então pedir exatamente o mínimo costuma cair um centavo abaixo
   * dele e a ordem volta recusada.
   */
  const minimoDaCorretora = useMemo(() => {
    const minimo = preview?.filters?.minNotional ?? 0;
    return minimo > 0 ? Math.ceil(minimo * 1.02 * 100) / 100 : null;
  }, [preview]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID().replace(/-/g, '').slice(0, 24));
  // Digitar 5, depois 10, dispara duas prévias. Se a resposta de 5 chegar por
  // último, ela não pode voltar a tela para um valor que o usuário já mudou.
  const latestPreviewRequest = useRef(0);

  /*
    A tese exibida é a que VOLTOU do preview, não a que foi clicada.

    O servidor peneira os alvos antes de responder — descarta o que passa do
    teto e o que caiu abaixo de zero, que só o lado vendido produz. Mostrar a
    tese do radar aqui faria a tela oferecer um alvo que a ordem não vai usar,
    e o usuário confirmaria uma operação diferente da que leu.
  */
  const setup: TradeSetup = { ...(preview?.setup ?? clicado), ...draftPlan };
  const manualComPoliticaEmAviso = !futuros && preview?.overridden === true;

  const load = useCallback(
    async (body: {
      quoteAmount?: number;
      percentOfCapital?: number;
      leverage?: number;
      override?: boolean;
      stopLoss: number;
      target1: number;
      target2: number | null;
      target3: number | null;
    }) => {
      const requestId = ++latestPreviewRequest.current;
      setLoading(true);
      setError(null);
      try {
        const result = await api.preview({ setupId: clicado.id, ...body });
        if (requestId !== latestPreviewRequest.current) return;
        setPreview(result);
        const approved = {
          stopLoss: result.setup.stopLoss,
          target1: result.setup.target1,
          target2: result.setup.target2,
          target3: result.setup.target3,
        };
        draftPlanRef.current = approved;
        setDraftPlan(approved);
        if (body.percentOfCapital !== undefined) setAmount(result.sizing.notional);
        // a primeira resposta traz a alavancagem dos ajustes; é dela que o
        // seletor parte, em vez de inventar um número que ninguém escolheu
        setLeverage((current) => current ?? result.leverage);
      } catch (failure) {
        if (requestId !== latestPreviewRequest.current) return;
        setError((failure as Error).message);
        setPreview(null);
      } finally {
        if (requestId === latestPreviewRequest.current) setLoading(false);
      }
    },
    [clicado.id],
  );

  useEffect(() => {
    void load({
      percentOfCapital: 25,
      stopLoss: clicado.stopLoss,
      target1: clicado.target1,
      target2: clicado.target2,
      target3: clicado.target3,
    });
  }, [load]);

  /** O tamanho pedido de agora, para reenviar junto quando a alavancagem muda. */
  const tamanhoAtual = (): { quoteAmount?: number; percentOfCapital?: number } =>
    percentChoice !== null ? { percentOfCapital: percentChoice } : { quoteAmount: amount ?? undefined };

  const corpoAtual = (plan = draftPlanRef.current) => ({
    ...tamanhoAtual(),
    leverage: leverage ?? undefined,
    override: forcar,
    ...plan,
  });

  const applyPercent = (value: number): void => {
    setPercentChoice(value);
    void load({ ...corpoAtual(), quoteAmount: undefined, percentOfCapital: value });
  };

  const applyAmount = (value: number): void => {
    setPercentChoice(null);
    setAmount(value);
    if (value > 0) void load({ ...corpoAtual(), percentOfCapital: undefined, quoteAmount: value });
  };

  const applyLeverage = (value: number): void => {
    setLeverage(value);
    void load({ ...corpoAtual(), leverage: value });
  };

  /** Refaz a conta com as travas de política desarmadas — e volta atrás igual. */
  const alternarForcar = (): void => {
    const proximo = !forcar;
    setForcar(proximo);
    void load({ ...corpoAtual(), override: proximo });
  };

  const changePlan = (level: EditableChartLevel, value: number, committed: boolean): void => {
    const next = { ...draftPlanRef.current, [level]: value };
    draftPlanRef.current = next;
    setDraftPlan(next);
    if (committed) void load(corpoAtual(next));
  };

  const commitPlanInput = (): void => {
    void load(corpoAtual());
  };

  const resetPlan = (): void => {
    const original = {
      stopLoss: clicado.stopLoss,
      target1: clicado.target1,
      target2: clicado.target2,
      target3: clicado.target3,
    };
    draftPlanRef.current = original;
    setDraftPlan(original);
    void load(corpoAtual(original));
  };

  const confirm = async (): Promise<void> => {
    if (!preview?.confirmationToken || !preview.canExecute) return;
    setSending(true);
    setError(null);
    try {
      const trade = await api.execute({
        setupId: clicado.id,
        confirmationToken: preview.confirmationToken,
        idempotencyKey: idempotencyKey.current,
      });
      onExecuted(trade);
    } catch (failure) {
      setError((failure as Error).message);
      setStep('SIZE');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 sm:items-center" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto overscroll-contain rounded-t-2xl border border-terminal-border bg-terminal-panel p-4 sm:rounded-2xl sm:p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            {step === 'SIZE' ? `${verbo} setup` : 'Confirmar operação'}
            <span className={`rounded border px-2 py-0.5 text-[10px] font-bold ${sideTone(side)}`}>
              {SIDE_LABEL[side]}
            </span>
          </h2>
          <span className="flex shrink-0 items-center gap-1">
            <span className="rounded border border-terminal-border px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-terminal-muted">
              {MARKET_LABEL[preview?.market ?? setup.market]}
            </span>
            <span className="rounded border border-terminal-border px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-terminal-muted">
              {preview?.mode ?? '—'}
            </span>
          </span>
        </div>

        <div className="mt-1 text-sm text-terminal-muted">
          {setup.symbol.replace('USDT', '')}/USDT · entrada {price(preview?.entryPrice ?? setup.entryLow)} ·
          stop {price(setup.stopLoss)} · alvo {price(setup.target1)}
          {preview && preview.leverage > 1 ? ` · ${preview.leverage}x` : ''}
        </div>

        {/*
          Qual ESTRATÉGIA é esta.

          É o dado que mais separa uma operação boa de uma ruim neste sistema —
          das quatro medidas, só uma manteve expectativa positiva no treino e
          no teste — e era o único que não estava na tela de decisão. O usuário
          via score, R/R e alvos, todos números de aparência técnica, sem saber
          que estava olhando uma família que o laboratório já reprovou.
        */}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span
            className={`rounded border px-2 py-0.5 font-semibold ${
              OBSERVACIONAL.has(setup.setupType)
                ? 'border-warn/40 bg-warn/10 text-warn'
                : 'border-bull/40 bg-bull/10 text-bull'
            }`}
          >
            {SETUP_LABEL[setup.setupType]}
          </span>
          <span className="text-terminal-muted">
            {OBSERVACIONAL.has(setup.setupType)
              ? 'estratégia observacional — expectativa NEGATIVA no treino e no teste do laboratório'
              : 'única estratégia com expectativa positiva medida no treino e no teste'}
          </span>
        </div>

        {step === 'SIZE' ? (
          <>
            <section className="mt-3 rounded-xl border border-terminal-border bg-terminal-panel-soft p-2.5">
              <div className="mb-2 flex items-center justify-between gap-3 px-0.5">
                <div>
                  <p className="text-xs font-semibold">Ajustar stop e alvos</p>
                  <p className="text-[10px] text-terminal-muted">
                    Arraste as linhas ou digite o preço. Cada mudança refaz risco, R/R e liquidação.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={resetPlan}
                  className="shrink-0 rounded border border-terminal-border px-2 py-1 text-[10px] text-terminal-muted"
                >
                  Restaurar
                </button>
              </div>
              <PriceChart
                symbol={setup.symbol}
                timeframe={setup.timeframe}
                plan={{
                  entryLow: preview?.entryPrice ?? setup.entryLow,
                  entryHigh: preview?.entryPrice ?? setup.entryHigh,
                  ...draftPlan,
                }}
                livePrice={preview?.currentPrice ?? setup.currentPrice}
                height={240}
                editableLevels={[
                  'stopLoss',
                  'target1',
                  ...(draftPlan.target2 !== null ? (['target2'] as const) : []),
                  ...(draftPlan.target3 !== null ? (['target3'] as const) : []),
                ]}
                onLevelChange={changePlan}
              />
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <PlanInput
                  label="Stop"
                  value={draftPlan.stopLoss}
                  tone="text-bear"
                  onChange={(value) => changePlan('stopLoss', value, false)}
                  onCommit={commitPlanInput}
                />
                <PlanInput
                  label="Alvo 1"
                  value={draftPlan.target1}
                  tone="text-bull"
                  onChange={(value) => changePlan('target1', value, false)}
                  onCommit={commitPlanInput}
                />
                {draftPlan.target2 !== null ? (
                  <PlanInput
                    label="Alvo 2"
                    value={draftPlan.target2}
                    tone="text-bull"
                    onChange={(value) => changePlan('target2', value, false)}
                    onCommit={commitPlanInput}
                  />
                ) : null}
                {draftPlan.target3 !== null ? (
                  <PlanInput
                    label="Alvo 3"
                    value={draftPlan.target3}
                    tone="text-bull"
                    onChange={(value) => changePlan('target3', value, false)}
                    onCommit={commitPlanInput}
                  />
                ) : null}
              </div>
            </section>
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
            <div>
            <div className="rounded-xl border border-terminal-border bg-terminal-panel-soft p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-terminal-muted">Capital disponível</span>
                <span className="tabular">
                  {preview ? usdWithBrl(preview.available, preview.brlRate) : '—'}
                </span>
              </div>
            </div>

            <div className="mt-4">
              <label className="text-xs uppercase tracking-wide text-terminal-muted">Quero investir</label>
              <div className="mt-1 flex gap-2">
                {PERCENT_OPTIONS.map((option) => {
                  // percentual que não alcança o mínimo da corretora produz uma
                  // ordem morta: some com o botão em vez de deixar o usuário
                  // montar a ordem inteira para descobrir no fim que ela não sai
                  const daria = ((preview?.available ?? 0) * option) / 100;
                  const insuficiente = minimoDaCorretora !== null && daria < minimoDaCorretora;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => applyPercent(option)}
                      disabled={insuficiente}
                      title={
                        insuficiente
                          ? `${option}% do capital dá US$ ${daria.toFixed(2)} — abaixo do mínimo de US$ ${minimoDaCorretora?.toFixed(2)} da Binance`
                          : undefined
                      }
                      className={`flex-1 rounded-lg border px-2 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-30 ${
                        percentChoice === option
                          ? 'border-bull/60 bg-bull/10 text-bull'
                          : 'border-terminal-border text-terminal-muted'
                      }`}
                    >
                      {option}%
                    </button>
                  );
                })}
                {/*
                  O atalho para o mínimo que a corretora aceita.
                  
                  Este não é um valor "nosso": é a régua da Binance. Sem o
                  botão, a única saída de uma ordem pequena demais era o
                  usuário adivinhar o número no campo — com "Operação
                  bloqueada" na tela e nenhuma pista de quanto faltava.
                */}
                {minimoDaCorretora !== null ? (
                  <button
                    type="button"
                    onClick={() => applyAmount(minimoDaCorretora)}
                    disabled={(preview?.available ?? 0) < minimoDaCorretora}
                    title={`Mínimo por ordem na Binance: US$ ${minimoDaCorretora.toFixed(2)}`}
                    className="flex-1 rounded-lg border border-terminal-border px-2 py-2 text-sm font-semibold text-terminal-muted disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    mín.
                  </button>
                ) : null}
              </div>
              <div className="mt-2 flex items-center gap-2 rounded-xl border border-terminal-border bg-terminal-panel-soft px-3 py-3">
                <span className="text-xs text-terminal-muted">USDT</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={amount ?? ''}
                  onChange={(event) => applyAmount(Number(event.target.value))}
                  className="w-full bg-transparent text-right text-lg font-semibold tabular outline-none"
                  placeholder="0,00"
                />
              </div>
            </div>

            {/*
              A alavancagem fica JUNTO do tamanho, e não nos ajustes, porque é
              a mesma decisão vista de dois lados: ela não muda o quanto se
              arrisca (isso continua saindo do stop), muda quanta margem a
              posição prende e onde a corretora liquida. Mexer nela sem ver os
              dois números ao lado é como o painel deixa de proteger.
            */}
            {futuros && preview ? (
              <div className="mt-4">
                <label className="text-xs uppercase tracking-wide text-terminal-muted">
                  Alavancagem
                </label>
                <div className="mt-1 flex flex-wrap gap-2">
                  {alavancagensAte(preview.safeLeverage, leverage ?? preview.leverage).map((value) => {
                    const arriscada = preview.safeLeverage !== null && value > preview.safeLeverage;
                    const ativa = (leverage ?? preview.leverage) === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => applyLeverage(value)}
                        title={
                          arriscada
                            ? `Com este stop, acima de ${preview.safeLeverage}x a liquidação chega antes dele`
                            : undefined
                        }
                        className={`min-w-11 flex-1 rounded-lg border px-2 py-2 text-sm font-semibold ${
                          ativa
                            ? arriscada
                              ? 'border-bear/60 bg-bear/10 text-bear'
                              : 'border-info/60 bg-info/10 text-info'
                            : arriscada
                              ? 'border-terminal-border text-bear/60'
                              : 'border-terminal-border text-terminal-muted'
                        }`}
                      >
                        {value}x
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-terminal-muted">
                  Não muda o risco — o prejuízo no stop continua sendo{' '}
                  <span className="text-bear">{usd(preview.sizing.riskAmount)}</span>. Muda a margem
                  presa e a linha de liquidação.
                  {preview.safeLeverage !== null
                    ? ` Com este stop, o máximo seguro é ${preview.safeLeverage}x.`
                    : ''}
                </p>
              </div>
            ) : null}

            </div>
            {preview ? (
              <div className="space-y-1.5 rounded-xl border border-terminal-border bg-terminal-panel-soft p-4 text-sm">
                <Row label="Quantidade" value={`${quantity(preview.sizing.quantity)} ${setup.symbol.replace('USDT', '')}`} />
                <Row label="Preço de entrada" value={price(preview.entryPrice)} />
                <Row label="Valor da posição" value={usd(preview.sizing.notional)} />
                <Row label="Stop" value={price(setup.stopLoss)} tone="text-bear" />
                <Row label="Risco" value={`${usd(preview.sizing.riskAmount)} (${percent(preview.sizing.riskPercentOfCapital)} do capital)`} tone="text-bear" />
                <Row label="Alvo 1" value={`${price(setup.target1)} · ${usd(preview.sizing.potentialProfitTarget1)}`} tone="text-bull" />
                {setup.target2 ? (
                  <Row label="Alvo 2" value={`${price(setup.target2)} · ${usd(preview.sizing.potentialProfitTarget2 ?? 0)}`} tone="text-bull" />
                ) : null}
                {setup.target3 ? (
                  <Row label="Alvo 3" value={`${price(setup.target3)} · ${usd(preview.sizing.potentialProfitTarget3 ?? 0)}`} tone="text-bull" />
                ) : null}
                {/*
                  Dois R/R, e o que decide é o de baixo.

                  O bruto é a razão entre alvo e stop neste preço. O líquido
                  desconta taxa e escorregamento nas duas pontas — e é ele que
                  o porteiro compara com o mínimo configurado. Mostrar só o
                  bruto era a tela dizer "1:2,7" e o painel recusar a ordem
                  falando de um número que não estava em lugar nenhum.
                */}
                <Row label="Risco / retorno" value={`1:${preview.sizing.riskReward.toFixed(1)}`} />
                <Row
                  label="R/R líquido — o que decide"
                  value={`1:${preview.netRiskReward.toFixed(2)}`}
                  tone={
                    preview.blockers.some((item) => item.includes('R/R líquido'))
                      ? 'text-bear'
                      : 'text-terminal-muted'
                  }
                />
                {preview.leverage > 1 ? (
                  <>
                    <div className="my-1 border-t border-terminal-border" />
                    <Row label="Alavancagem" value={`${preview.leverage}x`} />
                    {/* a margem não é o risco: é o saldo que fica preso. O
                        prejuízo continua sendo o do stop, e os dois números
                        juntos evitam a leitura de que "só posso perder isso" */}
                    <Row
                      label="Margem prendida"
                      value={usd(preview.margin)}
                      tone="text-terminal-muted"
                    />
                    <Row
                      label="Liquidação estimada"
                      value={preview.liquidationPrice === null ? '—' : price(preview.liquidationPrice)}
                      tone="text-bear"
                    />
                  </>
                ) : null}
              </div>
            ) : null}
            </div>

            <Messages preview={preview} error={error} />

            {/*
              O caminho forçado é OUTRO botão, nunca o mesmo.

              Quem chega aqui está com a ordem recusada por uma régua que ele
              mesmo escolheu. Afrouxar a régua nos ajustes resolveria — e valeria
              para todas as ordens dali em diante, que é o preço errado a pagar
              por um teste. Este botão atropela a régua UMA vez, lista o que está
              ignorando e some quando o modal fecha. A ordem forçada fica gravada
              na auditoria com nome próprio.

              Só aparece quando o que resta são travas de política. Mínimo da
              corretora, par parado, saldo que não existe e liquidação antes do
              stop não aparecem aqui porque nenhuma confirmação muda o mundo.
            */}
            {preview?.canOverride ? (
              <div className="mt-3 rounded-lg border border-warn/40 bg-warn/5 p-3">
                <p className="text-[11px] font-semibold text-warn">
                  Estas travas são suas, não da corretora
                </p>
                <ul className="mt-1 space-y-0.5 text-[10px] leading-relaxed text-terminal-muted">
                  {preview.overridableBlockers.map((item) => (
                    <li key={item}>• {item}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={alternarForcar}
                  className="mt-2 w-full rounded-lg border border-warn/50 px-3 py-2 text-[11px] font-bold text-warn transition hover:bg-warn/10"
                >
                  Assumir o risco e liberar esta ordem
                </button>
              </div>
            ) : null}

            {preview?.overridden ? (
              <div
                className={`mt-3 rounded-lg border p-3 ${
                  manualComPoliticaEmAviso
                    ? 'border-warn/40 bg-warn/5'
                    : 'border-bear/50 bg-bear/10'
                }`}
              >
                <p
                  className={`text-[11px] font-bold ${
                    manualComPoliticaEmAviso ? 'text-warn' : 'text-bear'
                  }`}
                >
                  {manualComPoliticaEmAviso
                    ? 'COMPRA MANUAL — REGRAS DE RISCO EM AVISO'
                    : 'ORDEM FORÇADA'}
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-terminal-muted">
                  {manualComPoliticaEmAviso
                    ? `As ${preview.overridableBlockers.length} regra(s) internas abaixo não bloqueiam sua decisão manual. Elas continuam visíveis e esta confirmação fica registrada. Saldo e regras da Binance continuam obrigatórios.`
                    : `Esta ordem vai sair com ${preview.overridableBlockers.length} trava(s) de risco desarmada(s), só desta vez, e fica registrada na auditoria. As regras da corretora continuam valendo.`}
                </p>
                {!manualComPoliticaEmAviso ? (
                  <button
                    type="button"
                    onClick={alternarForcar}
                    className="mt-2 w-full rounded-lg border border-terminal-border px-3 py-2 text-[11px] font-semibold text-terminal-muted"
                  >
                    Voltar a respeitar as travas
                  </button>
                ) : null}
              </div>
            ) : null}

            <button
              type="button"
              disabled={!preview?.canExecute || loading}
              onClick={() => setStep('CONFIRM')}
              title={
                preview && !preview.canExecute
                  ? [...preview.blockers, ...preview.filterErrors].join(' · ')
                  : undefined
              }
              className={`mt-3.5 w-full rounded-lg px-4 py-2.5 text-sm font-bold disabled:opacity-40 ${sideButton(
                side,
              )}`}
            >
              {loading
                ? 'Calculando…'
                : preview && !preview.canExecute
                  ? preview.blockers.some((item) => item.includes('R/R líquido'))
                    ? 'Bloqueada: R/R líquido abaixo do mínimo'
                    : 'Operação bloqueada'
                  : preview?.overridden
                    ? manualComPoliticaEmAviso
                      ? 'Revisar compra manual'
                      : 'Revisar operação FORÇADA'
                    : 'Revisar operação'}
            </button>
          </>
        ) : (
          <>
            <div
              className={`mt-4 space-y-1.5 rounded-xl border p-4 text-sm ${
                preview?.overridden && !manualComPoliticaEmAviso
                  ? 'border-bear/50 bg-bear/10'
                  : 'border-warn/40 bg-warn/5'
              }`}
            >
              <p
                className={`text-xs uppercase tracking-wide ${
                  preview?.overridden && !manualComPoliticaEmAviso
                    ? 'font-bold text-bear'
                    : 'text-warn'
                }`}
              >
                {manualComPoliticaEmAviso
                  ? 'Confirmar compra manual'
                  : preview?.overridden
                    ? 'Confirmar ordem FORÇADA'
                    : 'Confirmar operação'}
              </p>
              {/* a segunda etapa repete o que está sendo ignorado: quem forçou
                  há dois cliques precisa reler antes de mandar, e não lembrar */}
              {preview?.overridden ? (
                <ul className="space-y-0.5 text-[10px] leading-relaxed text-bear/90">
                  {preview.overridableBlockers.map((item) => (
                    <li key={item}>• ignorando: {item}</li>
                  ))}
                </ul>
              ) : null}
              <p className="text-lg font-semibold">
                {verbo} {quantity(preview?.sizing.quantity ?? 0)} {setup.symbol.replace('USDT', '')}
                {preview && preview.leverage > 1 ? ` com ${preview.leverage}x` : ''}
              </p>
              <Row
                label={preview?.mode === 'PAPER' ? 'Entrada imediata' : 'Entrada limite'}
                value={price(preview?.entryPrice ?? 0)}
              />
              <Row
                label="Valor aproximado"
                value={usdWithBrl(preview?.sizing.notional ?? 0, preview?.brlRate ?? null)}
              />
              <Row label="Stop" value={price(setup.stopLoss)} tone="text-bear" />
              <Row label="Alvo 1" value={price(setup.target1)} tone="text-bull" />
              {setup.target2 ? <Row label="Alvo 2" value={price(setup.target2)} tone="text-bull" /> : null}
              {preview && preview.leverage > 1 ? (
                <>
                  <Row label="Margem prendida" value={usd(preview.margin)} />
                  <Row
                    label="Liquidação estimada"
                    value={preview.liquidationPrice === null ? '—' : price(preview.liquidationPrice)}
                    tone="text-bear"
                  />
                </>
              ) : null}
              <Row label="Modo" value={preview?.mode ?? '—'} />
            </div>

            {preview?.mode === 'PAPER' ? (
              <p className="mt-2 text-xs text-terminal-muted">
                Operação simulada com entrada imediata: nada é enviado à Binance. O acompanhamento usa o preço real.
              </p>
            ) : (
              <p className="mt-2 text-xs text-warn">
                Ordem real na Binance ({preview?.mode}): entrada limite com stop e alvo vinculados.
                {preview && preview.leverage > 1
                  ? ' Em futuros a proteção vai como duas ordens de redução, enviadas logo após a entrada preencher.'
                  : ''}
              </p>
            )}

            <Messages preview={preview} error={error} />

            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setStep('SIZE')}
                disabled={sending}
                className="rounded-lg border border-terminal-border px-4 py-2.5 text-sm text-terminal-muted"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={sending || !preview?.canExecute}
                className={`rounded-lg px-4 py-2.5 text-sm font-bold disabled:opacity-40 ${
                  preview?.overridden && !manualComPoliticaEmAviso
                    ? 'bg-bear text-white'
                    : sideButton(side)
                }`}
              >
                {sending
                  ? 'Enviando…'
                  : preview?.overridden
                    ? manualComPoliticaEmAviso
                      ? `CONFIRMAR ${SIDE_LABEL[side]}`
                      : `FORÇAR ${SIDE_LABEL[side]}`
                    : `CONFIRMAR ${SIDE_LABEL[side]}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * As opções do seletor de alavancagem.
 *
 * A escada fixa 1·2·3·5·10 cobre o uso real sem virar um campo livre onde se
 * digita 50 por engano. O máximo seguro entra na lista mesmo fora da escada —
 * é o número que interessa quando o stop é apertado — e a alavancagem em uso
 * também, para o botão aceso nunca sumir da fileira.
 */
function alavancagensAte(safeLeverage: number | null, atual: number): number[] {
  const escada = [1, 2, 3, 5, 10];
  const extras = [atual, ...(safeLeverage !== null ? [safeLeverage] : [])];
  return [...new Set([...escada, ...extras])]
    .filter((value) => value >= 1 && value <= 10)
    .sort((a, b) => a - b);
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-terminal-muted">{label}</span>
      <span className={`tabular ${tone ?? ''}`}>{value}</span>
    </div>
  );
}

function PlanInput({
  label,
  value,
  tone,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  tone: string;
  onChange: (value: number) => void;
  onCommit: () => void;
}) {
  return (
    <label className="rounded-lg border border-terminal-border bg-terminal-panel px-2 py-1.5">
      <span className={`block text-[9px] uppercase tracking-wide ${tone}`}>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next) && next > 0) onChange(next);
        }}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
        className="mt-0.5 w-full bg-transparent text-xs tabular text-terminal-text outline-none"
      />
    </label>
  );
}

function Messages({ preview, error }: { preview: PreviewResponse | null; error: string | null }) {
  const blockers = [...new Set([...(preview?.blockers ?? []), ...(preview?.filterErrors ?? [])])];
  // `preview.warnings` já é a lista consolidada pelo servidor e contém os
  // avisos do dimensionamento. Somar `sizing.warnings` novamente fazia a
  // mesma frase aparecer duas vezes no modal.
  const warnings = [...new Set(preview?.warnings ?? [])];
  return (
    <>
      {error ? <p className="mt-3 rounded border border-bear/40 bg-bear/10 p-2 text-xs text-bear">{error}</p> : null}
      {blockers.length > 0 ? (
        <ul className="mt-3 space-y-1 rounded border border-bear/40 bg-bear/10 p-2 text-xs text-bear">
          {blockers.map((item) => (
            <li key={item}>• {item}</li>
          ))}
        </ul>
      ) : null}
      {warnings.length > 0 ? (
        <ul className="mt-2 space-y-1 rounded border border-warn/40 bg-warn/10 p-2 text-xs text-warn">
          {warnings.map((item) => (
            <li key={item}>• {item}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
