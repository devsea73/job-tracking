import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { avatarColor, avatarInitials } from '../src/shared/avatar';
import { assertRestorable } from '../src/server/services/backups';
import { ApiClient, createTestServer, createUsers, jobPage, signInAdmin, tempDir, type TestServer } from './helpers';

async function jobWithTwoApplicants(server: TestServer) {
  const { admin, users } = await createUsers(server.app, 'tyler', 'john');
  server.http.serve('https://company.com/jobs/1', jobPage({ title: 'Engineer', company: 'Stripe' }));
  const tyler: any = await users.tyler.addJob('https://company.com/jobs/1', { memo: 'tyler memo' });
  const john: any = await users.john.addJob('https://company.com/jobs/1', { memo: 'john memo' });
  return { admin, tyler: users.tyler, john: users.john, jobId: tyler.jobId as number, tylerApp: tyler.applicationId as number, johnApp: john.applicationId as number };
}

/** The signed-in user's application within a job's details. */
const mine = (job: any) => job.applications.find((application: any) => application.isMine);

const INTERVIEW = { stage: 'Technical Interview', scheduledAt: '2030-11-13T14:00:00-05:00', timezone: 'America/New_York' };

describe('application status', () => {
  it('starts as Applied and stays independent per user', async () => {
    const server = await createTestServer();
    const { tyler, john, jobId, tylerApp, johnApp } = await jobWithTwoApplicants(server);
    expect(mine((await tyler.get(`/api/jobs/${jobId}`)).json).status).toBe('Applied');

    await tyler.patch(`/api/applications/${tylerApp}`, { status: 'Technical Interview' });
    await john.patch(`/api/applications/${johnApp}`, { status: 'Recruiter Screen' });

    expect(mine((await tyler.get(`/api/jobs/${jobId}`)).json).status).toBe('Technical Interview');
    expect(mine((await john.get(`/api/jobs/${jobId}`)).json).status).toBe('Recruiter Screen');
  });

  it('records history, including the first status', async () => {
    const server = await createTestServer();
    const { tyler, jobId, tylerApp } = await jobWithTwoApplicants(server);
    await tyler.patch(`/api/applications/${tylerApp}`, { status: 'Recruiter Screen' });
    await tyler.patch(`/api/applications/${tylerApp}`, { status: 'Recruiter Screen' }); // no change, no entry
    await tyler.patch(`/api/applications/${tylerApp}`, { status: 'Offer' });
    const history = mine((await tyler.get(`/api/jobs/${jobId}`)).json).history;
    expect(history.map((entry: any) => [entry.oldStatus, entry.newStatus])).toEqual([
      ['Recruiter Screen', 'Offer'],
      ['Applied', 'Recruiter Screen'],
      [null, 'Applied']
    ]);
  });

  it('rejects statuses that do not exist', async () => {
    const server = await createTestServer();
    const { tyler, tylerApp } = await jobWithTwoApplicants(server);
    expect((await tyler.patch(`/api/applications/${tylerApp}`, { status: 'Hired!' })).status).toBe(400);
  });

  it("cannot touch another user's application", async () => {
    const server = await createTestServer();
    const { john, jobId, tyler, tylerApp } = await jobWithTwoApplicants(server);
    expect((await john.patch(`/api/applications/${tylerApp}`, { status: 'Rejected' })).status).toBe(404);
    expect((await john.patch(`/api/applications/${tylerApp}`, { memo: 'hacked' })).status).toBe(404);
    expect((await john.delete(`/api/applications/${tylerApp}`)).status).toBe(404);
    expect((await john.post(`/api/applications/${tylerApp}/interviews`, INTERVIEW)).status).toBe(404);
    expect(mine((await tyler.get(`/api/jobs/${jobId}`)).json)).toMatchObject({ status: 'Applied', memo: 'tyler memo' });
  });
});

