import { useEffect, useState } from 'react';
import { price as formatPrice } from '../lib/format.ts';
import { api } from '../lib/api.ts';
import { useAtalhosDeModal } from '../lib/atalhos.ts';
import { Aviso, Botao, Modal, ModalTitulo } from './Modal.tsx';
import type { Side, Timeframe, TradingMode } from '../lib/types.ts';
import {
  PriceChart,
  type ChartMarker,
  type ChartPlan,
  type EditableChartLevel,
} from './PriceChart.tsx';

export interface ChartRequest {
  symbol: string;
  /** o que a tela de origem sabe do plano: stop, entrada e alvos */
  plan?: ChartPlan | null;
  timeframe?: Timeframe;
  /** de onde veio o clique — "posição aberta", "operação encerrada"… */
  note?: string | null;
  /** entrada e saída desenhadas sobre os candles em que aconteceram */
  markers?: ChartMarker[] | null;
  /** momento que a tela enquadra ao abrir: o encerramento, e não "agora" */
  focusTime?: number | null;
  /** presente somente para uma posição aberta cujo plano pode ser rearmado */
  tradeId?: string;
  side?: Side;
  /** conta da posição — decide o aviso do encerramento */
  mode?: TradingMode;
  /** avisado depois de encerrar, para a tela de origem se atualizar */
  onClosed?: () => void;
}

/**
 * O gráfico de qualquer ativo, aberto de qualquer lugar.
 *
 * A ficha do setup (SetupSheet) responde "compro ou não"; esta responde
 * apenas "como está o preço". Por isso ela não tem score, nem botão de
 * compra: quem clica no nome de uma moeda numa lista quer ver o gráfico, não
 * tomar uma decisão de entrada.
 */
