import { cpSync, existsSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/server/db/client';
import { AUTOMATIC_BACKUPS_KEPT, createBackup, listBackups } from '../src/server/services/backups';
import { ADMIN_PASSWORD, ApiClient, createTestServer, createUsers, jobPage, signInAdmin, tempDir } from './helpers';

const MIGRATIONS = resolve(__dirname, '..', 'drizzle');

/** The app's migrations plus one more, written here. */
function withExtraMigration(sql: string, when: number): string {
  const dir = join(tempDir(), 'drizzle');
  cpSync(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }> };
  const tag = `${String(journal.entries.length).padStart(4, '0')}_extra`;
  journal.entries.push({ idx: journal.entries.length, version: '6', when, tag, breakpoints: true });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  writeFileSync(join(dir, `${tag}.sql`), sql);
  return dir;
}

function existingDatabase(): { path: string; backupDir: string } {
  const dir = tempDir();
  const path = join(dir, 'job-tracker.sqlite');
  const handle = openDatabase(path, MIGRATIONS);
  handle.sqlite.prepare(`INSERT INTO users (username, password_hash, role) VALUES ('keep-me', 'x', 'admin')`).run();
  handle.sqlite.prepare(`INSERT INTO profiles (user_id, name) VALUES ((SELECT id FROM users WHERE username = 'keep-me'), 'Main')`).run();
  closeDatabase(handle);
  return { path, backupDir: join(dir, 'backups') };
}

const tableExists = (sqlite: Database.Database, name: string) => !!sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

describe('updating the database', () => {
  it('has journal dates that only go up, so every runner sees each migration as newer', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ when: number; tag: string }> };
    for (let index = 1; index < journal.entries.length; index += 1) {
      expect(journal.entries[index].when, journal.entries[index].tag).toBeGreaterThan(journal.entries[index - 1].when);
    }
  });

  it('runs a migration even when it is dated before the last one applied', () => {
    const { path } = existingDatabase();
    const migrations = withExtraMigration('CREATE TABLE extra_marker (id integer PRIMARY KEY);', 1_700_000_000_000);
    const handle = openDatabase(path, migrations);
    expect(tableExists(handle.sqlite, 'extra_marker')).toBe(true);
    expect(handle.migrated?.tags).toEqual([expect.stringMatching(/_extra$/)]);
    closeDatabase(handle);
    // And only once.
    const again = openDatabase(path, migrations);
    expect(again.migrated).toBeUndefined();
    closeDatabase(again);
  });

  it('saves a copy of an existing database first, and none of a new one', () => {
    const { path, backupDir } = existingDatabase();
    const migrations = withExtraMigration('CREATE TABLE extra_marker (id integer PRIMARY KEY);', 1_800_000_000_000);
    const handle = openDatabase(path, migrations, { backupDir });
    closeDatabase(handle);
    const copies = readdirSync(backupDir).filter((name) => name.startsWith('before-update-'));
    expect(copies).toHaveLength(1);
    const copy = new Database(join(backupDir, copies[0]), { readonly: true });
    expect(copy.prepare(`SELECT username FROM users WHERE username = 'keep-me'`).get()).toEqual({ username: 'keep-me' });
    expect(tableExists(copy, 'extra_marker')).toBe(false);
    copy.close();

    const freshDir = tempDir();
    closeDatabase(openDatabase(join(freshDir, 'new.sqlite'), MIGRATIONS, { backupDir: join(freshDir, 'backups') }));
    expect(existsSync(join(freshDir, 'backups'))).toBe(false);
  });

  it('changes nothing when a migration fails part way', () => {
    const { path } = existingDatabase();
    const migrations = withExtraMigration('CREATE TABLE half_done (id integer PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO no_such_table VALUES (1);', 1_800_000_000_000);
    expect(() => openDatabase(path, migrations)).toThrow(/failed at \d{4}_extra, so nothing was changed/);
    const handle = openDatabase(path, MIGRATIONS);
    expect(tableExists(handle.sqlite, 'half_done')).toBe(false);
    expect(handle.sqlite.prepare(`SELECT username FROM users WHERE username = 'keep-me'`).get()).toBeTruthy();
    closeDatabase(handle);
    // A fixed version of the app can still update it later.
    const fixed = openDatabase(path, withExtraMigration('CREATE TABLE half_done (id integer PRIMARY KEY);', 1_800_000_000_000));
    expect(tableExists(fixed.sqlite, 'half_done')).toBe(true);
    closeDatabase(fixed);
  });

  it('changes nothing when a migration would leave references broken', () => {
    const { path } = existingDatabase();
    // With foreign keys off while migrating, this would orphan the profile.
    const migrations = withExtraMigration(`DELETE FROM users WHERE username = 'keep-me';`, 1_800_000_000_000);
    expect(() => openDatabase(path, migrations)).toThrow(/broken reference/);
    const handle = openDatabase(path, MIGRATIONS);
    expect(handle.sqlite.prepare(`SELECT COUNT(*) AS total FROM users WHERE username = 'keep-me'`).get()).toEqual({ total: 1 });
    closeDatabase(handle);
  });
});

