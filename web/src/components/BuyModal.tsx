import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type PreviewResponse } from '../lib/api.ts';
import type { Trade, TradeSetup } from '../lib/types.ts';
import {
  MARKET_LABEL,
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
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID().replace(/-/g, '').slice(0, 24));

  /*
    A tese exibida é a que VOLTOU do preview, não a que foi clicada.

    O servidor peneira os alvos antes de responder — descarta o que passa do
    teto e o que caiu abaixo de zero, que só o lado vendido produz. Mostrar a
    tese do radar aqui faria a tela oferecer um alvo que a ordem não vai usar,
    e o usuário confirmaria uma operação diferente da que leu.
  */
  const setup = preview?.setup ?? clicado;

  const load = useCallback(
    async (body: { quoteAmount?: number; percentOfCapital?: number; leverage?: number }) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.preview({ setupId: clicado.id, ...body });
        setPreview(result);
        if (body.percentOfCapital !== undefined) setAmount(result.sizing.notional);
        // a primeira resposta traz a alavancagem dos ajustes; é dela que o
        // seletor parte, em vez de inventar um número que ninguém escolheu
        setLeverage((current) => current ?? result.leverage);
      } catch (failure) {
        setError((failure as Error).message);
        setPreview(null);
      } finally {
        setLoading(false);
      }
    },
    [clicado.id],
  );

  useEffect(() => {
    void load({ percentOfCapital: 25 });
  }, [load]);

  /** O tamanho pedido de agora, para reenviar junto quando a alavancagem muda. */
  const tamanhoAtual = (): { quoteAmount?: number; percentOfCapital?: number } =>
    percentChoice !== null ? { percentOfCapital: percentChoice } : { quoteAmount: amount ?? undefined };

  const applyPercent = (value: number): void => {
    setPercentChoice(value);
    void load({ percentOfCapital: value, leverage: leverage ?? undefined });
  };

  const applyAmount = (value: number): void => {
    setPercentChoice(null);
    setAmount(value);
    if (value > 0) void load({ quoteAmount: value, leverage: leverage ?? undefined });
  };

  const applyLeverage = (value: number): void => {
    setLeverage(value);
    void load({ ...tamanhoAtual(), leverage: value });
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
        className="max-h-[95vh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-terminal-border bg-terminal-panel p-5 sm:rounded-2xl sm:p-6"
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

        {step === 'SIZE' ? (
          <>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
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
                {PERCENT_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => applyPercent(option)}
                    className={`flex-1 rounded-lg border px-2 py-2 text-sm font-semibold ${
                      percentChoice === option
                        ? 'border-bull/60 bg-bull/10 text-bull'
                        : 'border-terminal-border text-terminal-muted'
                    }`}
                  >
                    {option}%
                  </button>
                ))}
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
                <Row label="Risco / retorno" value={`1:${preview.sizing.riskReward.toFixed(1)}`} />
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

            <button
              type="button"
              disabled={!preview?.canExecute || loading}
              onClick={() => setStep('CONFIRM')}
              className={`mt-5 w-full rounded-xl px-4 py-4 text-base font-bold disabled:opacity-40 ${sideButton(
                side,
              )}`}
            >
              {loading ? 'Calculando…' : 'Revisar operação'}
            </button>
          </>
        ) : (
          <>
            <div className="mt-4 space-y-1.5 rounded-xl border border-warn/40 bg-warn/5 p-4 text-sm">
              <p className="text-xs uppercase tracking-wide text-warn">Confirmar operação</p>
              <p className="text-lg font-semibold">
                {verbo} {quantity(preview?.sizing.quantity ?? 0)} {setup.symbol.replace('USDT', '')}
                {preview && preview.leverage > 1 ? ` com ${preview.leverage}x` : ''}
              </p>
              <Row label="Entrada limite" value={price(preview?.entryPrice ?? 0)} />
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
                Operação simulada: nada é enviado à Binance. O acompanhamento usa o preço real.
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
                className="rounded-xl border border-terminal-border px-4 py-4 text-sm text-terminal-muted"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={sending || !preview?.canExecute}
                className={`rounded-xl px-4 py-4 text-base font-bold disabled:opacity-40 ${sideButton(
                  side,
                )}`}
              >
                {sending ? 'Enviando…' : `CONFIRMAR ${SIDE_LABEL[side]}`}
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

function Messages({ preview, error }: { preview: PreviewResponse | null; error: string | null }) {
  const blockers = [...(preview?.blockers ?? []), ...(preview?.filterErrors ?? [])];
  const warnings = [...(preview?.warnings ?? []), ...(preview?.sizing.warnings ?? [])];
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
