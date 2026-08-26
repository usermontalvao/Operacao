import type { DecisionRecord, EquityPoint, FactorPerformance, Trade } from './types.ts';
import { round } from './risk/riskReward.ts';

/**
 * Quanto a carteira andou DENTRO de uma janela de tempo.
 *
 * O painel tem o filtro de período há tempos, mas ele só recortava o gráfico:
 * o número grande do topo continuava sendo "desde o início", em qualquer
 * recorte. Trocar para "Ontem" e ver o mesmo +0,58% de sempre é pior que não
 * ter o filtro — parece resposta e não é.
 *
 * A base da janela é o patrimônio no instante em que ela começa: o último
 * ponto ANTES do recorte, não o primeiro ponto dentro dele. Usar o primeiro
 * de dentro apagaria justamente a operação que abriu o período.
 *
 * `agora` entra só quando a janela vai até hoje. Em janela fechada (ontem, um
 * mês passado) o fim tem de sair da curva, senão o resultado de hoje vazaria
 * para dentro do período de ontem.
 */
export function growthInWindow(input: {
  points: EquityPoint[];
  startingCapital: number;
  /** patrimônio de agora, já com o resultado em aberto */
  currentEquity: number;
  /** início da janela em ms; null = desde sempre */
  from: number | null;
  /** fim da janela em ms; null = até agora */
  to: number | null;
}): { percent: number; base: number; end: number; hasData: boolean } {
  const { points, startingCapital, currentEquity, from, to } = input;

  if (from === null && to === null) {
    const base = startingCapital;
    const percent = base > 0 ? ((currentEquity - base) / base) * 100 : 0;
    return { percent, base, end: currentEquity, hasData: points.length > 1 };
  }

  const comTempo = points
    .map((point) => ({ time: Date.parse(point.time), equity: point.equity }))
    .filter((point) => Number.isFinite(point.time))
    .sort((a, b) => a.time - b.time);

  const inicio = from ?? Number.NEGATIVE_INFINITY;
  const fim = to ?? Number.POSITIVE_INFINITY;

  const anteriores = comTempo.filter((point) => point.time < inicio);
  const base = anteriores.length > 0 ? (anteriores[anteriores.length - 1] as { equity: number }).equity : startingCapital;

  const dentro = comTempo.filter((point) => point.time >= inicio && point.time <= fim);
  const end =
    to === null
      ? currentEquity
      : dentro.length > 0
        ? (dentro[dentro.length - 1] as { equity: number }).equity
        : base;

  const percent = base > 0 ? ((end - base) / base) * 100 : 0;
  /*
   * "Teve movimento?" não é a mesma pergunta que "encerrou operação?".
   *
   * Uma posição aberta que subiu hoje move o patrimônio sem produzir ponto
   * nenhum na curva — a curva só registra encerramento. Dizer "sem operação
   * hoje" enquanto o número mudou seria negar o que a própria tela mostra
   * logo acima.
   */
  const houveMovimento = Math.abs(end - base) > 1e-9;
  return { percent, base, end, hasData: dentro.length > 0 || houveMovimento };
}

/**
 * Curva de patrimônio a partir das operações encerradas. O ponto inicial é o
 * capital declarado; cada fechamento move a linha.
 */
export function buildEquityCurve(trades: Trade[], startingCapital: number): EquityPoint[] {
  const closed = trades
    .filter((trade) => trade.status === 'CLOSED' && trade.closedAt)
    .sort((a, b) => new Date(a.closedAt as string).getTime() - new Date(b.closedAt as string).getTime());

  let equity = startingCapital;
  const points: EquityPoint[] = [
    {
      time: closed[0]?.openedAt ?? new Date().toISOString(),
      equity: round(equity, 2),
      realizedPnl: 0,
      tradeId: null,
    },
  ];

  for (const trade of closed) {
    equity += trade.realizedPnl;
    points.push({
      time: trade.closedAt as string,
      equity: round(equity, 2),
      realizedPnl: round(trade.realizedPnl, 2),
      tradeId: trade.id,
    });
  }
  return points;
}

interface Accumulator {
  key: string;
  label: string;
  bucket: string;
  trades: number;
  wins: number;
  totalPnl: number;
}

/**
 * Qual fator estava certo? Agrupa as operações encerradas por faixa de cada
 * componente do score e de cada indicador registrado no momento do sinal,
 * e mostra o acerto de cada faixa.
 *
 * Não é backtest: é a leitura honesta do que já aconteceu no diário.
 */
