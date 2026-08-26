import { EventEmitter } from 'node:events';
import type { MarketKind, TradingMode } from '../../core/types.ts';
import { environmentForMode } from '../config.ts';
import { logger } from '../logger.ts';
import type { OrderExecutionEvent } from './userEvents.ts';
import { UserDataStream } from './userStream.ts';

/** Execução avisada pela corretora, já carimbada com a modalidade de onde veio. */
export interface MarketExecutionEvent {
  market: MarketKind;
  event: OrderExecutionEvent;
}

/** O mínimo que esta conta precisa saber de uma operação para decidir o fluxo. */
export interface TradeComConta {
  mode: TradingMode;
  market?: MarketKind;
}

/**
 * As modalidades que precisam de fluxo agora.
 *
 * A que está em exibição, mais qualquer uma que tenha posição viva na
 * corretora: trocar a tela para spot não faz a posição de futuros parar de
 * existir, e é justamente enquanto ninguém está olhando que o preenchimento
 * precisa ser ouvido. Operação de papel não conta — ela não tem ordem lá.
 */
export function marketsWithAccount(
  displayed: MarketKind,
  openTrades: TradeComConta[],
): MarketKind[] {
  return [
    ...new Set<MarketKind>([
      displayed,
      ...openTrades
        .filter((trade) => trade.mode !== 'PAPER')
        .map((trade) => trade.market ?? 'SPOT'),
    ]),
  ];
}

/**
 * Os fluxos de conta do painel — um por modalidade.
 *
 * Existe por duas razões que custaram caro:
 *
 *  1. SPOT E FUTUROS SÃO DUAS CONTAS. Cada uma tem endpoint de chave, host de
 *     socket e credenciais próprios. Enquanto havia um fluxo só, futuros nunca
 *     recebeu um evento sequer: a ordem preenchia na Binance e o painel seguia
 *     mostrando AGUARDANDO até a próxima volta da reconciliação.
 *  2. O FLUXO PRECISA SEGUIR O QUE ESTÁ NA TELA. Antes ele era aberto uma vez
 *     no boot e só se o painel já tivesse subido em conta real. Quem começava
 *     em DEMO e trocava para a conta real depois — o caminho normal — operava
 *     o resto da sessão inteira sem fluxo nenhum. Trocar de rede
 *     (produção ↔ testnet) também exige refazer: a chave pertence à rede em
 *     que foi criada.
 */
export class AccountStreams extends EventEmitter {
  private readonly streams = new Map<MarketKind, UserDataStream>();
  /** ambiente com que cada fluxo foi aberto — mudou, tem de renascer */
  private readonly openedAs = new Map<MarketKind, string>();

  private stream(market: MarketKind): UserDataStream {
    const existing = this.streams.get(market);
    if (existing) return existing;
    const created = new UserDataStream(market);
    created.on('execution', (event: OrderExecutionEvent) => {
      this.emit('execution', { market, event } satisfies MarketExecutionEvent);
    });
    created.on('balance', (payload: unknown) => this.emit('balance', { market, payload }));
    created.on('status', () => this.emit('status'));
    this.streams.set(market, created);
    return created;
  }

  /** O fluxo desta modalidade está entregando notícia agora? */
  isLive(market: MarketKind): boolean {
    return this.streams.get(market)?.isLive() ?? false;
  }

  /**
   * Alinha os fluxos ao que o painel está operando.
   *
   * Em DEMO não há ordem na corretora para acompanhar, então nada fica aberto.
   * Fora dele, abre-se o fluxo da modalidade em exibição — e o da outra
   * modalidade continua de pé enquanto ela tiver posição viva, porque uma
   * posição de spot não deixa de existir quando a tela vai para futuros.
   */
  sync(mode: TradingMode, markets: MarketKind[]): void {
    const wanted = mode === 'PAPER' ? new Set<MarketKind>() : new Set(markets);

    for (const market of ['SPOT', 'FUTURES'] as const) {
      const environment = environmentForMode(mode, market);
      const stream = this.streams.get(market);

      if (!wanted.has(market) || !environment.hasCredentials) {
        if (stream && this.openedAs.has(market)) {
          this.openedAs.delete(market);
          void stream.stop();
          logger.info('Fluxo da conta encerrado', { modalidade: market });
        }
        continue;
      }

      const already = this.openedAs.get(market);
      if (already === environment.name) continue;
      if (already) {
        // trocou de rede: a chave da antiga não vale na nova, e o socket
        // aberto continuaria entregando eventos da conta errada
        void this.streams.get(market)?.stop();
      }
      this.openedAs.set(market, environment.name);
      this.stream(market).start();
      logger.info('Fluxo da conta solicitado', { modalidade: market, ambiente: environment.name });
    }
  }

  async stop(): Promise<void> {
    this.openedAs.clear();
    await Promise.all([...this.streams.values()].map((stream) => stream.stop()));
  }
}