describe('memos', () => {
  it('can be edited by their owner', async () => {
    const server = await createTestServer();
    const { tyler, jobId, tylerApp } = await jobWithTwoApplicants(server);
    await tyler.patch(`/api/applications/${tylerApp}`, { memo: 'updated' });
    expect(mine((await tyler.get(`/api/jobs/${jobId}`)).json).memo).toBe('updated');
  });

  it('are shared with everyone, along with interview notes', async () => {
    const server = await createTestServer();
    const { john, jobId, tylerApp, tyler } = await jobWithTwoApplicants(server);
    await tyler.post(`/api/applications/${tylerApp}/interviews`, { ...INTERVIEW, note: 'tyler note' });
    const job = (await john.get(`/api/jobs/${jobId}`)).json;
    const tylers = job.applications.find((application: any) => application.owner.username === 'tyler');
    expect(tylers).toMatchObject({ memo: 'tyler memo', isMine: false });
    expect(tylers.interviews[0].note).toBe('tyler note');
    expect((await john.get('/api/jobs')).json.items[0].applications[0].memoPreview).toBe('tyler memo');
    // Anyone's memo can be found by searching.
    expect((await john.get('/api/jobs?q=tyler%20memo')).json.total).toBe(1);
  });
});

describe('interviews', () => {
  it('supports several per application, stored in UTC with their timezone', async () => {
    const server = await createTestServer();
    const { tyler, jobId, tylerApp } = await jobWithTwoApplicants(server);
    const created = await tyler.post(`/api/applications/${tylerApp}/interviews`, INTERVIEW);
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ scheduledAt: '2030-11-13T19:00:00.000Z', timezone: 'America/New_York', stage: 'Technical Interview' });
    await tyler.post(`/api/applications/${tylerApp}/interviews`, { stage: 'Recruiter Screen', scheduledAt: '2030-11-10T10:00:00Z', timezone: 'UTC', note: 'Call' });
    await tyler.post(`/api/applications/${tylerApp}/interviews`, { stage: 'Final Interview', scheduledAt: '2030-11-18T11:00:00Z', timezone: 'UTC' });
    const list = mine((await tyler.get(`/api/jobs/${jobId}`)).json).interviews;
    expect(list.map((item: any) => item.stage)).toEqual(['Recruiter Screen', 'Technical Interview', 'Final Interview']);
  });

  it('rejects ambiguous times and unknown timezones', async () => {
    const server = await createTestServer();
    const { tyler, tylerApp } = await jobWithTwoApplicants(server);
    expect((await tyler.post(`/api/applications/${tylerApp}/interviews`, { ...INTERVIEW, scheduledAt: '2030-11-13T14:00:00' })).status).toBe(400);
    expect((await tyler.post(`/api/applications/${tylerApp}/interviews`, { ...INTERVIEW, timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await tyler.post(`/api/applications/${tylerApp}/interviews`, { ...INTERVIEW, stage: 'Coffee' })).status).toBe(400);
  });

  it('can be edited and removed by their owner only', async () => {
    const server = await createTestServer();
    const { tyler, john, tylerApp } = await jobWithTwoApplicants(server);
    const { id } = (await tyler.post(`/api/applications/${tylerApp}/interviews`, INTERVIEW)).json;

    expect((await john.patch(`/api/interviews/${id}`, INTERVIEW)).status).toBe(404);
    expect((await john.delete(`/api/interviews/${id}`)).status).toBe(404);

    const updated = await tyler.patch(`/api/interviews/${id}`, { ...INTERVIEW, stage: 'Final Interview', note: 'moved' });
    expect(updated.json).toMatchObject({ stage: 'Final Interview', note: 'moved' });
    expect((await tyler.delete(`/api/interviews/${id}`)).status).toBe(200);
    expect((await tyler.get('/api/interviews')).json).toEqual([]);
  });

  it('shows upcoming interviews on the dashboard, and filters by date and stage', async () => {
    const server = await createTestServer();
    const { tyler, tylerApp } = await jobWithTwoApplicants(server);
    await tyler.post(`/api/applications/${tylerApp}/interviews`, { stage: 'Recruiter Screen', scheduledAt: '2020-01-01T10:00:00Z', timezone: 'UTC' });
    await tyler.post(`/api/applications/${tylerApp}/interviews`, { stage: 'Technical Interview', scheduledAt: '2030-11-13T10:00:00Z', timezone: 'UTC' });
    await tyler.post(`/api/applications/${tylerApp}/interviews`, { stage: 'Final Interview', scheduledAt: '2031-01-13T10:00:00Z', timezone: 'UTC' });

    const dashboard = (await tyler.get('/api/dashboard')).json;
    expect(dashboard.upcomingInterviews).toBe(2);
    expect(dashboard.nextInterviews[0]).toMatchObject({ stage: 'Technical Interview', company: 'Stripe' });

    const inRange = (await tyler.get(`/api/interviews?from=${encodeURIComponent('2030-11-01T00:00:00Z')}&to=${encodeURIComponent('2030-12-01T00:00:00Z')}`)).json;
    expect(inRange.map((item: any) => item.stage)).toEqual(['Technical Interview']);
    const byStage = (await tyler.get('/api/interviews?stage=Final%20Interview')).json;
    expect(byStage.map((item: any) => item.stage)).toEqual(['Final Interview']);
  });
});

