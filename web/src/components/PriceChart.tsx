import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { api } from '../lib/api.ts';
import type { Candle, ChartInterval } from '../lib/types.ts';

/*
 * Os tempos que o gráfico oferece.
 *
 * Mais curtos que os do motor de propósito: o robô não decide em 1 minuto,
 * mas quem clica em comprar decide — e decidir sem ver o minuto é escolher o
 * momento no escuro. "2m" não está aqui porque não existe na Binance: os
 * intervalos dela pulam de 1m para 3m.
 */
const TIMEFRAMES: ChartInterval[] = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'];
/**
 * Quantos candles a tela mostra ao abrir.
 *
 * Antes o gráfico abria com os 300 candles carregados espremidos na largura, e
 * o usuário precisava dar seis zooms para conseguir ler o preço. Abrir já
 * aproximado é o padrão certo: quem quiser o histórico inteiro afasta uma vez.
 */
const VISIBLE_BARS = 90;

/**
 * As linhas do plano operacional desenhadas sobre o preço. Todas opcionais: o
 * gráfico aberto a partir de um ativo qualquer não tem plano nenhum, e nem por
 * isso deixa de ser gráfico.
 */
export interface ChartPlan {
  stopLoss?: number | null;
  entryLow?: number | null;
  entryHigh?: number | null;
  target1?: number | null;
  target2?: number | null;
  target3?: number | null;
}

export type EditableChartLevel = 'stopLoss' | 'target1' | 'target2' | 'target3';

/** Um acontecimento da operação desenhado sobre o candle em que aconteceu. */
export interface ChartMarker {
  /** milissegundos */
  time: number;
  kind: 'ENTRY' | 'EXIT';
  label: string;
}

interface PriceChartProps {
  symbol: string;
  /** timeframe em que o gráfico abre; o usuário troca nos botões */
  timeframe?: ChartInterval;
  plan?: ChartPlan | null;
  markers?: ChartMarker[] | null;
  /** momento que a tela deve enquadrar ao abrir (ex.: a hora do encerramento) */
  focusTime?: number | null;
  livePrice: number | null;
  height?: number;
  /** níveis que respondem ao gesto de arrastar; entrada nunca é editável */
  editableLevels?: EditableChartLevel[];
  /** `committed` só fica true quando o dedo/mouse é solto */
  onLevelChange?: (level: EditableChartLevel, price: number, committed: boolean) => void;
}

/** Casas decimais suficientes para o par, lidas dos próprios candles. */
function decimalsFor(candles: Candle[]): number {
  let decimals = 2;
  for (const candle of candles.slice(-60)) {
    const text = String(candle.close);
    const fraction = text.includes('e') ? '' : (text.split('.')[1] ?? '');
    decimals = Math.max(decimals, Math.min(fraction.length, 8));
  }
  return decimals;
}

/**
 * Gráfico de verdade: candles, volume, escala de preço e de tempo, crosshair,
 * zoom e as linhas do plano operacional (zona de entrada, stop e alvos)
 * desenhadas sobre o preço. Os dados vêm do próprio servidor.
 *
 * Três regras de comportamento, todas aprendidas apanhando:
 *  1. o enquadramento é do usuário. Só o carregamento de candles novos
 *     (símbolo ou timeframe) reposiciona a tela; preço vivo e mudança de plano
 *     nunca — era isso que tirava o gráfico do zoom sozinho a cada segundo;
 *  2. as linhas do plano dependem dos NÚMEROS, não do objeto que os carrega.
 *     O setup chega novo a cada atualização do servidor, e comparar por
 *     identidade fazia o gráfico recarregar sem parar;
 *  3. abre aproximado, não com o histórico inteiro espremido.
 */
