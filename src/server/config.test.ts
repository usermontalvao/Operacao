import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSupabaseAuthKey } from './config.ts';

test('chave anon vazia cai para a service role no Supabase Auth', () => {
  assert.equal(selectSupabaseAuthKey('', 'service-role-de-teste'), 'service-role-de-teste');
  assert.equal(selectSupabaseAuthKey('   ', 'service-role-de-teste'), 'service-role-de-teste');
});

test('chave anon preenchida é preferida para o Supabase Auth', () => {
  assert.equal(selectSupabaseAuthKey('anon-de-teste', 'service-role-de-teste'), 'anon-de-teste');
});

test('sem nenhuma chave o Supabase Auth continua indisponível', () => {
  assert.equal(selectSupabaseAuthKey(undefined, undefined), undefined);
});
