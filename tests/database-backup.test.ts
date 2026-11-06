import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AutoBackup, BACKUP_INTERVAL_MS, DEFAULT_AUTO_BACKUP, RETRY_AFTER_MS, type AutoBackupDeps } from '../src/main/auto-backup';
import { PinnedClient } from '../src/main/lan-client';
import { buildApp } from '../src/server/app';
import { loadOrCreateTls } from '../src/server/tls';
import type { LoginResponse } from '../src/shared/api';
import type { AutoBackupSettings } from '../src/shared/bridge';
import { ADMIN_PASSWORD, createTestServer, createUsers, tempDir } from './helpers';

const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'latin1');

describe('downloading the whole database', () => {
  it('gives an administrator a consistent copy, and leaves nothing behind on the host', async () => {
    const server = await createTestServer();
    const { admin, users } = await createUsers(server.app, 'andy');
    const response = await server.app.inject({ method: 'GET', url: '/api/admin/database/download', headers: { authorization: `Bearer ${admin.token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/vnd.sqlite3');
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="job-tracker-.+\.sqlite"$/);
    expect(response.rawPayload.subarray(0, 16)).toEqual(SQLITE_HEADER);
    expect(Number(response.headers['content-length'])).toBe(response.rawPayload.length);
    // A self-contained file: no write-ahead log needed beside it.
    expect(response.rawPayload[18]).toBe(1);

    const saved = join(tempDir(), 'copy.sqlite');
    writeFileSync(saved, response.rawPayload);
    const copy = new Database(saved, { readonly: true });
    expect((copy.prepare('SELECT username FROM users ORDER BY username').all() as Array<{ username: string }>).map((row) => row.username)).toEqual(['admin', 'andy']);
    copy.close();

    // The temporary copy is gone once sent, and never shows among the backups.
    await expect.poll(() => readdirSync(join(server.dataDir, 'downloads'))).toEqual([]);
    expect((await admin.get('/api/admin/backups')).json).toEqual([]);
    expect((await users.andy.get('/api/admin/database/download')).status).toBe(403);
  });
});

/** The scheduler with a pretend host, clock and settings store. */
function scheduler(overrides: Partial<AutoBackupDeps> & { settings?: Partial<AutoBackupSettings> } = {}) {
  const folder = tempDir();
  let settings: AutoBackupSettings = { ...DEFAULT_AUTO_BACKUP, enabled: true, folder, ...overrides.settings };
  const clock = { now: new Date('2026-11-05T21:30:00') };
  const downloads: string[] = [];
  const backup = new AutoBackup({
    get: () => settings,
    save: (next) => {
      settings = next;
    },
    role: async () => 'admin',
    download: async (destination) => {
      downloads.push(destination);
      const body = Buffer.concat([SQLITE_HEADER, Buffer.alloc(84)]);
      writeFileSync(destination, body);
      return { bytes: body.length };
    },
    now: () => clock.now,
    ...overrides
  });
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  return { backup, folder, downloads, advance, settings: () => settings };
}

describe('the weekly copy to a folder', () => {
  it('does nothing while switched off or without a folder', async () => {
    expect(await scheduler({ settings: { enabled: false } }).backup.saveIfDue()).toEqual({ saved: false, reason: 'off' });
    expect(await scheduler({ settings: { folder: null } }).backup.saveIfDue()).toEqual({ saved: false, reason: 'off' });
  });

  it('saves straight away the first time, named by date, then once a week, keeping every file', async () => {
    const { backup, folder, advance, settings } = scheduler();
    expect(await backup.saveIfDue()).toEqual({ saved: true, file: join(folder, 'job-tracker-backup-2026-11-05-2130.sqlite') });
    expect(settings()).toMatchObject({ lastFile: 'job-tracker-backup-2026-11-05-2130.sqlite', lastBytes: 100, lastError: null });
    expect(backup.state().nextDueAt).toBe(new Date(new Date('2026-11-05T21:30:00').getTime() + BACKUP_INTERVAL_MS).toISOString());

    advance(BACKUP_INTERVAL_MS - 60_000);
    expect(await backup.saveIfDue()).toEqual({ saved: false, reason: 'not_due' });
    advance(60_000);
    expect((await backup.saveIfDue()).saved).toBe(true);
    expect(readdirSync(folder).sort()).toEqual(['job-tracker-backup-2026-11-05-2130.sqlite', 'job-tracker-backup-2026-11-12-2130.sqlite']);
  });

  it('makes up a missed week as soon as it can, rather than waiting another week', async () => {
    const { backup, advance } = scheduler({ settings: { lastSavedAt: new Date('2026-10-01T09:00:00').toISOString() } });
    advance(60_000);
    expect((await backup.saveIfDue()).saved).toBe(true);
  });

  it('never overwrites a file already in the folder', async () => {
    const { backup, folder } = scheduler();
    writeFileSync(join(folder, 'job-tracker-backup-2026-11-05-2130.sqlite'), 'mine');
    expect(await backup.saveNow()).toEqual({ saved: true, file: join(folder, 'job-tracker-backup-2026-11-05-2130-2.sqlite') });
    expect(readFileSync(join(folder, 'job-tracker-backup-2026-11-05-2130.sqlite'), 'utf8')).toBe('mine');
  });

  it('waits quietly while nobody is signed in or the host is off, but says so when asked directly', async () => {
    const { backup, downloads, settings } = scheduler({ role: async () => null });
    expect(await backup.saveIfDue()).toEqual({ saved: false, reason: 'waiting' });
    expect(settings().lastError).toBeNull();
    expect((await backup.saveNow()).saved).toBe(false);
    expect(settings().lastError).toMatch(/Sign in as an administrator/);
    expect(downloads).toEqual([]);
  });

  it('refuses for someone who is not an administrator, and tries again only after an hour', async () => {
    let role: 'admin' | 'user' = 'user';
    const { backup, advance, settings } = scheduler({ role: async () => role });
    expect(await backup.saveIfDue()).toMatchObject({ saved: false, reason: 'failed', message: 'Only an administrator can save the database.' });
    role = 'admin';
    advance(RETRY_AFTER_MS - 60_000);
    expect(await backup.saveIfDue()).toEqual({ saved: false, reason: 'waiting' });
    advance(60_000);
    expect((await backup.saveIfDue()).saved).toBe(true);
    expect(settings().lastError).toBeNull();
  });

  it('reports a folder that has gone, such as an unplugged drive', async () => {
    const { backup, settings } = scheduler({ settings: { folder: join(tempDir(), 'missing') } });
    expect((await backup.saveIfDue()).saved).toBe(false);
    expect(settings().lastError).toMatch(/cannot be reached/);
  });

  it('keeps a finished copy even when its settings cannot be written', async () => {
    const { backup, folder } = scheduler({
      save: () => {
        throw Object.assign(new Error('EPERM: operation not permitted, rename settings.json.tmp'), { code: 'EPERM' });
      }
    });
    expect(await backup.saveIfDue()).toEqual({ saved: true, file: join(folder, 'job-tracker-backup-2026-11-05-2130.sqlite') });
    expect(readdirSync(folder)).toEqual(['job-tracker-backup-2026-11-05-2130.sqlite']);
  });

  it('keeps nothing when the download fails or is not a database', async () => {
    const failing = scheduler({
      download: async (destination) => {
        writeFileSync(destination, 'half');
        throw new Error('The connection to 127.0.0.1:3847 was lost.');
      }
    });
    expect(await failing.backup.saveIfDue()).toMatchObject({ saved: false, message: 'The connection to 127.0.0.1:3847 was lost.' });
    expect(readdirSync(failing.folder)).toEqual([]);

    const wrong = scheduler({
      download: async (destination) => {
        writeFileSync(destination, '<html>not a database</html>');
        return { bytes: 27 };
      }
    });
    expect((await wrong.backup.saveIfDue()).saved).toBe(false);
    expect(readdirSync(wrong.folder)).toEqual([]);
    expect(wrong.settings().lastSavedAt).toBeNull();
  });

  it('runs one copy at a time', async () => {
    let release: () => void = () => undefined;
    const { backup, downloads } = scheduler({
      download: async (destination) => {
        downloads.push(destination);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        writeFileSync(destination, Buffer.concat([SQLITE_HEADER, Buffer.alloc(4)]));
        return { bytes: 20 };
      }
    });
    const first = backup.saveIfDue();
    await expect.poll(() => downloads.length).toBe(1);
    expect(backup.state().running).toBe(true);
    expect(await backup.saveIfDue()).toEqual({ saved: false, reason: 'busy' });
    release();
    expect((await first).saved).toBe(true);
    expect(downloads).toHaveLength(1);
  });
});

describe('the weekly copy, from a real host over the network', () => {
  it('lands in the folder as a database that opens, with everyone in it', async () => {
    const server = await createTestServer();
    await createUsers(server.app, 'andy', 'john');
    const tls = await loadOrCreateTls(server.dataDir);
    const app = buildApp(server.ctx, { https: { key: tls.key, cert: tls.cert } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new PinnedClient({ host: '127.0.0.1', port: (app.server.address() as AddressInfo).port, fingerprint: tls.fingerprint, certPem: tls.cert });
    try {
      const login = await client.call<LoginResponse>('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD }, null);
      const token = login.data?.token as string;
      const folder = join(tempDir(), 'Job Tracker backups');
      mkdirSync(folder);
      let settings: AutoBackupSettings = { ...DEFAULT_AUTO_BACKUP, enabled: true, folder };
      const backup = new AutoBackup({
        get: () => settings,
        save: (next) => {
          settings = next;
        },
        role: async () => ((await client.call<{ role: 'admin' | 'user' }>('GET', '/api/auth/me', undefined, token)).data?.role ?? null),
        download: (destination) => client.download('/api/admin/database/download', token, destination)
      });
      const outcome = await backup.saveIfDue();
      expect(outcome.saved).toBe(true);
      const file = outcome.saved ? outcome.file : '';
      expect(existsSync(`${file}.part`)).toBe(false);
      const copy = new Database(file, { readonly: true });
      expect((copy.prepare('SELECT username FROM users ORDER BY username').all() as Array<{ username: string }>).map((row) => row.username)).toEqual(['admin', 'andy', 'john']);
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      copy.close();
      expect(settings.lastBytes).toBe(readFileSync(file).length);
      // One file per week, and nothing else left in the folder.
      expect(readdirSync(folder)).toEqual([outcome.saved ? outcome.file.slice(folder.length + 1) : '']);
    } finally {
      client.destroy();
      await app.close();
    }
  });

  it('turns down someone who is not an administrator with the host’s own words', async () => {
    const server = await createTestServer();
    await createUsers(server.app, 'andy');
    const tls = await loadOrCreateTls(server.dataDir);
    const app = buildApp(server.ctx, { https: { key: tls.key, cert: tls.cert } });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const client = new PinnedClient({ host: '127.0.0.1', port: (app.server.address() as AddressInfo).port, fingerprint: tls.fingerprint, certPem: tls.cert });
    try {
      const login = await client.call<LoginResponse>('POST', '/api/auth/login', { username: 'andy', password: 'andy-password' }, null);
      const destination = join(tempDir(), 'copy.sqlite');
      await expect(client.download('/api/admin/database/download', login.data?.token as string, destination)).rejects.toThrow('Only the administrator can do this.');
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(`${destination}.part`)).toBe(false);
    } finally {
      client.destroy();
      await app.close();
    }
  });
});
