import type { AppSettings, SymbolFilters, Trade } from '../../core/types.ts';
import { sideLabel } from '../../core/direction.ts';
import { buildExitPlan, SCALE_OUT, type ExitPlan } from '../../core/execution/exitPlan.ts';
import { formatPrice, formatQuantity } from '../../core/risk/index.ts';
import { quantidadeVendavel } from '../../core/execution/posicaoReal.ts';
import {
  explicarSaidaImediata,
  saidaImediataNecessaria,
} from '../../core/execution/protecaoPossivel.ts';
import {
  cancelAllOpenOrders,
  cancelOrderList,
  getAccountBalances,
  invalidateAccountCache,
  marketSell,
  newOcoSellOrder,
} from '../binance/rest.ts';
import {
  cancelAllFuturesOrders,
  futuresMarketExit,
  futuresStopOrder,
  futuresTakeProfitOrder,
} from '../binance/futures.ts';
import { logger } from '../logger.ts';
import type { AuditService } from './auditService.ts';
import type { SettingsService } from './settingsService.ts';

/**
 * O que aconteceu com a venda de emergência. Booleano não bastava: "não
 * vendeu" tem dois significados opostos — a corretora recusou (alarme) ou não
 * havia nada para vender (a posição não existe, e insistir é o próprio bug).
 */
export type SaidaDeEmergencia = 'VENDIDA' | 'CARTEIRA_VAZIA' | 'FALHOU';

export interface ProtectionResult {
  armed: boolean;
  kind: ExitPlan['kind'] | 'NONE';
  listIds: string[];
  notes: string[];
  /**
   * Por que não armou — e é o chamador que precisa disso, não o log.
   *
   * `CARTEIRA_VAZIA` não é uma falha a repetir na volta seguinte: o livro do
   * par foi esvaziado, o saldo foi relido fresco, e o ativo não está lá. Uma
   * posição que a corretora não tem não fica desprotegida — ela não existe, e
   * insistir em protegê-la foi o que produziu o alarme de minuto em minuto.
   */
  reason?: 'CARTEIRA_VAZIA' | 'RECUSADA' | 'SAIDA_IMEDIATA' | 'SAIDA_FALHOU';
}

/**
 * Tradução do desfecho da venda de emergência para o motivo que o chamador lê.
 *
 * Existe porque o desfecho deixou de ser booleano e um `? :` sobre a string
 * daria sempre o mesmo ramo — todo texto não vazio é verdadeiro. Uma tabela
 * não tem esse jeito de errar em silêncio.
 */
const MOTIVO_DA_SAIDA: Record<SaidaDeEmergencia, NonNullable<ProtectionResult['reason']>> = {
  VENDIDA: 'SAIDA_IMEDIATA',
  CARTEIRA_VAZIA: 'CARTEIRA_VAZIA',
  FALHOU: 'SAIDA_FALHOU',
};

/**
 * Quem garante que a posição aberta tem alvo e stop NA CORRETORA.
 *
 * Três coisas moram aqui porque as três dependem do mesmo par cancelar/recriar:
 *  - executar na conta real o mesmo plano de saída do papel;
 *  - subir o stop sem, no caminho, mandar uma ordem de compra (era o que o
 *    OTOCO fazia: ele nasce com uma ordem de trabalho de COMPRA);
 *  - cobrir a posição que a entrada preencheu pela metade, situação em que o
 *    OTOCO ainda não armou nada.
 *
 * Entre cancelar a proteção velha e a nova entrar no livro existe uma janela
 * em que a posição está descoberta. Não dá para eliminá-la — a corretora
 * prende o saldo na ordem existente. Dá para não sair dela em silêncio: toda
 * falha termina em venda a mercado ou em alarme gravado.
 */
export class LiveProtection {
  private readonly audit: AuditService;
  private readonly settings: SettingsService;
  /**
   * O preço de agora, para saber se o par de preços da proteção ainda cabe no
   * livro. Opcional porque os testes montam esta classe sem feed; sem ele o
   * comportamento é o antigo — tenta o OCO e trata a recusa.
   */
  private readonly precoDe: (symbol: string) => number | null;

  constructor(
    audit: AuditService,
    settings: SettingsService,
    precoDe: (symbol: string) => number | null = () => null,
  ) {
    this.audit = audit;
    this.settings = settings;
    this.precoDe = precoDe;
  }

