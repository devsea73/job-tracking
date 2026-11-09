import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/server/db/client';
import { standingChanges, stepsOf } from '../src/server/db/steps-from-history';
import { computeStats, currentStage, furthestStage, interviewsEndedBy, passRate } from '../src/shared/pipeline';
import { createTestServer, createUsers, jobPage, tempDir, type ApiClient, type TestServer } from './helpers';

const PNG = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]).toString('base64')}`;

async function addProfile(client: ApiClient, name: string): Promise<number> {
  const created = await client.post('/api/profiles', { name });
  if (created.status !== 201) throw new Error(`Creating profile failed: ${JSON.stringify(created.json)}`);
  return created.json.id;
}

function serveJob(server: TestServer, slug: string, title = 'Engineer', company = slug) {
  const url = `https://${slug}.com/jobs/1`;
  server.http.serve(url, jobPage({ title, company, description: `${title} at ${company}. ${'plenty of text describing this particular opening '.repeat(8)}${slug}` }));
  return url;
}

describe('migrating an existing database', () => {
  /**
   * A database as an early version left it, with real rows in every table involved: statuses set by
   * hand, with their history, and interviews with stages of their own.
   *
   * Tyler's application 100 went to Recruiter Screen, was set to Final Interview by mistake and put
   * back to Technical Interview a few minutes later, then was rejected. It had a call ("Other"), a
   * hiring manager interview and a technical interview. John's application 101 reached Technical,
   * got an offer, and still had a final interview on the calendar after it. Tyler's 102 was imported
   * the day after it was applied, and never went anywhere.
   */
  function databaseFromPreviousVersion(dir: string): { path: string; realMigrations: string } {
    const realMigrations = resolve(__dirname, '..', 'drizzle');
    const oldMigrations = join(dir, 'old-migrations');
    mkdirSync(join(oldMigrations, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(join(realMigrations, 'meta', '_journal.json'), 'utf8'));
    journal.entries = journal.entries.slice(0, 2);
    writeFileSync(join(oldMigrations, 'meta', '_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) copyFileSync(join(realMigrations, `${entry.tag}.sql`), join(oldMigrations, `${entry.tag}.sql`));

    const path = join(dir, 'old.sqlite');
    const old = openDatabase(path, oldMigrations);
    old.sqlite.exec(`
      INSERT INTO users (id, username, display_name, password_hash) VALUES (1, 'tyler', 'Tyler Morgan', 'x'), (2, 'john', NULL, 'x'), (3, 'unused', NULL, 'x');
      INSERT INTO jobs (id, company_name, title, description, company_key, title_key) VALUES (10, 'Stripe', 'Engineer', 'text', 'stripe', 'engineer'), (11, 'Figma', 'Designer', 'text', 'figma', 'designer');
      INSERT INTO applications (id, user_id, job_id, status, memo, applied_at, updated_at) VALUES
        (100, 1, 10, 'Rejected', 'keep this memo', '2026-10-01T09:00:00.000Z', '2026-10-10T12:00:00.000Z'),
        (101, 2, 10, 'Offer', '', '2026-10-05T10:00:00.000Z', '2026-10-20T10:00:00.000Z'),
        (102, 1, 11, 'Applied', '', '2026-10-14T00:00:00.000Z', '2026-10-15T08:00:00.000Z');
      INSERT INTO interviews (id, application_id, stage, scheduled_at, timezone, note) VALUES
        (1000, 100, 'Other', '2026-10-03T15:00:00.000Z', 'UTC', 'Phone call'),
        (1001, 100, 'Hiring Manager', '2026-10-06T16:00:00.000Z', 'Europe/London', 'Ask about the team'),
        (1002, 100, 'Technical Interview', '2026-10-08T14:00:00.000Z', 'UTC', NULL),
        (1003, 101, 'Final Interview', '2026-10-25T13:00:00.000Z', 'America/New_York', 'Meet the team');
      INSERT INTO application_status_history (application_id, old_status, new_status, changed_at) VALUES
        (100, NULL, 'Applied', '2026-10-01T09:00:00.000Z'),
        (100, 'Applied', 'Recruiter Screen', '2026-10-02T09:00:00.000Z'),
        (100, 'Recruiter Screen', 'Final Interview', '2026-10-04T09:00:00.000Z'),
        (100, 'Final Interview', 'Technical Interview', '2026-10-04T09:05:00.000Z'),
        (100, 'Technical Interview', 'Rejected', '2026-10-10T12:00:00.000Z'),
        (101, NULL, 'Applied', '2026-10-05T10:00:00.000Z'),
        (101, 'Applied', 'Technical Interview', '2026-10-07T10:00:00.000Z'),
        (101, 'Technical Interview', 'Offer', '2026-10-20T10:00:00.000Z'),
        (102, NULL, 'Applied', '2026-10-15T08:00:00.000Z');
    `);
    closeDatabase(old);
    return { path, realMigrations };
  }

  const stepsOfApplication = (sqlite: Database.Database, id: number) =>
    sqlite.prepare('SELECT stage, at, timezone, note FROM application_steps WHERE application_id = ? ORDER BY at, id').all(id);

  it('turns every interview and status change into steps on a timeline, and gives each user a profile', () => {
    const { path, realMigrations } = databaseFromPreviousVersion(tempDir());
    const migrated = openDatabase(path, realMigrations);
    try {
      const { sqlite } = migrated;
      const profiles = sqlite.prepare('SELECT user_id, name FROM profiles ORDER BY user_id').all();
      expect(profiles).toEqual([
        { user_id: 1, name: 'Tyler Morgan' },
        { user_id: 2, name: 'john' },
        { user_id: 3, name: 'unused' }
      ]);
      const application = sqlite.prepare('SELECT a.memo, a.stage, a.furthest_rank, a.applied_at, a.created_at, p.name FROM applications a JOIN profiles p ON p.id = a.profile_id WHERE a.id = 100').get();
      expect(application).toEqual({ memo: 'keep this memo', stage: 'Rejected', furthest_rank: 2, applied_at: '2026-10-01T09:00:00.000Z', created_at: '2026-10-01T09:00:00.000Z', name: 'Tyler Morgan' });

      // Each interview at its own time. "Other" and "Hiring Manager" take the stage the application
      // was at then; the mistaken Final Interview, undone minutes later, is gone; the rejection ends it.
      expect(stepsOfApplication(sqlite, 100)).toEqual([
        { stage: 'Recruiter Screen', at: '2026-10-03T15:00:00.000Z', timezone: 'UTC', note: 'Phone call' },
        { stage: 'Technical Interview', at: '2026-10-06T16:00:00.000Z', timezone: 'Europe/London', note: 'Hiring manager: Ask about the team' },
        { stage: 'Technical Interview', at: '2026-10-08T14:00:00.000Z', timezone: 'UTC', note: null },
        { stage: 'Rejected', at: '2026-10-10T12:00:00.000Z', timezone: 'UTC', note: null }
      ]);

      // A stage reached without an interview is a step at the moment it was set. The offer stays the
      // last step, after the final interview still on the calendar, so the application stays at Offer.
      expect(stepsOfApplication(sqlite, 101)).toEqual([
        { stage: 'Technical Interview', at: '2026-10-07T10:00:00.000Z', timezone: 'UTC', note: null },
        { stage: 'Final Interview', at: '2026-10-25T13:00:00.000Z', timezone: 'America/New_York', note: 'Meet the team' },
        { stage: 'Offer', at: '2026-10-25T13:00:01.000Z', timezone: 'UTC', note: null }
      ]);
      expect(sqlite.prepare('SELECT stage, furthest_rank FROM applications WHERE id = 101').get()).toEqual({ stage: 'Offer', furthest_rank: 4 });

      // Nothing happened to the third: no steps, still Applied. It was written the day after it was applied.
      expect(stepsOfApplication(sqlite, 102)).toEqual([]);
      expect(sqlite.prepare('SELECT stage, furthest_rank, applied_at, created_at FROM applications WHERE id = 102').get()).toEqual({
        stage: 'Applied',
        furthest_rank: 0,
        applied_at: '2026-10-14T00:00:00.000Z',
        created_at: '2026-10-15T08:00:00.000Z'
      });

      // The status, its history and the interviews' own stages are gone.
      const tables = (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toContain('application_steps');
      expect(tables).not.toContain('interviews');
      expect(tables).not.toContain('application_status_history');
      const columns = (sqlite.prepare('PRAGMA table_info(applications)').all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(['stage', 'furthest_rank', 'applied_at', 'created_at', 'updated_at']));
      expect(columns).not.toContain('status');
      // The memo search was rebuilt along with the table.
      expect(sqlite.prepare(`SELECT rowid FROM applications_fts WHERE applications_fts MATCH 'memo'`).pluck().all()).toEqual([100]);
    } finally {
      closeDatabase(migrated);
    }
  });

  it('leaves foreign keys on, and working, afterwards, and keeps each stage up to date from its steps', () => {
    const { path, realMigrations } = databaseFromPreviousVersion(tempDir());
    const migrated = openDatabase(path, realMigrations);
    try {
      const { sqlite } = migrated;
      expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
      sqlite.prepare('DELETE FROM applications WHERE id = 100').run();
      expect(sqlite.prepare('SELECT COUNT(*) AS c FROM application_steps WHERE application_id = 100').get()).toEqual({ c: 0 });
      expect(sqlite.prepare('SELECT application_count FROM jobs WHERE id = 10').get()).toEqual({ application_count: 1 });

      // The triggers work on the rebuilt table: a step sets the stage, removing it sets it back.
      sqlite.prepare(`INSERT INTO application_steps (application_id, stage, at, timezone) VALUES (102, 'Technical Interview', '2026-10-20T10:00:00.000Z', 'UTC')`).run();
      expect(sqlite.prepare('SELECT stage, furthest_rank FROM applications WHERE id = 102').get()).toEqual({ stage: 'Technical Interview', furthest_rank: 2 });
      sqlite.prepare('DELETE FROM application_steps WHERE application_id = 102').run();
      expect(sqlite.prepare('SELECT stage, furthest_rank FROM applications WHERE id = 102').get()).toEqual({ stage: 'Applied', furthest_rank: 0 });
      expect(() => sqlite.prepare(`INSERT INTO application_steps (application_id, stage, at, timezone) VALUES (999, 'Offer', '2026-10-20T10:00:00.000Z', 'UTC')`).run()).toThrow(/FOREIGN KEY/);
      expect(() => sqlite.prepare(`INSERT INTO application_steps (application_id, stage, at, timezone) VALUES (102, 'Applied', '2026-10-20T10:00:00.000Z', 'UTC')`).run()).toThrow(/CHECK/);
    } finally {
      closeDatabase(migrated);
    }
  });
});

describe('reading an old status history', () => {
  const change = (id: number, old_status: string | null, new_status: string, changed_at: string) => ({ id, application_id: 1, old_status, new_status, changed_at });

  it('drops a stage that was moved back from, and a rejection that was taken back', () => {
    expect(
      standingChanges([
        change(1, null, 'Applied', '2026-10-01T00:00:00.000Z'),
        change(2, 'Applied', 'Final Interview', '2026-10-02T00:00:00.000Z'),
        change(3, 'Final Interview', 'Recruiter Screen', '2026-10-02T00:01:00.000Z'),
        change(4, 'Recruiter Screen', 'Rejected', '2026-10-05T00:00:00.000Z'),
        change(5, 'Rejected', 'Technical Interview', '2026-10-06T00:00:00.000Z')
      ])
    ).toEqual([
      { status: 'Recruiter Screen', at: '2026-10-02T00:01:00.000Z' },
      { status: 'Technical Interview', at: '2026-10-06T00:00:00.000Z' }
    ]);
  });

  it('reads two merged applications as two runs, so the start of the second undoes nothing', () => {
    expect(
      standingChanges([
        change(1, null, 'Applied', '2026-10-01T00:00:00.000Z'),
        change(2, 'Applied', 'Final Interview', '2026-10-02T00:00:00.000Z'),
        change(3, null, 'Applied', '2026-10-03T00:00:00.000Z'),
        change(4, 'Applied', 'Recruiter Screen', '2026-10-04T00:00:00.000Z')
      ])
    ).toEqual([
      { status: 'Final Interview', at: '2026-10-02T00:00:00.000Z' },
      { status: 'Recruiter Screen', at: '2026-10-04T00:00:00.000Z' }
    ]);
  });

  it('keeps a stage set with no change recorded for it, as late as is known', () => {
    expect(stepsOf({ status: 'Technical Interview', updated_at: '2026-10-09T00:00:00.000Z' }, [], [])).toEqual([
      { stage: 'Technical Interview', at: '2026-10-09T00:00:00.000Z', timezone: 'UTC', note: null, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z' }
    ]);
    expect(stepsOf({ status: 'Applied', updated_at: '2026-10-09T00:00:00.000Z' }, [], [change(1, null, 'Applied', '2026-10-01T00:00:00.000Z')])).toEqual([]);
  });
});

describe('profiles', () => {
  it('every new user starts with one, named after them', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const { profiles } = (await users.tyler.get('/api/profiles')).json;
    expect(profiles.map((profile: any) => profile.name)).toEqual(['tyler']);
  });

  it('can be created, renamed and listed, and belong to one user', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const id = await addProfile(users.tyler, 'Data Engineer');

    expect((await users.tyler.post('/api/profiles', { name: 'data engineer' })).status).toBe(409);
    expect((await users.john.post('/api/profiles', { name: 'Data Engineer' })).status).toBe(201);
    expect((await users.tyler.post('/api/profiles', { name: '   ' })).status).toBe(400);

    expect((await users.tyler.patch(`/api/profiles/${id}`, { name: 'Backend' })).status).toBe(200);
    expect((await users.john.patch(`/api/profiles/${id}`, { name: 'Stolen' })).status).toBe(404);
    expect((await users.john.delete(`/api/profiles/${id}`)).status).toBe(404);
    const names = (await users.tyler.get('/api/profiles')).json.profiles.map((profile: any) => profile.name);
    expect(names).toEqual(['Backend', 'tyler']);
  });

  it('are deleted if never used, and archived if they have applications', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const unused = await addProfile(users.tyler, 'Unused');
    const used = await addProfile(users.tyler, 'Used');
    await users.tyler.addJob(serveJob(server, 'acme'), { profileId: used });

    expect((await users.tyler.delete(`/api/profiles/${unused}`)).json).toEqual({ outcome: 'deleted' });
    expect((await users.tyler.delete(`/api/profiles/${used}`)).json).toEqual({ outcome: 'archived' });

    const { profiles } = (await users.tyler.get('/api/profiles')).json;
    expect(profiles.map((profile: any) => [profile.name, profile.isArchived, profile.applicationCount])).toEqual([
      ['tyler', false, 0],
      ['Used', true, 1]
    ]);
    // The application and its timeline are still there.
    expect((await users.tyler.get('/api/jobs?scope=mine')).json.total).toBe(1);
  });

  it('leave you at least one active profile', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const only = await users.tyler.defaultProfileId();
    expect((await users.tyler.delete(`/api/profiles/${only}`)).json.error.code).toBe('last_profile');
    expect((await users.tyler.patch(`/api/profiles/${only}`, { isArchived: true })).json.error.code).toBe('last_profile');
  });

  it('suggest the one used last', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const other = await addProfile(users.tyler, 'Other');
    expect((await users.tyler.get('/api/profiles')).json.lastUsedProfileId).toBeNull();
    await users.tyler.addJob(serveJob(server, 'acme'), { profileId: other });
    expect((await users.tyler.get('/api/profiles')).json.lastUsedProfileId).toBe(other);
  });
});

