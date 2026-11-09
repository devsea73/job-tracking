import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { identifyAts, isAggregator, referencedIdentities, sourcePlatform, titleFromUrl } from '../src/server/dedupe/ats';
import { closeDatabase } from '../src/server/db/client';
import { reconcileJobIdentities } from '../src/server/services/job-merge';
import { createTestServer, createUsers, jobPage, LONG_DESCRIPTION, tempDir, type TestServer } from './helpers';

const JR = '6ada3d42950ef68d51855574';
const JR_OTHER = '6ae8e7f5777c336eb6d6779c';
// The kind of link a user pasted when they found this bug.
const GREENHOUSE = 'https://job-boards.greenhouse.io/embed/job_app?for=promptioinc&token=4463863009';
const JOBRIGHT = `https://jobright.ai/jobs/info/${JR}`;

/** Jobright rewrites postings, so its text differs from the employer's. */
const REWRITTEN = `Software Engineer designing, building and maintaining production web applications. ${'Own features from development through deployment and ongoing maintenance. '.repeat(6)}`;

/** The app reads Greenhouse through its public job API, so that is what answers here. */
function serveGreenhouse(server: TestServer, board: string, token: string, job: { title: string; company: string; description?: string }) {
  server.http.serve(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${token}`, {
    contentType: 'application/json',
    body: JSON.stringify({
      id: Number(token),
      title: job.title,
      company_name: job.company,
      location: { name: 'Remote' },
      content: (job.description ?? LONG_DESCRIPTION)
        .split('\n\n')
        .map((block) => `<p>${block}</p>`)
        .join('')
    })
  });
}

function servePrompt(server: TestServer) {
  serveGreenhouse(server, 'promptioinc', '4463863009', { title: 'Software Engineer', company: 'Prompt.io' });
  server.http.serve(JOBRIGHT, jobPage({ title: 'Software Engineer', company: 'Prompt.io', description: REWRITTEN }));
  server.http.serve(`https://jobright.ai/jobs/info/${JR_OTHER}`, jobPage({ title: 'Software Engineer', company: 'Prompt.io', description: REWRITTEN }));
}

const counts = (server: TestServer) => server.ctx.db.$client.prepare('SELECT (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM applications) AS applications').get() as { jobs: number; applications: number };

describe('ids in link parameters', () => {
  it('reads Jobright’s id from jr_id, whatever the link points at', () => {
    expect(referencedIdentities(`${GREENHOUSE}&jr_id=${JR}`)).toEqual([{ provider: 'jobright', externalId: JR }]);
    expect(referencedIdentities(`https://jobs.lever.co/acme/59d16304-6164-44b0-8895-cf26ca90c8a6/apply?utm_source=jobright&jr_id=${JR}`)).toEqual([{ provider: 'jobright', externalId: JR }]);
    expect(referencedIdentities(`https://careers.example.com/job/5?jr_id=${JR.toUpperCase()}`)).toEqual([{ provider: 'jobright', externalId: JR }]);
  });

  it('keeps the link’s own identity next to it', () => {
    expect(identifyAts(`${GREENHOUSE}&jr_id=${JR}`)).toMatchObject({ provider: 'greenhouse', externalId: '4463863009' });
  });

  it('ignores a jr_id that is not an id', () => {
    expect(referencedIdentities(`${GREENHOUSE}&jr_id=abc`)).toEqual([]);
    expect(referencedIdentities(`${GREENHOUSE}&jr_id=`)).toEqual([]);
    expect(referencedIdentities(GREENHOUSE)).toEqual([]);
  });

  it('does not report a Jobright page as naming itself', () => {
    expect(referencedIdentities(`${JOBRIGHT}?jr_id=${JR}`)).toEqual([]);
  });

  it('reads a real link wrapped inside another one', () => {
    const wrapped = `https://www.linkedin.com/jobs/view/externalApply/4454862094?url=${encodeURIComponent('https://job-boards.greenhouse.io/acme/jobs/987654321?utm_source=linkedin')}&urlHash=abc`;
    expect(identifyAts(wrapped)).toMatchObject({ provider: 'linkedin', externalId: '4454862094' });
    expect(referencedIdentities(wrapped)).toEqual([{ provider: 'greenhouse', externalId: '987654321', board: 'acme' }]);
  });

  it('reads a wrapped link encoded twice', () => {
    const inner = encodeURIComponent(encodeURIComponent('https://jobs.lever.co/acme/59d16304-6164-44b0-8895-cf26ca90c8a6'));
    expect(referencedIdentities(`https://redirect.example.com/go?target=${inner}`)).toMatchObject([{ provider: 'lever', externalId: '59d16304-6164-44b0-8895-cf26ca90c8a6' }]);
  });
});

describe('job ids in parameters on other sites', () => {
  it('sees the same job through unrelated parameters', () => {
    const a = identifyAts('https://careers.example.com/openings/view?jobId=8841&campaign=x&color=red');
    const b = identifyAts('https://careers.example.com/openings?color=blue&jobId=8841');
    expect(a).not.toBeNull();
    expect(a?.externalId).toBe(b?.externalId);
    expect(sourcePlatform('https://careers.example.com/openings?jobId=8841')).toBe('company');
  });

  it('keeps different job numbers apart', () => {
    expect(identifyAts('https://careers.example.com/openings?jobId=8841')?.externalId).not.toBe(identifyAts('https://careers.example.com/openings?jobId=8842')?.externalId);
  });

  it('does not confuse one customer’s job 5 with another’s', () => {
    const one = identifyAts('https://ats.example.com/board?company=acme&reqId=555');
    const two = identifyAts('https://ats.example.com/board?company=globex&reqId=555');
    expect(one?.externalId).not.toBe(two?.externalId);
    const pathOne = identifyAts('https://ats.example.com/acme/board?reqId=555');
    const pathTwo = identifyAts('https://ats.example.com/globex/board?reqId=555');
    expect(pathOne?.externalId).not.toBe(pathTwo?.externalId);
  });

  it('does not treat every number as a job id', () => {
    expect(identifyAts('https://news.example.com/article?id=12345')).toBeNull();
    expect(identifyAts('https://careers.example.com/openings?jobId=abc')).toBeNull();
  });

  it('leaves systems with their own rule to it', () => {
    expect(identifyAts('https://workforcenow.adp.com/x/recruitment.html?cid=AAA&jobId=568860')).toMatchObject({ provider: 'adp' });
  });
});

describe('titles in link parameters', () => {
  it('reads the common names', () => {
    expect(titleFromUrl('https://apply.example.com/x?jobTitle=Principal%20Data%20Platform%20Engineer')).toBe('Principal Data Platform Engineer');
    expect(titleFromUrl('https://apply.example.com/x?businessTitle=Data+Engineer&id=4')).toBe('Data Engineer');
  });

  it('skips values that are not titles', () => {
    expect(titleFromUrl('https://apply.example.com/x?title=12345')).toBeNull();
    expect(titleFromUrl('https://apply.example.com/x?title=https%3A%2F%2Fexample.com')).toBeNull();
    expect(titleFromUrl('https://apply.example.com/x')).toBeNull();
  });

  it('fills in the title when the page cannot be read', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    server.http.serve('https://apply.example.com/x?jobTitle=Snowflake%20Data%20Engineer', { status: 403, body: '<html><title>Access denied</title></html>' });
    const first: any = await users.tyler.addJob('https://apply.example.com/x?jobTitle=Snowflake%20Data%20Engineer');
    expect(first).toMatchObject({ outcome: 'needs_manual', extracted: { title: 'Snowflake Data Engineer' } });
    expect(first.missing).not.toContain('title');
  });
});

