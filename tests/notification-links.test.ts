import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JobBrief, JobDetail } from '../src/shared/api';
import { closeDatabase, openDatabase } from '../src/server/db/client';
import { createTestServer, createUsers, jobPage, tempDir } from './helpers';

/** Tyler adds a job with one link; John joins it with another link to the same posting. */
async function twoLinks() {
  const server = await createTestServer();
  const { admin, users } = await createUsers(server.app, 'tyler', 'john', 'zoe');
  server.http.serve('https://careers.example.com/jobs/7', jobPage({ title: 'Data Engineer', company: 'Acme' }));
  const tylers = await users.tyler.addJob('https://careers.example.com/jobs/7');
  if (tylers.outcome !== 'created') throw new Error(tylers.outcome);
  // The same posting on a job board: John said so when asked.
  const johns = await users.john.addJob('https://www.linkedin.com/jobs/view/4100000001/?trk=public_jobs', { resolution: { action: 'merge', jobId: tylers.jobId } });
  if (johns.outcome !== 'created') throw new Error(johns.outcome);
  return { server, admin, users, jobId: tylers.jobId, tylers, johns };
}

const brief = async (client: { get: (url: string) => Promise<{ json: unknown }> }, jobId: number, applicationId?: number) =>
  (await client.get(`/api/jobs/${jobId}/brief${applicationId ? `?application=${applicationId}` : ''}`)).json as JobBrief;

describe('the link a new-job notification copies', () => {
  it('is the one the person in the notice applied with, not the first one the job was saved with', async () => {
    const { users, jobId, tylers, johns } = await twoLinks();
    const aboutJohn = await brief(users.zoe, jobId, johns.outcome === 'created' ? johns.applicationId : undefined);
    expect(aboutJohn).toMatchObject({ owner: 'john', url: 'https://www.linkedin.com/jobs/view/4100000001/' });
    const aboutTyler = await brief(users.zoe, jobId, tylers.outcome === 'created' ? tylers.applicationId : undefined);
    expect(aboutTyler).toMatchObject({ owner: 'tyler', url: 'https://careers.example.com/jobs/7' });

    // Each application shows the link it came with, and the ids match the job's own links.
    const job = (await users.zoe.get(`/api/jobs/${jobId}`)).json as JobDetail;
    const linkOf = (owner: string) => job.applications.find((application) => application.owner.username === owner)?.link;
    expect(linkOf('john')?.url).toBe(aboutJohn.url);
    expect(job.urls.find((url) => url.id === aboutJohn.urlId)?.originalUrl).toBe(aboutJohn.url);
    expect(linkOf('tyler')?.id).toBe(aboutTyler.urlId);
  });

  it('falls back to the first link anyone applied with when the person joined without one', async () => {
    const { users, jobId } = await twoLinks();
    const joined = await users.zoe.post(`/api/jobs/${jobId}/apply`, { profileId: await users.zoe.defaultProfileId() });
    expect(joined.json).toMatchObject({ outcome: 'created' });
    const card = await brief(users.tyler, jobId, joined.json.applicationId);
    expect(card).toMatchObject({ owner: 'zoe', url: 'https://careers.example.com/jobs/7' });
  });

  it('is kept on the application made from the notice, and only if it belongs to that job', async () => {
    const { server, users, jobId, johns } = await twoLinks();
    const offered = await brief(users.zoe, jobId, johns.outcome === 'created' ? johns.applicationId : undefined);
    const applied = await users.zoe.post(`/api/jobs/${jobId}/apply`, { profileId: await users.zoe.defaultProfileId(), urlId: offered.urlId });
    expect(applied.json).toMatchObject({ outcome: 'created' });
    const job = (await users.zoe.get(`/api/jobs/${jobId}`)).json as JobDetail;
    expect(job.applications.find((application) => application.isMine)?.link?.url).toBe('https://www.linkedin.com/jobs/view/4100000001/');

    // Another job's link is not taken for this one.
    server.http.serve('https://careers.example.com/jobs/8', jobPage({ title: 'Platform Engineer', company: 'Globex', description: 'Kubernetes platform work at Globex. '.repeat(30) }));
    const other = await users.john.addJob('https://careers.example.com/jobs/8');
    if (other.outcome !== 'created') throw new Error(other.outcome);
    const otherJob = (await users.john.get(`/api/jobs/${other.jobId}`)).json as JobDetail;
    const wrong = await users.tyler.post(`/api/jobs/${jobId}/apply`, { profileId: (await users.tyler.post('/api/profiles', { name: 'Second' })).json.id, urlId: otherJob.urls[0].id });
    expect(wrong.json).toMatchObject({ outcome: 'created' });
    const again = (await users.tyler.get(`/api/jobs/${jobId}`)).json as JobDetail;
    expect(again.applications.find((application) => application.id === wrong.json.applicationId)?.link).toBeNull();
  });

  it('survives two copies of a job being merged, keeping the earlier application’s link', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    server.http.serve('https://careers.example.com/jobs/20', jobPage({ title: 'Backend Engineer', company: 'Initech', description: 'Initech builds billing software for banks. '.repeat(30) }));
    server.http.serve('https://jobs.example.org/initech/backend', jobPage({ title: 'Backend Developer', company: 'Initech Inc', description: 'Ruby and Postgres work on reporting for insurers. '.repeat(30) }));
    const first = await users.tyler.addJob('https://careers.example.com/jobs/20');
    const second = await users.tyler.addJob('https://jobs.example.org/initech/backend', { resolution: { action: 'new' } });
    if (first.outcome !== 'created' || second.outcome !== 'created') throw new Error(`${first.outcome} ${second.outcome}`);
    expect(second.jobId).not.toBe(first.jobId);
    // Offered on the Duplicates page, as the background check would.
    server.ctx.db.$client
      .prepare(`INSERT INTO duplicate_candidates (job_id_low, job_id_high, status, score, reasons) VALUES (?, ?, 'pending', 0.7, '[]') ON CONFLICT (job_id_low, job_id_high) DO UPDATE SET status = 'pending'`)
      .run(Math.min(first.jobId, second.jobId), Math.max(first.jobId, second.jobId));
    const merged = await users.tyler.post('/api/duplicates/merge', { jobIdA: first.jobId, jobIdB: second.jobId });
    const job = (await users.tyler.get(`/api/jobs/${merged.json.keptJobId}`)).json as JobDetail;
    expect(job.applications).toHaveLength(1);
    expect(job.applications[0].link?.url).toBe('https://careers.example.com/jobs/20');
  });

  it('is offered to the administrator like anyone, since they apply too', async () => {
    const { admin, users, jobId, johns } = await twoLinks();
    expect(await brief(admin, jobId, johns.outcome === 'created' ? johns.applicationId : undefined)).toMatchObject({ viewerIsAdmin: true, addedByMe: false, alreadyApplied: false });
    expect((await brief(users.zoe, jobId)).viewerIsAdmin).toBe(false);
  });
});