describe('global highlights', () => {
  it('are shared by everyone, and anyone can remove them', async () => {
    const server = await createTestServer();
    const { tyler, john, admin, jobId } = await jobWithTwoApplicants(server);
    await john.post(`/api/jobs/${jobId}/highlight`, { highlighted: true });

    for (const client of [tyler, john, admin]) {
      const list = (await client.get('/api/jobs?highlighted=true')).json;
      expect(list.items.map((job: any) => job.id)).toEqual([jobId]);
      expect(list.items[0].isHighlighted).toBe(true);
    }
    expect((await tyler.get(`/api/jobs/${jobId}`)).json.highlightedBy).toBe('john');

    await tyler.post(`/api/jobs/${jobId}/highlight`, { highlighted: false });
    expect((await john.get('/api/jobs?highlighted=true')).json.total).toBe(0);
  });

  it('can be sorted to the top', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    server.http.serve('https://a.com/jobs/1', jobPage({ title: 'Old', company: 'Aaa', description: `${'first posting words here '.repeat(20)}` }));
    server.http.serve('https://b.com/jobs/2', jobPage({ title: 'New', company: 'Bbb', description: `${'second posting other text '.repeat(20)}` }));
    const first: any = await users.tyler.addJob('https://a.com/jobs/1');
    await users.tyler.addJob('https://b.com/jobs/2');
    await users.tyler.post(`/api/jobs/${first.jobId}/highlight`, { highlighted: true });
    const plain = (await users.tyler.get('/api/jobs')).json.items.map((job: any) => job.title);
    const sorted = (await users.tyler.get('/api/jobs?highlightFirst=true')).json.items.map((job: any) => job.title);
    expect(plain).toEqual(['New', 'Old']);
    expect(sorted).toEqual(['Old', 'New']);
  });
});

describe('avatars', () => {
  it('derive initials from names', () => {
    expect(avatarInitials('tyler', 'Tyler Morgan')).toBe('TM');
    expect(avatarInitials('john.doe')).toBe('JD');
    expect(avatarInitials('mike')).toBe('MI');
    expect(avatarInitials('mary-kate_smith')).toBe('MS');
  });

  it('keep a stable color through a rename', () => {
    expect(avatarColor(7)).toBe(avatarColor(7));
    expect(new Set([1, 2, 3, 4, 5, 6].map(avatarColor)).size).toBeGreaterThan(1);
  });

  it('show who applied, and under which profile', async () => {
    const server = await createTestServer();
    const { john, jobId } = await jobWithTwoApplicants(server);
    const { applications } = (await john.get(`/api/jobs/${jobId}`)).json;
    expect(applications.map((application: any) => [application.owner.username, application.profile.name])).toEqual([
      ['tyler', 'tyler'],
      ['john', 'john']
    ]);
    expect(applications[0].owner.passwordHash).toBeUndefined();
    expect(applications[0].profile).toMatchObject({ kind: 'profile', avatarVersion: null });
  });

  it('appear on a job once its second applicant joins, with one avatar each', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    server.http.serve('https://company.com/jobs/1', jobPage({ title: 'Engineer', company: 'Stripe' }));
    const first: any = await users.tyler.addJob('https://company.com/jobs/1');
    expect((await users.john.get('/api/jobs')).json.items[0].applications).toHaveLength(1);
    const profileId = await users.john.defaultProfileId();
    const joined = await users.john.post(`/api/jobs/${first.jobId}/apply`, { memo: 'me too', profileId });
    expect(joined.json.outcome).toBe('created');
    expect((await users.tyler.get('/api/jobs')).json.items[0].applications).toHaveLength(2);
    expect((await users.john.post(`/api/jobs/${first.jobId}/apply`, { profileId })).json.outcome).toBe('already_applied');
  });
});

