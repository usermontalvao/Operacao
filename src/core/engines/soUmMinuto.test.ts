import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSetups } from './setupEngine.ts';
import {
  analysisFrom,
  candlesFromPath,
  defaultTestSettings,
  uptrendWithPullback,
} from '../testing/fixtures.ts';

/**
 * O MODO "SÓ 1 MINUTO".
 *
 * Desligar todos os gatilhos de tendência é uma configuração válida desde que
 * o micro scalp esteja ligado. O que estes testes travam é a consequência: com
 * a lista vazia, os detectores de tendência precisam parar de verdade — não
 * "gerar menos", parar. Um resíduo aqui seria pior que o comportamento antigo,
 * porque o usuário acredita ter desligado.
 */

function analiseComPullback() {
  const candles = candlesFromPath(uptrendWithPullback());
  return analysisFrom('TESTUSDT', candles, ['15m', '1h', '4h', '1d']);
}

test('com gatilho ligado, o detector de tendência roda', () => {
  const settings = defaultTestSettings();
  settings.scanner.triggerTimeframes = ['1h'];
  const setups = generateSetups({
    analysis: analiseComPullback(),
    context: null,
    settings,
    now: new Date(),
    makeId: () => 'id',
  });
  assert.ok(setups.length > 0, 'a fixture precisa gerar setup para o teste seguinte valer');
});

test('sem gatilho de tendência, NENHUM setup de tendência nasce', () => {
  const settings = defaultTestSettings();
  settings.scanner.triggerTimeframes = [];
  const setups = generateSetups({
    analysis: analiseComPullback(),
    context: null,
    settings,
    now: new Date(),
    makeId: () => 'id',
  });
  assert.deepEqual(setups, []);
});

test("'1m' em triggerTimeframes não roda detector de tendência", () => {
  /*
   * Defesa em profundidade. O schema das Configurações já recusa '1m' como
   * gatilho, mas um arquivo gravado à mão, uma migração futura ou um teste
   * distraído poderiam colocá-lo ali. Se o motor obedecesse, rodaria pullback
   * e rompimento em candle de 1 minuto — exatamente a ideia que a medição
   * reprovou, e por um caminho que ninguém revisou.
   */
  const settings = defaultTestSettings();
  settings.scanner.triggerTimeframes = ['1m' as never];
  const candles = candlesFromPath(uptrendWithPullback());
  const analysis = analysisFrom('TESTUSDT', candles, ['1m', '15m', '1h', '4h', '1d']);
  const setups = generateSetups({
    analysis,
    context: null,
    settings,
    now: new Date(),
    makeId: () => 'id',
  });
  assert.deepEqual(setups, []);
});
