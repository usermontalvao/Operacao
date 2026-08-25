#!/usr/bin/env node
/**
 * Aplica as migrations de supabase/migrations no projeto do .env.
 *
 * Aplicar duas vezes não faz mal: o que já rodou fica anotado na tabela
 * public.schema_migrations e é pulado na próxima. Cada arquivo roda dentro de
 * uma transação — se uma linha falhar no meio, nada daquele arquivo fica pela
 * metade.
 *
 * Precisa de um token pessoal (SUPABASE_ACCESS_TOKEN), que é a única chave com
 * direito a criar tabela. A service_role NÃO serve para isto: ela fala com o
 * PostgREST, que não executa DDL. Gere o token em:
 *   https://supabase.com/dashboard/account/tokens
 *
 * Uso:
 *   npm run migrar            aplica o que falta
 *   npm run migrar -- --status  só mostra o que está pendente
 *   npm run migrar -- --print   imprime o SQL junto, para colar no SQL Editor
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url).pathname;
const API = 'https://api.supabase.com/v1';

const flags = new Set(process.argv.slice(2));
const onlyStatus = flags.has('--status');
const onlyPrint = flags.has('--print');

function projectRef() {
  if (process.env.SUPABASE_PROJECT_REF) return process.env.SUPABASE_PROJECT_REF.trim();
  const url = process.env.SUPABASE_URL ?? '';
  const match = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return match ? match[1] : null;
}

async function listMigrations() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (name) => ({ name, sql: await readFile(join(MIGRATIONS_DIR, name), 'utf8') })),
  );
}

async function run(ref, token, query) {
  const response = await fetch(`${API}/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).message ?? text;
    } catch {
      /* mantém o texto cru */
    }
    throw new Error(`${response.status} — ${detail}`);
  }
  return text ? JSON.parse(text) : null;
}

const LEDGER = `
create table if not exists public.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
`;

async function main() {
  const migrations = await listMigrations();

  if (onlyPrint) {
    // caminho sem token: um arquivo só, para colar no SQL Editor do painel
    const pieces = [LEDGER];
    for (const migration of migrations) {
      pieces.push(
        `\n-- ======== ${migration.name} ========\n`,
        migration.sql,
        `\ninsert into public.schema_migrations (name) values ('${migration.name}')\n  on conflict (name) do nothing;\n`,
      );
    }
    process.stdout.write(pieces.join('\n'));
    return;
  }

  const ref = projectRef();
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!ref) {
    console.error('\n  Não achei o projeto. Preencha SUPABASE_URL (ou SUPABASE_PROJECT_REF) no .env.\n');
    process.exit(1);
  }
  if (!token) {
    console.error('\n  Falta SUPABASE_ACCESS_TOKEN no .env — é o token pessoal, o único');
    console.error('  que pode criar tabela. Gere em https://supabase.com/dashboard/account/tokens');
    console.error('\n  Sem token, use o caminho manual:');
    console.error('    npm run migrar -- --print > migracao.sql');
    console.error('  e cole o conteúdo no SQL Editor do projeto.\n');
    process.exit(1);
  }

  console.log(`\n  Projeto: ${ref}\n`);
  await run(ref, token, LEDGER);
  const applied = await run(ref, token, 'select name from public.schema_migrations;');
  const done = new Set((applied ?? []).map((row) => row.name));

  const pending = migrations.filter((migration) => !done.has(migration.name));
  for (const migration of migrations) {
    console.log(`  ${done.has(migration.name) ? '✓ já aplicada ' : '· pendente    '} ${migration.name}`);
  }
  if (pending.length === 0) {
    console.log('\n  Nada a fazer — o banco já está em dia.\n');
    return;
  }
  if (onlyStatus) {
    console.log(`\n  ${pending.length} pendente(s). Rode "npm run migrar" para aplicar.\n`);
    return;
  }

  console.log('');
  for (const migration of pending) {
    process.stdout.write(`  aplicando ${migration.name} … `);
    await run(
      ref,
      token,
      `begin;\n${migration.sql}\ninsert into public.schema_migrations (name) values ('${migration.name}');\ncommit;`,
    );
    console.log('ok');
  }
  console.log(`\n  ${pending.length} migration(s) aplicada(s).\n`);
}

main().catch((error) => {
  console.error(`\n  Falhou: ${error.message}\n`);
  process.exit(1);
});
