import type { Trade } from '../../core/types.ts';
import { invalidateAccountCache } from '../binance/rest.ts';
import type { EventBus } from '../events.ts';
import { logger } from '../logger.ts';
import type { ExecutionService } from './executionService.ts';
import type { SettingsService } from './settingsService.ts';

/**
 * Janela de agrupamento.
 *
 * Um preenchimento produz uma rajada de avisos — execução, saldo, posição —
 * em poucos milissegundos, e cada um deles pede a mesma leitura de conta. Sem
 * a janela, uma ordem que preenche em cinco partes vira cinco consultas
 * assinadas seguidas, que é o caminho mais curto para um 429 da corretora.
 */
const JANELA_MS = 400;

/**
 * O que, numa operação, mexe no dinheiro.
 *
 * O evento de operação é barulhento de propósito: no DEMO ele sai a cada
 * tique que renova o topo do preço, várias vezes por segundo. Reagir a todos
 * transformaria cada um numa leitura de conta — consulta assinada na
 * corretora ou varredura no banco. O que importa é o punhado de campos
 * abaixo; enquanto eles não mudam, não há saldo novo para mostrar.
 */
function assinaturaFinanceira(trade: Trade): string {
  return [
    trade.status,
    trade.filledQuantity,
    trade.remainingQuantity,
    trade.realizedPnl,
    trade.feesPaid,
    trade.notional,
  ].join('|');
}

/**
 * O saldo do topo da tela, empurrado em vez de perguntado.
 *
 * Antes o número só mudava na volta do relógio de 15 segundos do navegador:
 * a ordem executava, o dinheiro saía da conta na Binance e o painel seguia
 * mostrando o saldo de antes — tempo suficiente para a pessoa achar que a
 * ordem não saiu e mandar de novo. O aviso da corretora chega no instante do
 * negócio; daqui ele vira um evento para a tela.
 *
 * A leitura continua sendo a da corretora (ou a da carteira de papel): o que
 * mudou foi QUANDO ela é feita, não de onde o número vem. Inventar o saldo
 * novo somando o que se acha que a ordem gastou seria criar uma segunda
 * contabilidade para divergir da primeira.
 */
export class BalanceFeed {
  private readonly execution: ExecutionService;
  private readonly settings: SettingsService;
  private readonly bus: EventBus;
  private timer: NodeJS.Timeout | null = null;
  /** uma leitura por vez: a rajada seguinte espera esta terminar */
  private emAndamento = false;
  private pedidoDurante = false;
  /** último retrato financeiro de cada operação, para ignorar o resto */
  private readonly assinaturas = new Map<string, string>();

  constructor(execution: ExecutionService, settings: SettingsService, bus: EventBus) {
    this.execution = execution;
    this.settings = settings;
    this.bus = bus;
  }

  /**
   * A operação mudou — mas mudou o DINHEIRO?
   *
   * Devolve `true` só quando vale pedir saldo de novo. É a mesma pergunta que
   * a tela faz para decidir se recarrega a carteira, e por isso a resposta
   * mora aqui: um lugar só, a mesma regra dos dois lados.
   */
  mexeuNoDinheiro(trade: Trade): boolean {
    const assinatura = assinaturaFinanceira(trade);
    const anterior = this.assinaturas.get(trade.id);
    if (anterior === assinatura) return false;
    if (trade.status === 'CLOSED' || trade.status === 'CANCELLED') {
      // encerrada não muda mais: guardar a assinatura dela seria vazamento
      this.assinaturas.delete(trade.id);
    } else {
      this.assinaturas.set(trade.id, assinatura);
    }
    return true;
  }

  /** Alguma coisa mexeu no dinheiro: mande o saldo novo assim que der. */
  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.push();
    }, JANELA_MS);
    this.timer.unref?.();
  }

  async push(): Promise<void> {
    if (this.emAndamento) {
      // não descarta: quem chegou no meio da leitura anterior é justamente
      // quem tem a novidade mais recente
      this.pedidoDurante = true;
      return;
    }
    this.emAndamento = true;
    try {
      // este é o único lugar que NÃO pode aceitar saldo guardado: ele existe
      // para contar que o dinheiro mudou
      invalidateAccountCache();
      const { mode, market } = this.settings.get();
      const capital = await this.execution.getCapital(mode, market);
      this.bus.broadcast({
        type: 'balance',
        payload: {
          capital: capital.capital,
          available: capital.available,
          source: capital.source,
          currency: capital.currency,
          brlRate: capital.brlRate,
          mode,
          market,
        },
      });
    } catch (error) {
      // saldo indisponível não pode virar erro na tela: o painel já sabe
      // desenhar "DADOS INDISPONÍVEIS" pela consulta que continua existindo
      logger.debug('Não foi possível empurrar o saldo', { error: (error as Error).message });
    } finally {
      this.emAndamento = false;
      if (this.pedidoDurante) {
        this.pedidoDurante = false;
        this.schedule();
      }
    }
  }
}
