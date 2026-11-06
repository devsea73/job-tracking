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
import { createBackup, pruneAutomaticBackups, recoverInterruptedRestore } from './services/backups';
import { DraftStore } from './services/drafts';
import { prepareSavedData } from './services/upkeep';
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
  const backupDir = join(options.dataDir, 'backups');
  const databasePath = options.databasePath ?? join(options.dataDir, 'job-tracker.sqlite');
  // Before anything opens the file: a missing one would otherwise start empty.
  if (recoverInterruptedRestore(databasePath)) options.logger.warn('Put the database back after a restore that did not finish');
  const handle = openDatabase(databasePath, options.migrationsDir, { backupDir });
  if (handle.migrated) options.logger.info({ migrations: handle.migrated.tags, backup: handle.migrated.backupPath }, 'Updated the database');
  const ctx = new AppContext(
    handle,
    options.hasher ?? createPasswordHasher(),
    new LoginRateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT),
    new EventBus(),
    options.http,
    options.renderer,
    new DraftStore(),
    options.logger,
    { dataDir: options.dataDir, migrationsDir: options.migrationsDir, backupDir },
    options.version,
    new ReadCache()
  );
  await ensureInitialAdmin(ctx);
  await prepareSavedData(ctx, { backup: () => createBackup(ctx, 'before-merge') });
  const pruned = pruneAutomaticBackups(ctx);
  if (pruned > 0) options.logger.info({ pruned }, 'Removed old automatic backups');
  return ctx;
}