describe('search and filtering', () => {
  async function catalog() {
    const server = await createTestServer();
    const { admin, users } = await createUsers(server.app, 'tyler', 'john');
    const add = async (client: ApiClient, slug: string, title: string, company: string, description: string, memo = '') => {
      server.http.serve(`https://${slug}.com/jobs/1`, jobPage({ title, company, description: `${description} ${'filler words for this particular posting number '.repeat(8)}${slug}` }));
      return (await client.addJob(`https://${slug}.com/jobs/1`, { memo })) as any;
    };
    const stripe = await add(users.tyler, 'stripe', 'Backend Engineer', 'Stripe', 'Work on payments with Kubernetes.', 'recruiter called me');
    const figma = await add(users.tyler, 'figma', 'Data Analyst', 'Figma', 'Design tooling analytics in Snowflake.', 'applied via referral');
    const notion = await add(users.john, 'notion', 'Product Manager', 'Notion', 'Own the docs roadmap.', 'john note');
    await users.tyler.patch(`/api/applications/${stripe.applicationId}`, { status: 'Technical Interview' });
    await users.tyler.post(`/api/applications/${stripe.applicationId}/interviews`, { stage: 'Technical Interview', scheduledAt: '2030-11-13T14:00:00Z', timezone: 'UTC' });
    return { server, admin, tyler: users.tyler, john: users.john, stripe, figma, notion };
  }
  const titles = (response: any) => response.json.items.map((job: any) => job.company);

  it('searches company, title and description', async () => {
    const { tyler } = await catalog();
    expect(titles(await tyler.get('/api/jobs?q=stripe'))).toEqual(['Stripe']);
    expect(titles(await tyler.get('/api/jobs?q=analyst'))).toEqual(['Figma']);
    expect(titles(await tyler.get('/api/jobs?q=kubernetes'))).toEqual(['Stripe']);
    expect(titles(await tyler.get('/api/jobs?q=snow'))).toEqual(['Figma']); // prefix
    expect(titles(await tyler.get('/api/jobs?q=zzzz'))).toEqual([]);
  });

  it("searches everyone's memos", async () => {
    const { tyler, john } = await catalog();
    expect(titles(await tyler.get('/api/jobs?q=recruiter'))).toEqual(['Stripe']);
    expect(titles(await john.get('/api/jobs?q=recruiter'))).toEqual(['Stripe']);
    expect(titles(await tyler.get('/api/jobs?q=john%20note'))).toEqual(['Notion']);
  });

  it('survives search text with special characters', async () => {
    const { tyler } = await catalog();
    for (const q of ['"', "'; DROP TABLE jobs; --", 'c++', 'a*', 'NEAR(', '%', '_', '\\']) {
      expect((await tyler.get(`/api/jobs?q=${encodeURIComponent(q)}`)).status, q).toBe(200);
    }
    expect((await tyler.get('/api/jobs')).json.total).toBe(3);
  });

  it('combines filters', async () => {
    const { tyler } = await catalog();
    expect(titles(await tyler.get('/api/jobs?company=stripe&status=Technical%20Interview&q=recruiter'))).toEqual(['Stripe']);
    expect(titles(await tyler.get('/api/jobs?company=stripe&status=Applied'))).toEqual([]);
    expect(titles(await tyler.get('/api/jobs?company=figma&q=recruiter'))).toEqual([]);
  });

  it('filters by who applied', async () => {
    const { tyler, john } = await catalog();
    expect(titles(await tyler.get('/api/jobs?scope=mine&sort=company'))).toEqual(['Figma', 'Stripe']);
    expect(titles(await tyler.get('/api/jobs?scope=others'))).toEqual(['Notion']);
    expect(titles(await tyler.get('/api/jobs?scope=all&sort=company'))).toEqual(['Figma', 'Notion', 'Stripe']);
    expect(titles(await john.get('/api/jobs?scope=mine'))).toEqual(['Notion']);
  });

  it("matches status and stage on anyone's application, unless narrowed to your own", async () => {
    const { tyler, john } = await catalog();
    expect(titles(await john.get('/api/jobs?status=Technical%20Interview'))).toEqual(['Stripe']);
    expect(titles(await john.get('/api/jobs?stage=Technical%20Interview'))).toEqual(['Stripe']);
    expect(titles(await john.get('/api/jobs?status=Technical%20Interview&scope=mine'))).toEqual([]);
    expect(titles(await tyler.get('/api/jobs?status=Technical%20Interview&scope=mine'))).toEqual(['Stripe']);
  });

  it('filters by interview stage and date range', async () => {
    const { tyler } = await catalog();
    expect(titles(await tyler.get('/api/jobs?stage=Technical%20Interview'))).toEqual(['Stripe']);
    expect(titles(await tyler.get('/api/jobs?stage=Final%20Interview'))).toEqual([]);
    const from = encodeURIComponent('2030-11-01T00:00:00Z');
    const to = encodeURIComponent('2030-11-30T00:00:00Z');
    expect(titles(await tyler.get(`/api/jobs?interviewFrom=${from}&interviewTo=${to}`))).toEqual(['Stripe']);
    expect(titles(await tyler.get(`/api/jobs?interviewFrom=${to}`))).toEqual([]);
  });

  it('sorts every way the list offers', async () => {
    const { tyler } = await catalog();
    expect(titles(await tyler.get('/api/jobs?sort=company'))).toEqual(['Figma', 'Notion', 'Stripe']);
    expect(titles(await tyler.get('/api/jobs?sort=recent'))).toEqual(['Notion', 'Figma', 'Stripe']);
    expect(titles(await tyler.get('/api/jobs?sort=interview'))[0]).toBe('Stripe');
    expect(titles(await tyler.get('/api/jobs?scope=mine&sort=status'))).toEqual(['Figma', 'Stripe']);
    expect((await tyler.get('/api/jobs?sort=updated')).status).toBe(200);
    expect((await tyler.get('/api/jobs?sort=nonsense')).status).toBe(400);
  });

  it('pages through results', async () => {
    const { tyler } = await catalog();
    const page = (await tyler.get('/api/jobs?sort=company&limit=2&offset=1')).json;
    expect(page.total).toBe(3);
    expect(page.items.map((job: any) => job.company)).toEqual(['Notion', 'Stripe']);
  });

  it('counts a user’s dashboard numbers correctly', async () => {
    const { tyler, figma } = await catalog();
    await tyler.patch(`/api/applications/${figma.applicationId}`, { status: 'Rejected' });
    const dashboard = (await tyler.get('/api/dashboard')).json;
    expect(dashboard).toMatchObject({ totalApplications: 2, activeApplications: 1, rejectedApplications: 1, upcomingInterviews: 1 });
  });

  it('keeps search in step with corrected job details', async () => {
    const { admin, tyler, stripe } = await catalog();
    await admin.patch(`/api/jobs/${stripe.jobId}`, { title: 'Platform Wizard' });
    expect(titles(await tyler.get('/api/jobs?q=wizard'))).toEqual(['Stripe']);
    expect(titles(await tyler.get('/api/jobs?q=backend'))).toEqual([]);
    await admin.delete(`/api/jobs/${stripe.jobId}`);
    expect(titles(await tyler.get('/api/jobs?q=wizard'))).toEqual([]);
  });

  it('lets only the administrator change shared job details', async () => {
    const { tyler, stripe } = await catalog();
    expect((await tyler.patch(`/api/jobs/${stripe.jobId}`, { title: 'Mine now' })).status).toBe(403);
  });
});

