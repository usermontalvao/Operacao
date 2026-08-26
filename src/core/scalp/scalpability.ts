import type {
  LiquiditySnapshot,
  ScalpGrade,
  ScalpLiquidityFilters,
  ScalpScoreComponent,
  ScalpScoreWeights,
  ScalpabilityReport,
} from '../types.ts';
import { allInCostPercent } from './microEconomics.ts';

/**
 * "Esta moeda dá para operar em 1 minuto?"
 *
 * Ranking por volume não responde isso, e foi por isso que este módulo
 * existe. Volume de 24h é um número do PASSADO e do agregado: um par pode ter
 * girado 80 milhões ontem à noite num pump e estar agora com book de mil
 * dólares e spread de 0,3%. Operar 1 minuto ali é pagar o spread duas vezes
 * para capturar um movimento menor que ele.
 *
 * A nota junta o que ajuda (liquidez, volume agora, amplitude aproveitável,
 * profundidade) e desconta o que atrapalha (spread, escorregamento, custo).
 * Os descontos podem zerar a nota sozinhos — é intencional: spread alto deve
 * conseguir reprovar um par com volume excelente, porque na prática ele
 * reprova mesmo.
 */

/** 0..1 com saturação suave: dobrar o volume de um par já bom vale pouco. */
function ratio(value: number, reference: number): number {
  if (reference <= 0) return 0;
  return Math.max(0, Math.min(1, value / reference));
}

/**
 * Quanto um desconto morde: quase nada perto do ideal, tudo perto do limite.
 *
 * A primeira versão era linear, e linear estava errado. Um spread de 0,02%
 * contra um teto de 0,06% custava um terço da penalidade inteira — dez pontos
 * de desconto por um spread que, na prática, é irrelevante. O par ideal
 * terminava com 62 e era reprovado por excelência.
 *
 * Ao quadrado, a curva diz o que se quer dizer: metade do limite custa um
 * quarto do desconto, e só perto do teto o desconto vira proibitivo.
 */
function penaltyRatio(value: number, limit: number): number {
  if (limit <= 0) return 1;
  const r = Math.max(0, Math.min(1, value / limit));
  return r * r;
}

export function gradeFor(score: number): ScalpGrade {
  if (score >= 90) return 'EXCELENTE';
  if (score >= 80) return 'BOM';
  if (score >= 70) return 'APTO';
  return 'BLOQUEADO';
}

export interface ScalpabilityInput {
  liquidity: LiquiditySnapshot;
  /** ATR de 1m em % do preço; null quando ainda não há candles suficientes */
  microAtrPercent: number | null;
  filters: ScalpLiquidityFilters;
  weights: ScalpScoreWeights;
  /** taxa por lado da conta/modalidade ativa */
  feePercent: number;
  /** escorregamento declarado, usado quando o book não pôde ser varrido */
  fallbackSlippagePercent: number;
  /**
   * Quantas vezes o alvo precisa pagar o custo — o mesmo número que o guarda
   * de oportunidade usa. Entra aqui para que o piso de amplitude e a recusa
   * final falem do MESMO critério, em vez de dois palpites que se contradizem.
   */
  minCostMultiple: number;
  /**
   * Os cortes vetam (true) ou só descrevem (false).
   *
   * Falso não muda NENHUM número: a nota é a mesma, os motivos são os mesmos,
   * o custo é o mesmo. Muda só quem decide o que fazer com eles.
   */
  enforce: boolean;
}

