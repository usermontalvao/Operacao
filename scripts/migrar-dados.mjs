#!/usr/bin/env node
/**
 * Copia o histórico local (data/*.json) para o Postgres do Supabase.
 *
 * Reaproveita os dois adaptadores do próprio servidor em vez de escrever SQL à
 * mão: o que sabe converter um Trade em linha é o SupabaseStore, e duplicar
 * essa tradução aqui seria duas versões da mesma regra para divergirem depois.
 *
 * A ordem importa por causa das chaves estrangeiras — setups antes de tudo,
 * porque alertas e operações apontam para eles. Referência órfã (o setup já
 * saiu do arquivo, mas o alerta ficou) vira NULL em vez de derrubar a cópia:
 * perder o vínculo é aceitável, perder o alerta não.
 *
 * Rodar duas vezes não duplica nada — tudo é upsert por id.
 *
 * Uso:
 *   npm run migrar-dados            copia
 *   npm run migrar-dados -- --seco  só conta o que copiaria
 */
import { JsonStore } from '../src/server/store/jsonStore.ts';
import { SupabaseStore } from '../src/server/store/supabaseStore.ts';
import { findUserIdByEmail } from '../src/server/auth/supabaseAuth.ts';

const seco = process.argv.includes('--seco');

async function main() {
  const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !serviceKey) {
    console.error('\n  Faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env.\n');
    process.exit(1);
  }

  let ownerId = process.env.SUPABASE_OWNER_ID ?? '';
  if (!ownerId) {
    const email = process.env.PANEL_USER;
    if (!email) {
      console.error('\n  Defina PANEL_USER (ou SUPABASE_OWNER_ID) para saber de quem são os dados.\n');
      process.exit(1);
    }
    ownerId = await findUserIdByEmail(url, serviceKey, email);
    if (!ownerId) {
      console.error(`\n  Nenhuma conta com o e-mail ${email} no Supabase.\n`);
      process.exit(1);
    }
    console.log(`\n  Dono dos dados: ${email} (${ownerId})`);
  }

  const local = new JsonStore(process.env.DATA_DIR ?? 'data');
  await local.init();

  const [settings, setups, trades, alerts, decisions, audit] = await Promise.all([
    local.loadSettings(),
    local.listSetups(),
    local.listTrades(),
    local.listAlerts(),
    local.listDecisions(),
    local.listAudit(5000),
  ]);

  console.log('\n  No arquivo local:');
  console.log(`    ajustes ....... ${settings ? 'sim' : 'não'}`);
  console.log(`    setups ........ ${setups.length}`);
  console.log(`    operações ..... ${trades.length}`);
  console.log(`    alertas ....... ${alerts.length}`);
  console.log(`    decisões ...... ${decisions.length}`);
  console.log(`    auditoria ..... ${audit.length}`);

  if (seco) {
    console.log('\n  --seco: nada foi gravado.\n');
    return;
  }

  const remoto = new SupabaseStore(url, serviceKey, ownerId);
  await remoto.init();

  // quem existe de fato, para não empurrar referência que a FK vai recusar
  const idsDeSetup = new Set(setups.map((setup) => setup.id));
  const idsDeTrade = new Set(trades.map((trade) => trade.id));

  console.log('');
  if (settings) await passo('ajustes', 1, () => remoto.saveSettings(settings));

  await emLote('setups', setups, (setup) => remoto.saveSetup(setup));

  await emLote('operações', trades, (trade) =>
    remoto.saveTrade({ ...trade, setupId: idsDeSetup.has(trade.setupId) ? trade.setupId : null }),
  );

  await emLote('alertas', alerts, (alerta) =>
    remoto.saveAlert({ ...alerta, setupId: idsDeSetup.has(alerta.setupId) ? alerta.setupId : null }),
  );

  await emLote('decisões', decisions, (decisao) =>
    remoto.saveDecision({
      ...decisao,
      tradeId: idsDeTrade.has(decisao.tradeId) ? decisao.tradeId : null,
      setupId: idsDeSetup.has(decisao.setupId) ? decisao.setupId : null,
    }),
  );

  /*
   * A auditoria é append-only de propósito — o adaptador usa INSERT, não
   * upsert, porque linha de auditoria que se reescreve não é auditoria. Então
   * quem tem de evitar a repetição é esta cópia: perguntamos o que já está lá
   * e mandamos só o resto.
   *
   * A ordem é da mais antiga para a mais nova: a lista do painel ordena por
   * horário, e a ordem de gravação é o único desempate quando duas entradas
   * caem no mesmo instante.
   */
  const jaGravadas = new Set((await remoto.listAudit(100_000)).map((entrada) => entrada.id));
  const faltando = [...audit].reverse().filter((entrada) => !jaGravadas.has(entrada.id));
  if (jaGravadas.size > 0) {
    console.log(`  auditoria    ${jaGravadas.size} já no banco, ${faltando.length} a copiar`);
  }
  await emLote('auditoria', faltando, (entrada) => remoto.appendAudit(entrada));

  console.log('\n  Pronto. Troque STORE=json por STORE=supabase no .env e reinicie.\n');
}

async function passo(rotulo, total, executar) {
  process.stdout.write(`  ${rotulo.padEnd(12)} `);
  await executar();
  console.log(`ok (${total})`);
}

/** Grava em blocos pequenos: 400 requisições soltas de uma vez viram 429. */
async function emLote(rotulo, itens, gravar) {
  if (itens.length === 0) {
    console.log(`  ${rotulo.padEnd(12)} — nada a copiar`);
    return;
  }
  process.stdout.write(`  ${rotulo.padEnd(12)} `);
  let feitos = 0;
  let falhas = 0;
  const TAMANHO = 20;
  for (let inicio = 0; inicio < itens.length; inicio += TAMANHO) {
    const bloco = itens.slice(inicio, inicio + TAMANHO);
    const resultados = await Promise.allSettled(bloco.map((item) => gravar(item)));
    for (const resultado of resultados) {
      if (resultado.status === 'fulfilled') feitos += 1;
      else {
        falhas += 1;
        if (falhas <= 3) console.log(`\n     ! ${resultado.reason?.message ?? resultado.reason}`);
      }
    }
    process.stdout.write('.');
  }
  console.log(` ${feitos}/${itens.length}${falhas > 0 ? ` (${falhas} falha(s))` : ''}`);
}

main().catch((error) => {
  console.error(`\n  Falhou: ${error.message}\n`);
  process.exit(1);
});
