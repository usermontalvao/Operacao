import { CORPO_DE_SINAL_FORTE } from '../setups/momentumBurst.ts';
import type { MarketKind, Side } from '../direction.ts';
import type { AutoTradeSettings, SetupType } from '../types.ts';

/**
 * Estratégias autorizadas a operar sem intervenção humana.
 *
 * O laboratório separa treino e teste. Até agora, somente MOMENTUM_BURST
 * manteve expectativa positiva nas duas janelas; pullback, reteste e reversão
 * seguem no scanner para observação e pesquisa, mas não podem movimentar o
 * robô só porque receberam uma nota alta de um score que não previu retorno.
 */
/*
 * RANGE_FADE (micro scalp de 1m) NÃO entra nesta lista, e isso é a decisão
 * central do módulo: ele nasce gerando sinal e medindo resultado, sem
 * permissão para movimentar dinheiro sozinho. A pergunta que autoriza um
 * automatismo — "há expectativa líquida positiva depois dos custos, em treino
 * e em teste?" — só pode ser respondida pelo backtest separado do micro scalp
 * (src/lab/microScalp.ts). Enquanto ela não tiver resposta, a entrada é manual.
 */
export const VALIDATED_AUTOMATIC_SETUP_TYPES: readonly SetupType[] = ['MOMENTUM_BURST'];
export const MIN_VALIDATED_AUTOMATIC_SCORE = 90;

const validated = new Set<SetupType>(VALIDATED_AUTOMATIC_SETUP_TYPES);

export interface AutomaticStrategyCandidate {
  setupType: SetupType;
  score: number;
  /** corpo da barra de explosão em ATRs; ausente = trata como sinal médio */
  burstBodyAtr?: number | null;
  /** ausente = comprado, que é o único lado medido */
  side?: Side;
  /** ausente = spot, que é o único mercado medido */
  market?: MarketKind;
}

/**
 * Por que uma tese não pode rodar sozinha — com código, para o funil contar.
 *
 * A frase é apresentação e muda quando a redação melhorar; o código é estável
 * e é por ele que o painel escolhe a cor e a auditoria agrupa. Antes o
 * chamador adivinhava o código lendo a frase (`includes('observação')`), o que
 * quebrava calado a cada texto novo.
 */
export interface AutomaticRejection {
  code:
    | 'SHORT_NOT_AUTOMATED'
    | 'MARKET_NOT_VALIDATED'
    | 'STRATEGY_NOT_VALIDATED'
    | 'STRATEGY_DISABLED'
    | 'SCORE_BELOW_VALIDATED_FLOOR';
  message: string;
}

export function automaticRejection(
  setup: AutomaticStrategyCandidate,
  autoTrade?: AutoTradeSettings,
): AutomaticRejection | null {
  /*
   * O lado vendido existe no radar e pode ser executado à mão em futuros, mas
   * NÃO pelo robô. Os números que autorizam a automação — treino e teste, duas
   * janelas, custos nas duas pontas — foram medidos só na compra. Espelhar o
   * código de um detector não espelha a expectativa dele: ligar o robô no lado
   * de baixo seria colocar em produção uma estratégia que ninguém mediu, e o
   * fato de a mecânica ser simétrica não é evidência de que o resultado é.
   */
  if (setup.side === 'SELL') {
    return {
      code: 'SHORT_NOT_AUTOMATED',
      message:
        'tese vendida: o laboratório só mediu o lado comprado, então a venda a descoberto é entrada manual',
    };
  }
  /*
   * E o COMPRADO em futuros também não foi medido.
   *
   * É o mesmo erro do parágrafo acima, por outro eixo, e mais fácil de
   * cometer porque a tese parece idêntica à do spot. Não é:
   *
   *  - o backtest que autoriza a automação rodou sobre histórico de SPOT, e o
   *    contrato perpétuo tem candle e volume próprios;
   *  - o preço do futuro se afasta do à vista (basis), então entrada, stop e
   *    alvo medidos num livro não são os mesmos no outro;
   *  - funding é um custo recorrente que o backtest de spot não tinha e que
   *    come justamente a expectativa das operações que duram mais;
   *  - a liquidação é uma saída que não existe em spot, e ela chega antes do
   *    stop quando a alavancagem sobe.
   *
   * Enquanto a coluna de futuros for alimentada por candle de spot, "positivo
   * no laboratório" é uma frase sobre outro mercado. Entrada manual continua
   * liberada — quem clica está olhando o gráfico e assumindo a diferença.
   */
  if (setup.market === 'FUTURES') {
    return {
      code: 'MARKET_NOT_VALIDATED',
      message:
        'futuros não foi medido: a expectativa positiva veio de histórico de spot, e o perpétuo tem candle próprio, basis, funding e liquidação. Em futuros o robô não entra — a operação é manual',
    };
  }
  const configured = autoTrade?.strategies?.[setup.setupType];
  if (configured !== undefined) {
    if (!configured.enabled) {
      return {
        code: 'STRATEGY_DISABLED',
        message: `${setup.setupType} está visível no radar, mas a entrada automática desta estratégia está desligada nos ajustes desta conta`,
      };
    }
    if (setup.score < configured.minimumScore) {
      return {
        code: 'SCORE_BELOW_VALIDATED_FLOOR',
        message: `score ${setup.score} abaixo do piso de ${configured.minimumScore} configurado para ${setup.setupType}`,
      };
    }
    return null;
  }

  // Compatibilidade com snapshots e chamadas de laboratório anteriores à
  // política por setup: sem configuração explícita vale a régua validada.
  if (!validated.has(setup.setupType)) {
    return {
      code: 'STRATEGY_NOT_VALIDATED',
      message: `${setup.setupType} está em observação: sem expectativa positiva no treino e no teste; o robô só opera MOMENTUM_BURST`,
    };
  }
  if (setup.score < MIN_VALIDATED_AUTOMATIC_SCORE) {
    return {
      code: 'SCORE_BELOW_VALIDATED_FLOOR',
      message: `score ${setup.score} abaixo do piso validado de ${MIN_VALIDATED_AUTOMATIC_SCORE}`,
    };
  }
  return null;
}

