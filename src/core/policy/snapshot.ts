import type { CostSettings } from '../risk/costs.ts';
import type { GuardSettings } from '../risk/governor.ts';
import type {
  AutoTradeSettings,
  BtcContextState,
  RiskSettings,
  TradingMode,
} from '../types.ts';

/**
 * Versões das políticas que decidem.
 *
 * Sem isto, ler uma operação de semanas atrás usa as configurações de HOJE — e
 * a conclusão sai errada com toda a aparência de estar certa: "por que ele
 * comprou com score 88 se o mínimo é 90?" tem como resposta "porque naquele
 * dia o mínimo era 85", e essa resposta não existia em lugar nenhum.
 *
 * Suba a versão quando a REGRA mudar, não quando o código for reorganizado.
 * O que a versão promete é: duas operações com a mesma versão foram julgadas
 * pelo mesmo critério.
 */
export const STRATEGY_VERSION = 'per-setup-opportunity-engine@2';
export const SCORING_VERSION = 'score-engine@1';
export const RISK_POLICY_VERSION = 'risk-by-stop-with-costs@1';
export const EXECUTION_POLICY_VERSION = 'confirm-token-idempotent@1';

/**
 * Retrato imutável da política no instante da decisão.
 *
 * Guarda os NÚMEROS, não uma referência às configurações. Referência muda
 * junto; número fica.
 */
export interface PolicySnapshot {
  strategyVersion: string;
  scoringVersion: string;
  riskPolicyVersion: string;
  executionPolicyVersion: string;
  /** commit da build, quando o processo souber qual é */
  codeVersion: string | null;
  mode: TradingMode;
  autoTrade: AutoTradeSettings;
  risk: RiskSettings;
  guard: GuardSettings;
  costs: CostSettings;
  /** regime de mercado no momento — o mesmo setup vale diferente em cada um */
  btcContext: BtcContextState | null;
  capturedAt: string;
}

export function capturePolicySnapshot(input: {
  mode: TradingMode;
  autoTrade: AutoTradeSettings;
  risk: RiskSettings;
  guard: GuardSettings;
  btcContext: BtcContextState | null;
  now?: Date;
}): PolicySnapshot {
  const { guard } = input;
  return {
    strategyVersion: STRATEGY_VERSION,
    scoringVersion: SCORING_VERSION,
    riskPolicyVersion: RISK_POLICY_VERSION,
    executionPolicyVersion: EXECUTION_POLICY_VERSION,
    codeVersion: readCodeVersion(),
    mode: input.mode,
    // cópias rasas por valor: a intenção é congelar, então nada aqui pode
    // continuar apontando para o objeto vivo das configurações
    autoTrade: {
      ...input.autoTrade,
      ...(input.autoTrade.strategies
        ? {
            strategies: Object.fromEntries(
              Object.entries(input.autoTrade.strategies).map(([key, value]) => [key, { ...value }]),
            ) as AutoTradeSettings['strategies'],
          }
        : {}),
    },
    risk: { ...input.risk },
    guard: { ...guard },
    costs: {
      feePercent: guard.feePercent,
      stopSlippagePercent: guard.stopSlippagePercent,
      exitSlippagePercent: guard.exitSlippagePercent,
    },
    btcContext: input.btcContext,
    capturedAt: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * Operações antigas não têm retrato. Em vez de inventar um com os valores de
 * hoje — que é exatamente a mentira que este módulo existe para evitar — o
 * retrato ausente é declarado como ausente.
 */
export function describePolicy(snapshot: PolicySnapshot | null): string {
  if (snapshot === null) return 'Política não registrada (operação anterior ao versionamento)';
  return `${snapshot.strategyVersion} · score ${snapshot.scoringVersion} · risco ${snapshot.riskPolicyVersion}`;
}

function readCodeVersion(): string | null {
  const fromEnv =
    typeof process !== 'undefined' ? (process.env?.CODE_VERSION ?? process.env?.GIT_SHA) : undefined;
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}