describe('restoring a backup', () => {
  it('leaves everything as it was when another program holds the database open', async () => {
    const server = await createTestServer();
    const { admin, users } = await createUsers(server.app, 'tyler');
    server.http.serve('https://company.com/jobs/1', jobPage({ title: 'Kept', company: 'Acme' }));
    const backup = (await admin.post('/api/admin/backups')).json;
    await users.tyler.addJob('https://company.com/jobs/1');

    // A database viewer, a sync tool: Windows will not let the file be moved while it is open.
    const viewer = new Database(server.databasePath);
    viewer.prepare('SELECT COUNT(*) FROM jobs').get();
    try {
      const refused = await admin.post(`/api/admin/backups/${backup.name}/restore`);
      if (process.platform === 'win32') {
        expect(refused.status).toBe(409);
        expect(refused.json.error.code).toBe('database_in_use');
        // Still running, on the same data, with nothing left over.
        expect((await users.tyler.get('/api/jobs')).json.items.map((job: { title: string }) => job.title)).toEqual(['Kept']);
        expect(existsSync(`${server.databasePath}.previous`)).toBe(false);
        expect(existsSync(`${server.databasePath}.restoring`)).toBe(false);
      }
    } finally {
      viewer.close();
    }
    // Once the file is free, the same restore goes through.
    expect((await admin.post(`/api/admin/backups/${backup.name}/restore`)).status).toBe(200);
    expect((await users.tyler.get('/api/auth/me')).status).toBe(200);
  });

  it('puts the data back on the next start after a restore cut short', async () => {
    const first = await createTestServer();
    await signInAdmin(first.app);
    await first.app.close();
    closeDatabase(first.ctx.handle);
    // The power went off between moving the live file aside and putting the backup in its place.
    renameSync(first.databasePath, `${first.databasePath}.previous`);

    const second = await createTestServer({ dataDir: first.dataDir });
    const client = new ApiClient(second.app);
    // Not a fresh database with the default password: the real one, with the password chosen.
    expect((await client.post('/api/auth/login', { username: 'admin', password: 'admin' })).status).toBe(401);
    await client.login('admin', ADMIN_PASSWORD);
    expect(existsSync(`${first.databasePath}.previous`)).toBe(false);
  });

  it('refuses a backup from a newer version of the app', async () => {
    const server = await createTestServer();
    const admin = await signInAdmin(server.app);
    const backup = (await admin.post('/api/admin/backups')).json;
    const file = new Database(join(server.ctx.paths.backupDir, backup.name));
    file.prepare(`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ('made-by-a-later-version', 1999999999999)`).run();
    file.close();
    const refused = await admin.post(`/api/admin/backups/${backup.name}/restore`);
    expect(refused.status).toBe(400);
    expect(refused.json.error.message).toMatch(/newer version/);
  });

  it('brings a restored backup up to today’s rules, like a start does', async () => {
    const server = await createTestServer();
    const { admin, users } = await createUsers(server.app, 'tyler');
    server.http.serve('https://company.com/jobs/7', jobPage({ title: 'Engineer', company: 'Acme' }));
    await users.tyler.addJob('https://company.com/jobs/7');
    const backup = (await admin.post('/api/admin/backups')).json;
    // A backup from before personal tokens were taken out of saved links.
    const file = new Database(join(server.ctx.paths.backupDir, backup.name));
    file.prepare(`UPDATE job_urls SET original_url = 'https://company.com/jobs/7?code=SECRET-LOGIN-CODE'`).run();
    file.close();
    expect((await admin.post(`/api/admin/backups/${backup.name}/restore`)).status).toBe(200);
    const urls = server.ctx.handle.sqlite.prepare('SELECT original_url FROM job_urls').all() as Array<{ original_url: string }>;
    expect(urls.map((row) => row.original_url).join(' ')).not.toContain('SECRET');
  });

  it('runs one at a time, and says so to the second administrator', async () => {
    const server = await createTestServer();
    const admin = await signInAdmin(server.app);
    const backup = (await admin.post('/api/admin/backups')).json;
    const [first, second] = await Promise.all([admin.post(`/api/admin/backups/${backup.name}/restore`), admin.post(`/api/admin/backups/${backup.name}/restore`)]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect([first, second].find((response) => response.status === 409)?.json.error.code).toBe('database_busy');
  });

  it('keeps only the latest automatic copies of each kind, and every copy a person made', async () => {
    const server = await createTestServer();
    const admin = await signInAdmin(server.app);
    const manual = (await admin.post('/api/admin/backups')).json.name as string;
    for (let index = 0; index < AUTOMATIC_BACKUPS_KEPT + 3; index += 1) {
      const name = `before-merge-2020-01-${String(index + 1).padStart(2, '0')}T00-00-00-000Z.sqlite`;
      const path = join(server.ctx.paths.backupDir, name);
      writeFileSync(path, 'old copy');
      const at = new Date(Date.UTC(2020, 0, index + 1));
      utimesSync(path, at, at);
    }
    await createBackup(server.ctx, 'before-merge');
    const names = listBackups(server.ctx).map((item) => item.name);
    expect(names.filter((name) => name.startsWith('before-merge-'))).toHaveLength(AUTOMATIC_BACKUPS_KEPT);
    expect(names).not.toContain('before-merge-2020-01-01T00-00-00-000Z.sqlite');
    expect(names).toContain(manual);
  });
});

describe('signing in', () => {
  it('counts guesses sent all at once', async () => {
    const server = await createTestServer({ rateLimit: { maxPerAccount: 3, maxPerAddress: 100, windowMs: 60_000 } });
    const attempts = await Promise.all(Array.from({ length: 12 }, () => new ApiClient(server.app).post('/api/auth/login', { username: 'admin', password: 'wrong guess' })));
    const statuses = attempts.map((attempt) => attempt.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(3);
    expect(statuses.filter((status) => status === 429)).toHaveLength(9);
  });

  it('lets only the host computer use the default administrator password', async () => {
    const server = await createTestServer();
    const fromLan = await new ApiClient(server.app).request('POST', '/api/auth/login', { username: 'admin', password: 'admin' }, '192.168.1.50');
    expect(fromLan.status).toBe(403);
    expect(fromLan.json.error.code).toBe('setup_on_host');
    const fromHost = await new ApiClient(server.app).request('POST', '/api/auth/login', { username: 'admin', password: 'admin' }, '127.0.0.1');
    expect(fromHost.status).toBe(200);
    // Once a real password is chosen, it works from anywhere on the network.
    await signInAdmin(server.app);
    expect((await new ApiClient(server.app).request('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD }, '192.168.1.50')).status).toBe(200);
  });
});

describe('the live update stream', () => {
  it('sends nothing more once the session is revoked', async () => {
    const server = await createTestServer();
    const { admin, users } = await createUsers(server.app, 'tyler');
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = server.app.server.address() as AddressInfo;
    const received: string[] = [];
    const ended = new Promise<void>((resolveEnded) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/events', headers: { authorization: `Bearer ${users.tyler.token}` } }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => received.push(chunk));
        res.on('end', () => resolveEnded());
      });
      req.end();
    });
    await expect.poll(() => received.join('')).toContain('connected');
    const tylerId = (await users.tyler.get('/api/auth/me')).json.id;
    expect((await admin.patch(`/api/admin/users/${tylerId}`, { isActive: false })).status).toBe(200);
    server.ctx.events.publish('jobs_changed', 1);
    await ended;
    expect(received.join('')).not.toContain('jobs_changed');
  });
});
