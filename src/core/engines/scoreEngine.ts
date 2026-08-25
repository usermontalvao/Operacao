import type { TimeframeAnalysis } from '../analysis.ts';
import type {
  ExtensionCheck,
  MarketContext,
  ScoreBreakdown,
  ScoreComponent,
  SetupCandidate,
  SetupClassification,
} from '../types.ts';

export interface ScoreInput {
  candidate: SetupCandidate;
  trigger: TimeframeAnalysis;
  anchor: TimeframeAnalysis;
  context: MarketContext | null;
  riskReward: number;
  extension: ExtensionCheck;
}

const MAX = {
  trend: 18,
  structure: 14,
  momentum: 14,
  volume: 12,
  level: 14,
  riskReward: 18,
  btc: 10,
};

/**
 * Score explicável: cada ponto tem origem declarada. Nada de "87" sem dizer
 * de onde vieram os 87 — quem decide é o usuário, e ele precisa auditar.
 */
export function scoreSetup(input: ScoreInput): ScoreBreakdown {
  const { candidate, trigger, anchor, context, riskReward, extension } = input;
  const components: ScoreComponent[] = [];
  const penalties: ScoreComponent[] = [];

  // Tendência
  const anchorTrend = anchor.structure.trend;
  const triggerTrend = trigger.structure.trend;
  let trendPoints = 0;
  let trendDetail = '';
  if (anchorTrend === 'UP' && triggerTrend !== 'DOWN') {
    trendPoints = MAX.trend;
    trendDetail = `Alta no ${anchor.timeframe} com ${trigger.timeframe} acompanhando`;
  } else if (anchorTrend === 'UP') {
    trendPoints = 12;
    trendDetail = `Alta no ${anchor.timeframe}, mas ${trigger.timeframe} ainda corrigindo`;
  } else if (anchorTrend === 'SIDEWAYS' && triggerTrend === 'UP') {
    trendPoints = 9;
    trendDetail = `${anchor.timeframe} lateral com ${trigger.timeframe} virando`;
  } else if (anchorTrend === 'SIDEWAYS') {
    trendPoints = 6;
    trendDetail = `${anchor.timeframe} lateral`;
  } else {
    trendPoints = 0;
    trendDetail = `Tendência de baixa no ${anchor.timeframe}`;
  }
  components.push(component('trend', 'Tendência', trendPoints, MAX.trend, trendDetail));

  // Estrutura
  const structureMap: Record<string, number> = { HH_HL: MAX.structure, RANGE: 8, UNDEFINED: 5, LH_LL: 0 };
  const structurePoints = structureMap[anchor.structure.structure] ?? 5;
  components.push(
    component(
      'structure',
      'Estrutura',
      structurePoints,
      MAX.structure,
      `Estrutura ${labelStructure(anchor.structure.structure)} no ${anchor.timeframe}`,
    ),
  );

  // Momentum
  const rsiValue = trigger.indicators.rsi14;
  let momentumPoints = 0;
  const momentumNotes: string[] = [];
  if (rsiValue !== null) {
    if (rsiValue >= 45 && rsiValue <= 65) {
      momentumPoints += 8;
      momentumNotes.push(`RSI em ${rsiValue.toFixed(0)}`);
    } else if (rsiValue >= 35 && rsiValue < 45) {
      momentumPoints += 6;
      momentumNotes.push(`RSI se recuperando (${rsiValue.toFixed(0)})`);
    } else if (rsiValue > 65 && rsiValue < 72) {
      momentumPoints += 3;
      momentumNotes.push(`RSI adiantado (${rsiValue.toFixed(0)})`);
    }
  }
  const macdNow = trigger.indicators.macd;
  const macdBefore = trigger.indicators.macdPrev;
  if (macdNow && macdBefore && macdNow.histogram > macdBefore.histogram) {
    momentumPoints += 4;
    momentumNotes.push('MACD melhorando');
  }
  if (macdNow && macdNow.histogram > 0) {
    momentumPoints += 2;
    momentumNotes.push('MACD positivo');
  }
  momentumPoints = Math.min(momentumPoints, MAX.momentum);
  components.push(
    component('momentum', 'Momentum', momentumPoints, MAX.momentum, momentumNotes.join(' · ') || 'Sem momentum claro'),
  );

  // Volume
  const relativeVolume = trigger.indicators.relativeVolume;
  let volumePoints = 0;
  let volumeDetail = 'Volume abaixo da média';
  if (relativeVolume !== null) {
    if (relativeVolume >= 1.5) {
      volumePoints = MAX.volume;
      volumeDetail = `Volume ${relativeVolume.toFixed(1)}x a média`;
    } else if (relativeVolume >= 1.1) {
      volumePoints = 8;
      volumeDetail = `Volume ${relativeVolume.toFixed(1)}x a média`;
    } else if (relativeVolume >= 0.8) {
      volumePoints = 5;
      volumeDetail = 'Volume dentro da média';
    }
  }
  if (candidate.qualityHints.volumeConfirmation) {
    volumePoints = Math.min(volumePoints + 4, MAX.volume);
    volumeDetail += ' · pressão vendedora cedendo';
  }
  components.push(component('volume', 'Volume', volumePoints, MAX.volume, volumeDetail));

  // Qualidade do nível
  const levelPoints = Math.round(clamp01(candidate.qualityHints.levelQuality) * MAX.level);
  components.push(
    component(
      'level',
      candidate.setupType === 'BREAKOUT_RETEST' ? 'Qualidade do rompimento' : 'Qualidade do suporte',
      levelPoints,
      MAX.level,
      `Nível em ${candidate.levelPrice.toPrecision(6)}`,
    ),
  );

  // Risco / retorno
  let rrPoints = 0;
  if (riskReward >= 4) rrPoints = MAX.riskReward;
  else if (riskReward >= 3) rrPoints = 15;
  else if (riskReward >= 2.5) rrPoints = 12;
  else if (riskReward >= 2) rrPoints = 9;
  else if (riskReward >= 1.5) rrPoints = 5;
  components.push(
    component('riskReward', 'Risco / retorno', rrPoints, MAX.riskReward, `R/R de 1:${riskReward.toFixed(1)}`),
  );

  // Contexto do BTC
  const modifier = context?.scoreModifier ?? 0;
  const btcPoints = Math.round(clamp01((modifier + 20) / 30) * MAX.btc);
  components.push(
    component('btc', 'Contexto BTC', btcPoints, MAX.btc, context ? context.reasons[0] ?? context.state : 'Sem contexto'),
  );

  // Penalidades
  if (extension.extended) {
    penalties.push(component('extended', 'Preço esticado', -20, 0, extension.reasons.join(' · ')));
  }
  const atrPercent = trigger.indicators.atrPercent ?? 0;
  if (atrPercent > 5) {
    penalties.push(
      component('volatility', 'Volatilidade do ativo', -6, 0, `ATR de ${atrPercent.toFixed(1)}% no ${trigger.timeframe}`),
    );
  }
  if (triggerTrend === 'DOWN') {
    penalties.push(component('triggerTrend', 'Gatilho contra a tendência', -5, 0, `${trigger.timeframe} em baixa`));
  }

  const rawTotal =
    components.reduce((acc, item) => acc + item.points, 0) +
    penalties.reduce((acc, item) => acc + item.points, 0);
  const total = Math.max(0, Math.min(100, Math.round(rawTotal)));

  return { total, classification: classify(total), components, penalties };
}