describe('manual entry', () => {
  it('asks for details when a page cannot be read, then saves them', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    server.http.serve('https://blocked.com/jobs/1', { status: 403, body: '<html><title>Access denied</title><body>Forbidden</body></html>' });

    const first: any = await users.tyler.addJob('https://blocked.com/jobs/1', { memo: 'my memo' });
    expect(first).toMatchObject({ outcome: 'needs_manual', reason: 'blocked' });
    expect(first.missing).toEqual(expect.arrayContaining(['title', 'company', 'description']));
    expect(first.draftId).toBeTruthy();
    expect((server.ctx.db.$client.prepare('SELECT COUNT(*) AS c FROM jobs').get() as any).c).toBe(0);

    const saved: any = await users.tyler.addJob('https://blocked.com/jobs/1', {
      memo: 'my memo',
      draftId: first.draftId,
      manual: { title: 'Typed Role', company: 'Typed Co', description: 'Typed by hand.', location: 'Remote' }
    });
    expect(saved).toMatchObject({ outcome: 'created', jobWasNew: true });
    const job = (await users.tyler.get(`/api/jobs/${saved.jobId}`)).json;
    expect(job).toMatchObject({ title: 'Typed Role', company: 'Typed Co', location: 'Remote', extractionMethod: 'manual', lastExtractedAt: null });
    expect(job.applications[0].memo).toBe('my memo');
    expect(job.urls[0].originalUrl).toBe('https://blocked.com/jobs/1');
    // Only one read of the page: the draft carried the result over.
    expect(server.http.requests.filter((url) => url.includes('blocked.com'))).toHaveLength(1);
  });

  it('does not let one user use another user’s draft', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    server.http.serve('https://blocked.com/jobs/1', { status: 403, body: '<html><title>Access denied</title></html>' });
    const draft: any = await users.tyler.addJob('https://blocked.com/jobs/1');
    expect(server.ctx.drafts.get(draft.draftId, 999, 'https://blocked.com/jobs/1')).toBeNull();
  });

  it('removes personal tokens from a saved link', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    server.http.serve('https://company.com/jobs/1?step=1', jobPage({ title: 'Engineer', company: 'Acme' }));
    server.http.serve('https://company.com/jobs/1', jobPage({ title: 'Engineer', company: 'Acme' }));
    const saved: any = await users.tyler.addJob('https://company.com/jobs/1?indeed-apply-token=SECRET&rx_viewer=SECRET&code=SECRET');
    const stored = JSON.stringify((await users.tyler.get(`/api/jobs/${saved.jobId}`)).json.urls);
    expect(stored).not.toContain('SECRET');
    expect(server.http.requests.join(' ')).not.toContain('SECRET');
  });
});

