import type { SymbolAnalysis } from '../analysis.ts';
import type {
  AppSettings,
  MicroEconomics,
  RangeRegimeReport,
  ScalpabilityReport,
  ScoreBreakdown,
  SetupCandidate,
  TradeSetup,
} from '../types.ts';
import { MICRO_TIMEFRAME, timeframeMinutes } from '../types.ts';
import { detectRangeFadeLong, detectRangeFadeShort, fingerprintOf } from '../setups/index.ts';
import { analyzeRangeRegime } from '../scalp/rangeRegime.ts';
import { computeMicroEconomics, microOpportunityRejection } from '../scalp/microEconomics.ts';
import { classify } from './scoreEngine.ts';
import { anchorFor, resolveVisualState } from './setupEngine.ts';
import { round } from '../risk/index.ts';

/**
 * O motor do micro scalp — separado do setupEngine de propósito.
 *
 * Compartilhar o caminho dos outros setups pareceria economia e seria o
 * contrário: o `buildSetup` comum aplica o teste de "esticado", pontua pela
 * régua de tendência e usa o TTL global de 12 horas. Nenhuma dessas três
 * coisas faz sentido para uma tese que compra a borda de uma faixa e morre em
 * três minutos. O que se reaproveita é o que de fato é comum — fingerprint,
 * estado visual, arredondamento e a classificação da nota.
 *
 * A ordem das perguntas é a decisão de projeto mais importante aqui, e ela é
 * do mais barato para o mais caro:
 *
 *   1. o par está apto? (já medido pelo universo de scalp)
 *   2. existe faixa?    (indicadores sobre candles em memória)
 *   3. a borda rejeitou? (detector)
 *   4. a conta fecha?   (custo real do par)
 *
 * O passo 4 é o último porque é o que mais reprova — mas ele é o único que
 * NÃO pode ser pulado. Um setup lindo cuja conta não fecha é um prejuízo com
 * boa aparência.
 */

export interface MicroScalpResult {
  setups: TradeSetup[];
  /** por que este par não gerou tese agora — é o que a tela mostra */
  blocked: MicroBlock | null;
}

export interface MicroBlock {
  symbol: string;
  reason: string;
  regime: RangeRegimeReport | null;
  scalpability: ScalpabilityReport;
}

export interface GenerateMicroSetupsInput {
  analysis: SymbolAnalysis;
  scalpability: ScalpabilityReport;
  settings: AppSettings;
  now: Date;
  makeId: () => string;
}

export function generateMicroSetups(input: GenerateMicroSetupsInput): MicroScalpResult {
  const { analysis, scalpability, settings, now, makeId } = input;
  const micro = settings.scanner.microScalp;

  if (!micro.enabled) return { setups: [], blocked: null };

  if (scalpability.blocked) {
    return {
      setups: [],
      blocked: {
        symbol: analysis.symbol,
        reason: scalpability.blockers[0] as string,
        regime: null,
        scalpability,
      },
    };
  }

  const trigger = analysis.timeframes[MICRO_TIMEFRAME];
  if (!trigger) {
    return {
      setups: [],
      blocked: {
        symbol: analysis.symbol,
        reason: 'sem candles de 1m carregados',
        regime: null,
        scalpability,
      },
    };
  }

  const anchorTimeframe = anchorFor(MICRO_TIMEFRAME, settings.scanner.anchorTimeframe);
  const anchor = analysis.timeframes[anchorTimeframe] ?? trigger;

  const regime = analyzeRangeRegime({
    candles: trigger.candles,
    settings: micro.regime,
    allInCostPercent: scalpability.allInCostPercent,
  });

  /*
   * A faixa continua sendo condição, com ou sem veto — e isso não é uma trava
   * de risco que dá para afrouxar, é a definição da estratégia.
   *
   * Os filtros de liquidez e de custo respondem "vale a pena operar este par?"
   * e essa pergunta é do operador. O regime responde outra: "existe a coisa
   * que este detector procura?". Comprar a borda de baixo de uma faixa que
   * não existe não é uma operação arriscada, é uma operação sem tese — o
   * detector estaria inventando um suporte onde há só uma queda em curso.
   */
  if (regime.verdict !== 'RANGE') {
    return {
      setups: [],
      blocked: {
        symbol: analysis.symbol,
        reason: regime.reasons[0] ?? 'sem faixa identificada',
        regime,
        scalpability,
      },
    };
  }

  /*
   * SPOT não tem lado vendido. Não é uma trava de segurança que dá para
   * afrouxar depois: à vista, vender o que não se tem exige ativo emprestado,
   * e este projeto não tem margem. Mostrar a tese vendida num painel de spot
   * seria mostrar uma oportunidade que ninguém consegue executar — e o passo
   * seguinte seria alguém tentar executá-la por fora.
   */
  const podeVender = settings.market === 'FUTURES' && settings.futures.allowShort;
  const detectores = podeVender
    ? [detectRangeFadeLong, detectRangeFadeShort]
    : [detectRangeFadeLong];

  const setups: TradeSetup[] = [];
  let ultimoMotivo: string | null = null;

  for (const detector of detectores) {
    const candidate = detector({
      analysis,
      trigger,
      anchor,
      context: null,
      regime,
      entryZonePercent: micro.regime.entryZonePercent,
    });
    if (!candidate) continue;

    const construido = buildMicroSetup({
      candidate,
      regime,
      scalpability,
      settings,
      analysis,
      now,
      makeId,
    });
    if (typeof construido === 'string') {
      ultimoMotivo = construido;
      continue;
    }
    setups.push(construido);
  }

  if (setups.length === 0) {
    return {
      setups: [],
      blocked: {
        symbol: analysis.symbol,
        reason:
          ultimoMotivo ??
          `faixa confirmada, aguardando rejeição na borda (preço a ${(regime.position * 100).toFixed(0)}% da amplitude)`,
        regime,
        scalpability,
      },
    };
  }

  return { setups, blocked: null };
}