  private guard(): AppSettings['guard'] {
    return this.settings.get().guard;
  }

  /**
   * Quanto do ativo a conta tem agora — livre E preso.
   *
   * Falha de leitura devolve a quantidade da operação: ficar sem proteção
   * porque a consulta de saldo não respondeu seria trocar um risco pequeno
   * (ordem recusada) pelo maior de todos (posição sem stop).
   *
   * Os dois números juntos respondem uma pergunta que o livre sozinho não
   * responde: "livre 0" significa que a posição não existe, ou que alguma
   * ordem ainda está segurando a moeda?
   *
   * A diferença decide o que o monitor faz depois. Sem ativo nenhum na conta,
   * a posição já não existe e insistir em protegê-la é o alarme de minuto em
   * minuto. Com moeda PRESA, existe posição e existe algo errado — e isso é
   * alarme de verdade, que ninguém pode arquivar sozinho.
   */
  private async saldoNaCarteira(
    trade: Trade,
    filters: SymbolFilters,
  ): Promise<{ free: number; locked: number }> {
    try {
      /*
       * Sem isto a resposta pode ser de ANTES do cancelamento que acabou de
       * acontecer — e aí a moeda ainda aparece presa na ordem que já não
       * existe. O cache do saldo dura dois segundos, e cancelar e reler leva
       * menos que isso: o "livre 0" que derrubou a proteção do MIRAUSDT em
       * 27/08/2026 era o retrato velho, não a carteira. `closeService` já
       * invalidava antes de ler; era a única diferença entre o botão
       * "Encerrar", que funcionava, e o stop automático, que não.
       */
      invalidateAccountCache();
      const balances = await getAccountBalances();
      const saldo = balances.find((item) => item.asset === filters.baseAsset);
      return { free: saldo?.free ?? 0, locked: saldo?.locked ?? 0 };
    } catch (error) {
      logger.warn('Saldo do ativo não pôde ser lido antes de proteger', {
        tradeId: trade.id,
        error: (error as Error).message,
      });
      // consulta que não respondeu não é carteira vazia: devolver a
      // quantidade da operação faz o caminho seguir tentando proteger
      return { free: trade.remainingQuantity, locked: 0 };
    }
  }

