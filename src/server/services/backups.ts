import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import type { BackupInfo } from '../../shared/api';
import type { AppContext } from '../context';
import { closeDatabase, openDatabase, readMigrations } from '../db/client';
import { ApiError, notFound } from '../errors';
import { prepareSavedData } from './upkeep';

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Copies the app makes by itself before a step that is hard to undo. Each kind keeps its latest few. */
export const AUTOMATIC_BACKUP_PREFIXES = ['before-merge', 'before-restore', 'before-update'] as const;
export const AUTOMATIC_BACKUPS_KEPT = 10;

export function listBackups(ctx: AppContext): BackupInfo[] {
  mkdirSync(ctx.paths.backupDir, { recursive: true });
  return readdirSync(ctx.paths.backupDir)
    .filter((name) => name.endsWith('.sqlite'))
    .map((name) => {
      const stats = statSync(join(ctx.paths.backupDir, name));
      return { name, sizeBytes: stats.size, createdAt: stats.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Removes the oldest automatic copies beyond the latest few of each kind. Copies people made stay. */
export function pruneAutomaticBackups(ctx: AppContext): number {
  let removed = 0;
  const all = listBackups(ctx);
  for (const prefix of AUTOMATIC_BACKUP_PREFIXES) {
    for (const old of all.filter((backup) => backup.name.startsWith(`${prefix}-`)).slice(AUTOMATIC_BACKUPS_KEPT)) {
      try {
        rmSync(join(ctx.paths.backupDir, old.name), { force: true });
        removed += 1;
      } catch {
        // In use right now: it goes next time.
      }
    }
  }
  return removed;
}

const busy = new WeakMap<AppContext, string>();

/** One backup, restore or download copy at a time: each reads or replaces the whole database. */
async function exclusive<T>(ctx: AppContext, what: string, work: () => Promise<T>): Promise<T> {
  const running = busy.get(ctx);
  if (running) throw new ApiError(409, 'database_busy', `The host is busy with ${running}. Try again when it has finished.`);
  busy.set(ctx, what);
  try {
    return await work();
  } finally {
    busy.delete(ctx);
  }
}

/** Uses SQLite's online backup, so a consistent copy is taken while people keep working. */
async function writeBackup(ctx: AppContext, prefix: string): Promise<BackupInfo> {
  mkdirSync(ctx.paths.backupDir, { recursive: true });
  const name = `${prefix}-${stamp()}.sqlite`;
  const path = join(ctx.paths.backupDir, name);
  await ctx.handle.sqlite.backup(path);
  const stats = statSync(path);
  ctx.logger.info({ name }, 'Created database backup');
  if ((AUTOMATIC_BACKUP_PREFIXES as readonly string[]).includes(prefix)) pruneAutomaticBackups(ctx);
  return { name, sizeBytes: stats.size, createdAt: stats.mtime.toISOString() };
}

export function createBackup(ctx: AppContext, prefix = 'backup'): Promise<BackupInfo> {
  return exclusive(ctx, 'a backup', () => writeBackup(ctx, prefix));
}

const SNAPSHOT_PREFIX = 'download-';

/**
 * A consistent copy of the whole database for an administrator to download, kept apart from the
 * backups list. The caller removes it once sent; copies left by an interrupted download are
 * cleared the next time one is made.
 */
export function createSnapshot(ctx: AppContext): Promise<{ path: string; name: string; sizeBytes: number }> {
  return exclusive(ctx, 'a copy for download', async () => {
    const directory = join(ctx.paths.dataDir, 'downloads');
    mkdirSync(directory, { recursive: true });
    const hourAgo = Date.now() - 3_600_000;
    for (const leftover of readdirSync(directory)) {
      const path = join(directory, leftover);
      if (leftover.startsWith(SNAPSHOT_PREFIX) && statSync(path).mtimeMs < hourAgo) rmSync(path, { force: true });
    }
    const name = `job-tracker-${stamp()}.sqlite`;
    const path = join(directory, `${SNAPSHOT_PREFIX}${Math.random().toString(36).slice(2)}-${name}`);
    await ctx.handle.sqlite.backup(path);
    // One self-contained file: opened anywhere, it needs no journal files beside it.
    const copy = new Database(path);
    copy.pragma('journal_mode = DELETE');
    copy.close();
    ctx.logger.info({ name }, 'Made a database copy for download');
    return { path, name, sizeBytes: statSync(path).size };
  });
}

const REQUIRED_TABLES = ['users', 'jobs', 'job_urls', 'applications', 'sessions'];

/** Timelines, or what a copy from before them kept instead: restoring one of those brings it up to date. */
const TIMELINE_TABLES = [['application_steps'], ['interviews', 'application_status_history']];

/**
 * Refuses to replace live data with anything that is not a healthy database from this app, or
 * one a newer version of the app has changed in ways this one does not know.
 */
export function assertRestorable(path: string, migrationsDir?: string): void {
  let candidate: Database.Database | null = null;
  try {
    candidate = new Database(path, { readonly: true, fileMustExist: true });
    const tables = new Set((candidate.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((row) => row.name));
    const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
    if (!TIMELINE_TABLES.some((set) => set.every((table) => tables.has(table)))) missing.push('application_steps');
    if (missing.length > 0) throw new Error(`missing tables: ${missing.join(', ')}`);
    const check = candidate.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`integrity check: ${String(check)}`);
    const admins = candidate.prepare(`SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND is_active = 1`).get() as { total: number };
    if (admins.total === 0) throw new Error('no administrator account');
    if (migrationsDir && tables.has('__drizzle_migrations')) {
      const known = readMigrations(migrationsDir);
      const whens = new Set(known.map((migration) => migration.when));
      const hashes = new Set(known.map((migration) => migration.hash));
      const applied = candidate.prepare('SELECT hash, created_at FROM "__drizzle_migrations"').all() as Array<{ hash: string; created_at: number | string }>;
      // A migration this version knows is recorded under its date or its exact text.
      if (applied.some((row) => !whens.has(Number(row.created_at)) && !hashes.has(row.hash))) throw new Error('it was made by a newer version of Job Tracker. Update this computer first');
    }
  } catch (error) {
    throw new ApiError(400, 'invalid_backup', `This file cannot be restored: ${error instanceof Error ? error.message : 'unreadable'}.`);
  } finally {
    candidate?.close();
  }
}

const RETRIED_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * Windows refuses to move or delete a file another program has open, often only for a moment (a
 * virus scanner, a sync tool). Tried a few times over about a second and a half before giving up.
 */
function retrying<T>(action: () => T): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (attempt >= 5 || !RETRIED_CODES.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * 2 ** attempt);
    }
  }
}

/** Opens the live file again. Never one that is missing: that would start an empty database in its place. */
function reopen(ctx: AppContext, livePath: string): void {
  if (!existsSync(livePath)) throw new Error(`The database file ${livePath} is missing; the previous one is kept beside it and comes back at the next start.`);
  ctx.handle = openDatabase(livePath, ctx.paths.migrationsDir);
}

/**
 * Puts a backup in place of the live database, or leaves everything as it was. Runs without
 * yielding, so no request can see the database half replaced.
 */
function swapInDatabase(ctx: AppContext, source: string): void {
  const livePath = ctx.handle.path;
  const stagedPath = `${livePath}.restoring`;
  const previousPath = `${livePath}.previous`;
  // A journal left by an earlier attempt would be applied to the new copy.
  for (const leftover of [stagedPath, `${stagedPath}-wal`, `${stagedPath}-shm`]) rmSync(leftover, { force: true });
  copyFileSync(source, stagedPath);

  closeDatabase(ctx.handle);
  try {
    for (const suffix of ['-wal', '-shm']) retrying(() => rmSync(`${livePath}${suffix}`, { force: true }));
    retrying(() => renameSync(livePath, previousPath));
    try {
      retrying(() => renameSync(stagedPath, livePath));
    } catch (error) {
      retrying(() => renameSync(previousPath, livePath));
      throw error;
    }
  } catch (error) {
    // Nothing was replaced: the database opens again as it was.
    reopen(ctx, livePath);
    rmSync(stagedPath, { force: true });
    ctx.logger.error({ err: error }, 'Could not put the backup in place, kept the current database');
    throw new ApiError(409, 'database_in_use', 'Another program has the database file open, so nothing was changed. Close it (a database viewer, a backup or sync tool) and try again.');
  }

  try {
    // Older backups are brought up to the current schema by the normal migrations.
    ctx.handle = openDatabase(livePath, ctx.paths.migrationsDir);
  } catch (error) {
    // The backup does not open: the previous database goes back.
    ctx.logger.error({ err: error }, 'Restored database failed to open, putting the previous one back');
    for (const suffix of ['', '-wal', '-shm']) retrying(() => rmSync(`${livePath}${suffix}`, { force: true }));
    retrying(() => renameSync(previousPath, livePath));
    reopen(ctx, livePath);
    throw new ApiError(400, 'invalid_backup', 'This backup could not be opened, so nothing was changed.');
  }
  try {
    rmSync(previousPath, { force: true });
  } catch {
    // Still held open somewhere: it is replaced by the next restore. The data is in the safety copy.
  }
}

/**
 * Replaces the live database with a backup. The current data is saved first, so a restore can
 * itself be undone. If anything goes wrong on the way, the database stays as it was.
 */
export function restoreBackup(ctx: AppContext, name: string): Promise<BackupInfo> {
  return exclusive(ctx, 'a restore', async () => {
    const source = join(ctx.paths.backupDir, basename(name));
    if (!existsSync(source)) throw notFound('That backup no longer exists.');
    assertRestorable(source, ctx.paths.migrationsDir);
    const safety = await writeBackup(ctx, 'before-restore');
    swapInDatabase(ctx, source);
    // A backup can be older than today's rules for saved data, just like a database at a start.
    // Merging jobs needs no copy here: the backup restored from is itself one.
    await prepareSavedData(ctx);
    ctx.logger.info({ name }, 'Restored database from backup');
    ctx.events.publish('database_restored');
    return safety;
  });
}

/**
 * A restore cut short (the computer lost power, say) can leave the data beside the database file
 * instead of in it. Put back before anything opens the file, which would otherwise start an
 * empty database with a default administrator. True when that happened.
 */
export function recoverInterruptedRestore(livePath: string): boolean {
  const previousPath = `${livePath}.previous`;
  if (livePath === ':memory:' || existsSync(livePath) || !existsSync(previousPath)) return false;
  for (const suffix of ['-wal', '-shm']) rmSync(`${livePath}${suffix}`, { force: true });
  renameSync(previousPath, livePath);
  return true;
}

export function deleteBackup(ctx: AppContext, name: string): void {
  const running = busy.get(ctx);
  if (running) throw new ApiError(409, 'database_busy', `The host is busy with ${running}. Try again when it has finished.`);
  const path = join(ctx.paths.backupDir, basename(name));
  if (!existsSync(path)) throw notFound('That backup no longer exists.');
  rmSync(path);
}
