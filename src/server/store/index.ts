import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { JsonStore } from './jsonStore.ts';
import type { Repository } from './repository.ts';

export type { Repository } from './repository.ts';

/** Escolhe a persistência conforme o ambiente, com JSON local como padrão. */
export async function createRepository(): Promise<Repository> {
  if (config.store === 'supabase' && config.supabase) {
    try {
      const { SupabaseStore } = await import('./supabaseStore.ts');
      const store = new SupabaseStore(
        config.supabase.url,
        config.supabase.serviceRoleKey,
        config.supabase.ownerId,
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