  /**
   * Deixa a corretora com exatamente a proteção que o plano pede para a
   * quantidade que está na mão agora.
   */
  async rearm(
    trade: Trade,
    filters: SymbolFilters,
    stopPrice: number,
    why: string,
  ): Promise<ProtectionResult> {
    if (trade.remainingQuantity <= 0) {
      return { armed: false, kind: 'NONE', listIds: [], notes: ['sem posição'] };
    }

    if (trade.market === 'FUTURES') return this.rearmFutures(trade, filters, stopPrice, why);

    await this.cancelExisting(trade);

    /*
     * O plano é feito sobre o que a CARTEIRA tem, não sobre o que a operação
     * diz ter.
     *
     * Sem BNB para pagar taxa, a Binance cobra a comissão da compra na moeda
     * comprada: entram 1156,94 de um preenchimento de 1158,1. Pedir o número
     * bruto não produz uma venda menor — produz recusa. Em 26/08/2026 isso
     * derrubou as três ordens de proteção E a venda de emergência, e uma
     * posição real passou 23 minutos sem stop. O encerramento manual já
     * limitava pela carteira; era o único lugar que limitava.
     */
    const carteira = await this.saldoNaCarteira(trade, filters);
    const quantity = quantidadeVendavel(trade.remainingQuantity, carteira.free, filters.stepSize);
    if (quantity <= 0) {
      const nota = `Carteira tem ${carteira.free} ${filters.baseAsset} livre e ${carteira.locked} preso em ordem`;
      /*
       * Moeda PRESA depois de o livro ter sido esvaziado é anomalia; ausência
       * total é posição que não existe. A distinção decide o que o chamador
       * faz — e o alarme sai de lá, não daqui. Alarmar neste ponto gritava
       * "posição sem proteção" mesmo quando o caminho seguinte recolocava a
       * proteção anterior ou vendia a mercado com sucesso.
       */
      const vazia = carteira.locked <= 0;
      return {
        armed: false,
        kind: 'NONE',
        listIds: [],
        notes: [nota],
        reason: vazia ? 'CARTEIRA_VAZIA' : 'RECUSADA',
      };
    }

    /*
     * O preço pode ter passado por cima do plano enquanto ninguém olhava.
     *
     * Aí o OCO é impossível por construção, não por saldo: a Binance recusa
     * com "The relationship of the prices for the orders is not correct" e o
     * sistema lia isso como "posição sem proteção", tentava de novo na volta
     * seguinte e repetia o alarme para sempre. Preço no alvo é lucro a
     * realizar, preço no stop é prejuízo a cortar — nos dois casos o que
     * resolve é vender agora.
     */
    const motivo = saidaImediataNecessaria({
      preco: this.precoDe(trade.symbol),
      stop: stopPrice,
      alvo: trade.target1,
      side: trade.side,
    });
    if (motivo !== null) {
      const nota = explicarSaidaImediata(motivo);
      logger.warn('Proteção substituída por saída a mercado', {
        tradeId: trade.id,
        symbol: trade.symbol,
        motivo,
      });
      const saida = await this.panicSell(trade, filters, `${why} — ${nota}`);
      return {
        armed: false,
        kind: 'NONE',
        listIds: [],
        notes: [nota],
        reason: MOTIVO_DA_SAIDA[saida],
      };
    }

    const guard = this.guard();
    const plan = buildExitPlan({
      quantity,
      target1: trade.target1,
      target2: guard.liveScaleOut ? trade.target2 : null,
      target3: guard.liveScaleOut ? trade.target3 : null,
      shares: guard.liveScaleOut ? SCALE_OUT : [1, 0, 0],
      filters: {
        stepSize: filters.stepSize,
        minQty: filters.minQty,
        minNotional: filters.minNotional,
      },
    });

    const stopTrigger = formatPrice(stopPrice, filters);
    const stopLimit = formatPrice(stopPrice - filters.tickSize, filters);
    const listIds: string[] = [];
    const notes = [...plan.notes];
    let placed = 0;

    for (const [index, tranche] of plan.tranches.entries()) {
      const listId = this.listIdFor(trade, index);
      try {
        const result = await newOcoSellOrder({
          symbol: trade.symbol,
          listClientOrderId: listId,
          quantity: formatQuantity(tranche.quantity, filters),
          takeProfitPrice: formatPrice(tranche.price, filters),
          stopPrice: stopTrigger,
          stopLimitPrice: stopLimit,
        });
        listIds.push(result.listClientOrderId || listId);
        placed += tranche.quantity;
      } catch (error) {
        notes.push(`${tranche.kind} recusado: ${(error as Error).message}`);
        logger.warn('Parcela de proteção recusada', {
          tradeId: trade.id,
          tranche: tranche.kind,
          error: (error as Error).message,
        });
      }
    }

    const uncovered = quantity - placed;
    if (uncovered > 0 && listIds.length > 0) {
      // sobrou posição sem cobertura: uma trava só, no alvo 1, é melhor que nada
      const rescued = await this.placeSingle(trade, filters, uncovered, stopTrigger, stopLimit);
      if (rescued) {
        listIds.push(rescued);
        notes.push('Sobra coberta por uma trava única no alvo 1');
      }
    }

    trade.protectionListIds = listIds;
    trade.exitPlanKind = plan.kind;

    if (listIds.length === 0) {
      return { armed: false, kind: 'NONE', listIds, notes, reason: 'RECUSADA' };
    }

    this.audit.record({
      action: 'LIVE_PROTECTION_ARMED',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: {
        motivo: why,
        plano: plan.kind,
        parcelas: plan.tranches.map((item) => ({ alvo: item.kind, quantidade: item.quantity })),
        stop: stopTrigger,
        listas: listIds,
        observacoes: notes,
      },
    });
    return { armed: true, kind: plan.kind, listIds, notes };
  }

