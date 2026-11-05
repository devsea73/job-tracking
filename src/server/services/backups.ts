import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import type { BackupInfo } from '../../shared/api';
import type { AppContext } from '../context';
import { closeDatabase, openDatabase } from '../db/client';
import { ApiError, notFound } from '../errors';

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

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

/** Uses SQLite's online backup, so a consistent copy is taken while people keep working. */
export async function createBackup(ctx: AppContext, prefix = 'backup'): Promise<BackupInfo> {
  mkdirSync(ctx.paths.backupDir, { recursive: true });
  const name = `${prefix}-${stamp()}.sqlite`;
  const path = join(ctx.paths.backupDir, name);
  await ctx.handle.sqlite.backup(path);
  const stats = statSync(path);
  ctx.logger.info({ name }, 'Created database backup');
  return { name, sizeBytes: stats.size, createdAt: stats.mtime.toISOString() };
}

const REQUIRED_TABLES = ['users', 'jobs', 'job_urls', 'applications', 'interviews', 'application_status_history', 'sessions'];

/** Refuses to replace live data with anything that is not a healthy database from this app. */
export function assertRestorable(path: string): void {
  let candidate: Database.Database | null = null;
  try {
    candidate = new Database(path, { readonly: true, fileMustExist: true });
    const tables = new Set((candidate.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((row) => row.name));
    const missing = REQUIRED_TABLES.filter((table) => !tables.has(table));
    if (missing.length > 0) throw new Error(`missing tables: ${missing.join(', ')}`);
    const check = candidate.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`integrity check: ${String(check)}`);
    const admins = candidate.prepare(`SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND is_active = 1`).get() as { total: number };
    if (admins.total === 0) throw new Error('no administrator account');
  } catch (error) {
    throw new ApiError(400, 'invalid_backup', `This file cannot be restored: ${error instanceof Error ? error.message : 'unreadable'}.`);
  } finally {
    candidate?.close();
  }
}

/**
 * Replaces the live database with a backup. The current data is saved first, so a restore
 * can itself be undone, and if opening the restored file fails the previous file comes back.
 */
export async function restoreBackup(ctx: AppContext, name: string): Promise<BackupInfo> {
  const source = join(ctx.paths.backupDir, basename(name));
  if (!existsSync(source)) throw notFound('That backup no longer exists.');
  assertRestorable(source);

  const safety = await createBackup(ctx, 'before-restore');
  const livePath = ctx.handle.path;
  const stagedPath = `${livePath}.restoring`;
  const previousPath = `${livePath}.previous`;
  copyFileSync(source, stagedPath);

  closeDatabase(ctx.handle);
  for (const suffix of ['-wal', '-shm']) rmSync(`${livePath}${suffix}`, { force: true });
  renameSync(livePath, previousPath);
  renameSync(stagedPath, livePath);
  try {
    // Older backups are brought up to the current schema by the normal migrations.
    ctx.handle = openDatabase(livePath, ctx.paths.migrationsDir);
    rmSync(previousPath, { force: true });
  } catch (error) {
    rmSync(livePath, { force: true });
    renameSync(previousPath, livePath);
    ctx.handle = openDatabase(livePath, ctx.paths.migrationsDir);
    ctx.logger.error({ err: error }, 'Restored database failed to open, kept the previous one');
    throw new ApiError(400, 'invalid_backup', 'This backup could not be opened, so nothing was changed.');
  }
  ctx.logger.info({ name }, 'Restored database from backup');
  ctx.events.publish('database_restored');
  return safety;
}

export function deleteBackup(ctx: AppContext, name: string): void {
  const path = join(ctx.paths.backupDir, basename(name));
  if (!existsSync(path)) throw notFound('That backup no longer exists.');
  rmSync(path);
}
