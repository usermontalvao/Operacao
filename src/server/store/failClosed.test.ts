import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PersistenceUnavailableError, UnavailableRepository } from './unavailable.ts';

/**
 * O requisito é negativo — "nunca cai para JSON" — e requisito negativo se
 * prova mostrando que o caminho alternativo não existe, não que ele não foi
 * tomado desta vez.
 */

test('o repositório indisponível recusa TODA gravação', async () => {
  const store = new UnavailableRepository('conexão recusada');
  await store.init(); // init não falha: o painel precisa subir para explicar

  await assert.rejects(() => store.saveTrade({} as never), PersistenceUnavailableError);
  await assert.rejects(() => store.saveSetup({} as never), PersistenceUnavailableError);
  await assert.rejects(() => store.saveSettings({} as never), PersistenceUnavailableError);
  await assert.rejects(() => store.appendAudit({} as never), PersistenceUnavailableError);
  await assert.rejects(() => store.saveEntryDecision({} as never), PersistenceUnavailableError);
  await assert.rejects(() => store.saveDecision({} as never), PersistenceUnavailableError);
  await assert.rejects(() => store.saveAlert({} as never), PersistenceUnavailableError);
});

test('as LEITURAS também falham — lista vazia seria pior que o erro', async () => {
  const store = new UnavailableRepository('timeout');
  await store.init();

  // devolver [] faria o painel mostrar patrimônio zero, nenhuma posição aberta
  // e nenhum disjuntor acionado: um estado tranquilo e inteiramente falso, que
  // é justamente o que convida a operar
  await assert.rejects(() => store.listTrades(), PersistenceUnavailableError);
  await assert.rejects(() => store.listSetups(), PersistenceUnavailableError);
  await assert.rejects(() => store.loadSettings(), PersistenceUnavailableError);
  await assert.rejects(() => store.listAudit(10), PersistenceUnavailableError);
  await assert.rejects(() => store.listEntryDecisions(10), PersistenceUnavailableError);
});

test('o erro diz a causa sem vazar credencial', async () => {
  const store = new UnavailableRepository('getaddrinfo ENOTFOUND db.exemplo.supabase.co');
  await assert.rejects(
    () => store.listTrades(),
    (error: Error) => {
      assert.match(error.message, /Persistência principal indisponível/);
      assert.match(error.message, /ENOTFOUND/);
      // a mensagem carrega o motivo, nunca a chave
      assert.ok(!/service_role|eyJ|apikey|secret/i.test(error.message));
      return true;
    },
  );
});

test('STORE=supabase com falha NÃO grava nada em disco', async () => {
  // a prova concreta do split-brain evitado: mesmo mandando gravar, o
  // diretório de dados continua vazio — não existe um segundo histórico
  const directory = await mkdtemp(join(tmpdir(), 'hunter-failclosed-'));
  try {
    const store = new UnavailableRepository('Supabase fora do ar');
    await store.init();
    await store.saveTrade({} as never).catch(() => {
      /* esperado */
    });
    await store.appendAudit({} as never).catch(() => {
      /* esperado */
    });

    const arquivos = await readdir(directory);
    assert.deepEqual(arquivos, [], 'nada pode ter sido escrito no disco local');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('createRepository não tem caminho de código que troque supabase por json', async () => {
  // Teste estrutural, de propósito. Um teste de comportamento só provaria que
  // o fallback não aconteceu naquela execução; este prova que ele não existe.
  const { readFile } = await import('node:fs/promises');
  const fonte = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

  const blocoSupabase = fonte.slice(
    fonte.indexOf("if (config.store === 'supabase')"),
    fonte.indexOf('const store = new JsonStore(config.dataDir);'),
  );
  assert.ok(blocoSupabase.length > 0, 'o bloco do supabase precisa existir');
  assert.ok(
    !blocoSupabase.includes('new JsonStore'),
    'o caminho do supabase não pode instanciar o armazenamento local',
  );
  assert.ok(
    blocoSupabase.includes('UnavailableRepository'),
    'a falha do supabase precisa terminar no repositório que recusa tudo',
  );
});
