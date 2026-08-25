import { useEffect, useRef } from 'react';
import { AreaSeries, createChart, type IChartApi, type UTCTimestamp } from 'lightweight-charts';
import type { EquityPoint } from '../lib/types.ts';

/** Curva de patrimônio da carteira de teste, ponto a ponto por operação encerrada. */
export function EquityChart({ points, height = 220 }: { points: EquityPoint[]; height?: number }) {
  const container = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      height,
      layout: {
        background: { color: 'transparent' },
        textColor: '#8b909a',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(35,38,46,0.4)' },
        horzLines: { color: 'rgba(35,38,46,0.4)' },
      },
      rightPriceScale: { borderColor: '#23262e' },
      timeScale: { borderColor: '#23262e', timeVisible: false },
      localization: { locale: 'pt-BR' },
    });
    chartRef.current = chart;

    const series = chart.addSeries(AreaSeries, {
      lineColor: '#16c784',
      topColor: 'rgba(22,199,132,0.28)',
      bottomColor: 'rgba(22,199,132,0.02)',
      lineWidth: 2,
    });

    // um ponto por operação; datas repetidas quebram a série, então desduplicamos
    const seen = new Set<number>();
    const data = points
      .map((point) => ({
        time: Math.floor(new Date(point.time).getTime() / 1000) as UTCTimestamp,
        value: point.equity,
      }))
      .filter((point) => {
        if (seen.has(point.time)) return false;
        seen.add(point.time);
        return true;
      })
      .sort((a, b) => a.time - b.time);
    series.setData(data);
    chart.timeScale().fitContent();

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) chart.applyOptions({ width });
    });
    observer.observe(container.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [points, height]);

  return <div ref={container} />;
}
