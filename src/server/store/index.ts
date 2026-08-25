import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { findUserIdByEmail } from '../auth/supabaseAuth.ts';
import { JsonStore } from './jsonStore.ts';
import type { Repository } from './repository.ts';

export type { Repository } from './repository.ts';

/** Escolhe a persistência conforme o ambiente, com JSON local como padrão. */
export async function createRepository(): Promise<Repository> {
  if (config.store === 'supabase' && config.supabase) {
    try {
      const ownerId = await resolveOwnerId();
      const { SupabaseStore } = await import('./supabaseStore.ts');
      const store = new SupabaseStore(
        config.supabase.url,
        config.supabase.serviceRoleKey,
        ownerId,
      );
      await store.init();
      return store;
    } catch (error) {
      logger.error('Supabase indisponível — caindo para persistência local', {
        error: (error as Error).message,
      });
    }
  }
  const store = new JsonStore(config.dataDir);
  await store.init();
  logger.info('Persistência local em arquivo', { directory: config.dataDir });
  return store;
}

/**
 * Dono das linhas no Postgres. As tabelas apontam para auth.users, então este
 * uuid precisa ser o de uma conta que existe de verdade — um valor inventado
 * é recusado pela chave estrangeira já na primeira gravação.
 *
 * Por isso o SUPABASE_OWNER_ID pode ficar em branco: quando fica, o uuid é
 * buscado pelo e-mail do painel. Copiar uuid à mão é o tipo de passo que se
 * erra em silêncio e só aparece muito depois como "sumiu tudo".
 */
async function resolveOwnerId(): Promise<string> {
  const supabase = config.supabase;
  if (!supabase) throw new Error('Supabase não configurado');
  if (supabase.ownerId) return supabase.ownerId;

  const email = config.auth.user;
  if (!email) {
    throw new Error(
      'Defina SUPABASE_OWNER_ID ou PANEL_USER no .env para saber de quem são os dados',
    );
  }
  const found = await findUserIdByEmail(supabase.url, supabase.serviceRoleKey, email);
  if (!found) {
    throw new Error(
      `Nenhuma conta com o e-mail ${email} no Supabase — rode: npm run usuario`,
    );
  }
  logger.info('Dono dos dados resolvido pelo e-mail do painel', { email, ownerId: found });
  return found;
}
