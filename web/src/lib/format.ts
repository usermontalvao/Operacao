import type {
  MarketKind,
  SetupClassification,
  SetupType,
  SetupVisualState,
  Side,
  TradeSetup,
} from './types.ts';

/** Preço legível para qualquer faixa: BTC em 79.000 e ONDO em 0,3723. */
export function price(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value >= 1000) return value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString('pt-BR', { maximumFractionDigits: 4 });
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 6 });
}

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'USD' });
}

/** Mesmo valor em USDT e em reais — o motor opera em USDT. */
export function usdWithBrl(value: number | null | undefined, brlRate: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const base = usd(value);
  if (!brlRate || brlRate <= 0) return base;
  const brl = (value * brlRate).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return `${base} · ${brl}`;
}

export function brl(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function percent(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

export function quantity(value: number): string {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 8 });
}

export const SETUP_LABEL: Record<SetupType, string> = {
  PULLBACK: 'Pullback',
  BREAKOUT_RETEST: 'Rompimento + reteste',
  SUPPORT_REVERSAL: 'Reversão em suporte',
  MOMENTUM_BURST: 'Explosão de força',
};

export const CLASSIFICATION_LABEL: Record<SetupClassification, string> = {
  SEM_SETUP: 'Sem setup',
  OBSERVAR: 'Observar',
  SETUP_INTERESSANTE: 'Setup interessante',
  SETUP_FORTE: 'Setup forte',
  SETUP_EXCEPCIONAL: 'Setup excepcional',
};

/**
 * O vocabulário do lado.
 *
 * Uma tese vendida ganha quando o preço CAI: chamar isso de "comprar" na tela
 * é o erro mais caro que a interface pode cometer, porque o usuário confirma
 * a ordem lendo o botão. Tudo que fala de direção sai daqui.
 */
export const SIDE_LABEL: Record<Side, string> = {
  BUY: 'COMPRA',
  SELL: 'VENDA',
};

/** O verbo, para o botão e para a frase da confirmação. */
export const SIDE_VERB: Record<Side, string> = {
  BUY: 'Comprar',
  SELL: 'Vender',
};

/** Verde para comprado, vermelho para vendido — a mesma cor do gráfico. */
export function sideTone(side: Side): string {
  return side === 'SELL'
    ? 'bg-bear/15 text-bear border-bear/40'
    : 'bg-bull/15 text-bull border-bull/40';
}

/** Cor de fundo do botão que executa — é o último aviso antes da ordem. */
export function sideButton(side: Side): string {
  return side === 'SELL' ? 'bg-bear text-white' : 'bg-bull text-black';
}

export const MARKET_LABEL: Record<MarketKind, string> = {
  SPOT: 'SPOT',
  FUTURES: 'FUTUROS',
};

export const STATE_LABEL: Record<SetupVisualState, string> = {
  AGUARDANDO: 'Aguardando',
  QUASE_LA: 'Quase lá',
  SETUP_ATIVO: 'Setup ativo',
  ROMPENDO: 'Rompendo',
  RETESTANDO: 'Retestando',
  COMPRAVEL: 'Comprável',
  ESTICADO: 'Esticado',
  INVALIDADO: 'Invalidado',
};

/**
 * O estado visual escrito no idioma do lado.
 *
 * `COMPRAVEL` é o nome interno de "dá para executar agora" — e numa tese
 * vendida executar é VENDER. O motor não precisa de dois estados; a tela
 * precisa de duas palavras.
 */
export function stateLabel(state: SetupVisualState, side: Side = 'BUY'): string {
  if (state === 'COMPRAVEL' && side === 'SELL') return 'Vendível';
  return STATE_LABEL[state];
}

export function stateTone(state: SetupVisualState | null, side: Side = 'BUY'): string {
  switch (state) {
    case 'COMPRAVEL':
      // "dá para executar" pinta da cor do LADO: verde executando uma venda
      // faria o olho ler alta onde a tese é de queda
      return side === 'SELL'
        ? 'bg-bear/15 text-bear border-bear/40'
        : 'bg-bull/15 text-bull border-bull/40';
    case 'SETUP_ATIVO':
    case 'ROMPENDO':
      return 'bg-info/15 text-info border-info/40';
    case 'QUASE_LA':
    case 'RETESTANDO':
      return 'bg-warn/15 text-warn border-warn/40';
    case 'ESTICADO':
      return 'bg-warn/10 text-warn border-warn/30';
    case 'INVALIDADO':
      return 'bg-bear/15 text-bear border-bear/40';
    default:
      return 'bg-terminal-panel-soft text-terminal-muted border-terminal-border';
  }
}

export function scoreTone(score: number): string {
  if (score >= 90) return 'text-bull';
  if (score >= 80) return 'text-bull';
  if (score >= 70) return 'text-info';
  if (score >= 60) return 'text-warn';
  return 'text-terminal-muted';
}

export function changeTone(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'text-terminal-muted';
  if (value > 0) return 'text-bull';
  if (value < 0) return 'text-bear';
  return 'text-terminal-muted';
}

/** Alavancagem só aparece quando existe: "1x" em spot é ruído. */
export function leverageLabel(leverage: number | null | undefined): string | null {
  if (!leverage || leverage <= 1) return null;
  return `${leverage}x`;
}

/** Distância percentual do preço atual até a zona de entrada. */
export function distanceToEntry(setup: TradeSetup, current: number): number {
  if (current >= setup.entryLow && current <= setup.entryHigh) return 0;
  const reference = current > setup.entryHigh ? setup.entryHigh : setup.entryLow;
  return ((current - reference) / reference) * 100;
}