describe('applications saved before links were kept with them', () => {
  it('get the link that was saved in the same moment, and no guess otherwise', () => {
    const dir = tempDir();
    const realMigrations = resolve(__dirname, '..', 'drizzle');
    const oldMigrations = join(dir, 'old-migrations');
    mkdirSync(join(oldMigrations, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(join(realMigrations, 'meta', '_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag < '0007');
    writeFileSync(join(oldMigrations, 'meta', '_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries) copyFileSync(join(realMigrations, `${entry.tag}.sql`), join(oldMigrations, `${entry.tag}.sql`));

    const path = join(dir, 'old.sqlite');
    const old = openDatabase(path, oldMigrations);
    old.sqlite.exec(`
      INSERT INTO users (id, username, password_hash) VALUES (1, 'tyler', 'x'), (2, 'john', 'x');
      INSERT INTO profiles (id, user_id, name) VALUES (1, 1, 'tyler'), (2, 2, 'john'), (3, 1, 'Second');
      INSERT INTO jobs (id, company_name, title, description, company_key, title_key) VALUES (10, 'Acme', 'Engineer', 'text', 'acme', 'engineer');
      INSERT INTO job_urls (id, job_id, original_url, normalized_url, kind, created_at) VALUES
        (1, 10, 'https://careers.example.com/jobs/1', 'https://careers.example.com/jobs/1', 'original', '2026-10-01T09:00:00.120Z'),
        (2, 10, 'https://careers.example.com/jobs/1?gh_jid=1', 'https://careers.example.com/jobs/1?gh_jid=1', 'canonical', '2026-10-01T09:00:00.121Z'),
        (3, 10, 'https://www.linkedin.com/jobs/view/1', 'https://linkedin.com/jobs/view/1', 'original', '2026-10-03T15:30:00.900Z');
      INSERT INTO applications (id, user_id, profile_id, job_id, applied_at) VALUES
        (100, 1, 1, 10, '2026-10-01T09:00:00.125Z'),
        (101, 2, 2, 10, '2026-10-03T15:30:01.000Z'),
        (102, 1, 3, 10, '2026-10-20T12:00:00.000Z');
    `);
    closeDatabase(old);

    const migrated = openDatabase(path, realMigrations);
    try {
      expect(migrated.sqlite.prepare('SELECT id, job_url_id FROM applications ORDER BY id').all()).toEqual([
        { id: 100, job_url_id: 1 },
        { id: 101, job_url_id: 3 },
        { id: 102, job_url_id: null }
      ]);
      // Deleting a link leaves the application in place, without one.
      migrated.sqlite.prepare('DELETE FROM job_urls WHERE id = 3').run();
      expect(migrated.sqlite.prepare('SELECT job_url_id FROM applications WHERE id = 101').get()).toEqual({ job_url_id: null });
    } finally {
      closeDatabase(migrated);
    }
  });
});
