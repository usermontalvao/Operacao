/*
 * Deixa a conta pronta para medir performance do zero.
 *
 * Faz três coisas, nesta ordem, e a ordem importa:
 *   1. BACKUP de tudo o que vai sumir, em arquivo, antes de tocar em nada;
 *   2. LIMPEZA do histórico (operações, teses, alertas, decisões, auditoria);
 *   3. CONFIGURAÇÃO aplicada nas três contas de cada modalidade.
 *
 * A configuração passa pelo SettingsService, não por SQL: assim ela atravessa
 * o mesmo schema e a mesma fusão que a tela usa. Escrever direto na tabela
 * criaria um estado que o painel nunca produziria — e que ninguém testou.
 *
 *   node --env-file-if-exists=.env scripts/preparar-producao.mjs           (só mostra)
 *   node --env-file-if-exists=.env scripts/preparar-producao.mjs --aplicar (executa)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const APLICAR = process.argv.includes('--aplicar');
const raiz = process.cwd();

const { createRepository } = await import(join(raiz, 'src/server/store/index.ts'));
const { SettingsService } = await import(join(raiz, 'src/server/services/settingsService.ts'));
const { config } = await import(join(raiz, 'src/server/config.ts'));

const handle = await createRepository();
if (handle.degraded) {
  console.error(`Persistência indisponível: ${handle.error}`);
  process.exit(1);
}
const repo = handle.repository;

// ---------- 1. o que existe hoje --------------------------------------------
const [trades, setups, alerts, decisions, entryDecisions, audit] = await Promise.all([
  repo.listTrades(),
  repo.listSetups(),
  repo.listAlerts(),
  repo.listDecisions(),
  repo.listEntryDecisions(5000),
  repo.listAudit(5000),
]);

const abertas = trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING');
console.log('\n=== O QUE EXISTE HOJE ===');
console.log(`operações .................. ${trades.length}  (${abertas.length} AINDA ABERTAS)`);
console.log(`teses no radar ............. ${setups.length}`);
console.log(`alertas .................... ${alerts.length}`);
console.log(`decisões ................... ${decisions.length}`);
console.log(`decisões de entrada ........ ${entryDecisions.length}`);
console.log(`linhas de auditoria ........ ${audit.length}`);

if (abertas.length > 0) {
  console.log('\n*** ATENÇÃO ***');
  for (const t of abertas) {
    console.log(`  ${t.symbol} ${t.status} ${t.mode} — ${t.remainingQuantity} em mãos`);
  }
  console.log(
    '  Limpar o histórico NÃO fecha estas posições na Binance. A moeda\n' +
      '  continua na carteira e o painel deixa de saber dela. Encerre antes.',
  );
}

// ---------- 2. backup --------------------------------------------------------
const pasta = join(raiz, 'data', 'backup');
await mkdir(pasta, { recursive: true });
const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
const arquivo = join(pasta, `historico-${carimbo}.json`);
await writeFile(
  arquivo,
  JSON.stringify({ trades, setups, alerts, decisions, entryDecisions, audit }, null, 2),
  'utf8',
);
console.log(`\nbackup gravado em ${arquivo}`);

// ---------- 3. configuração --------------------------------------------------
const settings = new SettingsService(repo);
await settings.load();

const PATCH = {
  scanner: {
    triggerTimeframes: ['1h', '4h'],
    burstRequireBtcRegime: false,
  },
  risk: { maxOpenTrades: 20 },
  autoTrade: {
    maxConcurrentTrades: 20,
    strategies: { MOMENTUM_BURST: { enabled: true, minimumScore: 85 } },
  },
  guard: {
    maxDailyTrades: 100,
    maxTotalExposurePercent: 95,
    maxAltExposurePercent: 95,
  },
};

console.log('\n=== CONFIGURAÇÃO A APLICAR (nas 3 contas de cada modalidade) ===');
console.log('  gatilhos ........................ 1h, 4h');
console.log('  explosão exige BTC em alta ...... NÃO (interruptor desligado)');
console.log('  piso de score do MOMENTUM_BURST . 85');
console.log('  operações por dia ............... 100');
console.log('  posições automáticas simultâneas  20');
console.log('  operações abertas ao mesmo tempo  20');
console.log('  exposição total ................. 95%');
console.log('  exposição em altcoins ........... 95%');

if (!APLICAR) {
  console.log('\n--- ENSAIO. Nada foi alterado nem apagado. ---');
  console.log('Para valer: node --env-file-if-exists=.env scripts/preparar-producao.mjs --aplicar');
  process.exit(0);
}

const mercados = ['SPOT', 'FUTURES'];
const modos = ['PAPER', 'TESTNET', 'LIVE'];
for (const targetMarket of mercados) {
  for (const targetMode of modos) {
    await settings.update(PATCH, { targetMode, targetMarket });
  }
}
console.log('\nconfiguração aplicada.');

// ---------- 4. limpeza -------------------------------------------------------
const { createClient } = await import('@supabase/supabase-js');
if (!config.supabase) {
  console.log('\nSem Supabase configurado: nada a limpar por aqui.');
  process.exit(0);
}
const db = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { resolveOwnerId } = await import(join(raiz, 'src/server/store/index.ts'));
const userId = await resolveOwnerId();

const TABELAS = ['trades', 'trade_setups', 'alerts', 'decisions', 'entry_decisions', 'audit_logs'];
console.log('');
for (const tabela of TABELAS) {
  // sempre escopado ao dono: um delete sem filtro numa base compartilhada
  // apagaria dados de outra conta
  const { error } = await db.from(tabela).delete().eq('user_id', userId);
  console.log(error ? `  ${tabela}: FALHOU — ${error.message}` : `  ${tabela}: limpo`);
}

console.log('\nPronto. A carteira começa a contar do zero a partir de agora.');
console.log(`O que foi apagado está em ${arquivo}`);