interface BuildMicroInput {
  candidate: SetupCandidate;
  regime: RangeRegimeReport;
  scalpability: ScalpabilityReport;
  settings: AppSettings;
  analysis: SymbolAnalysis;
  now: Date;
  makeId: () => string;
}

/** Devolve o setup pronto, ou a FRASE que explica por que ele não nasceu. */
function buildMicroSetup(input: BuildMicroInput): TradeSetup | string {
  const { candidate, regime, scalpability, settings, analysis, now, makeId } = input;
  const micro = settings.scanner.microScalp;

  const entryPrice = (candidate.entryLow + candidate.entryHigh) / 2;

  /*
   * A taxa vem do guard da conta E da modalidade ativa — é lá que spot (0,1%)
   * e futuros (0,05%) já são números diferentes. O spread e o escorregamento
   * vêm do book medido deste par. Misturar as duas fontes é o ponto: a taxa é
   * da conta, o resto é do mercado.
   */
  const economics = computeMicroEconomics({
    side: candidate.side,
    entryPrice,
    stopLoss: candidate.stopLoss,
    target: candidate.target1,
    feePercent: settings.guard.feePercent,
    liquidity: scalpability.liquidity,
    costs: settings.guard,
  });

  const recusa = microOpportunityRejection(
    economics,
    micro.regime.minCostMultiple,
    settings.guard.minNetRiskReward,
  );
  /*
   * Vetando, a tese sem margem não nasce. Sem vetar, ela nasce COM o motivo
   * colado nela — e o cartão mostra o lucro líquido em vermelho quando ele é
   * negativo. Não bloquear é devolver a decisão a quem olha; apagar o motivo
   * seria outra coisa, e essa nenhuma configuração faz.
   */
  if (recusa !== null && micro.enforceFilters) return recusa;
  const economicsComAviso: MicroEconomics = { ...economics, warning: recusa };

  const breakdown = scoreRangeFade(regime, scalpability, economics);
  if (breakdown.total < settings.risk.minimumScoreToShow) {
    return `nota ${breakdown.total} abaixo do mínimo de ${settings.risk.minimumScoreToShow} para exibir`;
  }

  const price = analysis.price > 0 ? analysis.price : candidate.entryHigh;
  const createdAt = now.toISOString();
  /*
   * O TTL é o MENOR entre o configurado e a duração de uma faixa de 1m. A
   * tese mede 60 barras de um minuto; passados poucos minutos, as barras que
   * a definiram já estão saindo da janela.
   */
  const ttlMinutes = Math.min(
    micro.setupTtlMinutes,
    Math.max(1, Math.round(timeframeMinutes(MICRO_TIMEFRAME) * 3)),
  );

  const setup: TradeSetup = {
    id: makeId(),
    symbol: candidate.symbol,
    side: candidate.side,
    market: settings.market,
    timeframe: candidate.timeframe,
    anchorTimeframe: candidate.anchorTimeframe,
    setupType: 'RANGE_FADE',
    currentPrice: price,
    entryLow: round(candidate.entryLow, 8),
    entryHigh: round(candidate.entryHigh, 8),
    stopLoss: round(candidate.stopLoss, 8),
    target1: round(candidate.target1, 8),
    target2: null,
    target3: null,
    riskReward: economicsComAviso.netRiskReward,
    score: breakdown.total,
    classification: breakdown.classification,
    scoreBreakdown: breakdown,
    reasons: candidate.reasons,
    btcContext: 'BTC_NEUTRAL',
    status: breakdown.total >= settings.risk.minimumScoreToAlert ? 'ACTIVE' : 'WATCHING',
    visualState: 'AGUARDANDO',
    extended: false,
    extensionReasons: [],
    evidence: {
      rsi14: null,
      atrPercent: scalpability.microAtrPercent,
      relativeVolume: null,
      macdHistogram: null,
      distanceToEma20InAtr: null,
      triggerTrend: 'SIDEWAYS',
      anchorTrend: 'SIDEWAYS',
      anchorStructure: 'RANGE',
      levelQuality: regime.confidence,
      volumeConfirmation: candidate.qualityHints.volumeConfirmation,
      momentumTurning: true,
      btcScoreModifier: 0,
    },
    fingerprint: fingerprintOf(
      candidate.symbol,
      'RANGE_FADE',
      candidate.timeframe,
      candidate.levelPrice,
      candidate.side,
      settings.market,
    ),
    invalidationNote: null,
    micro: { scalpability, regime, economics: economicsComAviso },
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
    ignoredAt: null,
  };

  setup.visualState = resolveVisualState(setup, price);
  return setup;
}