describe('applying under a profile', () => {
  it('allows one application per profile for the same job', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const first = await users.tyler.defaultProfileId();
    const second = await addProfile(users.tyler, 'Second');
    const url = serveJob(server, 'acme');

    const one: any = await users.tyler.addJob(url, { profileId: first });
    const two: any = await users.tyler.addJob(`${url}?utm_source=linkedin`, { profileId: second });
    expect(two).toMatchObject({ outcome: 'created', jobId: one.jobId, jobWasNew: false });

    const again: any = await users.tyler.addJob(url, { profileId: second, memo: 'ignored' });
    expect(again).toMatchObject({ outcome: 'already_applied', applicationId: two.applicationId, profileName: 'Second' });

    const job = (await users.tyler.get(`/api/jobs/${one.jobId}`)).json;
    expect(job.applications.map((application: any) => application.profile.name)).toEqual(['tyler', 'Second']);
  });

  it('is enforced by the database, even for concurrent requests', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const url = serveJob(server, 'acme');
    const results = await Promise.all([users.tyler.addJob(url), users.tyler.addJob(url)]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['already_applied', 'created']);
    const sqlite = server.ctx.db.$client;
    const row = sqlite.prepare('SELECT user_id, profile_id, job_id FROM applications').get() as any;
    expect(() => sqlite.prepare('INSERT INTO applications (user_id, profile_id, job_id) VALUES (?, ?, ?)').run(row.user_id, row.profile_id, row.job_id)).toThrow(/UNIQUE/);
  });

  it("refuses a missing, archived or someone else's profile before reading the page", async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const url = serveJob(server, 'acme');
    const johns = await users.john.defaultProfileId();

    expect((await users.tyler.post('/api/applications', { url })).status).toBe(400);
    expect((await users.tyler.post('/api/applications', { url, profileId: johns })).json.error.code).toBe('invalid_profile');

    const archived = await addProfile(users.tyler, 'Old');
    await users.tyler.patch(`/api/profiles/${archived}`, { isArchived: true });
    expect((await users.tyler.post('/api/applications', { url, profileId: archived })).json.error.code).toBe('invalid_profile');

    expect(server.http.requests).toEqual([]);
  });

  it('applies to a job already in the list under the chosen profile', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const added: any = await users.tyler.addJob(serveJob(server, 'acme'));
    const backend = await addProfile(users.john, 'Backend');
    const joined = await users.john.post(`/api/jobs/${added.jobId}/apply`, { profileId: backend });
    expect(joined.json.outcome).toBe('created');
    expect((await users.john.post(`/api/jobs/${added.jobId}/apply`, {})).status).toBe(400);
    const job = (await users.john.get(`/api/jobs/${added.jobId}`)).json;
    expect(job.applications[1].profile.name).toBe('Backend');
  });
});

