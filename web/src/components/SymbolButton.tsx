import { useChartViewer } from '../lib/chartViewer.tsx';
import type { ChartRequest } from './ChartSheet.tsx';

/**
 * O nome do ativo, clicável.
 *
 * Regra da casa: em qualquer lugar do sistema onde aparece o par da moeda,
 * clicar nele abre o gráfico. Esta peça existe para que essa regra não dependa
 * de alguém lembrar de repetir o mesmo `onClick` em cada tela nova.
 */
export function SymbolButton({
  symbol,
  plan = null,
  timeframe,
  note,
  tradeId,
  side,
  className = '',
  children,
}: ChartRequest & { className?: string; children?: React.ReactNode }) {
  const chart = useChartViewer();

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        chart.open({ symbol, plan, timeframe, note, tradeId, side });
      }}
      title={`Ver o gráfico de ${symbol}`}
      className={`cursor-pointer text-left underline-offset-4 transition hover:text-info hover:underline ${className}`}
    >
      {children ?? symbol.replace('USDT', '')}
    </button>
  );
}
