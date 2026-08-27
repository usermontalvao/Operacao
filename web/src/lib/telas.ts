import { api } from './api.ts';
import { adiantar } from './resource.ts';
import type { Tab } from '../components/NavTabs.tsx';
import { buildPeriod, periodQuery, type PeriodId } from '../components/PeriodFilter.tsx';

/**
 * Chave de cache e busca de cada aba, em um lugar só.
 *
 * A página usa isto para carregar e a navegação usa para adiantar quando o
 * ponteiro encosta na aba. Se cada lado tivesse a sua cópia, o "adiantar"
 * gravaria numa chave e a página leria de outra — o cache existiria e nunca
 * seria aproveitado, que é o tipo de defeito que não dá erro, só lentidão.
 */

export const chaveOperacoes = 'operacoes';
/**
 * O histórico de teses é uma chave só dele, e de propósito.
 *
 * Ele vinha junto com a carteira, então as abas "Em andamento" e "Encerradas"
 * baixavam 1,25 MB de teses a cada 5 segundos para não mostrar nenhuma. Agora
 * só a aba que o exibe o pede — e num ritmo mais folgado, porque uma tese
 * registrada não muda mais.
 */
export const chaveSetupsHistorico = 'setups-historico';
/** Chave inerte: `useResource` precisa de uma, e esta não busca nada. */
export const chaveOciosa = 'ociosa';
export const chaveAjustes = 'ajustes';
export const chaveDesempenho = (periodo: PeriodId): string => `desempenho:${periodo}`;
export const chaveDiario = (periodo: PeriodId): string => `diario:${periodo}`;

/** Período que as duas telas abrem por padrão — é o que vale a pena adiantar. */
export const PERIODO_PADRAO: PeriodId = 'MES';

export async function buscarOperacoes() {
  const [equity, trades] = await Promise.all([api.equity(), api.trades()]);
  return { equity, trades };
}

export async function buscarSetupsHistorico() {
  return api.setupHistory();
}

export async function buscarAjustes() {
  const [settings, riskState] = await Promise.all([
    api.settings(),
    api.risk().catch(() => null),
  ]);
  return { settings, riskState };
}

export async function buscarDesempenho(consulta: string) {
  const [stats, equity] = await Promise.all([api.performance(consulta), api.equity()]);
  return { stats, equity };
}

export async function buscarDiario(consulta: string) {
  const [decisions, factors] = await Promise.all([api.decisions(consulta), api.factors(consulta)]);
  return { decisions, factors: factors.factors };
}

/**
 * Começa a busca da aba antes do clique. O Radar não entra: ele vive do
 * estado ao vivo que já está carregado, e não há o que adiantar.
 */
export function adiantarAba(aba: Tab): void {
  const consulta = periodQuery(buildPeriod(PERIODO_PADRAO));
  if (aba === 'HISTORICO') adiantar(chaveOperacoes, buscarOperacoes);
  else if (aba === 'AJUSTES') adiantar(chaveAjustes, buscarAjustes);
  else if (aba === 'DESEMPENHO')
    adiantar(chaveDesempenho(PERIODO_PADRAO), () => buscarDesempenho(consulta));
  else if (aba === 'DIARIO') adiantar(chaveDiario(PERIODO_PADRAO), () => buscarDiario(consulta));
}
