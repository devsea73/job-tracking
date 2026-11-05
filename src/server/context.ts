import type { PasswordHasher } from './auth/passwords';
import type { LoginRateLimiter } from './auth/rate-limit';
import type { Db, DbHandle } from './db/client';
import type { EventBus } from './events';
import type { HttpClient } from './extraction/safe-fetch';
import type { PageRenderer } from './extraction/types';
import type { DraftStore } from './services/drafts';
import type { Logger } from './logger';
import type { ReadCache } from './read-cache';

/** Everything request handlers share. */
export class AppContext {
  constructor(
    /** Swapped when a backup is restored, so always read `db` from the context. */
    public handle: DbHandle,
    public readonly hasher: PasswordHasher,
    public readonly limiter: LoginRateLimiter,
    public readonly events: EventBus,
    public readonly http: HttpClient,
    public readonly renderer: PageRenderer | null,
    public readonly drafts: DraftStore,
    public readonly logger: Logger,
    public readonly paths: { dataDir: string; migrationsDir: string; backupDir: string },
    public readonly version: string,
    public readonly readCache: ReadCache
  ) {}

  get db(): Db {
    return this.handle.db;
  }
}