export function classify(score: number): SetupClassification {
  if (score >= 90) return 'SETUP_EXCEPCIONAL';
  if (score >= 80) return 'SETUP_FORTE';
  if (score >= 70) return 'SETUP_INTERESSANTE';
  if (score >= 60) return 'OBSERVAR';
  return 'SEM_SETUP';
}

function component(
  key: string,
  label: string,
  points: number,
  maxPoints: number,
  detail: string,
): ScoreComponent {
  return { key, label, points, maxPoints, detail };
}

function labelStructure(structure: string): string {
  if (structure === 'HH_HL') return 'de topos e fundos ascendentes';
  if (structure === 'LH_LL') return 'de topos e fundos descendentes';
  if (structure === 'RANGE') return 'lateral';
  return 'indefinida';
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}


/**
 * Score da entrada por explosão.
 *
 * Ela não passa pelo score comum de propósito. Aquele foi calibrado para
 * repique — pontua RSI entre 45 e 65, nível testado, preço perto da média — e
 * uma explosão é o contrário disso em todos os itens: RSI esticado, sem nível
 * embaixo, preço longe da média. Somar as duas réguas daria uma nota que não
 * mede nada. Aqui cada ponto vem de uma medida que o laboratório mostrou estar
 * ligada ao resultado: quanto mais extrema a explosão, melhor a expectativa.
 */
export function scoreMomentumBurst(input: ScoreInput): ScoreBreakdown {
  const burst = input.candidate.qualityHints.burst;
  const components: ScoreComponent[] = [];
  const penalties: ScoreComponent[] = [];

  const bodyAtr = burst?.bodyAtr ?? 0;
  const volumeMultiple = burst?.volumeMultiple ?? 0;
  const closePosition = burst?.closePosition ?? 0;
  const lookback = burst?.lookback ?? 0;

  const bodyPoints = bodyAtr >= 3 ? 35 : bodyAtr >= 2.5 ? 30 : 25;
  components.push(
    component('trend', 'Tamanho da explosão', bodyPoints, 35, `Corpo de ${bodyAtr.toFixed(1)} ATR`),
  );

  const volumePoints = volumeMultiple >= 5 ? 30 : volumeMultiple >= 4 ? 25 : 20;
  components.push(
    component('volume', 'Volume', volumePoints, 30, `${volumeMultiple.toFixed(1)}x a média de 20 barras`),
  );

  components.push(
    component('structure', 'Rompimento', 15, 20, `Máxima de ${lookback} barras superada`),
  );

  const closePoints = closePosition >= 0.85 ? 10 : 5;
  components.push(
    component(
      'momentum',
      'Fechamento',
      closePoints,
      10,
      `Fechou em ${Math.round(closePosition * 100)}% do range da barra`,
    ),
  );

  components.push(
    component('btc', 'Regime', 5, 5, 'BTC acima da média de 200 dias'),
  );

  const total = components.reduce((sum, item) => sum + item.points, 0);
  return {
    total: Math.max(0, Math.min(100, total)),
    components,
    penalties,
    classification: classify(total),
  };
}