/** Só a frase, para quem não precisa do código. */
export function automaticStrategyRejectionReason(
  setup: AutomaticStrategyCandidate,
  autoTrade?: AutoTradeSettings,
): string | null {
  return automaticRejection(setup, autoTrade)?.message ?? null;
}

/**
 * Fração do tamanho cheio, conforme a FORÇA do sinal.
 *
 * O grau saiu do score, e isso não é preferência: é medição. Em 62 pares
 * negociáveis e 9 anos de explosões, a faixa de score 85-89 rendeu +0,369R e
 * a de 95-100 rendeu +0,296R. Não existe escada ali — graduar aposta por
 * score é apostar mais em ruído, com a aparência de critério.
 *
 * O que tem escada é o CORPO da explosão, e ela sobe e desce:
 *
 *   2,0 a 2,5 ATR ... +0,016R   (por isso o piso do detector subiu para 2,5)
 *   2,5 a 3,5 ATR ... +0,356R   <- "médio"
 *   3,5 ATR ou mais . +0,263R   <- "forte"
 *
 * A escolha do usuário em 27/08/2026 foi apostar MAIS no forte (70% da banca)
 * que no médio (30%), sabendo que o forte rendeu menos. Fica registrado que
 * a medição não sustenta essa direção — o que ela sustenta é o piso de 2,5.
 *
 * Fora da explosão, nenhum detector tem grau medido: eles operam com o
 * tamanho médio, nunca com o cheio.
 */
export const FRACAO_SINAL_MEDIO = 30 / 70;

export function strategyConfidenceSizeFactor(
  setup: AutomaticStrategyCandidate,
  _autoTrade: AutoTradeSettings,
): number {
  if (setup.setupType !== 'MOMENTUM_BURST') return FRACAO_SINAL_MEDIO;
  const corpo = setup.burstBodyAtr;
  // sem a medida do corpo (setup antigo, ou vindo do laboratório) vale o
  // tamanho médio: o benefício da dúvida nunca aumenta a aposta
  if (corpo === null || corpo === undefined || !Number.isFinite(corpo)) return FRACAO_SINAL_MEDIO;
  return corpo >= CORPO_DE_SINAL_FORTE ? 1 : FRACAO_SINAL_MEDIO;
}

/**
 * Até quando um sinal ainda representa o que foi medido.
 *
 * O TTL do setup (12h por padrão) serve para o radar: um pullback continua
 * sendo um pullback horas depois. Não serve para o robô. MOMENTUM_BURST mede
 * uma explosão — o backtest entrou logo depois dela, e comprar a mesma
 * explosão três horas mais tarde é outra operação, com outra expectativa, que
 * ninguém mediu.
 *
 * ATENÇÃO: este número é POLÍTICA, não resultado de backtest. Foi escolhido de
 * forma conservadora para que ligar o robô não ressuscite sinais antigos, e
 * está isolado aqui justamente para ser calibrado quando houver amostra.
 */
export const MAX_SIGNAL_AGE_MS: Record<SetupType, number> = {
  MOMENTUM_BURST: 3 * 60 * 60_000,
  PULLBACK: 12 * 60 * 60_000,
  BREAKOUT_RETEST: 12 * 60 * 60_000,
  SUPPORT_REVERSAL: 12 * 60 * 60_000,
  /*
   * Três minutos, e não é conservadorismo: é o tempo em que a tese existe.
   *
   * O RANGE_FADE mede uma faixa de 60 barras de 1 minuto e compra a borda
   * dela. Passados dez minutos, um sexto das barras que definiram a faixa já
   * saiu da janela — a faixa medida não é mais a faixa atual. Reaproveitar o
   * sinal seria operar um retrato de um mercado que já mudou.
   */
  RANGE_FADE: 3 * 60_000,
};

export function maxSignalAgeMs(setupType: SetupType): number {
  return MAX_SIGNAL_AGE_MS[setupType] ?? 12 * 60 * 60_000;
}
