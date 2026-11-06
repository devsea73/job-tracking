import { join } from 'node:path';
import { createPasswordHasher, type PasswordHasher } from './auth/passwords';
import { DEFAULT_RATE_LIMIT, LoginRateLimiter, type RateLimitOptions } from './auth/rate-limit';
import { AppContext } from './context';
import { openDatabase } from './db/client';
import { EventBus } from './events';
import type { HttpClient } from './extraction/safe-fetch';
import type { PageRenderer } from './extraction/types';
import type { Logger } from './logger';
import { ReadCache } from './read-cache';
import { createBackup } from './services/backups';
import { DraftStore } from './services/drafts';
import { cleanSavedLinks, reindexJobs, repairHtmlDescriptions } from './services/job-facts-store';
import { reconcileJobIdentities } from './services/job-merge';
import { ensureInitialAdmin } from './services/users';

export interface ContextOptions {
  dataDir: string;
  migrationsDir: string;
  version: string;
  http: HttpClient;
  renderer: PageRenderer | null;
  logger: Logger;
  databasePath?: string;
  hasher?: PasswordHasher;
  rateLimit?: RateLimitOptions;
}

export async function createContext(options: ContextOptions): Promise<AppContext> {
  const handle = openDatabase(options.databasePath ?? join(options.dataDir, 'job-tracker.sqlite'), options.migrationsDir);
  const ctx = new AppContext(
    handle,
    options.hasher ?? createPasswordHasher(),
    new LoginRateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT),
    new EventBus(),
    options.http,
    options.renderer,
    new DraftStore(),
    options.logger,
    { dataDir: options.dataDir, migrationsDir: options.migrationsDir, backupDir: join(options.dataDir, 'backups') },
    options.version,
    new ReadCache()
  );
  await ensureInitialAdmin(ctx);
  const repaired = repairHtmlDescriptions(handle.sqlite);
  const cleanedLinks = cleanSavedLinks(handle.sqlite);
  if (cleanedLinks > 0) options.logger.info({ cleanedLinks }, 'Removed visitor tracking from saved links');
  const reindexed = reindexJobs(handle.sqlite);
  if (reindexed > 0) options.logger.info({ reindexed }, 'Indexed saved jobs for duplicate detection');
  if (repaired > 0) options.logger.info({ repaired }, 'Turned descriptions saved as markup into text');
  await reconcileJobIdentities(ctx, { backup: () => createBackup(ctx, 'before-merge') });
  return ctx;
}
