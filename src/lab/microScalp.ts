/**
 * O BACKTEST DO MICRO SCALP — a pergunta que decide se o módulo fica.
 *
 * Gerar sinal não é evidência de nada. Um detector que compra toda borda de
 * toda faixa gera centenas de sinais por dia e pode perder dinheiro em todos
 * eles: com alvo curto, o custo é o termo dominante, e um sistema que acerta
 * 60% ainda perde se o alvo não pagar a viagem com folga.
 *
 * Este estudo mede o que interessa, SEPARADO dos outros setups:
 *
 *   - quantos sinais nasceram e quantos preencheram;
 *   - taxa de acerto, fator de lucro e expectativa por operação;
 *   - resultado BRUTO, quanto foi para taxa e escorregamento, e o LÍQUIDO;
 *   - a mesma conta por moeda e por modalidade (spot × futuros);
 *   - a taxa de acerto que a estratégia PRECISARIA ter para empatar.
 *
 * Esta última linha é a mais importante do relatório. Ela transforma "o
 * resultado deu X" em "o resultado precisaria ser Y para valer a pena" — e é
 * a única forma de saber se um período bom foi estratégia ou sorte.
 *
 * Rode com:
 *   node --env-file-if-exists=.env src/lab/microScalp.ts --symbols=12 --hours=48
 *
 * LIMITAÇÃO CONHECIDA E IMPORTANTE: o histórico da Binance não traz o book
 * passado. Spread e profundidade são medidos AGORA e aplicados a todo o
 * período — então o custo simulado é otimista nos momentos de estresse, que
 * são justamente aqueles em que o book abre. Trate o resultado como um TETO.
 */

import type { Candle, MarketKind } from '../core/types.ts';
import { MICRO_TIMEFRAME } from '../core/types.ts';
import { atr } from '../core/indicators/index.ts';
import { DEFAULT_MICRO_SCALP } from '../core/scalp/config.ts';
import { measureLiquidity } from '../core/scalp/liquidity.ts';
import { scoreScalpability } from '../core/scalp/scalpability.ts';
import { analyzeRangeRegime } from '../core/scalp/rangeRegime.ts';
import { computeMicroEconomics, microOpportunityRejection } from '../core/scalp/microEconomics.ts';
import { detectRangeFadeLong, detectRangeFadeShort } from '../core/setups/index.ts';
import { computeIndicators } from '../core/engines/indicatorEngine.ts';
import { computeStructure } from '../core/engines/structureEngine.ts';
import { DEFAULT_FEE_PERCENT, DEFAULT_FUTURES_FEE_PERCENT } from '../core/risk/costs.ts';
import type { SymbolAnalysis } from '../core/analysis.ts';

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? (hit.split('=')[1] ?? fallback) : fallback;
}

const BASE = 'https://api.binance.com/api/v3';

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} em ${url}`);
  return (await response.json()) as T;
}

async function candles(symbol: string, limit: number, interval = '1m'): Promise<Candle[]> {
  const raw = await json<unknown[][]>(
    `${BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  );
  return raw.map((k) => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: Number(k[6]),
    quoteVolume: Number(k[7]),
    closed: true,
  }));
}

interface Resultado {
  symbol: string;
  market: MarketKind;
  side: 'BUY' | 'SELL';
  bruto: number;
  custo: number;
  liquido: number;
  barras: number;
  ganhou: boolean;
  preencheu: boolean;
}

/**
 * Leva um sinal ao desfecho barra a barra, com a MESMA convenção pessimista
 * do resto do laboratório: dentro da barra, o stop acontece antes do alvo.
 */
