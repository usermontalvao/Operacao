import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type PreviewResponse } from '../lib/api.ts';
import type { Trade, TradeSetup } from '../lib/types.ts';
import { percent, price, quantity, usd, usdWithBrl } from '../lib/format.ts';

interface BuyModalProps {
  setup: TradeSetup;
  onClose: () => void;
  onExecuted: (trade: Trade) => void;
}

const PERCENT_OPTIONS = [10, 25, 50];

/**
 * Duas etapas obrigatórias: dimensionar e confirmar. O token devolvido no
 * preview é o que autoriza a ordem — se qualquer número mudar, o servidor
 * recusa e o usuário refaz. Nada é enviado antes do CONFIRMAR COMPRA.
 */
export function BuyModal({ setup, onClose, onExecuted }: BuyModalProps) {
  const [step, setStep] = useState<'SIZE' | 'CONFIRM'>('SIZE');
  const [amount, setAmount] = useState<number | null>(null);
  const [percentChoice, setPercentChoice] = useState<number | null>(25);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID().replace(/-/g, '').slice(0, 24));

  const load = useCallback(
    async (body: { quoteAmount?: number; percentOfCapital?: number }) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.preview({ setupId: setup.id, ...body });
        setPreview(result);
        if (body.percentOfCapital !== undefined) setAmount(result.sizing.notional);
      } catch (failure) {
        setError((failure as Error).message);
        setPreview(null);
      } finally {
        setLoading(false);
      }
    },
    [setup.id],
  );

  useEffect(() => {
    void load({ percentOfCapital: 25 });
  }, [load]);

  const applyPercent = (value: number): void => {
    setPercentChoice(value);
    void load({ percentOfCapital: value });
  };

  const applyAmount = (value: number): void => {
    setPercentChoice(null);
    setAmount(value);
    if (value > 0) void load({ quoteAmount: value });
  };

  const confirm = async (): Promise<void> => {
    if (!preview?.confirmationToken || !preview.canExecute) return;
    setSending(true);
    setError(null);
    try {
      const trade = await api.execute({
        setupId: setup.id,
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
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">
            {step === 'SIZE' ? 'Comprar setup' : 'Confirmar operação'}
          </h2>
          <span className="rounded border border-terminal-border px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-terminal-muted">
            {preview?.mode ?? '—'}
          </span>
        </div>

        <div className="mt-1 text-sm text-terminal-muted">
          {setup.symbol.replace('USDT', '')}/USDT · entrada {price(preview?.entryPrice ?? setup.entryLow)} ·
          stop {price(setup.stopLoss)} · alvo {price(setup.target1)}
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
              </div>
            ) : null}
            </div>

            <Messages preview={preview} error={error} />

            <button
              type="button"
              disabled={!preview?.canExecute || loading}
              onClick={() => setStep('CONFIRM')}
              className="mt-5 w-full rounded-xl bg-bull px-4 py-4 text-base font-bold text-black disabled:opacity-40"
            >
              {loading ? 'Calculando…' : 'Revisar operação'}
            </button>
          </>
        ) : (
          <>
            <div className="mt-4 space-y-1.5 rounded-xl border border-warn/40 bg-warn/5 p-4 text-sm">
              <p className="text-xs uppercase tracking-wide text-warn">Confirmar operação</p>
              <p className="text-lg font-semibold">
                Comprar {quantity(preview?.sizing.quantity ?? 0)} {setup.symbol.replace('USDT', '')}
              </p>
              <Row label="Entrada limite" value={price(preview?.entryPrice ?? 0)} />
              <Row
                label="Valor aproximado"
                value={usdWithBrl(preview?.sizing.notional ?? 0, preview?.brlRate ?? null)}
              />
              <Row label="Stop" value={price(setup.stopLoss)} tone="text-bear" />
              <Row label="Alvo 1" value={price(setup.target1)} tone="text-bull" />
              {setup.target2 ? <Row label="Alvo 2" value={price(setup.target2)} tone="text-bull" /> : null}
              <Row label="Modo" value={preview?.mode ?? '—'} />
            </div>

            {preview?.mode === 'PAPER' ? (
              <p className="mt-2 text-xs text-terminal-muted">
                Operação simulada: nada é enviado à Binance. O acompanhamento usa o preço real.
              </p>
            ) : (
              <p className="mt-2 text-xs text-warn">
                Ordem real na Binance ({preview?.mode}): entrada limite com stop e alvo vinculados.
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
                className="rounded-xl bg-bull px-4 py-4 text-base font-bold text-black disabled:opacity-40"
              >
                {sending ? 'Enviando…' : 'CONFIRMAR COMPRA'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
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