describe('the same job through different sites', () => {
  it('a Jobright page, then the employer’s link carrying its jr_id', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    servePrompt(server);
    const first: any = await users.tyler.addJob(JOBRIGHT);
    const second: any = await users.john.addJob(`${GREENHOUSE}&jr_id=${JR}`);
    expect(second).toMatchObject({ outcome: 'created', jobId: first.jobId, jobWasNew: false, matchedBy: 'identifier' });
    expect(counts(server)).toEqual({ jobs: 1, applications: 2 });
    const job = (await users.john.get(`/api/jobs/${first.jobId}`)).json;
    expect(job.urls.map((url: any) => url.sourcePlatform).sort()).toEqual(['greenhouse', 'jobright']);
  });

  it('the employer’s link first, then the Jobright page', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    servePrompt(server);
    const first: any = await users.tyler.addJob(`${GREENHOUSE}&jr_id=${JR}`);
    const requestsBefore = server.http.requests.length;
    const second: any = await users.john.addJob(JOBRIGHT);
    expect(second).toMatchObject({ outcome: 'created', jobId: first.jobId, matchedBy: 'identifier' });
    expect(counts(server)).toEqual({ jobs: 1, applications: 2 });
    // Known from the link alone, so no site had to be contacted.
    expect(server.http.requests.length).toBe(requestsBefore);
  });

  it('never stores the same job twice when Jobright lists it under two ids', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john', 'mike');
    servePrompt(server);
    const first: any = await users.tyler.addJob(`${GREENHOUSE}&jr_id=${JR}`);
    const second: any = await users.john.addJob(`${GREENHOUSE}&jr_id=${JR_OTHER}`);
    expect(second.jobId).toBe(first.jobId);
    const third: any = await users.mike.addJob(`https://jobright.ai/jobs/info/${JR_OTHER}`);
    expect(third.jobId).toBe(first.jobId);
    expect(counts(server)).toEqual({ jobs: 1, applications: 3 });
  });

  it('still recognizes the same user under the same profile', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    servePrompt(server);
    const first: any = await users.tyler.addJob(JOBRIGHT);
    const again: any = await users.tyler.addJob(`${GREENHOUSE}&jr_id=${JR}`);
    expect(again).toMatchObject({ outcome: 'already_applied', applicationId: first.applicationId });
  });

  it('finds the job from a wrapped LinkedIn link', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const direct = 'https://careers.example.com/x?gh_jid=5550001';
    server.http.serve(direct, jobPage({ title: 'Data Engineer', company: 'Acme' }));
    const first: any = await users.tyler.addJob(direct);
    const wrapped = `https://www.linkedin.com/jobs/view/externalApply/4454862094?url=${encodeURIComponent('https://job-boards.greenhouse.io/acme/jobs/5550001')}`;
    const second: any = await users.john.addJob(wrapped);
    expect(second).toMatchObject({ outcome: 'created', jobId: first.jobId, matchedBy: 'identifier' });
  });

  it('does not let a listing id overrule the system hosting the job', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const one = `https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1111111&jr_id=${JR}`;
    const two = `https://job-boards.greenhouse.io/embed/job_app?for=acme&token=2222222&jr_id=${JR}`;
    serveGreenhouse(server, 'acme', '1111111', { title: 'Backend Engineer', company: 'Acme', description: 'First opening text that is quite its own '.repeat(12) });
    serveGreenhouse(server, 'acme', '2222222', { title: 'Mobile Engineer', company: 'Acme', description: 'Second opening with nothing in common at all '.repeat(12) });
    const first: any = await users.tyler.addJob(one);
    const second: any = await users.john.addJob(two);
    expect(second.jobId).not.toBe(first.jobId);
    expect(counts(server).jobs).toBe(2);
  });

  it('does not let listing ids stop a content match', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    server.http.serve('https://jobright.ai/jobs/info/aaaaaaaaaaaaaaaaaaaaaaaa', jobPage({ title: 'Senior Engineer', company: 'Stripe' }));
    server.http.serve('https://jobright.ai/jobs/info/bbbbbbbbbbbbbbbbbbbbbbbb', jobPage({ title: 'Senior Engineer', company: 'Stripe' }));
    const first: any = await users.tyler.addJob('https://jobright.ai/jobs/info/aaaaaaaaaaaaaaaaaaaaaaaa');
    const second: any = await users.john.addJob('https://jobright.ai/jobs/info/bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(second).toMatchObject({ outcome: 'created', jobId: first.jobId, matchedBy: 'content' });
  });

  it('finds an apply link wrapped inside a page', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const direct = 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=7770001';
    serveGreenhouse(server, 'acme', '7770001', { title: 'Data Engineer', company: 'Acme' });
    const first: any = await users.tyler.addJob(direct);
    const listing = 'https://board.example.com/listing/5';
    server.http.serve(listing, jobPage({ title: 'Data Engineer', company: 'Acme Corp', description: `${'A different summary written by the listing site here '.repeat(10)}`, extraBody: `<a href="/go?url=${encodeURIComponent(direct)}">Apply</a>` }));
    const second: any = await users.john.addJob(listing);
    expect(second).toMatchObject({ outcome: 'created', jobId: first.jobId });
  });
});

