import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/server/db/client';
import { ReadCache } from '../src/server/read-cache';
// @ts-expect-error A plain script, shared with the command line.
import { seedLoadData } from '../scripts/seed-load.mjs';
import { createTestServer, createUsers, jobPage, tempDir, type TestServer } from './helpers';

function serveJob(server: TestServer, slug: string) {
  const url = `https://${slug}.com/jobs/1`;
  server.http.serve(url, jobPage({ title: 'Engineer', company: slug, description: `Engineer at ${slug}. ${'plenty of text describing this particular opening '.repeat(8)}${slug}` }));
  return url;
}

const counters = (server: TestServer, jobId: number) => server.ctx.db.$client.prepare('SELECT application_count, last_activity_at, updated_at FROM jobs WHERE id = ?').get(jobId) as { application_count: number; last_activity_at: string; updated_at: string };
const furthest = (server: TestServer, applicationId: number) => (server.ctx.db.$client.prepare('SELECT furthest_rank FROM applications WHERE id = ?').get(applicationId) as { furthest_rank: number }).furthest_rank;

describe('counters kept by the database', () => {
  it('count applications as they come and go', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const url = serveJob(server, 'acme');
    const first: any = await users.tyler.addJob(url);
    expect(counters(server, first.jobId).application_count).toBe(1);
    const second: any = await users.john.addJob(url);
    expect(counters(server, first.jobId).application_count).toBe(2);
    await users.john.delete(`/api/applications/${second.applicationId}`);
    expect(counters(server, first.jobId).application_count).toBe(1);
  });

  it('survive deleting a user and their applications', async () => {
    const server = await createTestServer();
    const { admin, users } = await createUsers(server.app, 'tyler', 'john');
    const url = serveJob(server, 'acme');
    const first: any = await users.tyler.addJob(url);
    await users.john.addJob(url);
    const john = (await users.john.get('/api/auth/me')).json;
    await admin.delete(`/api/admin/users/${john.id}`);
    expect(counters(server, first.jobId).application_count).toBe(1);
  });

  it('follow activity on a job, whoever causes it', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const first: any = await users.tyler.addJob(serveJob(server, 'acme'));
    const before = counters(server, first.jobId).last_activity_at;
    await new Promise((done) => setTimeout(done, 5));
    await users.tyler.patch(`/api/applications/${first.applicationId}`, { memo: 'later' });
    expect(counters(server, first.jobId).last_activity_at > before).toBe(true);
  });

  it('remember the furthest stage through a rejection, and correct it on a step back', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const { applicationId }: any = await users.tyler.addJob(serveJob(server, 'acme'));
    expect(furthest(server, applicationId)).toBe(0);
    await users.tyler.patch(`/api/applications/${applicationId}`, { status: 'Technical Interview' });
    expect(furthest(server, applicationId)).toBe(2);
    await users.tyler.patch(`/api/applications/${applicationId}`, { status: 'Recruiter Screen' });
    expect(furthest(server, applicationId)).toBe(1);
    await users.tyler.patch(`/api/applications/${applicationId}`, { status: 'Technical Interview' });
    await users.tyler.patch(`/api/applications/${applicationId}`, { status: 'Rejected' });
    expect(furthest(server, applicationId)).toBe(2);
    await users.tyler.patch(`/api/applications/${applicationId}`, { status: 'Offer' });
    expect(furthest(server, applicationId)).toBe(4);
  });

  it('are filled in for data from before this version', () => {
    const dir = tempDir();
    const realMigrations = resolve(__dirname, '..', 'drizzle');
    const oldMigrations = join(dir, 'old-migrations');
    mkdirSync(join(oldMigrations, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(join(realMigrations, 'meta', '_journal.json'), 'utf8'));
    journal.entries = journal.entries.slice(0, 3);
    writeFileSync(join(oldMigrations, 'meta', '_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) copyFileSync(join(realMigrations, `${entry.tag}.sql`), join(oldMigrations, `${entry.tag}.sql`));

    const path = join(dir, 'old.sqlite');
    const old = openDatabase(path, oldMigrations);
    old.sqlite.exec(`
      INSERT INTO users (id, username, password_hash) VALUES (1, 'tyler', 'x');
      INSERT INTO profiles (id, user_id, name) VALUES (1, 1, 'Main'), (2, 1, 'Other');
      INSERT INTO jobs (id, company_name, title, description, company_key, title_key, updated_at) VALUES (10, 'Stripe', 'Engineer', 'payments text', 'stripe', 'engineer', '2026-01-01T00:00:00.000Z');
      INSERT INTO applications (id, user_id, profile_id, job_id, status, memo, updated_at) VALUES (100, 1, 1, 10, 'Rejected', 'findable memo', '2026-03-01T00:00:00.000Z'), (101, 1, 2, 10, 'Applied', '', '2026-02-01T00:00:00.000Z');
      INSERT INTO application_status_history (application_id, old_status, new_status) VALUES (100, NULL, 'Applied'), (100, 'Applied', 'Final Interview'), (100, 'Final Interview', 'Rejected');
    `);
    closeDatabase(old);

    const migrated = openDatabase(path, realMigrations);
    try {
      const { sqlite } = migrated;
      expect(sqlite.prepare('SELECT application_count, last_activity_at FROM jobs WHERE id = 10').get()).toEqual({ application_count: 2, last_activity_at: '2026-03-01T00:00:00.000Z' });
      expect(sqlite.prepare('SELECT furthest_rank FROM applications WHERE id = 100').get()).toEqual({ furthest_rank: 3 });
      expect(sqlite.prepare(`SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH 'pay*'`).all()).toEqual([{ rowid: 10 }]);
      expect(sqlite.prepare(`SELECT rowid FROM applications_fts WHERE applications_fts MATCH 'find*'`).all()).toEqual([{ rowid: 100 }]);
    } finally {
      closeDatabase(migrated);
    }
  });
});

describe('search indexes', () => {
  it('find a memo when it is written, when it changes and not after it is gone', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const { applicationId }: any = await users.tyler.addJob(serveJob(server, 'acme'), { memo: 'zebra recruiter' });
    const total = async (q: string) => (await users.tyler.get(`/api/jobs?q=${q}`)).json.total;
    expect(await total('zebra')).toBe(1);
    expect(await total('zeb')).toBe(1);
    await users.tyler.patch(`/api/applications/${applicationId}`, { memo: 'giraffe recruiter' });
    expect(await total('zebra')).toBe(0);
    expect(await total('giraffe')).toBe(1);
    await users.tyler.delete(`/api/applications/${applicationId}`);
    expect(await total('giraffe')).toBe(0);
  });
});