describe('avatars', () => {
  it('can be set, shown and removed for a user', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const me = (await users.tyler.get('/api/auth/me')).json;
    expect(me.avatarVersion).toBeNull();

    expect((await users.tyler.post('/api/me/avatar', { image: PNG })).status).toBe(200);
    expect((await users.tyler.get('/api/auth/me')).json.avatarVersion).toEqual(expect.any(String));

    await users.tyler.addJob(serveJob(server, 'acme'));
    const seen = (await users.john.get('/api/jobs')).json.items[0].applications[0];
    expect(seen.owner.avatarVersion).toEqual(expect.any(String));
    expect((await users.john.get(`/api/avatars/users/${me.id}`)).json.image).toBe(PNG);

    expect((await users.tyler.delete('/api/me/avatar')).status).toBe(200);
    expect((await users.tyler.get('/api/auth/me')).json.avatarVersion).toBeNull();
    expect((await users.john.get(`/api/avatars/users/${me.id}`)).status).toBe(404);
  });

  it('are separate for each profile, which only its owner can change', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const profileId = await addProfile(users.tyler, 'Backend');
    const other = await users.tyler.defaultProfileId();

    expect((await users.john.post(`/api/profiles/${profileId}/avatar`, { image: PNG })).status).toBe(404);
    expect((await users.tyler.post(`/api/profiles/${profileId}/avatar`, { image: PNG })).status).toBe(200);

    const { profiles } = (await users.tyler.get('/api/profiles')).json;
    expect(profiles.find((profile: any) => profile.id === profileId).avatarVersion).toEqual(expect.any(String));
    expect(profiles.find((profile: any) => profile.id === other).avatarVersion).toBeNull();
    expect((await users.tyler.get('/api/auth/me')).json.avatarVersion).toBeNull();

    expect((await users.john.get(`/api/avatars/profiles/${profileId}`)).json.image).toBe(PNG);
    expect((await users.john.delete(`/api/profiles/${profileId}/avatar`)).status).toBe(404);
    expect((await users.tyler.delete(`/api/profiles/${profileId}/avatar`)).status).toBe(200);
  });

  it('refuse anything that is not really an image, whatever it claims to be', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const encode = (mime: string, content: string | Buffer) => `data:${mime};base64,${Buffer.from(content).toString('base64')}`;
    const bad = [
      'not a data url',
      encode('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      encode('image/png', '<svg><script>alert(1)</script></svg>'),
      encode('image/png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600 * 1024, 1)])),
      'x'.repeat(1_000_001)
    ];
    for (const image of bad) {
      expect((await users.tyler.post('/api/me/avatar', { image })).status, image.slice(0, 40)).toBe(400);
    }
    expect((await users.tyler.get('/api/auth/me')).json.avatarVersion).toBeNull();
  });

  it('can be taken down by the administrator only', async () => {
    const server = await createTestServer();
    const { admin, users } = await createUsers(server.app, 'tyler', 'john');
    const tyler = (await users.tyler.get('/api/auth/me')).json;
    const profileId = await users.tyler.defaultProfileId();
    await users.tyler.post('/api/me/avatar', { image: PNG });
    await users.tyler.post(`/api/profiles/${profileId}/avatar`, { image: PNG });

    expect((await users.john.delete(`/api/admin/users/${tyler.id}/avatar`)).status).toBe(403);
    expect((await users.john.delete(`/api/admin/profiles/${profileId}/avatar`)).status).toBe(403);
    expect((await admin.delete(`/api/admin/users/${tyler.id}/avatar`)).status).toBe(200);
    expect((await admin.delete(`/api/admin/profiles/${profileId}/avatar`)).status).toBe(200);
    expect((await users.tyler.get(`/api/avatars/users/${tyler.id}`)).status).toBe(404);
    expect((await users.tyler.get(`/api/avatars/profiles/${profileId}`)).status).toBe(404);
  });

  it('go away with their account', async () => {
    const server = await createTestServer();
    const { admin, users } = await createUsers(server.app, 'tyler');
    const tyler = (await users.tyler.get('/api/auth/me')).json;
    const profileId = await users.tyler.defaultProfileId();
    await users.tyler.post('/api/me/avatar', { image: PNG });
    await users.tyler.post(`/api/profiles/${profileId}/avatar`, { image: PNG });
    await users.tyler.addJob(serveJob(server, 'acme'));
    expect((await admin.delete(`/api/admin/users/${tyler.id}`)).status).toBe(200);
    const sqlite = server.ctx.db.$client;
    for (const table of ['profiles', 'user_avatars', 'profile_avatars', 'applications']) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${table === 'profile_avatars' ? 'profile_id' : 'user_id'} = ?`).get(table === 'profile_avatars' ? profileId : tyler.id)).toEqual({ c: 0 });
    }
    expect((await admin.get('/api/jobs')).json.total).toBe(1);
  });
});

describe('sharing everything', () => {
  async function shared() {
    const server = await createTestServer();
    const { admin, users } = await createUsers(server.app, 'tyler', 'john');
    const added: any = await users.tyler.addJob(serveJob(server, 'acme'), { memo: 'visible memo' });
    const interview = await users.tyler.addStep(added.applicationId, 'Technical Interview', '2030-11-13T14:00:00Z', { note: 'visible note' });
    return { server, admin, tyler: users.tyler, john: users.john, added, stepId: interview.id };
  }

  it("lets everyone read each other's stage, memo and timeline", async () => {
    const { john, tyler, added } = await shared();
    await tyler.addStep(added.applicationId, 'Recruiter Screen', '2026-10-02T15:00:00Z');
    const job = (await john.get(`/api/jobs/${added.jobId}`)).json;
    expect(job.applications[0]).toMatchObject({ isMine: false, stage: 'Technical Interview', furthestStage: 'Technical Interview', memo: 'visible memo', owner: { username: 'tyler' } });
    expect(job.applications[0].steps.map((step: any) => [step.stage, step.at, step.note])).toEqual([
      ['Recruiter Screen', '2026-10-02T15:00:00.000Z', null],
      ['Technical Interview', '2030-11-13T14:00:00.000Z', 'visible note']
    ]);
  });

  it('still lets only the owner change anything', async () => {
    const { john, tyler, added, stepId } = await shared();
    const url = `/api/applications/${added.applicationId}`;
    const step = { stage: 'Rejected', at: '2030-11-13T14:00:00Z', timezone: 'UTC' };
    expect((await john.patch(url, { memo: 'changed' })).status).toBe(404);
    expect((await john.patch(url, { appliedAt: '2026-01-01T00:00:00Z' })).status).toBe(404);
    expect((await john.delete(url)).status).toBe(404);
    expect((await john.post(`${url}/steps`, step)).status).toBe(404);
    expect((await john.patch(`/api/steps/${stepId}`, step)).status).toBe(404);
    expect((await john.delete(`/api/steps/${stepId}`)).status).toBe(404);
    // There is no stage to set by hand: it comes from the timeline.
    expect((await tyler.patch(url, { status: 'Rejected' })).status).toBe(400);
    const mine = (await tyler.get(`/api/jobs/${added.jobId}`)).json.applications[0];
    expect(mine).toMatchObject({ stage: 'Technical Interview', memo: 'visible memo', isMine: true });
    expect(mine.steps).toHaveLength(1);
  });

  it('never exposes password data or sessions', async () => {
    const { john, added } = await shared();
    const responses = await Promise.all([john.get(`/api/jobs/${added.jobId}`), john.get('/api/jobs'), john.get('/api/team'), john.get('/api/interviews?person=all')]);
    for (const response of responses) {
      const text = JSON.stringify(response.json);
      expect(text).not.toMatch(/passwordHash|password_hash|argon2|tokenHash/i);
    }
  });

  it('shows every job to every user, whoever added it', async () => {
    const { admin, john, added } = await shared();
    for (const client of [john, admin]) {
      expect((await client.get('/api/jobs')).json.items.map((job: any) => job.id)).toEqual([added.jobId]);
    }
  });

  it('lists anyone’s interviews on request, and your own by default', async () => {
    const { john, tyler } = await shared();
    expect((await john.get('/api/interviews')).json).toEqual([]);
    const everyone = (await john.get('/api/interviews?person=all')).json;
    expect(everyone[0]).toMatchObject({ note: 'visible note', isMine: false, owner: { username: 'tyler' }, profile: { name: 'tyler' } });
    const tylerId = (await tyler.get('/api/auth/me')).json.id;
    expect((await john.get(`/api/interviews?person=${tylerId}`)).json).toHaveLength(1);
    expect((await tyler.get('/api/interviews')).json[0].isMine).toBe(true);
  });

  it('tells connected apps about every change to a timeline', async () => {
    const { server, tyler, added, stepId } = await shared();
    const seen: string[] = [];
    server.ctx.events.subscribe((event) => seen.push(event.type));
    const final = await tyler.addStep(added.applicationId, 'Final Interview', '2030-12-01T14:00:00Z');
    await tyler.patch(`/api/steps/${stepId}`, { stage: 'Technical Interview', at: '2030-11-14T14:00:00Z', timezone: 'UTC' });
    await tyler.delete(`/api/steps/${final.id}`);
    await tyler.patch(`/api/applications/${added.applicationId}`, { appliedAt: '2026-10-01T08:00:00Z' });
    expect(seen).toEqual(['applications_changed', 'applications_changed', 'applications_changed', 'applications_changed']);
  });
});

describe('interview process on the job list', () => {
  it('reports the furthest stage each profile reached', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const second = await addProfile(users.tyler, 'Second');
    const url = serveJob(server, 'acme');
    const one: any = await users.tyler.addJob(url);
    const two: any = await users.tyler.addJob(url, { profileId: second });
    await users.tyler.addStep(one.applicationId, 'Technical Interview', '2026-10-05T10:00:00Z');
    await users.tyler.addStep(one.applicationId, 'Rejected', '2026-10-06T10:00:00Z');
    await users.tyler.addStep(two.applicationId, 'Final Interview', '2030-12-01T14:00:00Z');

    const { applications } = (await users.tyler.get('/api/jobs')).json.items[0];
    // The technical interview took place: it is still on the timeline, and still counts.
    expect(applications[0]).toMatchObject({ stage: 'Rejected', furthestStage: 'Technical Interview', interviewCount: 1, nextInterviewAt: null });
    expect(applications[1]).toMatchObject({ stage: 'Final Interview', furthestStage: 'Final Interview', interviewCount: 1, nextInterviewAt: '2030-12-01T14:00:00.000Z' });
  });

  it('lists a job once however many profiles applied', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const second = await addProfile(users.tyler, 'Second');
    const url = serveJob(server, 'acme');
    await users.tyler.addJob(url);
    await users.tyler.addJob(url, { profileId: second });
    for (const sort of ['recent', 'applied', 'updated', 'company', 'interview', 'stage', 'applicants']) {
      for (const scope of ['all', 'mine']) {
        const list = (await users.tyler.get(`/api/jobs?sort=${sort}&scope=${scope}`)).json;
        expect(list.total, `${sort} ${scope}`).toBe(1);
        expect(list.items, `${sort} ${scope}`).toHaveLength(1);
      }
    }
  });
});

describe('person and profile filters', () => {
  async function catalog() {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const backend = await addProfile(users.tyler, 'Backend');
    const stripe: any = await users.tyler.addJob(serveJob(server, 'stripe'), { profileId: backend });
    await users.tyler.addJob(serveJob(server, 'figma'));
    const johnStripe: any = await users.john.addJob(serveJob(server, 'stripe'));
    await users.john.addStep(johnStripe.applicationId, 'Offer', '2026-10-20T10:00:00Z');
    await users.tyler.addStep(stripe.applicationId, 'Rejected', '2026-10-21T10:00:00Z');
    const ids = { tyler: (await users.tyler.get('/api/auth/me')).json.id, john: (await users.john.get('/api/auth/me')).json.id };
    return { tyler: users.tyler, john: users.john, backend, ids };
  }
  const companies = (response: any) => response.json.items.map((job: any) => job.company).sort();

  it('narrow the list to one person or one profile', async () => {
    const { john, backend, ids } = await catalog();
    expect(companies(await john.get(`/api/jobs?personId=${ids.tyler}`))).toEqual(['figma', 'stripe']);
    expect(companies(await john.get(`/api/jobs?personId=${ids.john}`))).toEqual(['stripe']);
    expect(companies(await john.get(`/api/jobs?profileId=${backend}`))).toEqual(['stripe']);
  });

  it('require one application to meet every condition', async () => {
    const { john, ids } = await catalog();
    // Stripe has an Offer (John) and a Rejected (Tyler), but Tyler has no Offer.
    expect(companies(await john.get('/api/jobs?stage=Offer'))).toEqual(['stripe']);
    expect(companies(await john.get(`/api/jobs?stage=Offer&personId=${ids.john}`))).toEqual(['stripe']);
    expect(companies(await john.get(`/api/jobs?stage=Offer&personId=${ids.tyler}`))).toEqual([]);
    expect(companies(await john.get(`/api/jobs?stage=Applied&personId=${ids.tyler}`))).toEqual(['figma']);
  });
});

describe('most applied sort', () => {
  it('puts the job with the most applications first, newest first on a tie', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const extra = await addProfile(users.tyler, 'Extra');
    const popular = serveJob(server, 'popular');
    const middle = serveJob(server, 'middle');
    const tieOld = serveJob(server, 'tieold');
    const tieNew = serveJob(server, 'tienew');
    await users.tyler.addJob(popular);
    await users.tyler.addJob(popular, { profileId: extra });
    await users.john.addJob(popular);
    await users.tyler.addJob(middle);
    await users.john.addJob(middle);
    await users.tyler.addJob(tieOld);
    await users.tyler.addJob(tieNew);
    const order = (await users.john.get('/api/jobs?sort=applicants')).json.items.map((job: any) => [job.company, job.applications.length]);
    expect(order).toEqual([
      ['popular', 3],
      ['middle', 2],
      ['tienew', 1],
      ['tieold', 1]
    ]);
  });

  it('is accepted with paging past 500 jobs, up to the limit', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    expect((await users.tyler.get('/api/jobs?sort=applicants&limit=5000')).status).toBe(200);
    expect((await users.tyler.get('/api/jobs?limit=5001')).status).toBe(400);
  });
});

describe('pass rates', () => {
  it('uses the furthest stage any step reached, in whatever order, which a rejection keeps', () => {
    expect(furthestStage([])).toBe('Applied');
    expect(furthestStage(['Applied'])).toBe('Applied');
    expect(furthestStage(['Technical Interview', 'Rejected'])).toBe('Technical Interview');
    expect(furthestStage(['Final Interview', 'Recruiter Screen'])).toBe('Final Interview');
    expect(furthestStage(['Rejected'])).toBe('Applied');
  });

  it('puts an application at the stage of its latest step, by when each takes place', () => {
    expect(currentStage([])).toBe('Applied');
    const steps = [
      { id: 1, stage: 'Technical Interview', at: '2026-10-08T10:00:00.000Z' },
      { id: 2, stage: 'Recruiter Screen', at: '2026-10-02T10:00:00.000Z' },
      { id: 3, stage: 'Technical Interview', at: '2026-10-12T10:00:00.000Z' }
    ];
    expect(currentStage(steps)).toBe('Technical Interview');
    // Two at the same moment: the one put in later.
    expect(currentStage([...steps, { id: 5, stage: 'Rejected', at: '2026-10-12T10:00:00.000Z' }, { id: 4, stage: 'Offer', at: '2026-10-12T10:00:00.000Z' }])).toBe('Rejected');
    // An offer or a rejection ends it: only the interviews after it come off.
    expect(interviewsEndedBy(steps, { stage: 'Rejected', at: '2026-10-09T00:00:00.000Z' }).map((step) => step.id)).toEqual([3]);
    expect(interviewsEndedBy(steps, { stage: 'Technical Interview', at: '2026-10-01T00:00:00.000Z' })).toEqual([]);
    expect(interviewsEndedBy([...steps, { id: 6, stage: 'Offer', at: '2026-10-20T00:00:00.000Z' }], { stage: 'Rejected', at: '2026-10-09T00:00:00.000Z' }).map((step) => step.id)).toEqual([3]);
  });

  it('compares each stage with the one before it, counting skipped stages as passed', () => {
    const stats = computeStats(['Applied', 'Applied', 'Recruiter Screen', 'Technical Interview', 'Final Interview', 'Offer'], 3);
    expect(stats).toMatchObject({ applications: 6, interviews: 3, technical: 3, offers: 1 });
    expect(stats.screenPass).toEqual({ reached: 4, from: 6, percent: 66.7 });
    expect(stats.technicalPass).toEqual({ reached: 3, from: 4, percent: 75 });
    expect(stats.interviewPass).toEqual({ reached: 2, from: 3, percent: 66.7 });
    expect(stats.offerPass).toEqual({ reached: 1, from: 2, percent: 50 });
    expect(stats.success).toEqual({ reached: 1, from: 6, percent: 16.7 });
  });

  it('has no rate, rather than 0%, when nothing reached the stage before', () => {
    expect(passRate(0, 0).percent).toBeNull();
    const none = computeStats([], 0);
    expect(none.applications).toBe(0);
    expect(none.success.percent).toBeNull();
    const early = computeStats(['Applied'], 0);
    expect(early.screenPass.percent).toBe(0);
    expect(early.technicalPass.percent).toBeNull();
  });

  it('are reported for each person and each of their profiles', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const backend = await addProfile(users.tyler, 'Backend');
    const screened: any = await users.tyler.addJob(serveJob(server, 'one'));
    const rejected: any = await users.tyler.addJob(serveJob(server, 'two'));
    const offered: any = await users.tyler.addJob(serveJob(server, 'three'), { profileId: backend });
    await users.tyler.addStep(screened.applicationId, 'Recruiter Screen', '2026-10-02T10:00:00Z');
    await users.tyler.addStep(rejected.applicationId, 'Technical Interview', '2026-10-03T10:00:00Z');
    await users.tyler.addStep(rejected.applicationId, 'Rejected', '2026-10-04T10:00:00Z');
    await users.tyler.addStep(offered.applicationId, 'Final Interview', '2026-10-05T10:00:00Z');
    await users.tyler.addStep(offered.applicationId, 'Offer', '2026-10-09T10:00:00Z');

    // John is not admin and has nothing of his own, but sees the whole team. The administrator
    // applies with their own profiles too, and is part of it.
    const team = (await users.john.get('/api/team')).json;
    expect(team.map((member: any) => member.user.username)).toEqual(['admin', 'john', 'tyler']);
    const john = team.find((member: any) => member.user.username === 'john');
    expect(john.stats).toMatchObject({ applications: 0, interviews: 0, technical: 0, offers: 0 });
    expect(john.stats.success.percent).toBeNull();

    // Interviews are the interview steps on the timelines: the screen, the technical and the final.
    const tyler = team.find((member: any) => member.user.username === 'tyler');
    expect(tyler.stats).toMatchObject({ applications: 3, interviews: 3, technical: 2, offers: 1 });
    expect(tyler.stats.screenPass.percent).toBe(100);
    expect(tyler.stats.technicalPass).toEqual({ reached: 2, from: 3, percent: 66.7 });
    expect(tyler.stats.success).toEqual({ reached: 1, from: 3, percent: 33.3 });

    const byProfile = Object.fromEntries(tyler.profiles.map((entry: any) => [entry.profile.name, entry.stats]));
    expect(byProfile.Backend).toMatchObject({ applications: 1, offers: 1, interviews: 1 });
    expect(byProfile.tyler).toMatchObject({ applications: 2, offers: 0, technical: 1, interviews: 2 });
  });
});
