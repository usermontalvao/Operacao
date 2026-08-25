import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ChartSheet, type ChartRequest } from '../components/ChartSheet.tsx';

interface ChartViewer {
  open: (request: ChartRequest) => void;
}

const Context = createContext<ChartViewer>({ open: () => {} });

/**
 * O gráfico é de todas as telas.
 *
 * Antes ele só existia dentro da ficha do setup: quem estava olhando uma
 * posição aberta, uma operação encerrada ou uma linha do diário não tinha como
 * ver o preço sem sair do sistema. Como o gráfico pode ser pedido de qualquer
 * lugar, quem o guarda é o topo da árvore — as telas só pedem.
 */
export function useChartViewer(): ChartViewer {
  return useContext(Context);
}

export function ChartViewerProvider({
  prices,
  children,
}: {
  prices: Record<string, number>;
  children: ReactNode;
}) {
  const [request, setRequest] = useState<ChartRequest | null>(null);
  const open = useCallback((next: ChartRequest) => setRequest(next), []);
  const value = useMemo(() => ({ open }), [open]);

  return (
    <Context.Provider value={value}>
      {children}
      {request ? (
        <ChartSheet
          request={request}
          livePrice={prices[request.symbol] ?? null}
          onClose={() => setRequest(null)}
        />
      ) : null}
    </Context.Provider>
  );
}
