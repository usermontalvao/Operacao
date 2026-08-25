import type { EntryDecisionRecord } from './record.ts';
import type { DecisionCode, FunnelStage } from './types.ts';

/**
 * Funil do robô: onde os sinais param.
 *
 * A pergunta que o painel precisa responder não é "quantos setups apareceram",
 * é "de cem sinais, quantos morreram em cada porta". Um funil em que tudo
 * morre na mesma etapa é um sistema mal calibrado; um funil em que nada chega
 * ao fim é um robô que nunca vai operar — e as duas coisas são invisíveis numa
 * lista de cards.
 */

export const FUNNEL_ORDER: readonly FunnelStage[] = [
  'DETECTADO',
  'ESTRATEGIA_VALIDADA',
  'SCORE_SUFICIENTE',
  'DENTRO_DA_ZONA',
  'APROVADO_PELO_RISCO',
  'ORDEM_CRIADA',
  'ORDEM_PREENCHIDA',
  'RESULTADO',
];

export const FUNNEL_LABEL: Record<FunnelStage, string> = {
  DETECTADO: 'Sinais detectados',
  ESTRATEGIA_VALIDADA: 'Estratégia validada',
  SCORE_SUFICIENTE: 'Score suficiente',
  DENTRO_DA_ZONA: 'Dentro da zona',
  APROVADO_PELO_RISCO: 'Aprovados pelo risco',
  ORDEM_CRIADA: 'Ordem criada',
  ORDEM_PREENCHIDA: 'Ordem preenchida',
  RESULTADO: 'Resultado',
};

export interface FunnelStep {
  stage: FunnelStage;
  label: string;
  /** quantos sinais CHEGARAM a esta etapa */
  reached: number;
  /** quantos pararam aqui */
  stopped: number;
  /** os motivos de quem parou, do mais frequente para o menos */
  reasons: Array<{ code: DecisionCode; count: number; message: string }>;
}

export interface FunnelReport {
  steps: FunnelStep[];
  total: number;
  /** decisões consideradas, já deduplicadas por situação */
  decisions: number;
  since: string | null;
}

/**
 * Monta o funil a partir das decisões gravadas.
 *
 * Conta SETUPS, não decisões: um mesmo setup recusado quarenta vezes é um
 * sinal que parou numa porta, não quarenta sinais. Contar decisões faria a
 * etapa mais teimosa parecer a mais movimentada.
 */
export function buildFunnel(decisions: EntryDecisionRecord[]): FunnelReport {
  const porSetup = new Map<string, EntryDecisionRecord>();
  for (const decision of decisions) {
    const existing = porSetup.get(decision.setupId);
    // fica a decisão mais recente de cada setup: é ela que descreve onde o
    // sinal está agora, e não por onde já passou
    if (existing === undefined || decision.lastSeenAt > existing.lastSeenAt) {
      porSetup.set(decision.setupId, decision);
    }
  }

  const finais = [...porSetup.values()];
  const paradosPorEtapa = new Map<FunnelStage, EntryDecisionRecord[]>();
  for (const decision of finais) {
    const lista = paradosPorEtapa.get(decision.stage) ?? [];
    lista.push(decision);
    paradosPorEtapa.set(decision.stage, lista);
  }

  const total = finais.length;
  let restantes = total;
  const steps: FunnelStep[] = [];

  for (const stage of FUNNEL_ORDER) {
    const parados = paradosPorEtapa.get(stage) ?? [];
    // quem foi APROVADO não "parou" na etapa de aprovação: seguiu adiante
    const pararamAqui = stage === 'APROVADO_PELO_RISCO'
      ? parados.filter((decision) => !decision.allowed)
      : parados;

    const contagem = new Map<DecisionCode, { count: number; message: string }>();
    for (const decision of pararamAqui) {
      const primeiro = decision.blockers[0];
      if (primeiro === undefined) continue;
      const atual = contagem.get(primeiro.code);
      contagem.set(primeiro.code, {
        count: (atual?.count ?? 0) + 1,
        message: atual?.message ?? primeiro.message,
      });
    }

    steps.push({
      stage,
      label: FUNNEL_LABEL[stage],
      reached: restantes,
      stopped: pararamAqui.length,
      reasons: [...contagem.entries()]
        .map(([code, info]) => ({ code, count: info.count, message: info.message }))
        .sort((a, b) => b.count - a.count),
    });
    restantes -= pararamAqui.length;
  }

  const datas = finais.map((d) => d.firstSeenAt).sort();
  return {
    steps,
    total,
    decisions: decisions.length,
    since: datas[0] ?? null,
  };
}

/** Agrupa os motivos de recusa para a pergunta direta: "por que não entrou?". */
export function groupBlockReasons(
  decisions: EntryDecisionRecord[],
): Array<{ code: DecisionCode; count: number; message: string; symbols: string[] }> {
  const mapa = new Map<DecisionCode, { count: number; message: string; symbols: Set<string> }>();
  for (const decision of decisions) {
    if (decision.allowed) continue;
    const primeiro = decision.blockers[0];
    if (primeiro === undefined) continue;
    const atual = mapa.get(primeiro.code) ?? {
      count: 0,
      message: primeiro.message,
      symbols: new Set<string>(),
    };
    atual.count += 1;
    atual.symbols.add(decision.symbol);
    mapa.set(primeiro.code, atual);
  }
  return [...mapa.entries()]
    .map(([code, info]) => ({
      code,
      count: info.count,
      message: info.message,
      symbols: [...info.symbols].sort(),
    }))
    .sort((a, b) => b.count - a.count);
}