describe('a link that shows two saved jobs are one', () => {
  /** The same job saved twice, as could happen before this was fixed. */
  async function savedTwice() {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john', 'mike');
    servePrompt(server);
    const fromJobright: any = await users.tyler.addJob(JOBRIGHT, { memo: 'from jobright' });
    const fromEmployer: any = await users.john.addJob(GREENHOUSE, { memo: 'john memo', resolution: { action: 'new' } });
    expect(fromEmployer.jobId).not.toBe(fromJobright.jobId);
    expect(counts(server).jobs).toBe(2);
    return { server, users, fromJobright, fromEmployer };
  }

  it('folds them into one, keeping everyone’s applications', async () => {
    const { server, users, fromJobright, fromEmployer } = await savedTwice();
    await users.tyler.addStep(fromJobright.applicationId, 'Technical Interview', '2030-11-13T14:00:00Z', { note: 'kept' });

    const bridge: any = await users.mike.addJob(`${GREENHOUSE}&jr_id=${JR}`);
    expect(counts(server)).toEqual({ jobs: 1, applications: 3 });

    const job = (await users.mike.get(`/api/jobs/${bridge.jobId}`)).json;
    expect(job.applications.map((item: any) => item.owner.username).sort()).toEqual(['john', 'mike', 'tyler']);
    const tyler = job.applications.find((item: any) => item.owner.username === 'tyler');
    expect(tyler).toMatchObject({ stage: 'Technical Interview', memo: 'from jobright', furthestStage: 'Technical Interview' });
    expect(tyler.steps.map((step: any) => [step.stage, step.at, step.note])).toEqual([['Technical Interview', '2030-11-13T14:00:00.000Z', 'kept']]);
    expect(job.urls.map((url: any) => url.sourcePlatform).sort()).toEqual(['greenhouse', 'jobright']);
    expect([fromJobright.jobId, fromEmployer.jobId]).toContain(bridge.jobId);

    const stored = server.ctx.db.$client.prepare('SELECT application_count FROM jobs WHERE id = ?').get(bridge.jobId);
    expect(stored).toEqual({ application_count: 3 });
    // The employer's own words replace the listing site's summary.
    expect(job.description).toContain('payments infrastructure');
  });

  it('joins applications when one profile applied to both, with both timelines', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    servePrompt(server);
    const a: any = await users.tyler.addJob(JOBRIGHT, { memo: 'first memo' });
    const b: any = await users.tyler.addJob(GREENHOUSE, { memo: 'second memo', resolution: { action: 'new' } });
    // One applied earlier; the other was written down here earlier. Each date is kept on its own.
    const sqlite = server.ctx.db.$client;
    const dates = sqlite.prepare('UPDATE applications SET applied_at = ?, created_at = ? WHERE id = ?');
    dates.run('2030-01-01T09:00:00.000Z', '2030-01-20T09:00:00.000Z', a.applicationId);
    dates.run('2030-01-10T09:00:00.000Z', '2030-01-02T09:00:00.000Z', b.applicationId);
    await users.tyler.addStep(a.applicationId, 'Recruiter Screen', '2030-01-05T10:00:00Z');
    await users.tyler.addStep(a.applicationId, 'Technical Interview', '2030-01-12T10:00:00Z');
    await users.tyler.addStep(b.applicationId, 'Final Interview', '2030-02-01T10:00:00Z');
    // Written on the first copy, but the latest step of all.
    await users.tyler.addStep(a.applicationId, 'Rejected', '2030-02-03T10:00:00Z');

    const merged: any = await users.tyler.addJob(`${GREENHOUSE}&jr_id=${JR}`);
    expect(merged.outcome).toBe('already_applied');
    expect(counts(server)).toEqual({ jobs: 1, applications: 1 });
    const job = (await users.tyler.get(`/api/jobs/${merged.jobId}`)).json;
    const only = job.applications[0];
    // The stage is the latest step's, wherever it came from; the furthest is from either copy.
    expect(only).toMatchObject({ stage: 'Rejected', furthestStage: 'Final Interview', appliedAt: '2030-01-01T09:00:00.000Z', createdAt: '2030-01-02T09:00:00.000Z' });
    expect(only.memo).toContain('first memo');
    expect(only.memo).toContain('second memo');
    expect(only.steps.map((step: any) => step.stage)).toEqual(['Recruiter Screen', 'Technical Interview', 'Final Interview', 'Rejected']);
    expect(only.interviewCount).toBe(3);
    expect(sqlite.prepare('SELECT COUNT(*) AS c FROM application_steps WHERE application_id != ?').get(only.id)).toEqual({ c: 0 });
  });

  it('keeps search working after folding them', async () => {
    const { users } = await savedTwice();
    await users.mike.addJob(`${GREENHOUSE}&jr_id=${JR}`);
    expect((await users.mike.get('/api/jobs?q=Prompt')).json.total).toBe(1);
    expect((await users.mike.get('/api/jobs?q=john%20memo')).json.total).toBe(1);
    expect((await users.mike.get('/api/jobs')).json.total).toBe(1);
  });

  it('tells connected apps', async () => {
    const { server, users } = await savedTwice();
    const seen: string[] = [];
    server.ctx.events.subscribe((event) => seen.push(event.type));
    await users.mike.addJob(`${GREENHOUSE}&jr_id=${JR}`);
    expect(seen).toContain('jobs_changed');
  });
});