export function PriceChart({
  symbol,
  timeframe: initialTimeframe = '1h',
  plan = null,
  markers = null,
  focusTime = null,
  livePrice,
  height = 340,
  editableLevels = [],
  onLevelChange,
}: PriceChartProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markerPlugin = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lastCandle = useRef<Candle | null>(null);
  const loadedCandles = useRef<Candle[]>([]);
  /** as linhas do plano são recriadas a cada carga — sem isto elas se acumulam */
  const priceLines = useRef<IPriceLine[]>([]);
  const dragging = useRef<EditableChartLevel | null>(null);
  const [draggingLevel, setDraggingLevel] = useState<EditableChartLevel | null>(null);

  const [timeframe, setTimeframe] = useState<ChartInterval>(initialTimeframe);
  /** o gráfico ocupando a tela inteira, para ler o candle de perto */
  const [ampliado, setAmpliado] = useState(false);
  /*
   * Ampliar recria o gráfico — e recriar custa o zoom que a pessoa tinha
   * dado. É aceitável aqui porque ampliar JÁ é um gesto de "quero outra
   * vista"; seria inaceitável se acontecesse sozinho, e é por isso que a
   * altura só muda quando alguém clica.
   */
  const alturaEfetiva = ampliado
    ? Math.max(420, (typeof window === 'undefined' ? 900 : window.innerHeight) - 150)
    : height;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** muda a cada carga de candles: é o gatilho para redesenhar o que é sobreposto */
  const [dataVersion, setDataVersion] = useState(0);

  // a identidade do objeto muda a cada atualização vinda do servidor; o que
  // importa são os preços, e é por eles que este gráfico se compara
  const levelsKey = [
    plan?.stopLoss,
    plan?.entryLow,
    plan?.entryHigh,
    plan?.target1,
    plan?.target2,
    plan?.target3,
  ].join('|');
  const markersKey = (markers ?? []).map((item) => `${item.kind}@${item.time}`).join('|');

  const levels = useMemo(
    () => [
      { key: 'target3' as const, price: plan?.target3 ?? null, color: '#16c784', title: 'Alvo 3', dashed: true, label: false },
      { key: 'target2' as const, price: plan?.target2 ?? null, color: '#16c784', title: 'Alvo 2', dashed: true, label: false },
      { key: 'target1' as const, price: plan?.target1 ?? null, color: '#16c784', title: 'Alvo 1', dashed: false, label: true },
      { key: null, price: plan?.entryHigh ?? null, color: '#4b8ef7', title: 'Entrada', dashed: true, label: false },
      { key: null, price: plan?.entryLow ?? null, color: '#4b8ef7', title: 'Entrada', dashed: true, label: false },
      { key: 'stopLoss' as const, price: plan?.stopLoss ?? null, color: '#ea3943', title: 'Stop', dashed: false, label: true },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [levelsKey],
  );
  const editable = useMemo(() => new Set(editableLevels), [editableLevels.join('|')]);

  const priceAt = (event: ReactPointerEvent<HTMLDivElement>): number | null => {
    const series = candleSeries.current;
    if (!series) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const value = series.coordinateToPrice(event.clientY - rect.top);
    if (value === null || !Number.isFinite(value) || value <= 0) return null;
    const decimals = decimalsFor(loadedCandles.current);
    return Number(value.toFixed(decimals));
  };

  const startLevelDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!onLevelChange || editable.size === 0 || !candleSeries.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - rect.top;
    let nearest: { key: EditableChartLevel; distance: number } | null = null;
    for (const level of levels) {
      if (level.key === null || !editable.has(level.key) || level.price === null) continue;
      const coordinate = candleSeries.current.priceToCoordinate(level.price);
      if (coordinate === null) continue;
      const distance = Math.abs(coordinate - y);
      if (!nearest || distance < nearest.distance) nearest = { key: level.key, distance };
    }
    // Uma faixa estreita evita capturar o gesto normal de mover o gráfico.
    if (!nearest || nearest.distance > 14) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = nearest.key;
    setDraggingLevel(nearest.key);
    chartRef.current?.applyOptions({ handleScroll: false, handleScale: false });
  };

  const moveLevel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const level = dragging.current;
    if (!level || !onLevelChange) return;
    event.preventDefault();
    event.stopPropagation();
    const value = priceAt(event);
    if (value !== null) onLevelChange(level, value, false);
  };

  const finishLevelDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const level = dragging.current;
    if (!level || !onLevelChange) return;
    event.preventDefault();
    event.stopPropagation();
    const value = priceAt(event);
    dragging.current = null;
    setDraggingLevel(null);
    chartRef.current?.applyOptions({ handleScroll: true, handleScale: true });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (value !== null) onLevelChange(level, value, true);
  };

  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      height: alturaEfetiva,
      layout: {
        background: { color: 'transparent' },
        textColor: '#8b909a',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(35,38,46,0.6)' },
        horzLines: { color: 'rgba(35,38,46,0.6)' },
      },
      rightPriceScale: { borderColor: '#23262e', scaleMargins: { top: 0.1, bottom: 0.28 } },
      timeScale: { borderColor: '#23262e', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      localization: { locale: 'pt-BR' },
    });
    chartRef.current = chart;

    candleSeries.current = chart.addSeries(CandlestickSeries, {
      upColor: '#16c784',
      downColor: '#ea3943',
      wickUpColor: '#16c784',
      wickDownColor: '#ea3943',
      borderVisible: false,
    });
    volumeSeries.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    markerPlugin.current = createSeriesMarkers(candleSeries.current, []);

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) chart.applyOptions({ width });
    });
    observer.observe(container.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeries.current = null;
      volumeSeries.current = null;
      markerPlugin.current = null;
      priceLines.current = [];
    };
  }, [alturaEfetiva]);

  // carga dos candles: só o par e o timeframe mandam recarregar
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    api
      .candles(symbol, timeframe)
      .then((result) => {
        if (!active || !candleSeries.current || !volumeSeries.current) return;
        const candles = result.candles;
        loadedCandles.current = candles;
        candleSeries.current.setData(
          candles.map((candle) => ({
            time: (candle.openTime / 1000) as UTCTimestamp,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
          })),
        );
        volumeSeries.current.setData(
          candles.map((candle) => ({
            time: (candle.openTime / 1000) as UTCTimestamp,
            value: candle.volume,
            color: candle.close >= candle.open ? 'rgba(22,199,132,0.35)' : 'rgba(234,57,67,0.35)',
          })),
        );
        lastCandle.current = candles[candles.length - 1] ?? null;

        // a escala segue a moeda: 0,0047 não pode virar "0.00"
        const decimals = decimalsFor(candles);
        candleSeries.current.applyOptions({
          priceFormat: { type: 'price', precision: decimals, minMove: 10 ** -decimals },
        });

        frame(chartRef.current, candles, focusTime);
        setDataVersion((version) => version + 1);
        setLoading(false);
      })
      .catch((failure: Error) => {
        if (!active) return;
        setError(failure.message);
        setLoading(false);
      });

    return () => {
      active = false;
    };
    // focusTime entra só como leitura do enquadramento inicial: mudá-lo não
    // deve recarregar candle nenhum
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe]);

  // linhas do plano: redesenhadas quando os preços mudam ou chegam candles novos
  useEffect(() => {
    const series = candleSeries.current;
    if (!series) return;
    for (const line of priceLines.current) series.removePriceLine(line);
    priceLines.current = [];
    for (const level of levels) {
      if (level.price === null || !Number.isFinite(level.price)) continue;
      priceLines.current.push(
        series.createPriceLine({
          price: level.price,
          color: level.color,
          lineWidth: 1,
          lineStyle: level.dashed ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: level.label,
          title: level.title,
        }),
      );
    }
  }, [levels, dataVersion]);

  // marcas de entrada e saída sobre o candle em que aconteceram
  useEffect(() => {
    const plugin = markerPlugin.current;
    if (!plugin) return;
    const candles = loadedCandles.current;
    const list = (markers ?? [])
      .map((marker) => {
        const candle = candleAt(candles, marker.time);
        if (!candle) return null;
        return {
          time: (candle.openTime / 1000) as UTCTimestamp,
          position: marker.kind === 'ENTRY' ? ('belowBar' as const) : ('aboveBar' as const),
          color: marker.kind === 'ENTRY' ? '#4b8ef7' : '#f0b90b',
          shape: marker.kind === 'ENTRY' ? ('arrowUp' as const) : ('arrowDown' as const),
          text: marker.label,
        };
      })
      .filter((item) => item !== null);
    plugin.setMarkers(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markersKey, dataVersion]);

  // o último candle acompanha o preço que chega pelo stream
  useEffect(() => {
    if (livePrice === null || !candleSeries.current || !lastCandle.current) return;
    const candle = lastCandle.current;
    const updated = {
      ...candle,
      close: livePrice,
      high: Math.max(candle.high, livePrice),
      low: Math.min(candle.low, livePrice),
    };
    lastCandle.current = updated;
    candleSeries.current.update({
      time: (updated.openTime / 1000) as UTCTimestamp,
      open: updated.open,
      high: updated.high,
      low: updated.low,
      close: updated.close,
    });
  }, [livePrice]);

  useEffect(() => {
    if (!ampliado) return;
    const aoTeclar = (event: KeyboardEvent): void => {
      // Esc é o gesto que todo mundo tenta primeiro; sem ele o gráfico
      // ampliado vira uma tela da qual não se sabe sair
      if (event.key === 'Escape') setAmpliado(false);
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [ampliado]);

  return (
    <div
      className={
        ampliado
          ? 'fixed inset-0 z-50 flex flex-col bg-terminal-bg/98 p-3 backdrop-blur'
          : 'rounded-xl border border-terminal-border bg-terminal-panel-soft p-2'
      }
    >
      <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
        <div className="flex min-w-0 gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TIMEFRAMES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setTimeframe(option)}
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold transition ${
                timeframe === option
                  ? 'bg-terminal-border text-terminal-text'
                  : 'text-terminal-muted hover:text-terminal-text'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-[10px] text-terminal-muted sm:inline">{symbol}</span>
          <button
            type="button"
            onClick={() => setAmpliado((atual) => !atual)}
            aria-label={ampliado ? 'Reduzir gráfico' : 'Ampliar gráfico'}
            title={ampliado ? 'Reduzir (Esc)' : 'Ampliar'}
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-terminal-muted transition hover:bg-terminal-border hover:text-terminal-text"
          >
            {ampliado ? '↙ reduzir' : '↗ ampliar'}
          </button>
        </div>
      </div>
      {error ? (
        <div className="flex items-center justify-center text-xs text-bear" style={{ height: alturaEfetiva }}>
          {error}
        </div>
      ) : null}
      {editable.size > 0 ? (
        <p className="mb-1 px-0.5 text-[10px] text-terminal-muted">
          {draggingLevel ? 'Solte para posicionar a linha' : 'Arraste o stop ou um alvo pela linha no gráfico'}
        </p>
      ) : null}
      <div
        className={`${loading ? 'opacity-40' : ''} ${draggingLevel ? 'cursor-ns-resize' : ''}`}
        ref={container}
        onPointerDownCapture={startLevelDrag}
        onPointerMoveCapture={moveLevel}
        onPointerUpCapture={finishLevelDrag}
        onPointerCancelCapture={finishLevelDrag}
        // O navegador decide o gesto de toque no pointerdown; trocar para
        // `none` depois que começou já é tarde. `pan-x` reserva o movimento
        // vertical para a linha e ainda deixa a página rolar lateralmente.
        style={editable.size > 0 ? { touchAction: 'pan-x' } : undefined}
      />
    </div>
  );
}

/** O candle que contém um instante — é sobre ele que a marca é desenhada. */
function candleAt(candles: Candle[], time: number): Candle | null {
  if (!Number.isFinite(time) || candles.length === 0) return null;
  let found: Candle | null = null;
  for (const candle of candles) {
    if (candle.openTime > time) break;
    found = candle;
  }
  return found;
}

/**
 * Enquadramento inicial: os últimos candles, ou a janela em volta do momento
 * pedido (o encerramento de uma operação antiga, por exemplo).
 */
function frame(chart: IChartApi | null, candles: Candle[], focusTime: number | null): void {
  if (!chart || candles.length === 0) return;
  const total = candles.length;
  const scale = chart.timeScale();

  if (focusTime !== null && Number.isFinite(focusTime)) {
    const index = candles.findIndex((candle) => candle.openTime > focusTime);
    const at = index === -1 ? total - 1 : Math.max(index - 1, 0);
    const half = Math.round(VISIBLE_BARS / 2);
    scale.setVisibleLogicalRange({
      from: Math.max(at - half, 0),
      to: Math.min(at + half, total + 5),
    });
    return;
  }

  scale.setVisibleLogicalRange({ from: Math.max(total - VISIBLE_BARS, 0), to: total + 3 });
}