  /**
   * Proteção de uma posição de FUTUROS.
   *
   * Não existe OCO aqui. O que existe é:
   *   - UM stop `closePosition` de mercado, que fecha o que houver e some
   *     sozinho quando a posição zera. É o mais parecido com o OCO do spot, e
   *     é o único desenho em que uma saída parcial não deixa um stop com
   *     quantidade velha pronto para inverter a posição;
   *   - uma ordem limitada `reduceOnly` por alvo.
   *
   * O gatilho do stop é o preço de MARCA, o mesmo que a corretora usa para
   * liquidar. Preso ao último negócio, um pavio isolado dispararia o stop sem
   * ter chegado perto da liquidação.
   */
  private async rearmFutures(
    trade: Trade,
    filters: SymbolFilters,
    stopPrice: number,
    why: string,
  ): Promise<ProtectionResult> {
    const quantity = trade.remainingQuantity;
    const guard = this.guard();

    // o livro do par é zerado inteiro: ordens reduceOnly que sobraram de um
    // rearme anterior não somem sozinhas e disputariam a mesma posição
    try {
      await cancelAllFuturesOrders(trade.symbol);
    } catch (error) {
      logger.warn('Livro de futuros não pôde ser limpo antes do rearme', {
        tradeId: trade.id,
        error: (error as Error).message,
      });
    }
    trade.protectionListIds = [];

    const plan = buildExitPlan({
      quantity,
      target1: trade.target1,
      target2: guard.liveScaleOut ? trade.target2 : null,
      target3: guard.liveScaleOut ? trade.target3 : null,
      shares: guard.liveScaleOut ? SCALE_OUT : [1, 0, 0],
      filters: {
        stepSize: filters.stepSize,
        minQty: filters.minQty,
        minNotional: filters.minNotional,
      },
    });

    const ids: string[] = [];
    const notes = [...plan.notes];

    // o stop primeiro, e SEMPRE: entre proteger o capital e perseguir o alvo,
    // a ordem de envio decide o que existe se a segunda chamada falhar
    let stopArmed = false;
    try {
      const stop = await futuresStopOrder({
        symbol: trade.symbol,
        positionSide: trade.side,
        stopPrice: formatPrice(stopPrice, filters),
        clientOrderId: this.listIdFor(trade, 0),
      });
      ids.push(String(stop.orderId));
      stopArmed = true;
    } catch (error) {
      notes.push(`Stop recusado: ${(error as Error).message}`);
    }

    for (const [index, tranche] of plan.tranches.entries()) {
      try {
        const order = await futuresTakeProfitOrder({
          symbol: trade.symbol,
          positionSide: trade.side,
          quantity: formatQuantity(tranche.quantity, filters),
          price: formatPrice(tranche.price, filters),
          clientOrderId: this.listIdFor(trade, index + 1),
        });
        ids.push(String(order.orderId));
      } catch (error) {
        notes.push(`${tranche.kind} recusado: ${(error as Error).message}`);
      }
    }

    trade.protectionListIds = ids;
    trade.exitPlanKind = plan.kind;

    if (!stopArmed) {
      return { armed: false, kind: 'NONE', listIds: ids, notes, reason: 'RECUSADA' };
    }

    this.audit.record({
      action: 'LIVE_PROTECTION_ARMED',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: {
        mercado: 'FUTURES',
        lado: sideLabel(trade.side),
        motivo: why,
        plano: plan.kind,
        parcelas: plan.tranches.map((item) => ({ alvo: item.kind, quantidade: item.quantity })),
        stop: stopPrice,
        ordens: ids,
        observacoes: notes,
      },
    });
    return { armed: true, kind: plan.kind, listIds: ids, notes };
  }

  /** Encerra a mercado o que ficou descoberto — último recurso, nunca silencioso. */
  async panicSell(trade: Trade, filters: SymbolFilters, why: string): Promise<SaidaDeEmergencia> {
    if (trade.remainingQuantity <= 0) return 'CARTEIRA_VAZIA';
    /*
     * A última rede não pode cair pelo mesmo motivo que derrubou as outras.
     *
     * Em 26/08/2026 as três ordens de proteção foram recusadas por saldo
     * insuficiente — e esta venda, que existe justamente para salvar o que
     * sobrou, pediu o mesmo número bruto e levou a mesma recusa. Em futuros
     * não há taxa em moeda-base: a posição é a que a corretora diz que é.
     *
     * E antes de olhar o saldo, o livro do par é esvaziado. Quem segura a
     * moeda depois do preenchimento é a própria proteção — inclusive ordens
     * com ids que nunca chegaram ao banco. Ler o saldo com elas de pé devolve
     * "livre 0" com a carteira cheia, e a rede de segurança cai por causa da
     * rede de segurança anterior.
     */
    if (trade.market !== 'FUTURES') await this.esvaziarLivro(trade);
    const carteira =
      trade.market === 'FUTURES'
        ? { free: trade.remainingQuantity, locked: 0 }
        : await this.saldoNaCarteira(trade, filters);
    const quantity = quantidadeVendavel(trade.remainingQuantity, carteira.free, filters.stepSize);
    if (quantity <= 0) {
      if (carteira.locked > 0) {
        await this.alarm(trade, `${why} — ${carteira.locked} ${filters.baseAsset} preso em ordem`, [
          'o livro do par foi esvaziado e a moeda continua presa; a venda a mercado não tem o que vender',
        ]);
        return 'FALHOU';
      }
      return 'CARTEIRA_VAZIA';
    }
    try {
      if (trade.market === 'FUTURES') {
        await cancelAllFuturesOrders(trade.symbol);
        await futuresMarketExit({
          symbol: trade.symbol,
          positionSide: trade.side,
          quantity: formatQuantity(quantity, filters),
          clientOrderId: this.listIdFor(trade, 98),
        });
      } else {
        await marketSell(trade.symbol, formatQuantity(quantity, filters), this.listIdFor(trade, 99));
      }
      this.audit.record({
        action: 'LIVE_PANIC_SELL',
        mode: trade.mode,
        symbol: trade.symbol,
        setupId: trade.setupId,
        tradeId: trade.id,
        detail: { motivo: why, quantidade: quantity, naOperacao: trade.remainingQuantity },
      });
      return 'VENDIDA';
    } catch (error) {
      await this.alarm(trade, `${why} — e a venda a mercado também falhou`, [
        (error as Error).message,
      ]);
      return 'FALHOU';
    }
  }

