import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { schema } from './schema';
import { stepsFromHistory } from './steps-from-history';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export interface DbHandle {
  sqlite: Database.Database;
  db: Db;
  path: string;
  /** What opening it changed: the migrations run, and the copy saved before them. */
  migrated?: { tags: string[]; backupPath: string | null };
}

export interface OpenOptions {
  /** Where a copy is saved before an existing database is updated. None for a brand-new or restored one. */
  backupDir?: string;
}

export function openDatabase(path: string, migrationsDir: string, options: OpenOptions = {}): DbHandle {
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
  try {
    const migrated = runMigrations(sqlite, readMigrations(migrationsDir), options);
    return { sqlite, db, path, ...(migrated ? { migrated } : {}) };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

/** Drizzle's table of applied migrations: kept as it is, so databases from earlier versions open as before. */
const MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * Work too involved for SQL, run straight after the migration it belongs to, in the same
 * transaction: if it fails, nothing changes.
 */
const AFTER_MIGRATION: Record<string, (sqlite: Database.Database) => void> = {
  '0009_application_steps': stepsFromHistory
};

export interface Migration {
  tag: string;
  /** The journal's date for it, which is also what an applied migration is recorded under. */
  when: number;
  hash: string;
  statements: string[];
}

/** The migrations in the journal's order, read the way drizzle reads them (the same hash). */
export function readMigrations(migrationsDir: string): Migration[] {
  const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string; when: number }> };
  return journal.entries.map((entry) => {
    const text = readFileSync(join(migrationsDir, `${entry.tag}.sql`), 'utf8');
    return { tag: entry.tag, when: entry.when, hash: createHash('sha256').update(text).digest('hex'), statements: text.split('--> statement-breakpoint') };
  });
}

/** The journal dates and hashes of the migrations a database has had. */
export function appliedMigrations(sqlite: Database.Database): { whens: Set<number>; hashes: Set<string> } {
  const exists = sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(MIGRATIONS_TABLE);
  if (!exists) return { whens: new Set(), hashes: new Set() };
  const rows = sqlite.prepare(`SELECT hash, created_at FROM "${MIGRATIONS_TABLE}"`).all() as Array<{ hash: string; created_at: number | string }>;
  return { whens: new Set(rows.map((row) => Number(row.created_at))), hashes: new Set(rows.map((row) => row.hash)) };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Runs every migration the database has not had yet, in the journal's order. Drizzle's own runner
 * only runs migrations dated after the last one applied, so a migration written with an earlier
 * date would be skipped for good on every existing database. Here a migration counts as applied when
 * its date or its exact text is recorded, which keeps databases migrated by drizzle as they are.
 *
 * Foreign keys stay off while migrating. Changing a table in SQLite means rebuilding it, and with
 * them on, dropping the old copy would cascade and delete every row that refers to it. The pragma
 * has no effect inside a transaction, so it is set out here. Every pending migration runs in one
 * transaction, and the reference check runs before it commits: a migration that fails, or leaves a
 * reference broken, changes nothing at all. An existing database is copied first.
 */
function runMigrations(sqlite: Database.Database, migrations: Migration[], options: OpenOptions): { tags: string[]; backupPath: string | null } | null {
  const applied = appliedMigrations(sqlite);
  const pending = migrations.filter((migration) => !applied.whens.has(migration.when) && !applied.hashes.has(migration.hash));
  if (pending.length === 0) return null;

  let backupPath: string | null = null;
  if (applied.whens.size > 0 && options.backupDir) {
    mkdirSync(options.backupDir, { recursive: true });
    backupPath = join(options.backupDir, `before-update-${stamp()}.sqlite`);
    try {
      sqlite.prepare('VACUUM INTO ?').run(backupPath);
    } catch (error) {
      throw new Error(`The database needs updating, but a copy could not be saved first, so it was left as it is (${error instanceof Error ? error.message : 'unknown error'}).`);
    }
  }

  sqlite.pragma('foreign_keys = OFF');
  try {
    const brokenBefore = (sqlite.pragma('foreign_key_check') as unknown[]).length;
    let running = pending[0];
    try {
      sqlite.transaction(() => {
        sqlite.exec(`CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
        const record = sqlite.prepare(`INSERT INTO "${MIGRATIONS_TABLE}" ("hash", "created_at") VALUES (?, ?)`);
        for (const migration of pending) {
          running = migration;
          for (const statement of migration.statements) if (statement.trim()) sqlite.exec(statement);
          AFTER_MIGRATION[migration.tag]?.(sqlite);
          record.run(migration.hash, migration.when);
        }
        const broken = sqlite.pragma('foreign_key_check') as Array<{ table: string; parent: string }>;
        if (broken.length > brokenBefore) {
          const tables = [...new Set(broken.map((row) => `${row.table} -> ${row.parent}`))].join(', ');
          throw new Error(`it would leave ${broken.length - brokenBefore} broken reference(s) (${tables})`);
        }
      })();
    } catch (error) {
      throw new Error(`Updating the database failed at ${running.tag}, so nothing was changed: ${error instanceof Error ? error.message : 'unknown error'}.`);
    }
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
  return { tags: pending.map((migration) => migration.tag), backupPath };
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