function simular(
  serie: Candle[],
  inicio: number,
  entrada: number,
  stop: number,
  alvo: number,
  side: 'BUY' | 'SELL',
  custoPercent: number,
  ttlBarras: number,
  symbol: string,
  market: MarketKind,
): Resultado | null {
  const comprado = side === 'BUY';
  let preencheu = false;
  let barrasAteEntrar = 0;

  for (let i = inicio + 1; i < serie.length && i <= inicio + ttlBarras; i += 1) {
    const barra = serie[i] as Candle;
    if (comprado ? barra.low <= entrada : barra.high >= entrada) {
      preencheu = true;
      barrasAteEntrar = i - inicio;
      break;
    }
  }
  if (!preencheu) {
    return {
      symbol, market, side,
      bruto: 0, custo: 0, liquido: 0, barras: 0, ganhou: false, preencheu: false,
    };
  }

  const entradaIndex = inicio + barrasAteEntrar;
  for (let i = entradaIndex + 1; i < serie.length; i += 1) {
    const barra = serie[i] as Candle;
    const bateuStop = comprado ? barra.low <= stop : barra.high >= stop;
    const bateuAlvo = comprado ? barra.high >= alvo : barra.low <= alvo;
    // convenção pessimista: com os dois na mesma barra, vale o stop
    if (bateuStop) return fechar(stop, i);
    if (bateuAlvo) return fechar(alvo, i);
  }
  const ultima = serie[serie.length - 1] as Candle;
  return fechar(ultima.close, serie.length - 1);

  function fechar(preco: number, indice: number): Resultado {
    const bruto = comprado
      ? ((preco - entrada) / entrada) * 100
      : ((entrada - preco) / entrada) * 100;
    return {
      symbol, market, side,
      bruto,
      custo: custoPercent,
      liquido: bruto - custoPercent,
      barras: indice - entradaIndex,
      ganhou: bruto - custoPercent > 0,
      preencheu: true,
    };
  }
}

function resumo(nome: string, itens: Resultado[]): string {
  const entrou = itens.filter((i) => i.preencheu);
  if (entrou.length === 0) return `${nome.padEnd(16)} nenhum preenchimento`;

  const ganhos = entrou.filter((i) => i.liquido > 0);
  const perdas = entrou.filter((i) => i.liquido <= 0);
  const somaGanhos = ganhos.reduce((t, i) => t + i.liquido, 0);
  const somaPerdas = Math.abs(perdas.reduce((t, i) => t + i.liquido, 0));
  const bruto = entrou.reduce((t, i) => t + i.bruto, 0);
  const custo = entrou.reduce((t, i) => t + i.custo, 0);
  const liquido = entrou.reduce((t, i) => t + i.liquido, 0);
  const acerto = (ganhos.length / entrou.length) * 100;
  const mediaGanho = ganhos.length > 0 ? somaGanhos / ganhos.length : 0;
  const mediaPerda = perdas.length > 0 ? somaPerdas / perdas.length : 0;
  const empate = mediaGanho + mediaPerda > 0 ? (mediaPerda / (mediaGanho + mediaPerda)) * 100 : 0;
  const pf = somaPerdas > 0 ? somaGanhos / somaPerdas : Infinity;

  // pior sequência de queda do acumulado
  let pico = 0;
  let acumulado = 0;
  let drawdown = 0;
  for (const item of entrou) {
    acumulado += item.liquido;
    pico = Math.max(pico, acumulado);
    drawdown = Math.min(drawdown, acumulado - pico);
  }

  return [
    nome.padEnd(16),
    String(entrou.length).padStart(6),
    `${acerto.toFixed(1)}%`.padStart(8),
    `${empate.toFixed(1)}%`.padStart(10),
    (Number.isFinite(pf) ? pf.toFixed(2) : '∞').padStart(6),
    `${(liquido / entrou.length).toFixed(4)}%`.padStart(11),
    `${bruto >= 0 ? '+' : ''}${bruto.toFixed(2)}%`.padStart(10),
    `−${custo.toFixed(2)}%`.padStart(10),
    `${liquido >= 0 ? '+' : ''}${liquido.toFixed(2)}%`.padStart(10),
    `${drawdown.toFixed(2)}%`.padStart(9),
    `${(entrou.reduce((t, i) => t + i.barras, 0) / entrou.length).toFixed(0)}min`.padStart(8),
  ].join(' ');
}

