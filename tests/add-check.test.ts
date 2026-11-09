import { describe, expect, it } from 'vitest';
import type { CheckLinkResponse, CreateApplicationResponse, JobDetail } from '../src/shared/api';
import { UNREADABLE_NOTES } from '../src/shared/unreadable';
import { createTestServer, createUsers, jobPage, LONG_DESCRIPTION, type ApiClient } from './helpers';

type Created = Extract<CreateApplicationResponse, { outcome: 'created' }>;

async function setUp() {
  const server = await createTestServer();
  const { users } = await createUsers(server.app, 'andy', 'john');
  const check = async (client: ApiClient, url: string) => {
    const response = await client.post('/api/applications/check', { url });
    if (response.status !== 200) throw new Error(`check failed: ${response.status} ${JSON.stringify(response.json)}`);
    return response.json as CheckLinkResponse;
  };
  return { server, users, check };
}

describe('checking a pasted link before saving it', () => {
  it('says a new job is fresh, and saving reads the page no second time', async () => {
    const { server, users, check } = await setUp();
    server.http.serve('https://careers.example.com/jobs/1', jobPage({ title: 'Senior Data Engineer', company: 'Acme', location: 'Remote, US' }));
    const checked = await check(users.andy, 'https://careers.example.com/jobs/1');
    expect(checked).toMatchObject({ status: 'fresh', job: { title: 'Senior Data Engineer', company: 'Acme' } });
    expect(server.ctx.handle.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 0 });

    const reads = server.http.requests.length;
    const saved = await users.andy.addJob('https://careers.example.com/jobs/1', { draftId: checked.draftId, memo: 'snowflake' });
    expect(saved).toMatchObject({ outcome: 'created', jobWasNew: true });
    expect(server.http.requests.length).toBe(reads);
  });

  it('says a job already in the list is a duplicate, and whether my profile applied', async () => {
    const { server, users, check } = await setUp();
    server.http.serve('https://careers.example.com/jobs/2', jobPage({ title: 'Data Engineer', company: 'Acme' }));
    const added = (await users.john.addJob('https://careers.example.com/jobs/2')) as Created;

    const forAndy = await check(users.andy, 'https://careers.example.com/jobs/2?utm_source=linkedin');
    expect(forAndy).toMatchObject({ status: 'known', matchedBy: 'url', job: { id: added.jobId, title: 'Data Engineer', applicationCount: 1, myProfileIds: [] } });

    const johnProfile = await users.john.defaultProfileId();
    const forJohn = await check(users.john, 'https://careers.example.com/jobs/2');
    expect(forJohn).toMatchObject({ status: 'known', job: { myProfileIds: [johnProfile] } });

    const saved = await users.andy.addJob('https://careers.example.com/jobs/2?utm_source=linkedin', { draftId: forAndy.draftId ?? undefined });
    expect(saved).toMatchObject({ outcome: 'created', jobWasNew: false, jobId: added.jobId });
  });

  it('shows who applied to a job already in the list: when, under which profile, with which link, and where each is now', async () => {
    const { server, users, check } = await setUp();
    server.http.serve('https://careers.example.com/jobs/12', jobPage({ title: 'Analytics Engineer', company: 'Acme' }));
    const johns = (await users.john.addJob('https://careers.example.com/jobs/12')) as Created;
    await users.john.patch(`/api/applications/${johns.applicationId}`, { appliedAt: '2026-10-02T15:30:00.000Z' });
    await users.john.addStep(johns.applicationId, 'Recruiter Screen', '2026-10-06T14:00:00.000Z');
    await users.john.addStep(johns.applicationId, 'Technical Interview', '2030-01-10T16:00:00.000Z');
    const second = (await users.john.post('/api/profiles', { name: 'Backend' })).json.id;
    await users.john.post(`/api/jobs/${johns.jobId}/apply`, { profileId: second });

    const checked = await check(users.andy, 'https://careers.example.com/jobs/12');
    if (checked.status !== 'known') throw new Error(checked.status);
    expect(checked.job.applications).toHaveLength(2);
    // Earliest first, each with its own story.
    expect(checked.job.applications[0]).toMatchObject({
      owner: { username: 'john' },
      profile: { name: 'john' },
      isMine: false,
      appliedAt: '2026-10-02T15:30:00.000Z',
      stage: 'Technical Interview',
      furthestStage: 'Technical Interview',
      nextInterviewAt: '2030-01-10T16:00:00.000Z',
      link: { url: 'https://careers.example.com/jobs/12' }
    });
    expect(checked.job.applications[1]).toMatchObject({ profile: { name: 'Backend' }, stage: 'Applied', link: null });

    // For John, his own are marked as his.
    const forJohn = await check(users.john, 'https://careers.example.com/jobs/12?ref=x');
    if (forJohn.status !== 'known') throw new Error(forJohn.status);
    expect(forJohn.job.applications.every((application) => application.isMine)).toBe(true);
    expect(forJohn.job.myProfileIds.sort()).toEqual([await users.john.defaultProfileId(), second].sort());
    expect(server.ctx.handle.sqlite.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 2 });
  });

  it('finds a duplicate by content too, under another link', async () => {
    const { server, users, check } = await setUp();
    server.http.serve('https://careers.example.com/jobs/3', jobPage({ title: 'Platform Engineer', company: 'Acme', description: LONG_DESCRIPTION, location: 'Austin, TX' }));
    server.http.serve('https://acme-jobs.example.org/role/3', jobPage({ title: 'Platform Engineer', company: 'Acme', description: LONG_DESCRIPTION, location: 'Austin, TX' }));
    const first = (await users.john.addJob('https://careers.example.com/jobs/3')) as Created;
    const checked = await check(users.andy, 'https://acme-jobs.example.org/role/3');
    expect(checked).toMatchObject({ status: 'known', matchedBy: 'content', job: { id: first.jobId } });
  });

  it('warns about a possible duplicate, and saves it as new without asking', async () => {
    const { server, users, check } = await setUp();
    server.http.serve('https://careers.example.com/jobs/4', jobPage({ title: 'Senior Data Engineer', company: 'Devoted Health Services, Inc' }));
    server.http.serve('https://other.example.org/jobs/4', jobPage({ title: 'Senior Data Engineer', company: 'Devoted Health', description: `${LONG_DESCRIPTION.split('\n\n').reverse().join('\n\n')} Apply today.` }));
    await users.john.addJob('https://careers.example.com/jobs/4');
    const checked = await check(users.andy, 'https://other.example.org/jobs/4');
    expect(checked.status).toBe('possible');
    if (checked.status !== 'possible') return;
    expect(checked.candidates[0]).toMatchObject({ company: 'Devoted Health Services, Inc' });
    const saved = await users.andy.addJob('https://other.example.org/jobs/4', { draftId: checked.draftId, resolution: { action: 'new', seen: [checked.candidates[0].jobId] } });
    expect(saved).toMatchObject({ outcome: 'created', jobWasNew: true });
  });

  it('asks again when a likelier duplicate turned up after the check, instead of calling it different unseen', async () => {
    const { server, users, check } = await setUp();
    server.http.serve('https://careers.example.com/jobs/6', jobPage({ title: 'Senior Data Engineer', company: 'Devoted Health Services, Inc' }));
    server.http.serve('https://other.example.org/jobs/6', jobPage({ title: 'Senior Data Engineer', company: 'Devoted Health', description: `${LONG_DESCRIPTION.split('\n\n').reverse().join('\n\n')} Apply today.` }));
    // The check finds nothing: the other copy is saved only afterwards, by someone else.
    const checked = await check(users.andy, 'https://other.example.org/jobs/6');
    expect(checked.status).toBe('fresh');
    const theirs = (await users.john.addJob('https://careers.example.com/jobs/6')) as Created;

    const saved = await users.andy.addJob('https://other.example.org/jobs/6', { draftId: checked.draftId ?? undefined });
    expect(saved).toMatchObject({ outcome: 'possible_duplicate', candidates: [{ jobId: theirs.jobId }] });
    if (saved.outcome !== 'possible_duplicate') return;
    // "New" for a different candidate than the one now on top is asked about again.
    expect(await users.andy.addJob('https://other.example.org/jobs/6', { draftId: saved.draftId, resolution: { action: 'new', seen: [theirs.jobId + 1000] } })).toMatchObject({ outcome: 'possible_duplicate' });
    // Answered for the one shown: a new job, and that pair is remembered as different.
    const created = await users.andy.addJob('https://other.example.org/jobs/6', { draftId: saved.draftId, resolution: { action: 'new', seen: [theirs.jobId] } });
    expect(created).toMatchObject({ outcome: 'created', jobWasNew: true });
    if (created.outcome !== 'created') return;
    const pair = server.ctx.db.$client.prepare('SELECT status FROM duplicate_candidates WHERE job_id_low = ? AND job_id_high = ?').get(Math.min(theirs.jobId, created.jobId), Math.max(theirs.jobId, created.jobId));
    expect(pair).toEqual({ status: 'distinct' });
  });

  it('leaves matches nobody was shown for review, when told to save as new without a list', async () => {
    const { server, users, check } = await setUp();
    server.http.serve('https://careers.example.com/jobs/7', jobPage({ title: 'Senior Data Engineer', company: 'Devoted Health Services, Inc' }));
    server.http.serve('https://other.example.org/jobs/7', jobPage({ title: 'Senior Data Engineer', company: 'Devoted Health', description: `${LONG_DESCRIPTION.split('\n\n').reverse().join('\n\n')} Apply today.` }));
    const first = (await users.john.addJob('https://careers.example.com/jobs/7')) as Created;
    const checked = await check(users.andy, 'https://other.example.org/jobs/7');
    const saved = await users.andy.addJob('https://other.example.org/jobs/7', { draftId: checked.draftId ?? undefined, resolution: { action: 'new' } });
    expect(saved).toMatchObject({ outcome: 'created', jobWasNew: true });
    if (saved.outcome !== 'created') return;
    const pair = server.ctx.db.$client.prepare('SELECT status FROM duplicate_candidates WHERE job_id_low = ? AND job_id_high = ?').get(first.jobId, saved.jobId);
    expect(pair).toEqual({ status: 'pending' });
  });

  it('saves a possible duplicate under the matching job when told it is the same', async () => {
    const { server, users, check } = await setUp();
    server.http.serve('https://careers.example.com/jobs/5', jobPage({ title: 'Senior Data Engineer', company: 'Devoted Health Services, Inc' }));
    server.http.serve('https://other.example.org/jobs/5', jobPage({ title: 'Senior Data Engineer', company: 'Devoted Health', description: `${LONG_DESCRIPTION.split('\n\n').reverse().join('\n\n')} Apply today.` }));
    const first = (await users.john.addJob('https://careers.example.com/jobs/5')) as Created;
    const checked = await check(users.andy, 'https://other.example.org/jobs/5');
    if (checked.status !== 'possible') throw new Error(checked.status);
    const saved = await users.andy.addJob('https://other.example.org/jobs/5', { draftId: checked.draftId, resolution: { action: 'merge', jobId: checked.candidates[0].jobId } });
    expect(saved).toMatchObject({ outcome: 'created', jobId: first.jobId });
  });

  it('says why a page cannot be read, and saves it with a title and company', async () => {
    const { users, check } = await setUp();
    const checked = await check(users.andy, 'https://careers.example.com/jobs/gone-123');
    expect(checked.status).toBe('unreadable');
    if (checked.status !== 'unreadable') return;
    expect(checked.reason).toBe('not_found');
    expect(checked.description).toBe(UNREADABLE_NOTES.closed);
    const saved = (await users.andy.addJob('https://careers.example.com/jobs/gone-123', { draftId: checked.draftId, manual: { title: 'Data Engineer', company: 'Acme', description: checked.description } })) as Created;
    expect(saved.outcome).toBe('created');
    const detail = (await users.andy.get(`/api/jobs/${saved.jobId}`)).json as JobDetail;
    expect(detail).toMatchObject({ title: 'Data Engineer', company: 'Acme', description: UNREADABLE_NOTES.closed });
  });

  it('keeps a job description typed in by hand for a page that cannot be read', async () => {
    const { users, check } = await setUp();
    const checked = await check(users.andy, 'https://careers.example.com/jobs/gone-456');
    if (checked.status !== 'unreadable') throw new Error(checked.status);
    const typed = 'We are hiring a data engineer to build streaming pipelines with Kafka and Snowflake. '.repeat(8).trim();
    const saved = (await users.andy.addJob('https://careers.example.com/jobs/gone-456', { draftId: checked.draftId, manual: { title: 'Data Engineer', company: 'Acme', description: typed } })) as Created;
    expect(saved.outcome).toBe('created');
    const detail = (await users.andy.get(`/api/jobs/${saved.jobId}`)).json as JobDetail;
    expect(detail).toMatchObject({ title: 'Data Engineer', company: 'Acme', description: typed });
  });

  it('refuses what is not a link, and needs a signed-in person', async () => {
    const { server, users } = await setUp();
    expect((await users.andy.post('/api/applications/check', { url: 'not a link' })).status).toBe(400);
    expect((await users.andy.post('/api/applications/check', { url: 'http://127.0.0.1/admin' })).status).toBe(400);
    expect((await server.app.inject({ method: 'POST', url: '/api/applications/check', payload: { url: 'https://careers.example.com/x' } })).statusCode).toBe(401);
  });

  it('saves nothing at all when only checking', async () => {
    const { server, users, check } = await setUp();
    server.http.serve('https://careers.example.com/jobs/6', jobPage({ title: 'Engineer', company: 'Acme' }));
    await check(users.andy, 'https://careers.example.com/jobs/6');
    await check(users.andy, 'https://careers.example.com/jobs/gone');
    const counts = server.ctx.handle.sqlite.prepare('SELECT (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM applications) AS apps, (SELECT COUNT(*) FROM job_urls) AS urls').get();
    expect(counts).toEqual({ jobs: 0, apps: 0, urls: 0 });
  });
});
