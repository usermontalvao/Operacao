import { useState } from 'react';
import type { EntryDecision, MicroScalpDetail, TradeSetup } from '../lib/types.ts';
import {
  CLASSIFICATION_LABEL,
  MARKET_LABEL,
  SETUP_LABEL,
  SIDE_LABEL,
  SIDE_VERB,
  distanceToEntry,
  percent,
  price,
  scoreTone,
  sideButton,
  stateLabel,
  stateTone,
} from '../lib/format.ts';
import { PriceChart } from './PriceChart.tsx';
import { DecisionPanel } from './DecisionPanel.tsx';
import { useAtalhosDeModal } from '../lib/atalhos.ts';
import { Aviso, Botao, Etiqueta, Linha, Lista, Modal, ModalTitulo, Numero, Secao } from './Modal.tsx';

interface SetupSheetProps {
  setup: TradeSetup;
  livePrice: number | null;
  onClose: () => void;
  onBuy: (setup: TradeSetup) => void;
  onIgnore: (setup: TradeSetup) => void;
  /** já existe posição aberta neste ativo */
  inTrade: boolean;
  /** a decisão do robô, vinda do servidor */
  decision?: EntryDecision;
}

/**
 * Tela de decisão. A ordem da informação é proposital: em poucos segundos o
 * usuário vê ativo, preço, entrada, stop, alvos, R/R e score. No desktop o
 * gráfico ocupa a coluna maior; no celular ele vem depois dos números.
 */
