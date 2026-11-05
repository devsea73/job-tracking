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
  const db = drizzle(sqlite, { schema });
  if (!existsSync(join(migrationsDir, 'meta', '_journal.json'))) {
    sqlite.close();
    throw new Error(`Database migrations not found in ${migrationsDir}`);
  }
  migrate(db, { migrationsFolder: migrationsDir });
  return { sqlite, db, path };
}

export function closeDatabase(handle: DbHandle): void {
  if (!handle.sqlite.open) return;
  try {
    handle.sqlite.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    handle.sqlite.close();
  }
}

/** ISO-8601 UTC timestamp in the same format as the schema default. */
export function nowIso(): string {
  return new Date().toISOString();
}