/**
 * A nota do micro scalp.
 *
 * Não passa pelo score comum pelo mesmo motivo que a explosão não passa: a
 * régua de lá pontua tendência alinhada, nível testado e momento a favor —
 * uma tese de reversão à média pontuaria mal em todos os três justamente
 * quando está certa. Aqui a nota mede o que decide o resultado DESTA
 * estratégia: a faixa é confiável, o par é operável e a conta fecha com folga.
 */
export function scoreRangeFade(
  regime: RangeRegimeReport,
  scalpability: ScalpabilityReport,
  economics: MicroEconomics,
): ScoreBreakdown {
  const components = [
    {
      key: 'regime',
      label: 'Confiança na faixa',
      points: Math.round(regime.confidence * 30),
      maxPoints: 30,
      detail: `${regime.supportTouches} testes no suporte, ${regime.resistanceTouches} na resistência${
        regime.adx !== null ? `, ADX ${regime.adx.toFixed(0)}` : ''
      }`,
    },
    {
      key: 'scalpability',
      label: 'Aptidão do par',
      points: Math.round((scalpability.score / 100) * 25),
      maxPoints: 25,
      detail: `${scalpability.grade} · spread ${scalpability.liquidity.spreadPercent.toFixed(3)}%`,
    },
    {
      key: 'economics',
      // é a maior parcela porque é a que a medição mostrou decidir tudo
      label: 'Margem sobre o custo',
      points: Math.round(Math.min(1, economics.costMultiple / 4) * 30),
      maxPoints: 30,
      detail: `alvo paga ${economics.costMultiple.toFixed(1)}x o custo de ${economics.allInCostPercent.toFixed(3)}%`,
    },
    {
      key: 'position',
      label: 'Posição na borda',
      points: Math.round(
        (1 - Math.min(1, Math.abs(regime.position - (regime.position < 0.5 ? 0 : 1)) * 4)) * 15,
      ),
      maxPoints: 15,
      detail: `preço a ${(regime.position * 100).toFixed(0)}% da amplitude da faixa`,
    },
  ];

  const total = Math.max(
    0,
    Math.min(100, components.reduce((sum, item) => sum + item.points, 0)),
  );

  return { total, classification: classify(total), components, penalties: [] };
}