export function ChartSheet({
  request,
  livePrice,
  onClose,
}: {
  request: ChartRequest;
  livePrice: number | null;
  onClose: () => void;
}) {
  const initialPlan = completePlan(request.plan);
  const [savedPlan, setSavedPlan] = useState(initialPlan);
  const [draftPlan, setDraftPlan] = useState(initialPlan);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /*
    Encerrar em dois passos, dentro da própria janela.

    Não é `window.confirm`: o alerta do navegador tira o gráfico da frente
    justamente quando ele é a informação que sustenta a decisão, e não cabe o
    aviso do que vai acontecer na corretora. Aqui o segundo clique acontece
    olhando para o preço.
  */
  const [confirmandoSaida, setConfirmandoSaida] = useState(false);
  const [encerrando, setEncerrando] = useState(false);
  const [encerrada, setEncerrada] = useState(false);
  const editable = request.tradeId !== undefined && draftPlan !== null;
  const dirty = savedPlan !== null && draftPlan !== null && !samePlan(savedPlan, draftPlan);
  const plan = draftPlan ?? request.plan ?? null;
  const asset = request.symbol.replace('USDT', '');

  useEffect(() => {
    const next = completePlan(request.plan);
    setSavedPlan(next);
    setDraftPlan(next);
    setError(null);
    setMessage(null);
    setConfirmandoSaida(false);
    setEncerrada(false);
  }, [request.symbol, request.tradeId, request.plan]);

  const moveLevel = (level: EditableChartLevel, value: number): void => {
    setDraftPlan((current) => (current ? { ...current, [level]: value } : current));
    setError(null);
    setMessage(null);
  };

  const applyPlan = async (): Promise<void> => {
    if (!request.tradeId || !draftPlan || !dirty) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const trade = await api.updateTradePlan(request.tradeId, {
        stopLoss: draftPlan.stopLoss,
        target1: draftPlan.target1,
        target2: draftPlan.target2,
        target3: draftPlan.target3,
      });
      const applied = completePlan({
        entryLow: trade.averageFillPrice ?? trade.entryPrice,
        entryHigh: trade.averageFillPrice ?? trade.entryPrice,
        stopLoss: trade.stopLoss,
        target1: trade.target1,
        target2: trade.target2,
        target3: trade.target3,
      });
      setSavedPlan(applied);
      setDraftPlan(applied);
      setMessage(
        trade.mode === 'PAPER'
          ? 'Plano atualizado na simulação.'
          : 'Plano atualizado e proteção rearmada na Binance.',
      );
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const encerrar = async (): Promise<void> => {
    if (!request.tradeId) return;
    setEncerrando(true);
    setError(null);
    setMessage(null);
    try {
      const trade = await api.closeTrade(request.tradeId);
      setEncerrada(true);
      setConfirmandoSaida(false);
      setMessage(
        `Posição encerrada — resultado ${trade.realizedPnl >= 0 ? '+' : ''}${trade.realizedPnl.toFixed(2)} USDT.`,
      );
      request.onClosed?.();
    } catch (failure) {
      setError((failure as Error).message);
      setConfirmandoSaida(false);
    } finally {
      setEncerrando(false);
    }
  };

  // Esc fecha; Enter aplica o plano ajustado. Encerrar posição NÃO entra no
  // Enter: é dinheiro saindo, e já tem os seus dois cliques.
  useAtalhosDeModal({
    onClose,
    onConfirm: () => void applyPlan(),
    confirmHabilitado: editable && dirty && !saving,
  });

  const avisoDeSaida =
    request.mode === 'PAPER'
      ? 'Na conta DEMO a saída é simulada pelo preço atual.'
      : 'As proteções serão canceladas e a quantidade restante vendida a mercado. O preço final pode variar.';

  const rodape = confirmandoSaida ? (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-[0.8125rem] font-semibold text-bear">Encerrar {asset} agora?</p>
        <p className="mt-0.5 text-[0.75rem] leading-snug text-terminal-muted">{avisoDeSaida}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Botao tipo="fantasma" disabled={encerrando} onClick={() => setConfirmandoSaida(false)}>
          Manter posição
        </Botao>
        <Botao
          tipo="quieto"
          disabled={encerrando}
          onClick={() => void encerrar()}
          className="bg-bear text-white hover:bg-bear/90"
        >
          {encerrando ? 'Encerrando…' : 'Confirmar encerramento'}
        </Botao>
      </div>
    </div>
  ) : (
    <div className="space-y-3">
      {error ? <Aviso tom="bear" titulo={error} /> : null}
      {message ? <Aviso tom="bull" titulo={message} /> : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* o plano em três números soltos, sem moldura: é legenda do gráfico,
            não um painel à parte */}
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 text-[0.75rem] tabular">
          {plan?.stopLoss ? (
            <span className="text-terminal-muted">
              stop <span className="text-bear">{formatPrice(plan.stopLoss)}</span>
            </span>
          ) : null}
          {plan?.entryLow ? (
            <span className="text-terminal-muted">
              entrada <span className="text-terminal-text">{formatPrice(plan.entryLow)}</span>
            </span>
          ) : null}
          {plan?.target1 ? (
            <span className="text-terminal-muted">
              alvo <span className="text-bull">{formatPrice(plan.target1)}</span>
            </span>
          ) : null}
          {dirty ? <span className="text-warn">plano alterado — falta aplicar</span> : null}
        </div>

        <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto">
          {request.tradeId !== undefined && !encerrada ? (
            <Botao tipo="perigo" onClick={() => setConfirmandoSaida(true)} className="mr-auto sm:mr-0">
              Encerrar<span className="hidden sm:inline"> posição</span>
            </Botao>
          ) : null}
          {editable ? (
            <>
              <Botao
                tipo="fantasma"
                disabled={!dirty || saving}
                onClick={() => {
                  setDraftPlan(savedPlan);
                  setError(null);
                }}
              >
                Desfazer
              </Botao>
              <Botao tipo="forte" disabled={!dirty || saving} onClick={() => void applyPlan()}>
                {saving ? (
                  'Rearmando…'
                ) : (
                  <>
                    Aplicar<span className="hidden sm:inline"> stop e alvos</span>
                  </>
                )}
              </Botao>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );

  return (
    <Modal
      onClose={onClose}
      largura="lg"
      rolar={false}
      altura="cheia"
      rotulo={`Gráfico de ${asset}`}
      cabecalho={
        <ModalTitulo
          onClose={onClose}
          titulo={
            <>
              {asset}
              <span className="font-normal text-terminal-muted">/USDT</span>
            </>
          }
          subtitulo={
            <>
              {livePrice === null ? 'sem preço agora' : formatPrice(livePrice)}
              {request.note ? ` · ${request.note}` : ''}
            </>
          }
          etiquetas={
            <a
              href={`https://www.tradingview.com/chart/?symbol=BINANCE:${request.symbol}`}
              target="_blank"
              rel="noreferrer"
              title="Abrir no TradingView"
              className="hidden rounded-lg px-2.5 py-1.5 text-[0.75rem] font-medium text-terminal-muted transition hover:bg-white/[0.06] hover:text-terminal-text sm:inline-block"
            >
              TradingView ↗
            </a>
          }
        />
      }
      rodape={rodape}
    >
      {/*
        O gráfico ocupa a altura inteira do miolo.

        Antes ele tinha altura fixa e tudo o mais vinha empilhado embaixo em
        faixas com moldura — aplicar, encerrar, o resumo do plano, o link do
        TradingView: quatro caixas para três ações. Agora a decisão está no
        rodapé, numa linha só, e o gráfico fica com o que sobra.
      */}
      <div className="flex min-h-[320px] flex-1 flex-col">
        <PriceChart
          symbol={request.symbol}
          timeframe={request.timeframe ?? '1h'}
          plan={plan}
          markers={request.markers ?? null}
          focusTime={request.focusTime ?? null}
          livePrice={livePrice}
          preencher
          moldura={false}
          editableLevels={editable ? ['stopLoss', 'target1', 'target2', 'target3'] : []}
          onLevelChange={editable ? (level, value) => moveLevel(level, value) : undefined}
        />
      </div>
    </Modal>
  );
}

interface CompletePlan extends ChartPlan {
  stopLoss: number;
  target1: number;
  target2: number | null;
  target3: number | null;
}

function completePlan(plan: ChartPlan | null | undefined): CompletePlan | null {
  if (!plan || !plan.stopLoss || !plan.target1) return null;
  return {
    ...plan,
    stopLoss: plan.stopLoss,
    target1: plan.target1,
    target2: plan.target2 ?? null,
    target3: plan.target3 ?? null,
  };
}

function samePlan(a: CompletePlan, b: CompletePlan): boolean {
  return (
    a.stopLoss === b.stopLoss &&
    a.target1 === b.target1 &&
    a.target2 === b.target2 &&
    a.target3 === b.target3
  );
}
