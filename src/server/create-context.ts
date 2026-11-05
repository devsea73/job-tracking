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
import { DraftStore } from './services/drafts';
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
  return ctx;
}