describe('links already saved', () => {
  /** A database from before this fix: the link has a jr_id that was never recorded as an id. */
  async function fromBeforeTheFix(dataDir: string) {
    const server = await createTestServer({ dataDir });
    const { users } = await createUsers(server.app, 'tyler', 'john');
    servePrompt(server);
    const a: any = await users.tyler.addJob(JOBRIGHT, { memo: 'tyler memo' });
    const b: any = await users.john.addJob(`${GREENHOUSE}&jr_id=${JR_OTHER}`, { memo: 'john memo', resolution: { action: 'new' } });
    const sqlite = server.ctx.db.$client;
    // Rewrites history: the two are separate jobs, and the id in the saved link went unnoticed.
    sqlite.prepare(`UPDATE job_urls SET original_url = ? WHERE job_id = ? AND source_platform = 'greenhouse'`).run(`${GREENHOUSE}&jr_id=${JR}`, b.jobId);
    sqlite.prepare(`DELETE FROM job_identifiers WHERE provider = 'jobright' AND external_id = ?`).run(JR_OTHER);
    return { server, a, b };
  }

  it('are checked on start, merging what they show to be one job', async () => {
    const dataDir = tempDir();
    const { server, a, b } = await fromBeforeTheFix(dataDir);
    expect(a.jobId).not.toBe(b.jobId);
    expect(counts(server).jobs).toBe(2);
    await server.app.close();
    closeDatabase(server.ctx.handle);

    const restarted = await createTestServer({ dataDir });
    expect(counts(restarted)).toEqual({ jobs: 1, applications: 2 });
    const backups = readdirSync(join(dataDir, 'backups'));
    expect(backups.some((name) => name.startsWith('before-merge'))).toBe(true);
  });

  it('take no backup and change nothing when there is nothing to do', async () => {
    const dataDir = tempDir();
    const server = await createTestServer({ dataDir });
    const { users } = await createUsers(server.app, 'tyler');
    servePrompt(server);
    await users.tyler.addJob(`${GREENHOUSE}&jr_id=${JR}`);
    expect(await reconcileJobIdentities(server.ctx)).toEqual({ identifiersAdded: 0, jobsMerged: 0 });
    expect(await reconcileJobIdentities(server.ctx)).toEqual({ identifiersAdded: 0, jobsMerged: 0 });
    await server.app.close();
    closeDatabase(server.ctx.handle);
    const again = await createTestServer({ dataDir });
    expect(counts(again).jobs).toBe(1);
    let names: string[] = [];
    try {
      names = readdirSync(join(dataDir, 'backups'));
    } catch {
      // No backup folder at all is just as good.
    }
    expect(names.filter((name) => name.startsWith('before-merge'))).toEqual([]);
  });

  it('do not merge jobs that the hosting system says are different', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const one = 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1111111';
    const two = 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=2222222';
    serveGreenhouse(server, 'acme', '1111111', { title: 'Engineer', company: 'Acme', description: `${LONG_DESCRIPTION} one` });
    serveGreenhouse(server, 'acme', '2222222', { title: 'Engineer', company: 'Acme', description: 'nothing like the other one in any way at all '.repeat(12) });
    const a: any = await users.tyler.addJob(one);
    const b: any = await users.john.addJob(two, { resolution: { action: 'new' } });
    const sqlite = server.ctx.db.$client;
    sqlite.prepare(`UPDATE job_urls SET original_url = original_url || '&jr_id=${JR}' WHERE job_id IN (?, ?)`).run(a.jobId, b.jobId);
    expect((await reconcileJobIdentities(server.ctx)).jobsMerged).toBe(0);
    expect(counts(server).jobs).toBe(2);
  });
});

it('treats listing sites as listings', () => {
  expect(isAggregator('jobright')).toBe(true);
  expect(isAggregator('greenhouse')).toBe(false);
});