  private async placeSingle(
    trade: Trade,
    filters: SymbolFilters,
    quantity: number,
    stopTrigger: string,
    stopLimit: string,
  ): Promise<string | null> {
    try {
      const result = await newOcoSellOrder({
        symbol: trade.symbol,
        listClientOrderId: this.listIdFor(trade, 90),
        quantity: formatQuantity(quantity, filters),
        takeProfitPrice: formatPrice(trade.target1, filters),
        stopPrice: stopTrigger,
        stopLimitPrice: stopLimit,
      });
      return result.listClientOrderId;
    } catch {
      return null;
    }
  }

  private async cancelExisting(trade: Trade): Promise<void> {
    const lists = [...new Set([...(trade.protectionListIds ?? []), trade.clientOrderId])];
    for (const listId of lists) {
      try {
        await cancelOrderList(trade.symbol, listId);
      } catch (error) {
        // lista já encerrada ou inexistente é o caso comum, não é erro
        logger.debug('Lista de proteção não cancelada', {
          tradeId: trade.id,
          listId,
          error: (error as Error).message,
        });
      }
    }
    await this.esvaziarLivro(trade);
    trade.protectionListIds = [];
  }

  /**
   * Nada do par fica de pé no livro — e o saldo é relido depois disso.
   *
   * Cancelar só as listas que este servidor lembra tem um ponto cego que já
   * custou caro: a proteção é recriada com ids novos, e os ids nem sempre
   * chegam ao banco antes de o processo reiniciar. O que sobra no livro
   * continua segurando a moeda, e a leitura de saldo seguinte responde "livre
   * 0" com a carteira cheia. `closeService` já fazia exatamente isto ao
   * encerrar — era a diferença entre o botão que funcionava e o stop
   * automático que não.
   */
  private async esvaziarLivro(trade: Trade): Promise<void> {
    try {
      await cancelAllOpenOrders(trade.symbol);
    } catch (error) {
      logger.debug('Livro do par não pôde ser esvaziado antes de proteger', {
        tradeId: trade.id,
        error: (error as Error).message,
      });
    }
  }

  /** Id único e curto: a Binance recusa repetido e corta acima de 36 caracteres. */
  private listIdFor(trade: Trade, index: number): string {
    const stamp = Date.now().toString(36).slice(-6);
    return `${trade.clientOrderId}x${stamp}${index}`.slice(0, 36);
  }

  private async alarm(trade: Trade, why: string, notes: string[]): Promise<void> {
    this.audit.record({
      action: 'PROTECTIVE_STOP_FAILED',
      mode: trade.mode,
      symbol: trade.symbol,
      setupId: trade.setupId,
      tradeId: trade.id,
      detail: {
        alerta: 'POSIÇÃO SEM PROTEÇÃO NA CORRETORA — encerre manualmente',
        motivo: why,
        observacoes: notes,
      },
    });
    logger.error('Posição sem proteção na corretora', { tradeId: trade.id, symbol: trade.symbol, why });
  }
}
