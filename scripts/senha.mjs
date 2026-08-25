#!/usr/bin/env node
/**
 * Configura quem entra no painel.
 *
 * Dois caminhos, e o primeiro é o preferido quando existe Supabase:
 *
 *   Supabase Auth — a senha é a MESMA da conta do projeto e é conferida lá.
 *                   Nada de senha nem de hash fica neste computador, e trocar
 *                   a senha no Supabase já vale aqui.
 *
 *   Local ........  para quando não há Supabase. A senha é digitada aqui e
 *                   vira hash scrypt na hora: o que fica no .env não abre o
 *                   painel de ninguém.
 *
 * Em nenhum dos dois a senha é passada por argumento de linha de comando —
 * argumento fica no histórico do terminal.
 */
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { hashPassword, describePasswordProblem } from '../src/server/auth/password.ts';

const ENV_FILE = new URL('../.env', import.meta.url).pathname;

function ask(question, { silent = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (silent) {
      // some o que for digitado: senha na tela é senha em foto de tela
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

function upsertEnvLine(content, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${content.replace(/\n*$/, '')}\n${line}\n`;
}

async function lerEnv() {
  if (existsSync(ENV_FILE)) return readFile(ENV_FILE, 'utf8');
  if (existsSync(`${ENV_FILE}.example`)) return readFile(`${ENV_FILE}.example`, 'utf8');
  return '';
}

async function contasDoSupabase(url, serviceKey) {
  const response = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/admin/users?page=1&per_page=200`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!response.ok) throw new Error(`admin/users respondeu ${response.status}`);
  const body = await response.json();
  return body.users ?? [];
}

async function configurarSupabase(content, url, serviceKey) {
  let contas = [];
  try {
    contas = await contasDoSupabase(url, serviceKey);
  } catch (error) {
    console.error(`\n  Não deu para listar as contas do Supabase: ${error.message}\n`);
    process.exit(1);
  }

  if (contas.length === 0) {
    console.error('\n  Este projeto do Supabase ainda não tem nenhuma conta.');
    console.error('  Crie uma com: npm run usuario\n');
    process.exit(1);
  }

  console.log('\n  Contas deste projeto:');
  contas.forEach((conta, indice) => {
    console.log(`    ${indice + 1}) ${conta.email ?? '(sem e-mail)'}`);
  });

  let escolhida = contas[0];
  if (contas.length > 1) {
    const resposta = (await ask(`\n  Qual delas entra no painel? [1-${contas.length}]: `)).trim();
    const indice = Number(resposta) - 1;
    if (!Number.isInteger(indice) || indice < 0 || indice >= contas.length) {
      console.error('\n  Escolha inválida. Nada foi gravado.\n');
      process.exit(1);
    }
    escolhida = contas[indice];
  } else {
    console.log(`\n  Só há uma conta — vou usar ${escolhida.email}.`);
  }

  content = upsertEnvLine(content, 'PANEL_USER', escolhida.email);
  content = upsertEnvLine(content, 'AUTH_BACKEND', 'supabase');
  // sem hash local: a senha mora no Supabase e é conferida lá
  content = upsertEnvLine(content, 'PANEL_PASSWORD_HASH', '');
  await writeFile(ENV_FILE, content, { mode: 0o600 });

  console.log(`\n  Pronto. Entre no painel com ${escolhida.email} e a senha da conta do Supabase.`);
  console.log('  Nenhuma senha nem hash ficou gravada neste computador.\n');
  console.log('  Reinicie o servidor para valer.\n');
}

async function configurarLocal(content) {
  const user = (await ask('\n  Usuário: ')).trim();
  if (!user) {
    console.error('\n  Usuário em branco. Nada foi gravado.\n');
    process.exit(1);
  }
  const password = await ask('  Senha (não aparece enquanto digita): ', { silent: true });
  const problem = describePasswordProblem(password);
  if (problem) {
    console.error(`\n  Senha recusada — ${problem}. Nada foi gravado.\n`);
    process.exit(1);
  }
  const again = await ask('  Repita a senha: ', { silent: true });
  if (again !== password) {
    console.error('\n  As duas senhas não batem. Nada foi gravado.\n');
    process.exit(1);
  }

  content = upsertEnvLine(content, 'PANEL_USER', user);
  content = upsertEnvLine(content, 'PANEL_PASSWORD_HASH', await hashPassword(password));
  content = upsertEnvLine(content, 'AUTH_BACKEND', 'local');
  await writeFile(ENV_FILE, content, { mode: 0o600 });

  console.log('\n  Pronto. Login gravado no .env (hash scrypt, nunca a senha).\n');
  console.log('  Reinicie o servidor para valer.\n');
}

async function main() {
  console.log('\n  Login do painel Operação\n  ------------------------');

  const content = await lerEnv();
  const url = process.env.SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const temSupabase = Boolean(url && serviceKey);

  if (!temSupabase) {
    console.log('\n  Sem Supabase configurado — vamos de senha local.');
    await configurarLocal(content);
    return;
  }

  console.log('\n  Como conferir a senha?');
  console.log('    1) Supabase Auth — usa a conta que já existe no projeto (recomendado)');
  console.log('    2) Senha local   — guardada como hash no .env deste computador');
  const escolha = (await ask('\n  Escolha [1]: ')).trim() || '1';

  if (escolha === '1') await configurarSupabase(content, url, serviceKey);
  else if (escolha === '2') await configurarLocal(content);
  else {
    console.error('\n  Escolha inválida. Nada foi gravado.\n');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\n  Falhou: ${error.message}\n`);
  process.exit(1);
});