describe('cached responses', () => {
  it('never show anything older than the last change, to anyone', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const added: any = await users.tyler.addJob(serveJob(server, 'acme'));
    const status = async () => (await users.john.get('/api/jobs')).json.items[0].applications[0].status;

    expect(await status()).toBe('Applied');
    expect(await status()).toBe('Applied');
    await users.tyler.patch(`/api/applications/${added.applicationId}`, { status: 'Offer' });
    expect(await status()).toBe('Offer');
    const team = (await users.john.get('/api/team')).json;
    expect(team.find((member: any) => member.user.username === 'tyler').stats.offers).toBe(1);

    await users.tyler.patch(`/api/applications/${added.applicationId}`, { status: 'Rejected' });
    expect(await status()).toBe('Rejected');
    await users.john.post(`/api/jobs/${added.jobId}/highlight`, { highlighted: true });
    expect((await users.tyler.get('/api/jobs')).json.items[0].isHighlighted).toBe(true);
  });

  it('keep each person apart: "mine" is never served to someone else', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    await users.tyler.addJob(serveJob(server, 'acme'));
    const tyler = (await users.tyler.get('/api/jobs?scope=mine')).json;
    const john = (await users.john.get('/api/jobs?scope=mine')).json;
    expect(tyler.total).toBe(1);
    expect(john.total).toBe(0);
    expect((await users.tyler.get('/api/jobs')).json.items[0].applications[0].isMine).toBe(true);
    expect((await users.john.get('/api/jobs')).json.items[0].applications[0].isMine).toBe(false);
  });

  it('still require signing in', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    await users.tyler.get('/api/team');
    const token = users.tyler.token;
    users.tyler.token = null;
    expect((await users.tyler.get('/api/team')).status).toBe(401);
    users.tyler.token = token;
  });

  it('expire, since interview dates change with time and not only with writes', () => {
    const cache = new ReadCache(1000);
    let calls = 0;
    const read = (now: number) => cache.read('key', () => ++calls, now);
    expect(read(0)).toBe('1');
    expect(read(500)).toBe('1');
    expect(read(1500)).toBe('2');
    cache.invalidate();
    expect(read(1600)).toBe('3');
  });

  it('stay within their memory limit, dropping what was used longest ago', () => {
    const cache = new ReadCache(60_000, 100);
    cache.read('old', () => 'x'.repeat(60), 0);
    cache.read('used', () => 'y'.repeat(30), 0);
    cache.read('old', () => 'not reached', 1);
    cache.read('new', () => 'z'.repeat(60), 2);
    let recomputed = false;
    cache.read('used', () => ((recomputed = true), 'y'), 3);
    expect(recomputed).toBe(true);
  });

  it('are refreshed by a restore', async () => {
    const server = await createTestServer();
    const { admin, users } = await createUsers(server.app, 'tyler');
    const backup = (await admin.post('/api/admin/backups')).json;
    await users.tyler.addJob(serveJob(server, 'acme'));
    expect((await admin.get('/api/jobs')).json.total).toBe(1);
    await admin.post(`/api/admin/backups/${backup.name}/restore`);
    expect((await admin.get('/api/jobs')).json.total).toBe(0);
  });
});