export function analyzeFactors(decisions: DecisionRecord[]): FactorPerformance[] {
  const buckets = new Map<string, Accumulator>();

  const add = (key: string, label: string, bucket: string, decision: DecisionRecord): void => {
    const id = `${key}|${bucket}`;
    const current = buckets.get(id) ?? { key, label, bucket, trades: 0, wins: 0, totalPnl: 0 };
    current.trades += 1;
    if (decision.realizedPnl > 0) current.wins += 1;
    current.totalPnl += decision.realizedPnl;
    buckets.set(id, current);
  };

  for (const decision of decisions) {
    add('score', 'Faixa de score', scoreBucket(decision.score), decision);
    add('setupType', 'Tipo de setup', decision.setupType, decision);
    add('timeframe', 'Timeframe do gatilho', decision.timeframe, decision);
    add('btcContext', 'Contexto do BTC', decision.btcContext, decision);
    add('riskReward', 'R/R planejado', riskRewardBucket(decision.riskReward), decision);
    add('automatic', 'Origem da ordem', decision.automatic ? 'Automática' : 'Manual', decision);
    add('extended', 'Preço esticado', decision.extended ? 'Sim' : 'Não', decision);

    for (const component of decision.components) {
      add(`component:${component.key}`, `Score — ${component.label}`, componentBucket(component.points, component.maxPoints), decision);
    }

    const evidence = decision.evidence;
    if (evidence) {
      if (evidence.rsi14 !== null) add('rsi', 'RSI no sinal', rsiBucket(evidence.rsi14), decision);
      if (evidence.relativeVolume !== null) {
        add('relativeVolume', 'Volume relativo', volumeBucket(evidence.relativeVolume), decision);
      }
      if (evidence.atrPercent !== null) {
        add('atrPercent', 'Volatilidade (ATR%)', atrBucket(evidence.atrPercent), decision);
      }
      if (evidence.distanceToEma20InAtr !== null) {
        add('emaDistance', 'Distância da EMA 20', emaDistanceBucket(evidence.distanceToEma20InAtr), decision);
      }
      add('anchorTrend', 'Tendência do timeframe âncora', evidence.anchorTrend, decision);
      add('anchorStructure', 'Estrutura do âncora', evidence.anchorStructure, decision);
      add('volumeConfirmation', 'Confirmação de volume', evidence.volumeConfirmation ? 'Sim' : 'Não', decision);
      add('momentumTurning', 'Momentum virando', evidence.momentumTurning ? 'Sim' : 'Não', decision);
    }
  }

  return [...buckets.values()]
    .map((item) => ({
      key: item.key,
      label: item.label,
      bucket: item.bucket,
      trades: item.trades,
      wins: item.wins,
      winRate: round((item.wins / item.trades) * 100, 1),
      totalPnl: round(item.totalPnl, 2),
      averagePnl: round(item.totalPnl / item.trades, 2),
    }))
    .sort((a, b) => (a.key === b.key ? b.winRate - a.winRate : a.key.localeCompare(b.key)));
}

function scoreBucket(score: number): string {
  if (score >= 90) return '90+';
  if (score >= 80) return '80–89';
  if (score >= 70) return '70–79';
  if (score >= 60) return '60–69';
  return 'abaixo de 60';
}

function componentBucket(points: number, maxPoints: number): string {
  if (maxPoints <= 0) return points < 0 ? 'penalidade aplicada' : 'sem efeito';
  const ratio = points / maxPoints;
  if (ratio >= 0.7) return 'alto';
  if (ratio >= 0.4) return 'médio';
  return 'baixo';
}

function rsiBucket(value: number): string {
  if (value < 40) return 'abaixo de 40';
  if (value < 55) return '40–55';
  if (value < 70) return '55–70';
  return 'acima de 70';
}

function volumeBucket(value: number): string {
  if (value < 1) return 'abaixo da média';
  if (value < 1.5) return '1–1,5x';
  return 'acima de 1,5x';
}

function atrBucket(value: number): string {
  if (value < 1) return 'até 1%';
  if (value < 2.5) return '1–2,5%';
  if (value < 5) return '2,5–5%';
  return 'acima de 5%';
}

function emaDistanceBucket(value: number): string {
  if (value < 0) return 'abaixo da média';
  if (value < 1) return 'até 1 ATR acima';
  if (value < 2) return '1–2 ATR acima';
  return 'mais de 2 ATR acima';
}

function riskRewardBucket(value: number): string {
  if (value < 2) return 'abaixo de 1:2';
  if (value < 3) return '1:2 a 1:3';
  if (value < 4) return '1:3 a 1:4';
  return 'acima de 1:4';
}
