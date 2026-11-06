import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/server/db/client';
import { computeStats, furthestStage, passRate } from '../src/shared/pipeline';
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
  /** A database as the previous version left it, with real rows in every table involved. */
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
      INSERT INTO jobs (id, company_name, title, description, company_key, title_key) VALUES (10, 'Stripe', 'Engineer', 'text', 'stripe', 'engineer');
      INSERT INTO applications (id, user_id, job_id, status, memo) VALUES (100, 1, 10, 'Technical Interview', 'keep this memo'), (101, 2, 10, 'Applied', '');
      INSERT INTO interviews (id, application_id, stage, scheduled_at, timezone) VALUES (1000, 100, 'Technical Interview', '2030-01-01T00:00:00.000Z', 'UTC');
      INSERT INTO application_status_history (application_id, old_status, new_status) VALUES (100, NULL, 'Applied'), (100, 'Applied', 'Technical Interview');
    `);
    closeDatabase(old);
    return { path, realMigrations };
  }

  it('keeps every application, interview and history entry, and gives each user a profile', () => {
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
      const application = sqlite.prepare('SELECT a.memo, a.status, p.name FROM applications a JOIN profiles p ON p.id = a.profile_id WHERE a.id = 100').get();
      expect(application).toEqual({ memo: 'keep this memo', status: 'Technical Interview', name: 'Tyler Morgan' });
      expect(sqlite.prepare('SELECT COUNT(*) AS c FROM interviews').get()).toEqual({ c: 1 });
      expect(sqlite.prepare('SELECT COUNT(*) AS c FROM application_status_history').get()).toEqual({ c: 2 });
    } finally {
      closeDatabase(migrated);
    }
  });

  it('leaves foreign keys on, and working, afterwards', () => {
    const { path, realMigrations } = databaseFromPreviousVersion(tempDir());
    const migrated = openDatabase(path, realMigrations);
    try {
      const { sqlite } = migrated;
      expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      sqlite.prepare('DELETE FROM applications WHERE id = 100').run();
      expect(sqlite.prepare('SELECT COUNT(*) AS c FROM interviews').get()).toEqual({ c: 0 });
    } finally {
      closeDatabase(migrated);
    }
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
    // The application and its history are still there.
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
    await users.tyler.patch(`/api/applications/${added.applicationId}`, { status: 'Technical Interview' });
    const interview = await users.tyler.post(`/api/applications/${added.applicationId}/interviews`, { stage: 'Technical Interview', scheduledAt: '2030-11-13T14:00:00Z', timezone: 'UTC', note: 'visible note' });
    return { server, admin, tyler: users.tyler, john: users.john, added, interviewId: interview.json.id };
  }

  it("lets everyone read each other's status, memo, interviews and history", async () => {
    const { john, added } = await shared();
    const job = (await john.get(`/api/jobs/${added.jobId}`)).json;
    expect(job.applications[0]).toMatchObject({ isMine: false, status: 'Technical Interview', memo: 'visible memo', owner: { username: 'tyler' } });
    expect(job.applications[0].interviews[0].note).toBe('visible note');
    expect(job.applications[0].history.map((entry: any) => entry.newStatus)).toEqual(['Technical Interview', 'Applied']);
  });

  it('still lets only the owner change anything', async () => {
    const { john, tyler, added, interviewId } = await shared();
    const url = `/api/applications/${added.applicationId}`;
    expect((await john.patch(url, { status: 'Rejected' })).status).toBe(404);
    expect((await john.patch(url, { memo: 'changed' })).status).toBe(404);
    expect((await john.delete(url)).status).toBe(404);
    expect((await john.post(`${url}/interviews`, { stage: 'Other', scheduledAt: '2030-11-13T14:00:00Z', timezone: 'UTC' })).status).toBe(404);
    expect((await john.patch(`/api/interviews/${interviewId}`, { stage: 'Other', scheduledAt: '2030-11-13T14:00:00Z', timezone: 'UTC' })).status).toBe(404);
    expect((await john.delete(`/api/interviews/${interviewId}`)).status).toBe(404);
    expect((await tyler.get(`/api/jobs/${added.jobId}`)).json.applications[0]).toMatchObject({ status: 'Technical Interview', memo: 'visible memo', isMine: true });
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

  it('tells connected apps about status and interview changes', async () => {
    const { server, tyler, added } = await shared();
    const seen: string[] = [];
    server.ctx.events.subscribe((event) => seen.push(event.type));
    await tyler.patch(`/api/applications/${added.applicationId}`, { status: 'Final Interview' });
    await tyler.post(`/api/applications/${added.applicationId}/interviews`, { stage: 'Final Interview', scheduledAt: '2030-12-01T14:00:00Z', timezone: 'UTC' });
    expect(seen).toEqual(['applications_changed', 'applications_changed']);
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
    await users.tyler.patch(`/api/applications/${one.applicationId}`, { status: 'Technical Interview' });
    await users.tyler.patch(`/api/applications/${one.applicationId}`, { status: 'Rejected' });
    await users.tyler.patch(`/api/applications/${two.applicationId}`, { status: 'Final Interview' });
    await users.tyler.post(`/api/applications/${two.applicationId}/interviews`, { stage: 'Final Interview', scheduledAt: '2030-12-01T14:00:00Z', timezone: 'UTC' });

    const { applications } = (await users.tyler.get('/api/jobs')).json.items[0];
    expect(applications[0]).toMatchObject({ status: 'Rejected', furthestStage: 'Technical Interview', interviewCount: 0, nextInterviewAt: null });
    expect(applications[1]).toMatchObject({ status: 'Final Interview', furthestStage: 'Final Interview', interviewCount: 1, nextInterviewAt: '2030-12-01T14:00:00.000Z' });
  });

  it('lists a job once however many profiles applied', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const second = await addProfile(users.tyler, 'Second');
    const url = serveJob(server, 'acme');
    await users.tyler.addJob(url);
    await users.tyler.addJob(url, { profileId: second });
    for (const sort of ['recent', 'applied', 'updated', 'company', 'interview', 'status', 'applicants']) {
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
    await users.john.patch(`/api/applications/${johnStripe.applicationId}`, { status: 'Offer' });
    await users.tyler.patch(`/api/applications/${stripe.applicationId}`, { status: 'Rejected' });
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
    expect(companies(await john.get('/api/jobs?status=Offer'))).toEqual(['stripe']);
    expect(companies(await john.get(`/api/jobs?status=Offer&personId=${ids.john}`))).toEqual(['stripe']);
    expect(companies(await john.get(`/api/jobs?status=Offer&personId=${ids.tyler}`))).toEqual([]);
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
  it('uses the stage reached, where moving back corrects a mistake and a rejection does not', () => {
    expect(furthestStage(['Applied'])).toBe('Applied');
    expect(furthestStage(['Applied', 'Technical Interview', 'Rejected'])).toBe('Technical Interview');
    expect(furthestStage(['Applied', 'Final Interview', 'Recruiter Screen'])).toBe('Recruiter Screen');
    expect(furthestStage(['Rejected'])).toBe('Applied');
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
    await users.tyler.patch(`/api/applications/${screened.applicationId}`, { status: 'Recruiter Screen' });
    await users.tyler.patch(`/api/applications/${rejected.applicationId}`, { status: 'Technical Interview' });
    await users.tyler.patch(`/api/applications/${rejected.applicationId}`, { status: 'Rejected' });
    await users.tyler.patch(`/api/applications/${offered.applicationId}`, { status: 'Offer' });
    await users.tyler.post(`/api/applications/${offered.applicationId}/interviews`, { stage: 'Final Interview', scheduledAt: '2030-12-01T14:00:00Z', timezone: 'UTC' });

    // John is not admin and has nothing of his own, but sees the whole team. The administrator
    // applies with their own profiles too, and is part of it.
    const team = (await users.john.get('/api/team')).json;
    expect(team.map((member: any) => member.user.username)).toEqual(['admin', 'john', 'tyler']);
    const john = team.find((member: any) => member.user.username === 'john');
    expect(john.stats).toMatchObject({ applications: 0, interviews: 0, technical: 0, offers: 0 });
    expect(john.stats.success.percent).toBeNull();

    const tyler = team.find((member: any) => member.user.username === 'tyler');
    expect(tyler.stats).toMatchObject({ applications: 3, interviews: 1, technical: 2, offers: 1 });
    expect(tyler.stats.screenPass.percent).toBe(100);
    expect(tyler.stats.technicalPass).toEqual({ reached: 2, from: 3, percent: 66.7 });
    expect(tyler.stats.success).toEqual({ reached: 1, from: 3, percent: 33.3 });

    const byProfile = Object.fromEntries(tyler.profiles.map((entry: any) => [entry.profile.name, entry.stats]));
    expect(byProfile.Backend).toMatchObject({ applications: 1, offers: 1, interviews: 1 });
    expect(byProfile.tyler).toMatchObject({ applications: 2, offers: 0, technical: 1 });
  });
});