describe('persistence and backups', () => {
  it('keeps everything through a restart', async () => {
    const dataDir = tempDir();
    const first = await createTestServer({ dataDir });
    const { admin, users } = await createUsers(first.app, 'tyler');
    first.http.serve('https://company.com/jobs/1', jobPage({ title: 'Engineer', company: 'Acme' }));
    const added: any = await users.tyler.addJob('https://company.com/jobs/1', { memo: 'keep me' });
    await users.tyler.patch(`/api/applications/${added.applicationId}`, { status: 'Offer' });
    await admin.post(`/api/jobs/${added.jobId}/highlight`, { highlighted: true });
    await first.app.close();
    (await import('../src/server/db/client')).closeDatabase(first.ctx.handle);

    const second = await createTestServer({ dataDir });
    const tyler = new ApiClient(second.app);
    await tyler.login('tyler', 'tyler-password');
    const kept = (await tyler.get(`/api/jobs/${added.jobId}`)).json;
    expect(kept).toMatchObject({ title: 'Engineer', isHighlighted: true });
    expect(mine(kept)).toMatchObject({ status: 'Offer', memo: 'keep me' });
  });

  it('uses WAL mode and enforces foreign keys', async () => {
    const { ctx } = await createTestServer();
    expect(ctx.handle.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(ctx.handle.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => ctx.db.$client.prepare('INSERT INTO applications (user_id, profile_id, job_id) VALUES (999, 999, 999)').run()).toThrow(/FOREIGN KEY/);
  });

  it('backs up and restores, saving the current data first', async () => {
    const server = await createTestServer();
    const { users, admin } = await createUsers(server.app, 'tyler');
    server.http.serve('https://company.com/jobs/1', jobPage({ title: 'Before Backup', company: 'Acme' }));
    await users.tyler.addJob('https://company.com/jobs/1');

    const backup = (await admin.post('/api/admin/backups')).json;
    expect(backup.name).toMatch(/\.sqlite$/);
    expect(backup.sizeBytes).toBeGreaterThan(0);

    server.http.serve('https://company.com/jobs/2', jobPage({ title: 'After Backup', company: 'Other Co', description: `${'totally different text here '.repeat(20)}` }));
    await users.tyler.addJob('https://company.com/jobs/2');
    expect((await users.tyler.get('/api/jobs')).json.total).toBe(2);

    const restored = await admin.post(`/api/admin/backups/${backup.name}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.json.safetyBackup).toMatch(/^before-restore-/);

    const titles = (await users.tyler.get('/api/jobs')).json.items.map((job: any) => job.title);
    expect(titles).toEqual(['Before Backup']);
    const list = (await admin.get('/api/admin/backups')).json.map((item: any) => item.name);
    expect(list).toContain(restored.json.safetyBackup);
    // Search still works on the restored database.
    expect((await users.tyler.get('/api/jobs?q=before')).json.total).toBe(1);
  });

  it('refuses to restore a file that is not a healthy database from this app', async () => {
    const dir = tempDir();
    const garbage = join(dir, 'garbage.sqlite');
    writeFileSync(garbage, 'this is not a database');
    expect(() => assertRestorable(garbage)).toThrow(/cannot be restored/);

    const server = await createTestServer();
    const admin = await signInAdmin(server.app);
    const backup = (await admin.post('/api/admin/backups')).json;
    copyFileSync(garbage, join(server.ctx.paths.backupDir, 'bad.sqlite'));
    const refused = await admin.post('/api/admin/backups/bad.sqlite/restore');
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('invalid_backup');
    expect((await admin.get('/api/auth/me')).status).toBe(200); // still running on the real data
    expect((await admin.delete(`/api/admin/backups/${backup.name}`)).status).toBe(200);
  });

  it('rejects path tricks in backup names', async () => {
    const server = await createTestServer();
    const admin = await signInAdmin(server.app);
    expect((await admin.post('/api/admin/backups/..%2F..%2Fjob-tracker.sqlite/restore')).status).toBe(400);
    expect((await admin.delete('/api/admin/backups/..%5Csecret.sqlite')).status).toBe(400);
  });
});

describe('live updates', () => {
  it('tells connected apps when shared data changes', async () => {
    const server = await createTestServer();
    const seen: string[] = [];
    server.ctx.events.subscribe((event) => seen.push(event.type));
    const { users } = await createUsers(server.app, 'tyler', 'john');
    server.http.serve('https://company.com/jobs/1', jobPage({ title: 'Engineer', company: 'Acme' }));
    seen.length = 0;

    const first: any = await users.tyler.addJob('https://company.com/jobs/1');
    expect(seen).toEqual(['jobs_changed']);
    await users.john.addJob('https://company.com/jobs/1');
    expect(seen).toEqual(['jobs_changed', 'applications_changed']);
    await users.john.post(`/api/jobs/${first.jobId}/highlight`, { highlighted: true });
    expect(seen).toEqual(['jobs_changed', 'applications_changed', 'jobs_changed']);
  });
});
