import { useCallback, useEffect, useRef, useState, useMemo, type ReactNode } from 'react';
import { api, type PreviewResponse } from '../lib/api.ts';
import { useAtalhosDeModal } from '../lib/atalhos.ts';
import type { Trade, TradeSetup } from '../lib/types.ts';
import { PriceChart, type EditableChartLevel } from './PriceChart.tsx';
import { Aviso, Botao, Etiqueta, Linha, Lista, Modal, ModalTitulo } from './Modal.tsx';
import {
  MARKET_LABEL,
  SETUP_LABEL,
  SIDE_LABEL,
  SIDE_VERB,
  percent,
  price,
  quantity,
  sideButton,
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
  /** os textos completos de bloqueio e aviso, abertos no clique do rodapé */
  const [detalhes, setDetalhes] = useState(false);
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

  /*
    Esc fecha; Enter avança de DIMENSIONAR para CONFIRMAR — e para por aí.

    O último passo continua exigindo clique. Enter é a tecla que o dedo aperta
    sozinho depois de digitar um valor, e "mandar a ordem de dinheiro real
    porque o dedo apertou Enter" é o acidente que nenhuma auditoria desfaz. O
    atalho serve para chegar mais rápido à revisão, nunca para pular a revisão.
  */
  useAtalhosDeModal({
    onClose,
    onConfirm: () => setStep('CONFIRM'),
    confirmHabilitado: step === 'SIZE' && preview?.canExecute === true && !loading,
  });

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

  const observacional = OBSERVACIONAL.has(setup.setupType);
  const ativo = setup.symbol.replace('USDT', '');

  const bloqueios = [...new Set([...(preview?.blockers ?? []), ...(preview?.filterErrors ?? [])])];
  const avisos = [...new Set(preview?.warnings ?? [])];

  /*
    Uma LINHA no rodapé, e não uma pilha de faixas.

    O que impede a ordem, o que apenas avisa e a saída de assumir o risco eram
    três blocos com moldura empilhados dentro da coluna da ordem: empurravam a
    conta para fora da janela e criavam a barra de rolagem que uma boleta não
    pode ter. Aqui o motivo fica numa linha ao lado do botão que não sai — que
    sempre foi o lugar dele — e o texto inteiro abre no clique.
  */
  const resumo = bloqueios.length > 0
    ? `${bloqueios[0]}${bloqueios.length > 1 ? ` · +${bloqueios.length - 1}` : ''}`
    : preview?.overridden
      ? `${preview.overridableBlockers.length} trava(s) desarmada(s) — a ordem fica registrada na auditoria`
      : preview
        ? `${usd(preview.sizing.notional)} · risco ${usd(preview.sizing.riskAmount)} no stop`
        : 'Montando a ordem…';

  const rodape =
    step === 'SIZE' ? (
      <div className="space-y-2.5">
        {detalhes && (bloqueios.length > 0 || avisos.length > 0) ? (
          <ul className="modal-rolagem max-h-28 space-y-1.5 overflow-y-auto rounded-xl bg-white/[0.03] px-3 py-2.5 text-[12px] leading-relaxed">
            {bloqueios.map((item) => (
              <li key={item} className="flex gap-2 text-bear">
                <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-bear" />
                <span className="min-w-0">{item}</span>
              </li>
            ))}
            {avisos.map((item) => (
              <li key={item} className="flex gap-2 text-terminal-muted">
                <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {error ? <Aviso tom="bear" titulo={error} /> : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => setDetalhes((atual) => !atual)}
            disabled={bloqueios.length === 0 && avisos.length === 0}
            className="flex min-w-0 items-center gap-2 text-left text-[12px] leading-snug text-terminal-muted transition enabled:hover:text-terminal-text disabled:cursor-default"
          >
            {bloqueios.length > 0 ? (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-bear" />
            ) : preview?.overridden ? (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
            ) : null}
            <span className={`truncate ${bloqueios.length > 0 ? 'text-bear' : ''}`}>{resumo}</span>
            {avisos.length > 0 ? (
              <span className="shrink-0 text-warn">
                · {avisos.length} {avisos.length === 1 ? 'aviso' : 'avisos'}
              </span>
            ) : null}
            {bloqueios.length > 0 || avisos.length > 0 ? (
              <span
                aria-hidden
                className={`shrink-0 text-[10px] text-terminal-muted transition-transform duration-150 ${
                  detalhes ? 'rotate-90' : ''
                }`}
              >
                ▶
              </span>
            ) : null}
          </button>

          <div className="flex shrink-0 items-center justify-end gap-1.5">
            {/*
              O caminho forçado é OUTRO botão, nunca o mesmo.

              Quem chega aqui está com a ordem recusada por uma régua que ele
              mesmo escolheu. Afrouxar a régua nos ajustes resolveria — e
              valeria para todas as ordens dali em diante, que é o preço errado
              a pagar por um teste. Este botão atropela a régua UMA vez e some
              quando o modal fecha.
            */}
            {preview?.canOverride ? (
              <Botao tipo="fantasma" onClick={alternarForcar} className="text-warn hover:text-warn">
                Assumir o risco
              </Botao>
            ) : null}
            {preview?.overridden && !manualComPoliticaEmAviso ? (
              <Botao tipo="fantasma" onClick={alternarForcar}>
                Voltar a respeitar
              </Botao>
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
              className={`rounded-xl px-6 py-2.5 text-[13px] font-bold transition max-sm:flex-1 disabled:cursor-not-allowed ${
                !preview?.canExecute || loading
                  ? 'bg-white/[0.06] text-terminal-muted'
                  : sideButton(side)
              }`}
            >
              {loading
                ? 'Calculando…'
                : preview && !preview.canExecute
                  ? 'Operação bloqueada'
                  : preview?.overridden
                    ? manualComPoliticaEmAviso
                      ? 'Revisar compra manual'
                      : 'Revisar operação FORÇADA'
                    : 'Revisar operação'}
            </button>
          </div>
        </div>
      </div>
    ) : (
      <div className="flex items-center justify-end gap-2">
        <Botao tipo="fantasma" onClick={() => setStep('SIZE')} disabled={sending}>
          Voltar
        </Botao>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={sending || !preview?.canExecute}
          className={`rounded-xl px-6 py-2.5 text-[13px] font-bold transition disabled:cursor-not-allowed disabled:opacity-35 ${
            preview?.overridden && !manualComPoliticaEmAviso ? 'bg-bear text-white' : sideButton(side)
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
    );

  return (
    <Modal
      onClose={onClose}
      /*
        A confirmação é OUTRA janela, e o tamanho diz isso.

        Dimensionar precisa do gráfico e da conta lado a lado, e ocupa a tela.
        Confirmar precisa de uma frase, seis números e dois botões — numa folha
        do tamanho da boleta, isso vira uma coluna estreita boiando em meio
        metro de vazio. Estreitar no último passo é o que faz a atenção cair
        onde ela tem de cair.
      */
      largura={step === 'SIZE' ? 'xl' : 'md'}
      /*
        A boleta NÃO rola.

        Barra de rolagem dentro da janela de uma ordem significa que parte da
        decisão está fora da vista no instante em que ela é tomada — e o que
        costuma sobrar embaixo é justamente o risco. Aqui o gráfico cede a
        altura que faltar e o resumo cabe inteiro ao lado dele.
      */
      rolar={step === 'SIZE' ? 'ate-xl' : true}
      altura={step === 'SIZE' ? 'cheia' : 'conteudo'}
      rotulo={step === 'SIZE' ? `${verbo} ${ativo}` : 'Confirmar operação'}
      rodape={rodape}
      cabecalho={
        <ModalTitulo
          onClose={onClose}
          titulo={
            step === 'SIZE' ? (
              <>
                {verbo} {ativo}
                <span className="font-normal text-terminal-muted">/USDT</span>
              </>
            ) : (
              'Confirmar operação'
            )
          }
          subtitulo={
            <>
              {SETUP_LABEL[setup.setupType]} · entrada {price(preview?.entryPrice ?? setup.entryLow)} ·
              stop {price(setup.stopLoss)} · alvo {price(setup.target1)}
              {preview && preview.leverage > 1 ? ` · ${preview.leverage}x` : ''}
            </>
          }
          etiquetas={
            <>
              <Etiqueta tom={side === 'SELL' ? 'bear' : 'bull'}>{SIDE_LABEL[side]}</Etiqueta>
              <Etiqueta>{MARKET_LABEL[preview?.market ?? setup.market]}</Etiqueta>
              <Etiqueta tom={preview?.mode === 'PAPER' ? 'info' : 'warn'}>
                {preview?.mode ?? '—'}
              </Etiqueta>
            </>
          }
        />
      }
    >
      {step === 'SIZE' ? (
        <div className="grid gap-5 pb-3 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1.1fr)_minmax(380px,0.9fr)]">
          {/* o gráfico ocupa o que sobrar da coluna: é ele que encolhe quando
              a janela é baixa, nunca a conta da ordem */}
          <section className="flex min-w-0 flex-col gap-2.5">
            {/* no celular o gráfico tem altura própria; do xl para cima ele
                é quem cede espaço para a conta da ordem caber sem rolagem */}
            <div className="min-h-[240px] xl:min-h-0 xl:flex-1">
              <PriceChart
                symbol={setup.symbol}
                timeframe={setup.timeframe}
                plan={{
                  entryLow: preview?.entryPrice ?? setup.entryLow,
                  entryHigh: preview?.entryPrice ?? setup.entryHigh,
                  ...draftPlan,
                }}
                livePrice={preview?.currentPrice ?? setup.currentPrice}
                preencher
                editableLevels={[
                  'stopLoss',
                  'target1',
                  ...(draftPlan.target2 !== null ? (['target2'] as const) : []),
                  ...(draftPlan.target3 !== null ? (['target3'] as const) : []),
                ]}
                onLevelChange={changePlan}
              />
            </div>
            <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
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
            <p className="shrink-0 text-[11px] text-terminal-muted">
              Arraste as linhas ou digite o preço — cada mudança refaz risco, R/R e liquidação.{' '}
              <button
                type="button"
                onClick={resetPlan}
                className="font-medium text-terminal-muted underline decoration-white/20 underline-offset-2 transition hover:text-terminal-text"
              >
                restaurar
              </button>
            </p>
          </section>

          {/* a coluna da ordem: capital, tamanho, alavancagem e a conta */}
          <div className="modal-rolagem flex min-w-0 flex-col gap-4 xl:overflow-y-auto xl:border-l xl:border-white/[0.05] xl:pl-5">
            {/*
              Qual ESTRATÉGIA é esta.

              É o dado que mais separa uma operação boa de uma ruim neste
              sistema — das quatro medidas, só uma manteve expectativa positiva
              no treino e no teste — e era o único que não estava na tela de
              decisão. Só aparece quando é o caso ruim: um distintivo verde em
              toda ordem boa não informa nada, e o nome da estratégia já está
              no subtítulo.
            */}
            {observacional ? (
              <Aviso tom="warn" titulo="Estratégia observacional">
                Expectativa NEGATIVA medida no treino e no teste do laboratório.
              </Aviso>
            ) : null}

            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-terminal-muted">
                Capital disponível
              </span>
              <span className="tabular text-[13px] font-medium">
                {preview ? usdWithBrl(preview.available, preview.brlRate) : '—'}
              </span>
            </div>

            <div>
              <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-terminal-muted">
                Quero investir
              </label>
              <Trilho>
                {PERCENT_OPTIONS.map((option) => {
                  // percentual que não alcança o mínimo da corretora produz uma
                  // ordem morta: some com o botão em vez de deixar o usuário
                  // montar a ordem inteira para descobrir no fim que ela não sai
                  const daria = ((preview?.available ?? 0) * option) / 100;
                  const insuficiente = minimoDaCorretora !== null && daria < minimoDaCorretora;
                  return (
                    <Segmento
                      key={option}
                      ativo={percentChoice === option}
                      disabled={insuficiente}
                      onClick={() => applyPercent(option)}
                      title={
                        insuficiente
                          ? `${option}% do capital dá US$ ${daria.toFixed(2)} — abaixo do mínimo de US$ ${minimoDaCorretora?.toFixed(2)} da Binance`
                          : undefined
                      }
                    >
                      {option}%
                    </Segmento>
                  );
                })}
                {/*
                  O atalho para o mínimo que a corretora aceita. Este não é um
                  valor "nosso": é a régua da Binance. Sem o botão, a única
                  saída de uma ordem pequena demais era o usuário adivinhar o
                  número no campo.
                */}
                {minimoDaCorretora !== null ? (
                  <Segmento
                    ativo={false}
                    disabled={(preview?.available ?? 0) < minimoDaCorretora}
                    onClick={() => applyAmount(minimoDaCorretora)}
                    title={`Mínimo por ordem na Binance: US$ ${minimoDaCorretora.toFixed(2)}`}
                  >
                    mín.
                  </Segmento>
                ) : null}
              </Trilho>
              {/*
                O campo do valor não é mais uma caixa igual às outras.

                Ele é a única coisa desta janela que se DIGITA, e estava com o
                mesmo fundo dos botões ao lado — parecia mais um da fileira.
                Agora tem superfície própria, a moeda vira um selo à esquerda e
                o foco acende um fio verde em volta: o painel diz onde o dedo
                está antes de o número mudar.
              */}
              <div className="mt-2 flex items-center gap-3 rounded-xl bg-white/[0.05] px-3 py-2.5 ring-1 ring-inset ring-white/[0.05] transition focus-within:bg-white/[0.07] focus-within:ring-bull/35">
                <span className="rounded-md bg-white/[0.06] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-terminal-muted">
                  USDT
                </span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  value={amount ?? ''}
                  onChange={(event) => applyAmount(Number(event.target.value))}
                  className="w-full bg-transparent text-right text-[21px] font-semibold tabular outline-none placeholder:text-terminal-muted/40"
                  placeholder="0,00"
                />
              </div>
            </div>

            {/*
              A alavancagem fica JUNTO do tamanho, e não nos ajustes, porque é
              a mesma decisão vista de dois lados: ela não muda o quanto se
              arrisca (isso continua saindo do stop), muda quanta margem a
              posição prende e onde a corretora liquida.
            */}
            {futuros && preview ? (
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-terminal-muted">
                  Alavancagem
                </label>
                <Trilho>
                  {alavancagensAte(preview.safeLeverage, leverage ?? preview.leverage).map((value) => {
                    const arriscada = preview.safeLeverage !== null && value > preview.safeLeverage;
                    return (
                      <Segmento
                        key={value}
                        ativo={(leverage ?? preview.leverage) === value}
                        tom={arriscada ? 'bear' : 'info'}
                        onClick={() => applyLeverage(value)}
                        title={
                          arriscada
                            ? `Com este stop, acima de ${preview.safeLeverage}x a liquidação chega antes dele`
                            : undefined
                        }
                      >
                        {value}x
                      </Segmento>
                    );
                  })}
                </Trilho>
                <p className="mt-2 text-[11px] leading-relaxed text-terminal-muted">
                  Não muda o risco — o prejuízo no stop continua sendo{' '}
                  <span className="text-bear">{usd(preview.sizing.riskAmount)}</span>. Muda a margem
                  presa e a linha de liquidação.
                  {preview.safeLeverage !== null ? ` Máximo seguro: ${preview.safeLeverage}x.` : ''}
                </p>
              </div>
            ) : null}

            {preview ? (
              <Lista>
                <Linha
                  rotulo="Quantidade"
                  valor={`${quantity(preview.sizing.quantity)} ${ativo}`}
                  forte
                />
                <Linha rotulo="Valor da posição" valor={usd(preview.sizing.notional)} forte />
                <Linha
                  rotulo="Risco no stop"
                  nota={`${price(setup.stopLoss)} · ${percent(preview.sizing.riskPercentOfCapital)} do capital`}
                  valor={usd(preview.sizing.riskAmount)}
                  tom="text-bear"
                  forte
                />
                <Linha
                  rotulo="Ganho no alvo 1"
                  nota={price(setup.target1)}
                  valor={usd(preview.sizing.potentialProfitTarget1)}
                  tom="text-bull"
                  forte
                />
                {/*
                  Dois R/R, e o que decide é o de baixo. O bruto é a razão entre
                  alvo e stop; o líquido desconta taxa e escorregamento nas duas
                  pontas — e é ele que o porteiro compara com o mínimo.
                */}
                <Linha
                  rotulo="R/R líquido"
                  nota={`bruto 1:${preview.sizing.riskReward.toFixed(1)} — o líquido é o que decide`}
                  valor={`1:${preview.netRiskReward.toFixed(2)}`}
                  forte
                  tom={
                    preview.blockers.some((item) => item.includes('R/R líquido'))
                      ? 'text-bear'
                      : undefined
                  }
                />
                {preview.leverage > 1 ? (
                  <Linha
                    rotulo="Margem presa"
                    nota={`${preview.leverage}x · liquida em ${
                      preview.liquidationPrice === null ? '—' : price(preview.liquidationPrice)
                    }`}
                    valor={usd(preview.margin)}
                  />
                ) : null}
              </Lista>
            ) : null}

          </div>
        </div>
      ) : (
        <div className="space-y-4 pb-3">
          <div className="text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-terminal-muted">
              {manualComPoliticaEmAviso
                ? 'Confirmar compra manual'
                : preview?.overridden
                  ? 'Confirmar ordem forçada'
                  : 'Confirmar operação'}
            </p>
            <p className="mt-2 text-[22px] font-semibold leading-tight">
              {verbo} {quantity(preview?.sizing.quantity ?? 0)} {ativo}
              {preview && preview.leverage > 1 ? ` com ${preview.leverage}x` : ''}
            </p>
            <p className="mt-1 text-[13px] text-terminal-muted">
              {usdWithBrl(preview?.sizing.notional ?? 0, preview?.brlRate ?? null)}
            </p>
          </div>

          {/* a segunda etapa repete o que está sendo ignorado: quem forçou há
              dois cliques precisa reler antes de mandar, e não lembrar */}
          {preview?.overridden ? (
            <Aviso
              tom={manualComPoliticaEmAviso ? 'warn' : 'bear'}
              titulo={manualComPoliticaEmAviso ? 'Regras internas em aviso' : 'Travas desarmadas'}
            >
              <ul className="mt-1 space-y-0.5">
                {preview.overridableBlockers.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Aviso>
          ) : null}

          <Lista>
            <Linha
              rotulo={preview?.mode === 'PAPER' ? 'Entrada imediata' : 'Entrada limite'}
              valor={price(preview?.entryPrice ?? 0)}
              forte
            />
            <Linha rotulo="Stop" valor={price(setup.stopLoss)} tom="text-bear" forte />
            <Linha rotulo="Alvo 1" valor={price(setup.target1)} tom="text-bull" forte />
            {setup.target2 ? (
              <Linha rotulo="Alvo 2" valor={price(setup.target2)} tom="text-bull" />
            ) : null}
            {preview && preview.leverage > 1 ? (
              <Linha
                rotulo="Margem presa"
                nota={`${preview.leverage}x · liquida em ${
                  preview.liquidationPrice === null ? '—' : price(preview.liquidationPrice)
                }`}
                valor={usd(preview.margin)}
              />
            ) : null}
            <Linha rotulo="Conta" valor={preview?.mode ?? '—'} />
          </Lista>

          <p className={`text-[12px] leading-relaxed ${preview?.mode === 'PAPER' ? 'text-terminal-muted' : 'text-warn'}`}>
            {preview?.mode === 'PAPER'
              ? 'Operação simulada com entrada imediata: nada é enviado à Binance. O acompanhamento usa o preço real.'
              : `Ordem real na Binance (${preview?.mode}): entrada limite com stop e alvo vinculados.${
                  preview && preview.leverage > 1
                    ? ' Em futuros a proteção vai como duas ordens de redução, enviadas logo após a entrada preencher.'
                    : ''
                }`}
          </p>

          <Messages preview={preview} error={error} />
        </div>
      )}
    </Modal>
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

/**
 * A fileira de escolha única — porcentagem do capital, alavancagem.
 *
 * Antes cada opção era uma caixa isolada com fundo próprio, e a escolhida
 * acendia inteira em verde. Duas fileiras assim, uma embaixo da outra, davam
 * oito retângulos verdes e cinzas competindo com o botão verde que executa a
 * ordem — e verde, nesta tela, tem um significado só: pode ir.
 *
 * Aqui a fileira é UM controle: um trilho rebaixado, e a opção escolhida sobe
 * dele como uma tecla apertada. A cor não pinta o fundo, fica no texto — e é
 * por isso que a alavancagem pode falar em azul (é outro eixo, não é risco) e
 * em vermelho (esta passa do máximo seguro) sem virar semáforo.
 */
function Trilho({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-1 rounded-xl bg-black/25 p-1 ring-1 ring-inset ring-white/[0.04]">
      {children}
    </div>
  );
}

function Segmento({
  children,
  ativo,
  onClick,
  disabled,
  title,
  tom = 'neutro',
}: {
  children: ReactNode;
  ativo: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  tom?: 'neutro' | 'info' | 'bear';
}) {
  const tinta = {
    neutro: 'text-terminal-text',
    info: 'text-info',
    bear: 'text-bear',
  } as const;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex-1 rounded-lg px-2 py-2 text-[13px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-25 ${
        ativo
          ? `bg-white/[0.09] shadow-[0_1px_2px_rgba(0,0,0,0.5)] ${tinta[tom]}`
          : `hover:bg-white/[0.05] ${tom === 'bear' ? 'text-bear/55' : 'text-terminal-muted'}`
      }`}
    >
      {children}
    </button>
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
    <label className="rounded-lg bg-white/[0.04] px-2.5 py-1.5 transition focus-within:bg-white/[0.08]">
      <span className={`block text-[10px] font-medium uppercase tracking-[0.08em] ${tone}`}>
        {label}
      </span>
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
        className="mt-0.5 w-full bg-transparent text-[13px] tabular text-terminal-text outline-none"
      />
    </label>
  );
}

/**
 * O que impede e o que apenas avisa — com pesos diferentes na tela.
 *
 * Antes as duas listas vinham abertas, uma linha por frase, cada frase com
 * trinta palavras. Numa conta comum davam nove parágrafos empilhados entre a
 * conta da ordem e o botão: o bloqueio que interessa perdido no meio de sete
 * avisos que não mudam nada, e o botão empurrado para fora da tela.
 *
 * Bloqueio continua aberto: ele é o motivo de a ordem não sair, e esconder
 * isso seria esconder a resposta. Aviso vira uma linha resumida que abre no
 * clique — presente, contável, e fora do caminho de quem já leu.
 */
function Messages({ preview, error }: { preview: PreviewResponse | null; error: string | null }) {
  const [abertos, setAbertos] = useState(false);
  const blockers = [...new Set([...(preview?.blockers ?? []), ...(preview?.filterErrors ?? [])])];
  // `preview.warnings` já é a lista consolidada pelo servidor e contém os
  // avisos do dimensionamento. Somar `sizing.warnings` novamente fazia a
  // mesma frase aparecer duas vezes no modal.
  const warnings = [...new Set(preview?.warnings ?? [])];
  if (!error && blockers.length === 0 && warnings.length === 0) return null;
  return (
    <div className="space-y-2">
      {error ? <Aviso tom="bear" titulo={error} /> : null}
      {blockers.length > 0 ? (
        <Aviso tom="bear" titulo={blockers.length === 1 ? 'A ordem está bloqueada' : `${blockers.length} bloqueios`}>
          <ul className="mt-1 space-y-0.5">
            {blockers.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Aviso>
      ) : null}
      {warnings.length > 0 ? (
        <div>
          <button
            type="button"
            onClick={() => setAbertos((atual) => !atual)}
            aria-expanded={abertos}
            className="flex w-full items-center gap-2 rounded-lg py-1 text-left text-[12px] font-medium text-warn transition hover:text-warn/80"
          >
            <span
              aria-hidden
              className={`text-[9px] transition-transform duration-150 ${abertos ? 'rotate-90' : ''}`}
            >
              ▶
            </span>
            <span>
              {warnings.length} {warnings.length === 1 ? 'aviso' : 'avisos'}
            </span>
            <span className="ml-auto text-[11px] font-normal text-terminal-muted">
              {abertos ? 'ocultar' : 'não bloqueiam a ordem'}
            </span>
          </button>
          {abertos ? (
            <ul className="mt-1 space-y-1 pl-4 text-[12px] leading-relaxed text-terminal-muted">
              {warnings.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