async function main(): Promise<void> {
  const quantos = Number(arg('symbols', '12'));
  const horas = Number(arg('hours', '16'));
  const barras = Math.min(1000, horas * 60);
  const micro = DEFAULT_MICRO_SCALP;

  console.log(`\nMicro scalp · backtest separado · ${horas}h de candles de 1m\n`);

  const tickers = await json<Array<{ symbol: string; quoteVolume: string }>>(`${BASE}/ticker/24hr`);
  const universo = tickers
    .filter((t) => t.symbol.endsWith('USDT'))
    .map((t) => ({ symbol: t.symbol, volume: Number(t.quoteVolume) }))
    /*
     * O piso de volume do ESTUDO é separado do piso de produção de propósito.
     *
     * Em produção o filtro é conservador. Aqui ele atrapalha a amostragem: os
     * pares de maior volume são BTC, ETH e BNB, justamente os de menor
     * amplitude em 1 minuto — medir só eles responde uma pergunta que a
     * aritmética já respondeu. Baixar o piso é o que permite alcançar as
     * moedas de porte médio, que é onde o módulo foi desenhado para agir.
     */
    .filter((t) => t.volume >= Number(arg('minVolume', String(micro.filters.minQuoteVolume24h))))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, quantos);

  const resultados: Resultado[] = [];
  const funil = { pares: 0, aptos: 0, janelas: 0, comFaixa: 0, comSinal: 0, aprovados: 0 };
  const recusas = new Map<string, number>();
  /*
   * Quem passou, com a nota. Sem esta lista, um relatório de zero operações é
   * ambíguo entre "o detector não acha nada" e "nenhum par chegou até ele" —
   * e as duas conclusões pedem ações opostas.
   */
  const aptos: Array<{ symbol: string; score: number; atr: number | null; custo: number }> = [];

  for (const item of universo) {
    funil.pares += 1;
    const serie = await candles(item.symbol, barras);
    if (serie.length < 200) continue;

    /*
     * A ÂNCORA DE 15 MINUTOS — e ela não é um detalhe do estudo.
     *
     * A primeira versão passava o próprio 1m como âncora, por preguiça de
     * baixar outra série, e o resultado foi zero sinal em 102 janelas com
     * faixa confirmada. O motivo é circular e instrutivo: o preço só chega ao
     * FUNDO da faixa caindo, então a estrutura de 1m naquele instante lê
     * quase sempre "tendência de baixa" — e a trava de âncora recusava
     * exatamente as entradas que o detector existe para encontrar.
     *
     * Em produção `anchorFor('1m')` devolve '15m', que é outra pergunta: não
     * "o preço acabou de cair?" mas "o mercado maior está desabando?". Medir
     * com o 1m como âncora seria medir um sistema que não é o que roda.
     */
    const serie15m = await candles(item.symbol, Math.max(60, Math.ceil(barras / 15) + 60), '15m');
    const ind15m = computeIndicators(serie15m, '15m');
    const ancora = {
      timeframe: '15m' as const,
      candles: serie15m,
      indicators: ind15m,
      structure: computeStructure(serie15m, ind15m),
    };

    const book = await json<{ bids: [string, string][]; asks: [string, string][] }>(
      `${BASE}/depth?symbol=${item.symbol}&limit=100`,
    );
    const liquidez = measureLiquidity({
      symbol: item.symbol,
      bids: book.bids.map(([p, q]) => [Number(p), Number(q)]),
      asks: book.asks.map(([p, q]) => [Number(p), Number(q)]),
      quoteVolume24h: item.volume,
      recentQuoteVolume: serie.slice(-15).reduce((t, c) => t + c.quoteVolume, 0),
      probeOrderUsd: micro.probeOrderUsd,
      measuredAt: Date.now(),
    });
    if (!liquidez) continue;

    /*
     * As duas modalidades pagam taxas diferentes sobre o MESMO par e o mesmo
     * sinal. Rodar as duas lado a lado é o ponto: em alvo curto, a diferença
     * entre 0,1% e 0,05% por lado não é um detalhe contábil — ela decide
     * quais sinais chegam a existir.
     */
    for (const market of ['SPOT', 'FUTURES'] as MarketKind[]) {
      const feePercent = market === 'FUTURES' ? DEFAULT_FUTURES_FEE_PERCENT : DEFAULT_FEE_PERCENT;
      const apto = scoreScalpability({
        liquidity: liquidez,
        microAtrPercent: microAtr(serie),
        filters: micro.filters,
        weights: micro.weights,
        feePercent,
        fallbackSlippagePercent: 0.1,
        minCostMultiple: micro.regime.minCostMultiple,
        enforce: true,
      });
      if (apto.blocked) {
        conta(recusas, `par: ${apto.blockers[0]}`);
        continue;
      }
      if (market === 'SPOT') {
        funil.aptos += 1;
        aptos.push({
          symbol: item.symbol,
          score: apto.score,
          atr: apto.microAtrPercent,
          custo: apto.allInCostPercent,
        });
      }

      // janela deslizante: a cada 5 barras, como se o scanner tivesse rodado ali
      for (let fim = 120; fim < serie.length - 30; fim += 5) {
        const historico = serie.slice(0, fim);
        if (market === 'SPOT') funil.janelas += 1;

        const regime = analyzeRangeRegime({
          candles: historico,
          settings: micro.regime,
          allInCostPercent: apto.allInCostPercent,
        });
        if (regime.verdict !== 'RANGE') {
          conta(recusas, `regime: ${regime.verdict}`);
          continue;
        }
        if (market === 'SPOT') funil.comFaixa += 1;

        const analysis = montarAnalise(item.symbol, historico);
        const trigger = analysis.timeframes[MICRO_TIMEFRAME];
        if (!trigger) continue;

        const lados = market === 'FUTURES' ? [detectRangeFadeLong, detectRangeFadeShort] : [detectRangeFadeLong];
        for (const detector of lados) {
          const candidato = detector({
            analysis,
            trigger,
            anchor: ancora,
            context: null,
            regime,
            entryZonePercent: micro.regime.entryZonePercent,
          });
          if (!candidato) continue;
          if (market === 'SPOT') funil.comSinal += 1;

          const entrada = (candidato.entryLow + candidato.entryHigh) / 2;
          const economia = computeMicroEconomics({
            side: candidato.side,
            entryPrice: entrada,
            stopLoss: candidato.stopLoss,
            target: candidato.target1,
            feePercent,
            liquidity: liquidez,
            costs: { feePercent, stopSlippagePercent: 0.15, exitSlippagePercent: 0.1 },
          });
          const recusa = microOpportunityRejection(economia, micro.regime.minCostMultiple, 1.8);
          if (recusa) {
            conta(recusas, `conta: ${recusa.split('(')[0]?.trim() ?? recusa}`);
            continue;
          }
          if (market === 'SPOT') funil.aprovados += 1;

          const resultado = simular(
            serie, fim - 1, entrada, candidato.stopLoss, candidato.target1,
            candidato.side, economia.allInCostPercent, micro.setupTtlMinutes,
            item.symbol, market,
          );
          if (resultado) resultados.push(resultado);
        }
      }
    }
  }

  console.log('########## O FUNIL (lado spot) ##########');
  console.log(`  pares medidos:            ${funil.pares}`);
  console.log(`  aptos (scalpability):     ${funil.aptos}`);
  console.log(`  janelas analisadas:       ${funil.janelas}`);
  console.log(`  com faixa confirmada:     ${funil.comFaixa}`);
  console.log(`  com rejeição na borda:    ${funil.comSinal}`);
  console.log(`  aprovados pela conta:     ${funil.aprovados}`);

  console.log('\n########## PARES APTOS (chegaram ao detector) ##########');
  if (aptos.length === 0) {
    console.log('  nenhum — o funil parou na scalpabilidade, antes do detector');
  }
  for (const a of aptos.sort((x, y) => y.score - x.score)) {
    console.log(
      `  ${a.symbol.padEnd(12)} nota ${String(a.score).padStart(3)}  ` +
        `ATR 1m ${(a.atr ?? 0).toFixed(3)}%  custo ${a.custo.toFixed(3)}%`,
    );
  }

  console.log('\n########## POR QUE CADA UM FOI RECUSADO ##########');
  for (const [motivo, quantidade] of [...recusas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(quantidade).padStart(6)}  ${motivo}`);
  }

  if (resultados.length === 0) {
    console.log('\nNenhuma operação simulada. Sem operação não há edge para medir — e essa');
    console.log('também é uma resposta: nas condições atuais, o módulo não encontra o que operar.');
    return;
  }

  const cab = [
    'recorte'.padEnd(16), 'oper.'.padStart(6), 'acerto'.padStart(8), 'p/ empatar'.padStart(10),
    'PF'.padStart(6), 'expect.'.padStart(11), 'bruto'.padStart(10), 'custos'.padStart(10),
    'LÍQUIDO'.padStart(10), 'drawdown'.padStart(9), 'duração'.padStart(8),
  ].join(' ');

  console.log('\n########## RESULTADO ##########');
  console.log(cab);
  console.log('-'.repeat(cab.length));
  console.log(resumo('TUDO', resultados));

  console.log('\n########## POR MODALIDADE ##########');
  console.log(cab);
  console.log('-'.repeat(cab.length));
  for (const market of ['SPOT', 'FUTURES'] as MarketKind[]) {
    console.log(resumo(market, resultados.filter((r) => r.market === market)));
  }

  console.log('\n########## POR LADO ##########');
  console.log(cab);
  console.log('-'.repeat(cab.length));
  for (const side of ['BUY', 'SELL'] as const) {
    console.log(resumo(side === 'BUY' ? 'comprado' : 'vendido', resultados.filter((r) => r.side === side)));
  }

  console.log('\n########## POR MOEDA (spot) ##########');
  console.log(cab);
  console.log('-'.repeat(cab.length));
  const porMoeda = new Map<string, Resultado[]>();
  for (const r of resultados.filter((x) => x.market === 'SPOT')) {
    porMoeda.set(r.symbol, [...(porMoeda.get(r.symbol) ?? []), r]);
  }
  for (const [symbol, itens] of [...porMoeda.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(resumo(symbol, itens));
  }

  console.log('\nO custo do book foi medido AGORA e aplicado a todo o período: em momentos de');
  console.log('estresse o spread abre, então o resultado acima é um TETO, não uma expectativa.');
}

function conta(mapa: Map<string, number>, chave: string): void {
  mapa.set(chave, (mapa.get(chave) ?? 0) + 1);
}

function microAtr(serie: Candle[]): number | null {
  const s = atr(serie, 14);
  for (let i = s.length - 1; i >= 0; i -= 1) {
    const v = s[i];
    if (v !== null && v !== undefined) {
      const preco = serie[serie.length - 1]?.close ?? 0;
      return preco > 0 ? (v / preco) * 100 : null;
    }
  }
  return null;
}

function montarAnalise(symbol: string, historico: Candle[]): SymbolAnalysis {
  const indicators = computeIndicators(historico, MICRO_TIMEFRAME);
  return {
    symbol,
    price: historico[historico.length - 1]?.close ?? 0,
    changePercent24h: null,
    timeframes: {
      [MICRO_TIMEFRAME]: {
        timeframe: MICRO_TIMEFRAME,
        candles: historico,
        indicators,
        structure: computeStructure(historico, indicators),
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

main().catch((error) => {
  console.error('Estudo falhou:', error);
  process.exit(1);
});