describe('deleting a job', () => {
  it('is allowed when your one profile is the only one that applied', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const added: any = await users.tyler.addJob(serveJob(server, 'acme'));
    expect((await users.tyler.delete(`/api/jobs/${added.jobId}`)).status).toBe(200);
    expect((await users.tyler.get('/api/jobs')).json.total).toBe(0);
    // The link goes too, so adding it again starts afresh.
    expect((await users.tyler.addJob('https://acme.com/jobs/1') as any).jobWasNew).toBe(true);
  });

  it('is allowed when all the applications are from your own profiles', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const second = (await users.tyler.post('/api/profiles', { name: 'Second' })).json.id;
    const url = serveJob(server, 'acme');
    const added: any = await users.tyler.addJob(url);
    await users.tyler.addJob(url, { profileId: second });
    expect((await users.tyler.delete(`/api/jobs/${added.jobId}`)).status).toBe(200);
  });

  it("is refused when someone else's profile has applied too", async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const url = serveJob(server, 'acme');
    const added: any = await users.tyler.addJob(url);
    await users.john.addJob(url);
    expect((await users.tyler.delete(`/api/jobs/${added.jobId}`)).status).toBe(403);
    expect((await users.john.delete(`/api/jobs/${added.jobId}`)).status).toBe(403);
    expect((await users.john.get('/api/jobs')).json.items[0].applications).toHaveLength(2);
  });

  it('is refused for a job you have nothing to do with, or that nobody applied to', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const added: any = await users.tyler.addJob(serveJob(server, 'acme'));
    expect((await users.john.delete(`/api/jobs/${added.jobId}`)).status).toBe(403);
    await users.tyler.delete(`/api/applications/${added.applicationId}`);
    expect((await users.tyler.delete(`/api/jobs/${added.jobId}`)).status).toBe(403);
    expect((await users.tyler.delete('/api/jobs/99999')).status).toBe(404);
  });

  it('is always allowed for the administrator', async () => {
    const server = await createTestServer();
    const { admin, users } = await createUsers(server.app, 'tyler', 'john');
    const url = serveJob(server, 'acme');
    const added: any = await users.tyler.addJob(url);
    await users.john.addJob(url);
    expect((await admin.delete(`/api/jobs/${added.jobId}`)).status).toBe(200);
  });
});

describe('with a large data set', () => {
  async function loaded() {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    seedLoadData(server.ctx.handle.sqlite, { passwordHash: 'x', jobs: 400, users: 4, profilesPerUser: 3 });
    return { server, tyler: users.tyler };
  }

  it('sorts by most applied using the real number of applications', async () => {
    const { server, tyler } = await loaded();
    const items = (await tyler.get('/api/jobs?sort=applicants&limit=400')).json.items;
    const lengths = items.map((job: any) => job.applications.length);
    expect(lengths).toEqual([...lengths].sort((a: number, b: number) => b - a));
    const stored = server.ctx.db.$client.prepare('SELECT COUNT(*) AS wrong FROM jobs j WHERE j.application_count != (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id)').get();
    expect(stored).toEqual({ wrong: 0 });
  });

  it('pages through every job exactly once', async () => {
    const { tyler } = await loaded();
    for (const sort of ['recent', 'applied', 'updated', 'company', 'interview', 'status', 'applicants']) {
      const seen = new Set<number>();
      for (let offset = 0; offset < 400; offset += 50) {
        const { items, total } = (await tyler.get(`/api/jobs?sort=${sort}&limit=50&offset=${offset}`)).json;
        expect(total).toBe(400);
        for (const job of items) seen.add(job.id);
      }
      expect(seen.size, sort).toBe(400);
    }
  });

  it('agrees with counting by hand on the team page', async () => {
    const { server, tyler } = await loaded();
    const team = (await tyler.get('/api/team')).json;
    const sqlite = server.ctx.db.$client;
    for (const member of team) {
      const expected = sqlite.prepare('SELECT COUNT(*) AS c FROM applications WHERE user_id = ?').get(member.user.id) as { c: number };
      expect(member.stats.applications).toBe(expected.c);
      const offers = sqlite.prepare(`SELECT COUNT(DISTINCT h.application_id) AS c FROM application_status_history h JOIN applications a ON a.id = h.application_id WHERE a.user_id = ? AND h.new_status = 'Offer'`).get(member.user.id) as { c: number };
      expect(member.stats.offers).toBe(offers.c);
      const interviews = sqlite.prepare('SELECT COUNT(*) AS c FROM interviews i JOIN applications a ON a.id = i.application_id WHERE a.user_id = ?').get(member.user.id) as { c: number };
      expect(member.stats.interviews).toBe(interviews.c);
    }
  });
});
