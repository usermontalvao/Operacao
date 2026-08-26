import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { findUserIdByEmail } from '../auth/supabaseAuth.ts';
import { JsonStore } from './jsonStore.ts';
import { CachedRepository } from './cachedRepository.ts';
import { UnavailableRepository } from './unavailable.ts';
import type { Repository } from './repository.ts';

export type { Repository } from './repository.ts';
export { PersistenceUnavailableError, UnavailableRepository } from './unavailable.ts';

export interface RepositoryHandle {
  repository: Repository;
  /** o que foi PEDIDO no .env, não o que sobrou */
  kind: 'supabase' | 'json';
  /** true quando a persistência principal não respondeu */
  degraded: boolean;
  error: string | null;
}

/**
 * Escolhe a persistência conforme o ambiente.
 *
 * A regra que não se negocia: STORE=supabase nunca vira JSON. O JSON local só
 * entra quando foi ele o pedido. Antes havia um `catch` que trocava de banco
 * em silêncio, e o custo disso não é teórico — as duas cópias divergem em
 * horas, e a de arquivo continua achando que há posições abertas que o
 * Postgres já encerrou.
 */
export async function createRepository(): Promise<RepositoryHandle> {
  if (config.store === 'supabase') {
    if (!config.supabase) {
      const error =
        'STORE=supabase mas faltam SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env';
      logger.error('Persistência principal não configurada', { error });
      return { repository: new UnavailableRepository(error), kind: 'supabase', degraded: true, error };
    }
    try {
      const ownerId = await resolveOwnerId();
      const { SupabaseStore } = await import('./supabaseStore.ts');
      const store = new SupabaseStore(config.supabase.url, config.supabase.serviceRoleKey, ownerId);
      await store.init();
      // a memória curta entra AQUI, envolvendo o banco: assim vale para todo
      // mundo que lê, e ninguém precisa lembrar de não perguntar duas vezes
      return { repository: new CachedRepository(store), kind: 'supabase', degraded: false, error: null };
    } catch (cause) {
      // a mensagem do erro pode carregar URL do projeto; a chave nunca passa
      // por aqui, mas o log fica no nível do motivo, não do segredo
      const error = (cause as Error).message;
      logger.error(
        'Supabase indisponível — o painel sobe SEM operar. Nada será gravado no arquivo local.',
        { error },
      );
      return { repository: new UnavailableRepository(error), kind: 'supabase', degraded: true, error };
    }
  }

  const store = new JsonStore(config.dataDir);
  await store.init();
  logger.info('Persistência local em arquivo', { directory: config.dataDir });
  return { repository: new CachedRepository(store), kind: 'json', degraded: false, error: null };
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
    throw new Error(`Nenhuma conta com o e-mail ${email} no Supabase — rode: npm run usuario`);
  }
  logger.info('Dono dos dados resolvido pelo e-mail do painel', { email, ownerId: found });
  return found;
}