export function scoreScalpability(input: ScalpabilityInput): ScalpabilityReport {
  const { liquidity, microAtrPercent, filters, weights, feePercent, minCostMultiple } = input;
  const enforce = input.enforce;

  const allIn = allInCostPercent({
    feePercent,
    liquidity,
    fallbackSlippagePercent: input.fallbackSlippagePercent,
  });

  const components: ScalpScoreComponent[] = [];
  const blockers: string[] = [];

  /*
   * Os cortes eliminatórios vêm PRIMEIRO e são independentes da nota.
   *
   * Um par pode ser reprovado por spread e ainda assim somar 85 pontos de
   * volume e profundidade. Se o corte fosse só "nota < 70", esse par entraria.
   * Reprovar antes de pontuar é o que garante que cada filtro sozinho tenha
   * poder de veto — e a lista de blockers é o que a tela mostra como motivo.
   */
  if (liquidity.quoteVolume24h < filters.minQuoteVolume24h) {
    blockers.push(
      `volume de 24h abaixo do mínimo (${(liquidity.quoteVolume24h / 1e6).toFixed(1)}M < ${(filters.minQuoteVolume24h / 1e6).toFixed(0)}M)`,
    );
  }
  if (liquidity.recentQuoteVolume < filters.minRecentQuoteVolume) {
    blockers.push(
      `parado agora: US$ ${Math.round(liquidity.recentQuoteVolume).toLocaleString('pt-BR')} nos últimos 15 min`,
    );
  }
  if (liquidity.spreadPercent > filters.maxSpreadPercent) {
    blockers.push(
      `spread elevado (${liquidity.spreadPercent.toFixed(3)}% > ${filters.maxSpreadPercent}%)`,
    );
  }
  const depth = Math.min(liquidity.bidDepthUsd, liquidity.askDepthUsd);
  if (depth < filters.minBookDepthUsd) {
    blockers.push(
      `book insuficiente (US$ ${Math.round(depth).toLocaleString('pt-BR')} < US$ ${filters.minBookDepthUsd.toLocaleString('pt-BR')})`,
    );
  }
  if (liquidity.slippagePercent === null) {
    blockers.push('book raso demais para estimar o escorregamento da ordem');
  } else if (liquidity.slippagePercent > filters.maxSlippagePercent) {
    blockers.push(
      `escorregamento de ${liquidity.slippagePercent.toFixed(3)}% acima do teto de ${filters.maxSlippagePercent}%`,
    );
  }
  /*
   * O piso de amplitude é DERIVADO DO CUSTO, não um número fixo.
   *
   * A primeira versão usava 0,08% para todos os pares, e o número escondia mais
   * do que revelava. O que decide se um par é operável em 1 minuto não é o ATR
   * dele — é o ATR CONTRA O QUE A VIAGEM CUSTA NAQUELE PAR. Um piso fixo erra
   * nos dois sentidos: aprovava o SOL com 0,083% (que precisa de 0,44%) e a
   * mensagem "0,083% < 0,08%" dava a impressão de um quase-passou, quando
   * faltavam cinco vezes.
   *
   * Pior: o piso solto deixava esses pares entrarem no universo só para serem
   * recusados três estágios depois, pela conta de custo. O funil media o
   * mesmo fato duas vezes, em lugares diferentes, com números diferentes.
   *
   * A conta: o alvo é ~metade da faixa, e ele precisa pagar
   * `minCostMultiple` vezes o custo. Uma faixa de 2 ATR dá alvo de 1 ATR, logo
   * o par precisa de `ATR >= custo * minCostMultiple / 2` por barra.
   */
  const atrMinimoPeloCusto = (allIn * minCostMultiple) / 2;
  const pisoDeAmplitude = Math.max(filters.minMicroAtrPercent, atrMinimoPeloCusto);

  if (microAtrPercent === null) {
    blockers.push('sem candles de 1m suficientes para medir a amplitude');
  } else if (microAtrPercent < pisoDeAmplitude) {
    blockers.push(
      `amplitude insuficiente: a barra anda ${microAtrPercent.toFixed(3)}% e precisaria de ` +
        `${pisoDeAmplitude.toFixed(3)}% para o alvo pagar ${minCostMultiple}x o custo de ${allIn.toFixed(3)}%`,
    );
  } else if (microAtrPercent > filters.maxMicroAtrPercent) {
    blockers.push(
      `volatilidade anormal (ATR de 1m ${microAtrPercent.toFixed(2)}% > ${filters.maxMicroAtrPercent}%) — não é oscilação lateral`,
    );
  }

  // ---- as parcelas positivas -------------------------------------------
  const liquidityPoints =
    weights.liquidity * ratio(liquidity.quoteVolume24h, filters.minQuoteVolume24h * 5);
  components.push({
    key: 'liquidity',
    label: 'Liquidez (24h)',
    points: liquidityPoints,
    detail: `US$ ${(liquidity.quoteVolume24h / 1e6).toFixed(1)}M negociados em 24h`,
  });

  const recentPoints =
    weights.recentVolume * ratio(liquidity.recentQuoteVolume, filters.minRecentQuoteVolume * 5);
  components.push({
    key: 'recentVolume',
    label: 'Volume agora',
    points: recentPoints,
    detail: `US$ ${Math.round(liquidity.recentQuoteVolume).toLocaleString('pt-BR')} nos últimos 15 min`,
  });

  /*
   * Volatilidade APROVEITÁVEL, não volatilidade.
   *
   * O que interessa é quanto a barra anda em relação ao que a viagem custa. Um
   * ATR de 0,05% num par de custo 0,2% vale zero por mais que o par seja
   * líquido; o mesmo 0,05% num mercado sem taxa valeria muito. A referência é
   * o próprio custo — e o teto (4x) evita que uma vela de notícia pareça a
   * melhor oportunidade do dia.
   */
  const usable =
    microAtrPercent === null || allIn <= 0
      ? 0
      : Math.max(0, Math.min(1, (microAtrPercent * 2) / (allIn * 4)));
  const volatilityPoints = weights.usableVolatility * usable;
  components.push({
    key: 'usableVolatility',
    label: 'Amplitude aproveitável',
    points: volatilityPoints,
    detail:
      microAtrPercent === null
        ? 'sem medição de ATR de 1m'
        : `ATR de 1m ${microAtrPercent.toFixed(3)}% contra custo de ${allIn.toFixed(3)}%`,
  });

  const depthPoints = weights.bookDepth * ratio(depth, filters.minBookDepthUsd * 4);
  components.push({
    key: 'bookDepth',
    label: 'Profundidade do book',
    points: depthPoints,
    detail: `US$ ${Math.round(depth).toLocaleString('pt-BR')} no lado mais fino`,
  });

  // ---- os descontos ----------------------------------------------------
  const spreadPenalty =
    weights.spreadPenalty * penaltyRatio(liquidity.spreadPercent, filters.maxSpreadPercent);
  components.push({
    key: 'spread',
    label: 'Spread',
    points: -spreadPenalty,
    detail: `${liquidity.spreadPercent.toFixed(3)}% entre a melhor compra e a melhor venda`,
  });

  const slippage = liquidity.slippagePercent ?? filters.maxSlippagePercent;
  const slippagePenalty = weights.slippagePenalty * penaltyRatio(slippage, filters.maxSlippagePercent);
  components.push({
    key: 'slippage',
    label: 'Escorregamento',
    points: -slippagePenalty,
    detail:
      liquidity.slippagePercent === null
        ? 'book insuficiente para medir'
        : `${liquidity.slippagePercent.toFixed(3)}% ao varrer o book com a ordem`,
  });

  /*
   * Este desconto mede o ATRITO EVITÁVEL, não a razão custo/amplitude.
   *
   * A primeira versão descontava `allIn / (2*ATR)` — que é exatamente o que a
   * parcela "amplitude aproveitável" já mede, de cabeça para baixo. O mesmo
   * fato entrava duas vezes na nota, uma somando e outra subtraindo, e o par
   * era punido em dobro por uma única característica.
   *
   * O que falta medir é outra coisa: das duas taxas para cá, quanto este par
   * cobra a MAIS que o mínimo inevitável. Taxa é da corretora e não se
   * escolhe; spread e escorregamento são do par, e são o que distingue
   * atravessar um book fundo de atravessar um raso.
   */
  const custoMinimo = feePercent * 2;
  const atritoEvitavel = allIn > 0 ? Math.max(0, 1 - custoMinimo / allIn) : 0;
  const costPenalty = weights.costPenalty * atritoEvitavel;
  components.push({
    key: 'cost',
    label: 'Atrito além da taxa',
    points: -costPenalty,
    detail: `custo de ${allIn.toFixed(3)}% contra ${custoMinimo.toFixed(3)}% de taxa pura`,
  });

  const raw = components.reduce((total, item) => total + item.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  if (blockers.length === 0 && score < filters.minScore) {
    blockers.push(`nota ${score} abaixo do mínimo de ${filters.minScore} para operar em 1 minuto`);
  }

  const blocked = enforce && blockers.length > 0;

  return {
    symbol: liquidity.symbol,
    /*
     * A nota é a nota, sempre.
     *
     * A versão anterior rebaixava a nota de quem tinha algum impedimento, para
     * que ninguém lesse "68" e achasse que faltava pouco. Isso funcionava
     * enquanto reprovar era o único desfecho — com os filtros apenas avisando,
     * a mesma mexida mentiria: dois pares muito diferentes apareceriam com a
     * mesma nota inventada, e o ranking que decide quem entra no universo
     * deixaria de ordenar coisa alguma. Quem diz que há impedimento é
     * `blockers`; a nota volta a medir só o que ela mede.
     */
    score,
    grade: blocked ? 'BLOQUEADO' : gradeFor(score),
    components,
    blockers,
    blocked,
    liquidity,
    microAtrPercent,
    allInCostPercent: allIn,
    measuredAt: liquidity.measuredAt,
  };
}
