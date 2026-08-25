#!/usr/bin/env node
/**
 * Cria (ou confirma) a conta do painel no Supabase Auth.
 *
 * As tabelas do projeto apontam para auth.users: sem uma conta lá, a primeira
 * gravação é recusada pela chave estrangeira. Este script existe para você não
 * precisar abrir o painel do Supabase só para isso — e a senha é digitada
 * aqui, nunca passada por argumento.
 */
import { createInterface } from 'node:readline';
import { describePasswordProblem } from '../src/server/auth/password.ts';

const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

function ask(question, { silent = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (silent) {
      rl.output.write(question);
      rl._writeToOutput = (text) => {
        if (text.includes('\n')) rl.output.write('\n');
      };
      rl.question('', (value) => {
        rl.close();
        resolve(value);
      });
      return;
    }
    rl.question(question, (value) => {
      rl.close();
      resolve(value);
    });
  });
}

async function listUsers() {
  const response = await fetch(`${url}/auth/v1/admin/users?page=1&per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!response.ok) throw new Error(`admin/users respondeu ${response.status}`);
  const body = await response.json();
  return body.users ?? [];
}

async function main() {
  if (!url || !serviceKey) {
    console.error('\n  Faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env.\n');
    process.exit(1);
  }
  console.log(`\n  Conta do painel em ${url}\n  ${'-'.repeat(url.length + 20)}\n`);

  const existing = await listUsers();
  if (existing.length > 0) {
    console.log('  Contas que já existem neste projeto:');
    for (const user of existing) console.log(`    • ${user.email ?? '(sem e-mail)'} — ${user.id}`);
    console.log('');
  }

  const email = (await ask('  E-mail da conta: ')).trim();
  const found = existing.find((user) => (user.email ?? '').toLowerCase() === email.toLowerCase());
  if (found) {
    console.log(`\n  Esta conta já existe. uuid: ${found.id}`);
    console.log('  Nada foi alterado — a senha continua a mesma.\n');
    return;
  }

  const password = await ask('  Senha (não aparece enquanto digita): ', { silent: true });
  const problem = describePasswordProblem(password);
  if (problem) {
    console.error(`\n  Senha recusada — ${problem}. Nada foi criado.\n`);
    process.exit(1);
  }
  const again = await ask('  Repita a senha: ', { silent: true });
  if (again !== password) {
    console.error('\n  As duas senhas não batem. Nada foi criado.\n');
    process.exit(1);
  }

  const response = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${response.status} — ${detail.slice(0, 300)}`);
  }
  const created = await response.json();
  console.log(`\n  Conta criada. uuid: ${created.id}`);
  console.log('  Deixe SUPABASE_OWNER_ID em branco no .env: o servidor acha o uuid');
  console.log('  sozinho pelo PANEL_USER.\n');
}

main().catch((error) => {
  console.error(`\n  Falhou: ${error.message}\n`);
  process.exit(1);
});
