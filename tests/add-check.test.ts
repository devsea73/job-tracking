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
    const saved = await users.andy.addJob('https://other.example.org/jobs/4', { draftId: checked.draftId, resolution: { action: 'new' } });
    expect(saved).toMatchObject({ outcome: 'created', jobWasNew: true });
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