export function SetupSheet({ setup, livePrice, onClose, onBuy, onIgnore, inTrade, decision }: SetupSheetProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const current = livePrice ?? setup.currentPrice;
  const distance = distanceToEntry(setup, current);
  const dead = setup.status === 'INVALIDATED' || setup.status === 'EXPIRED';
  const vendida = setup.side === 'SELL';

  // Esc fecha a ficha; Enter é o mesmo que clicar em comprar/vender — o botão
  // que a tela inteira existe para apresentar
  useAtalhosDeModal({
    onClose,
    onConfirm: () => onBuy(setup),
    confirmHabilitado: !dead && !inTrade,
  });

  const acao = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      {/* a dica de teclado só existe onde há teclado */}
      <p
        className={`min-w-0 text-[12px] leading-snug text-terminal-muted ${
          inTrade || dead ? '' : 'hidden sm:block'
        }`}
      >
        {inTrade
          ? `Você já tem posição aberta em ${setup.symbol.replace('USDT', '')} — acompanhe na aba Operações.`
          : dead
            ? 'Esta tese não vale mais: foi invalidada ou expirou.'
            : 'Enter confirma · Esc fecha'}
      </p>
      <div className="flex shrink-0 items-center justify-end gap-1.5">
        <Botao tipo="fantasma" onClick={() => onIgnore(setup)}>
          Ignorar
        </Botao>
        {/*
          O verbo e a cor saem do LADO. Um botão verde escrito COMPRAR numa
          tese vendida é o pior erro possível desta tela: o usuário confirma
          lendo o botão.
        */}
        <button
          type="button"
          onClick={() => onBuy(setup)}
          disabled={dead || inTrade}
          className={`rounded-xl px-6 py-2.5 text-[13px] font-bold transition max-sm:flex-1 disabled:cursor-not-allowed ${
            dead || inTrade ? 'bg-white/[0.06] text-terminal-muted' : sideButton(setup.side)
          }`}
        >
          {inTrade ? 'JÁ EM OPERAÇÃO' : `${SIDE_VERB[setup.side].toUpperCase()} SETUP`}
        </button>
      </div>
    </div>
  );

  return (
    <Modal
      onClose={onClose}
      largura="xl"
      rotulo={`Setup de ${setup.symbol}`}
      rodape={acao}
      cabecalho={
        <ModalTitulo
          onClose={onClose}
          titulo={
            <>
              {setup.symbol.replace('USDT', '')}
              <span className="font-normal text-terminal-muted">/USDT</span>
            </>
          }
          subtitulo={
            <>
              {SETUP_LABEL[setup.setupType]} · gatilho {setup.timeframe} · viés {setup.anchorTimeframe}
              {vendida ? ' · ganha quando o preço cai' : ''}
            </>
          }
          etiquetas={
            <>
              <Etiqueta tom={setup.side === 'SELL' ? 'bear' : 'bull'}>{SIDE_LABEL[setup.side]}</Etiqueta>
              <Etiqueta>{MARKET_LABEL[setup.market]}</Etiqueta>
              <a
                href={`https://www.tradingview.com/chart/?symbol=BINANCE:${setup.symbol}`}
                target="_blank"
                rel="noreferrer"
                className="hidden rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-terminal-muted transition hover:bg-white/[0.06] hover:text-terminal-text lg:inline-block"
              >
                TradingView ↗
              </a>
            </>
          }
        />
      }
    >
      {/*
        Duas colunas de leitura, não duas colunas de caixas.

        A ficha era uma grade de retângulos: cada número num quadro com borda
        e fundo próprios, sete deles empilhados. Agora o preço e o score são os
        dois números grandes que abrem a coluna, o plano vira uma lista com
        fios entre as linhas, e o resto do desenho some.
      */}
      <div className="grid gap-5 pb-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="order-2 space-y-5 lg:order-1">
          <PriceChart
            symbol={setup.symbol}
            timeframe={setup.timeframe}
            plan={setup}
            livePrice={livePrice}
            height={330}
          />

          {setup.micro ? <MicroScalpPanel micro={setup.micro} /> : null}

          <Secao titulo="Por que este setup existe">
            <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {setup.reasons.map((reason) => (
                <li key={reason} className="flex gap-2 text-[13px] leading-snug">
                  <span className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-bull/70" />
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          </Secao>

          <div>
            <button
              type="button"
              onClick={() => setShowBreakdown((value) => !value)}
              aria-expanded={showBreakdown}
              className="flex w-full items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-terminal-muted transition hover:text-terminal-text"
            >
              <span>Como o score foi montado</span>
              <span
                aria-hidden
                className={`text-[9px] transition-transform duration-150 ${showBreakdown ? 'rotate-90' : ''}`}
              >
                ▶
              </span>
            </button>
            {showBreakdown ? (
              <div className="mt-2 divide-y divide-white/[0.05] rounded-xl bg-white/[0.025] px-3">
                {setup.scoreBreakdown.components.map((component) => (
                  <ScoreRow
                    key={component.key}
                    label={component.label}
                    points={component.points}
                    detail={component.detail}
                    max={component.maxPoints}
                  />
                ))}
                {setup.scoreBreakdown.penalties.map((penalty) => (
                  <ScoreRow
                    key={penalty.key}
                    label={penalty.label}
                    points={penalty.points}
                    detail={penalty.detail}
                    max={0}
                  />
                ))}
                <div className="flex items-center justify-between py-2.5 text-[13px] font-semibold">
                  <span>Total</span>
                  <span className={scoreTone(setup.score)}>{setup.score}/100</span>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <aside className="order-1 space-y-4 lg:order-2 lg:border-l lg:border-white/[0.05] lg:pl-5">
          {/* os dois números que abrem a leitura: onde o preço está e quanto
              a tese vale. Sem moldura — o tamanho já diz a hierarquia */}
          <div className="flex items-start justify-between gap-4">
            <Numero
              rotulo="Preço agora"
              valor={<span className="text-[28px]">{price(current)}</span>}
              nota={distance === 0 ? 'dentro da zona de entrada' : `${percent(distance)} da zona`}
            />
            <div className="text-right">
              <div className={`tabular text-[34px] font-bold leading-none ${scoreTone(setup.score)}`}>
                {setup.score}
              </div>
              <div className="mt-1 text-[11px] text-terminal-muted">
                {CLASSIFICATION_LABEL[setup.classification]}
              </div>
              <span
                className={`mt-2 inline-block rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${stateTone(
                  setup.visualState,
                  setup.side,
                )}`}
              >
                {stateLabel(setup.visualState, setup.side)}
              </span>
            </div>
          </div>

          <Lista>
            <Linha
              rotulo="Entrada"
              valor={`${price(setup.entryLow)} – ${price(setup.entryHigh)}`}
              forte
            />
            <Linha
              rotulo={vendida ? 'Invalidação (acima)' : 'Invalidação'}
              valor={price(setup.stopLoss)}
              tom="text-bear"
            />
            <Linha rotulo="Alvo 1" valor={price(setup.target1)} tom="text-bull" />
            {setup.target2 ? (
              <Linha rotulo="Alvo 2" valor={price(setup.target2)} tom="text-bull" />
            ) : null}
            {setup.target3 ? (
              <Linha rotulo="Alvo 3" valor={price(setup.target3)} tom="text-bull" />
            ) : null}
            <Linha rotulo="Risco / retorno" valor={`1:${setup.riskReward.toFixed(1)}`} forte />
            <Linha rotulo="Contexto BTC" valor={setup.btcContext.replace('BTC_', '')} />
          </Lista>

          {setup.extended ? (
            <Aviso tom="warn" titulo="Esticado — aguardar pullback">
              <ul className="mt-1 space-y-0.5">
                {setup.extensionReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </Aviso>
          ) : null}

          {setup.invalidationNote ? <Aviso tom="bear" titulo={setup.invalidationNote} /> : null}

          <DecisionPanel
            decision={decision}
            entryLow={setup.entryLow}
            entryHigh={setup.entryHigh}
            currentPrice={current}
          />
        </aside>
      </div>
    </Modal>
  );
}

function ScoreRow({
  label,
  points,
  detail,
  max,
}: {
  label: string;
  points: number;
  detail: string;
  max: number;
}) {
  const positive = points >= 0;
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-[12px]">
      <div className="min-w-0">
        <div className="font-medium">{label}</div>
        <div className="text-terminal-muted">{detail}</div>
      </div>
      <div className={`shrink-0 tabular font-semibold ${positive ? 'text-bull' : 'text-bear'}`}>
        {positive ? '+' : ''}
        {points}
        {max > 0 ? <span className="text-terminal-muted/60">/{max}</span> : null}
      </div>
    </div>
  );
}

/**
 * O painel do micro scalp — a conta inteira, na cara.
 *
 * Nos outros setups o custo é ruído perto do alvo e pode ficar implícito. Aqui
 * ele é o termo dominante: uma tese cujo alvo bruto é 0,6% e cujo custo é
 * 0,25% entrega menos da metade do que aparenta. Mostrar só "alvo" e "R/R"
 * numa operação dessas seria mostrar o número que engana.
 */
function MicroScalpPanel({ micro }: { micro: MicroScalpDetail }) {
  const { regime, economics, scalpability } = micro;
  return (
    <Secao
      titulo="Micro scalp · 1m"
      acao={
        <span className="text-[11px] text-terminal-muted">
          {regime.verdict} · scalp {scalpability.score}/100 {scalpability.grade}
        </span>
      }
    >
      <dl className="grid grid-cols-2 gap-x-5 gap-y-2.5 sm:grid-cols-4">
        <MicroLinha label="Spread" valor={`${scalpability.liquidity.spreadPercent.toFixed(3)}%`} />
        <MicroLinha
          label="Escorregamento"
          valor={
            scalpability.liquidity.slippagePercent === null
              ? '—'
              : `${scalpability.liquidity.slippagePercent.toFixed(3)}%`
          }
        />
        <MicroLinha label="Amplitude" valor={`${regime.amplitudePercent.toFixed(3)}%`} />
        <MicroLinha label="ADX" valor={regime.adx === null ? '—' : regime.adx.toFixed(0)} />
        <MicroLinha label="Suporte" valor={regime.support.toPrecision(6)} />
        <MicroLinha label="Resistência" valor={regime.resistance.toPrecision(6)} />
        <MicroLinha
          label="Testes na faixa"
          valor={`${regime.supportTouches} / ${regime.resistanceTouches}`}
        />
        <MicroLinha label="Posição na faixa" valor={`${(regime.position * 100).toFixed(0)}%`} />
      </dl>

      {/*
        Sem o veto, esta é a única coisa entre a tese e o clique. Fica antes
        dos números, em vermelho, dizendo o que o filtro diria se estivesse
        barrando — porque a diferença entre "não bloquear" e "esconder o
        problema" é exatamente esta faixa.
      */}
      {economics.warning ? (
        <div className="mt-3">
          <Aviso tom="bear" titulo="Sem margem pelos seus limites">
            {economics.warning}
          </Aviso>
        </div>
      ) : null}

      <Lista className="mt-3">
        <Linha
          rotulo="Lucro bruto estimado"
          valor={`${economics.grossExpectedProfitPercent.toFixed(3)}%`}
        />
        <Linha
          rotulo="Custos"
          nota={`taxa ${economics.entryFeePercent}% × 2 + spread + escorregamento`}
          valor={`−${economics.allInCostPercent.toFixed(3)}%`}
          tom="text-bear"
        />
        <Linha
          rotulo="Lucro líquido estimado"
          forte
          valor={`${economics.netExpectedProfitPercent >= 0 ? '+' : ''}${economics.netExpectedProfitPercent.toFixed(3)}%`}
          tom={economics.netExpectedProfitPercent > 0 ? 'text-bull' : 'text-bear'}
        />
        <Linha rotulo="O alvo paga o custo" valor={`${economics.costMultiple.toFixed(1)}×`} />
        <Linha rotulo="Net R/R" valor={economics.netRiskReward.toFixed(2)} />
      </Lista>
    </Secao>
  );
}

function MicroLinha({ label, valor }: { label: string; valor: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-[0.08em] text-terminal-muted">
        {label}
      </dt>
      <dd className="mt-0.5 truncate tabular text-[13px]">{valor}</dd>
    </div>
  );
}
