import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { schema } from './schema';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface DbHandle {
  sqlite: Database.Database;
  db: Db;
  path: string;
}

export function openDatabase(path: string, migrationsDir: string): DbHandle {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  // Reads come from memory wherever they can: a larger page cache, and the file mapped into
  // memory so that the operating system's own cache serves it without extra copies.
  sqlite.pragma('cache_size = -64000');
  sqlite.pragma('mmap_size = 268435456');
  sqlite.pragma('temp_store = MEMORY');
  const db = drizzle(sqlite, { schema });
  if (!existsSync(join(migrationsDir, 'meta', '_journal.json'))) {
    sqlite.close();
    throw new Error(`Database migrations not found in ${migrationsDir}`);
  }
  runMigrations(sqlite, db, migrationsDir);
  return { sqlite, db, path };
}

/**
 * Foreign keys stay off while migrating. Changing a table in SQLite means rebuilding it, and
 * with them on, dropping the old copy would cascade and delete every row that refers to it.
 * The pragma has no effect inside a transaction, so it has to be set out here. The check
 * afterwards turns any reference a migration left broken into a failed start, not bad data.
 */
function runMigrations(sqlite: Database.Database, db: Db, migrationsDir: string): void {
  sqlite.pragma('foreign_keys = OFF');
  try {
    migrate(db, { migrationsFolder: migrationsDir });
    const broken = sqlite.pragma('foreign_key_check') as unknown[];
    if (broken.length > 0) throw new Error(`Database migration left ${broken.length} broken reference(s).`);
  } catch (error) {
    sqlite.close();
    throw error;
  }
  sqlite.pragma('foreign_keys = ON');
}

export function closeDatabase(handle: DbHandle): void {
  if (!handle.sqlite.open) return;
  try {
    // Keeps the query planner's statistics fresh, cheaply, for the next start.
    handle.sqlite.pragma('optimize');
    handle.sqlite.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    handle.sqlite.close();
  }
}

const statementCaches = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/** Compiled statements, reused per connection: compiling a large query costs more than running it. */
export function prepared(sqlite: Database.Database, text: string): Database.Statement {
  let cache = statementCaches.get(sqlite);
  if (!cache) {
    cache = new Map();
    statementCaches.set(sqlite, cache);
  }
  let statement = cache.get(text);
  if (!statement) {
    statement = sqlite.prepare(text);
    // A safety limit: statements vary only by a person's or profile's id.
    if (cache.size >= 500) cache.clear();
    cache.set(text, statement);
  }
  return statement;
}

/** ISO-8601 UTC timestamp in the same format as the schema default. */
export function nowIso(): string {
  return new Date().toISOString();
}
