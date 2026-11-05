import { describe, expect, it } from 'vitest';
import { compareJobs } from '../src/server/dedupe/scoring';
import { ApiClient, createTestServer, createUsers, jobPage, LONG_DESCRIPTION } from './helpers';

const OTHER_DESCRIPTION = `About the role

Join the mobile growth organization and own experiments across the onboarding funnel, shipping to hundreds of millions of devices every week with a small and fast moving team of specialists.

What you will do
- Build native features in Swift and Kotlin for our consumer applications
- Partner with designers on rapid prototypes and user research sessions
- Analyze experiment results and decide what ships to all of our customers

What we look for
- Three or more years building consumer mobile applications at scale
- A portfolio of shipped applications in the public app stores`;

function jobCount(ctx: { db: { $client: { prepare(sql: string): { get(): unknown } } } }): number {
  return (ctx.db.$client.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c;
}
function applicationCount(ctx: { db: { $client: { prepare(sql: string): { get(): unknown } } } }): number {
  return (ctx.db.$client.prepare('SELECT COUNT(*) AS c FROM applications').get() as { c: number }).c;
}

describe('duplicate jobs', () => {
  it('layer A: the same URL with tracking parameters is one job and needs no second fetch', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler', 'john');
    http.serve('https://company.com/jobs/12345', jobPage({ title: 'Software Engineer', company: 'Company' }));

    const first = await users.tyler.addJob('https://company.com/jobs/12345');
    const second = await users.john.addJob('https://company.com/jobs/12345?utm_source=linkedin&ref=jobright');
    expect(first).toMatchObject({ outcome: 'created', jobWasNew: true, matchedBy: 'new' });
    expect(second).toMatchObject({ outcome: 'created', jobWasNew: false, matchedBy: 'url', jobId: (first as any).jobId });
    expect(jobCount(ctx)).toBe(1);
    expect(applicationCount(ctx)).toBe(2);
    expect(http.requests.filter((url) => url.includes('company.com'))).toHaveLength(1);
  });

  it('layer B: a canonical link connects two different URLs', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler', 'john');
    const canonical = 'https://company.com/careers/software-engineer-12345';
    http.serve(canonical, jobPage({ title: 'Software Engineer', company: 'Company', canonical }));
    http.serve('https://jobs.partner-site.com/listing/777', jobPage({ title: 'Software Engineer', company: 'Partner Staffing', description: OTHER_DESCRIPTION, canonical }));

    await users.tyler.addJob(canonical);
    const second = await users.john.addJob('https://jobs.partner-site.com/listing/777');
    expect(second).toMatchObject({ outcome: 'created', jobWasNew: false, matchedBy: 'canonical' });
    expect(jobCount(ctx)).toBe(1);
  });

  it('layer B: a redirect destination connects two URLs', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler', 'john');
    const target = 'https://company.com/careers/software-engineer-12345';
    http.serve(target, jobPage({ title: 'Software Engineer', company: 'Company' }));
    http.serve('https://short.link/abc', { redirectTo: target });

    await users.tyler.addJob(target);
    const second = await users.john.addJob('https://short.link/abc');
    expect(second).toMatchObject({ outcome: 'created', jobWasNew: false, matchedBy: 'canonical' });
    expect(jobCount(ctx)).toBe(1);
  });

  it('layer B: a canonical link shared by unrelated jobs is not evidence', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler', 'john');
    const canonical = 'https://company.com/careers/all-open-roles';
    http.serve('https://company.com/careers/role-1', jobPage({ title: 'Software Engineer', company: 'Company', canonical }));
    http.serve('https://company.com/careers/role-2', jobPage({ title: 'Marketing Director', company: 'Company', description: OTHER_DESCRIPTION, canonical }));

    await users.tyler.addJob('https://company.com/careers/role-1');
    const second = await users.john.addJob('https://company.com/careers/role-2');
    expect(second).toMatchObject({ outcome: 'created', jobWasNew: true });
    expect(jobCount(ctx)).toBe(2);
  });

  it('layer C: the same ATS id matches across URL shapes, without fetching again', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler', 'john', 'mike');
    http.serve(
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs/5213453007',
      JSON.stringify({ title: 'Staff Engineer', company_name: 'Acme', content: `&lt;p&gt;${LONG_DESCRIPTION}&lt;/p&gt;`, location: { name: 'Remote' } })
    );

    await users.tyler.addJob('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=5213453007&utm_source=jobright&jr_id=abc');
    const fetchesAfterFirst = http.requests.length;
    const second = await users.john.addJob('https://job-boards.greenhouse.io/acme/jobs/5213453007');
    const third = await users.mike.addJob('https://acme.com/careers/?gh_jid=5213453007');
    expect(second).toMatchObject({ outcome: 'created', jobWasNew: false, matchedBy: 'identifier' });
    expect(third).toMatchObject({ outcome: 'created', jobWasNew: false, matchedBy: 'identifier' });
    expect(http.requests.length).toBe(fetchesAfterFirst);
    expect(jobCount(ctx)).toBe(1);
  });

  it('layer C: an ATS link inside an aggregator page identifies the original posting', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler', 'john');
    http.serve(
      'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/98765',
      JSON.stringify({ title: 'Software Engineer', company_name: 'Stripe', content: LONG_DESCRIPTION, location: { name: 'Remote' } })
    );
    http.serve(
      'https://builtin.com/job/software-engineer/12345',
      jobPage({ title: 'Software Engineer', company: 'Stripe', description: OTHER_DESCRIPTION, extraBody: '<a href="https://job-boards.greenhouse.io/stripe/jobs/98765">Apply</a>' })
    );

    await users.tyler.addJob('https://job-boards.greenhouse.io/stripe/jobs/98765');
    const second = await users.john.addJob('https://builtin.com/job/software-engineer/12345');
    expect(second).toMatchObject({ outcome: 'created', jobWasNew: false, matchedBy: 'identifier' });
    expect(jobCount(ctx)).toBe(1);
  });

  it('layer D: identical postings on different platforms merge automatically', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler', 'john');
    http.serve('https://builtin.com/job/senior-software-engineer/123456', jobPage({ title: 'Senior Software Engineer', company: 'Stripe', location: 'Remote' }));
    http.serve('https://jobright.ai/jobs/info/abc123', jobPage({ title: 'Sr. Software Engineer', company: 'Stripe, Inc.', location: 'Remote' }));

    const first = await users.tyler.addJob('https://builtin.com/job/senior-software-engineer/123456', { memo: 'Recruiter contacted me.' });
    const second = await users.john.addJob('https://jobright.ai/jobs/info/abc123');
    expect(second).toMatchObject({ outcome: 'created', jobWasNew: false, matchedBy: 'content', jobId: (first as any).jobId });
    expect(jobCount(ctx)).toBe(1);
    expect(applicationCount(ctx)).toBe(2);

    const detail = (await users.tyler.get(`/api/jobs/${(first as any).jobId}`)).json;
    expect(detail.urls.map((url: any) => url.sourcePlatform).sort()).toEqual(['builtin', 'jobright']);
    expect(detail.applicants.map((user: any) => user.username)).toEqual(['tyler', 'john']);
  });

  it('layer D: same company and title with a different description asks instead of merging', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler', 'john');
    http.serve('https://stripe-careers.com/jobs/a', jobPage({ title: 'Senior Software Engineer', company: 'Stripe' }));
    http.serve('https://stripe-careers.com/jobs/b', jobPage({ title: 'Senior Software Engineer', company: 'Stripe', description: OTHER_DESCRIPTION }));

    const first = await users.tyler.addJob('https://stripe-careers.com/jobs/a');
    const second: any = await users.john.addJob('https://stripe-careers.com/jobs/b');
    expect(second.outcome).toBe('possible_duplicate');
    expect(second.candidates[0]).toMatchObject({ jobId: (first as any).jobId, company: 'Stripe' });
    expect(second.candidates[0].reasons).toContain('Same company');
    expect(jobCount(ctx)).toBe(1); // nothing saved yet

    // The person says these are different openings.
    const asNew = await users.john.addJob('https://stripe-careers.com/jobs/b', { draftId: second.draftId, resolution: { action: 'new' } });
    expect(asNew).toMatchObject({ outcome: 'created', jobWasNew: true });
    expect(jobCount(ctx)).toBe(2);
    // The draft saved a second fetch of the page.
    expect(http.requests.filter((url) => url.endsWith('/jobs/b'))).toHaveLength(1);
  });

  it('layer D: the person can confirm that a possible duplicate is the same job', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler', 'john');
    http.serve('https://stripe-careers.com/jobs/a', jobPage({ title: 'Senior Software Engineer', company: 'Stripe' }));
    http.serve('https://other-board.com/stripe/senior', jobPage({ title: 'Senior Software Engineer', company: 'Stripe', description: OTHER_DESCRIPTION }));

    const first: any = await users.tyler.addJob('https://stripe-careers.com/jobs/a');
    const second: any = await users.john.addJob('https://other-board.com/stripe/senior', { memo: 'mine' });
    expect(second.outcome).toBe('possible_duplicate');
    const merged = await users.john.addJob('https://other-board.com/stripe/senior', { memo: 'mine', draftId: second.draftId, resolution: { action: 'merge', jobId: first.jobId } });
    expect(merged).toMatchObject({ outcome: 'created', jobWasNew: false, matchedBy: 'user_confirmed', jobId: first.jobId });
    expect(jobCount(ctx)).toBe(1);

    // The link is now an alias: anyone using it goes straight to the job.
    const { users: more } = { users: { mike: new ApiClient(app) } };
    await users.tyler.post('/api/auth/logout');
    await more.mike.login('tyler', 'tyler-password');
    const again: any = await more.mike.addJob('https://other-board.com/stripe/senior?utm_source=x');
    expect(again).toMatchObject({ outcome: 'already_applied', jobId: first.jobId });
  });

  it('does not let a redirect from a closed posting become part of a job', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler', 'john');
    const board = 'https://company.com/open-roles/engineering';
    http.serve('https://company.com/jobs/closed-1', { redirectTo: board });
    http.serve('https://company.com/jobs/closed-2', { redirectTo: board });
    http.serve(board, '<html><head><title>Careers</title></head><body><h1>Careers</h1></body></html>');

    const manual = { title: 'Backend Engineer', company: 'Company', description: 'Typed by hand for the first one.' };
    const first: any = await users.tyler.addJob('https://company.com/jobs/closed-1');
    expect(first.outcome).toBe('needs_manual');
    const saved: any = await users.tyler.addJob('https://company.com/jobs/closed-1', { draftId: first.draftId, manual });

    const kinds = ctx.db.$client.prepare('SELECT kind FROM job_urls WHERE job_id = ?').all(saved.jobId) as Array<{ kind: string }>;
    expect(kinds.map((row) => row.kind)).toEqual(['original']);

    // A different closed job redirecting to the same page is not "the same job".
    const second: any = await users.john.addJob('https://company.com/jobs/closed-2');
    expect(second.outcome).toBe('needs_manual');
  });

  it('never merges two ids from the same ATS automatically, even with identical text', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler', 'john');
    const serve = (id: string) =>
      http.serve(`https://boards-api.greenhouse.io/v1/boards/acme/jobs/${id}`, JSON.stringify({ title: 'Software Engineer', company_name: 'Acme', content: LONG_DESCRIPTION }));
    serve('111');
    serve('222');
    await users.tyler.addJob('https://job-boards.greenhouse.io/acme/jobs/111');
    const second: any = await users.john.addJob('https://job-boards.greenhouse.io/acme/jobs/222');
    expect(second.outcome).toBe('possible_duplicate');
    expect(jobCount(ctx)).toBe(1);
  });
});

describe('content comparison', () => {
  const base = { company: 'Stripe', title: 'Senior Software Engineer', location: 'Remote', description: LONG_DESCRIPTION, identifiers: [] };

  it('merges strong agreement automatically', () => {
    expect(compareJobs(base, { ...base, company: 'Stripe, Inc.', title: 'Sr Software Engineer' }).decision).toBe('auto');
  });

  it('does not merge on company and title alone', () => {
    expect(compareJobs(base, { ...base, description: OTHER_DESCRIPTION }).decision).toBe('possible');
  });

  it('treats different requisition numbers as different openings', () => {
    const a = { ...base, description: `${LONG_DESCRIPTION}\nJob ID: R-1001` };
    const b = { ...base, description: `${LONG_DESCRIPTION}\nJob ID: R-2002` };
    expect(compareJobs(a, b).decision).not.toBe('auto');
  });

  it('merges on a matching requisition number with a similar title', () => {
    const a = { ...base, description: `Short summary of the role.\nJob ID: R-1001` };
    const b = { ...base, description: `${OTHER_DESCRIPTION}\nJob ID: R-1001` };
    expect(compareJobs(a, b).decision).toBe('auto');
  });

  it('treats different locations as different openings', () => {
    expect(compareJobs({ ...base, location: 'Austin, TX' }, { ...base, location: 'Berlin, Germany' }).decision).not.toBe('auto');
  });

  it('merges a long excerpt of the posting, as aggregators publish', () => {
    const full = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} of a long posting talks about the ${i}th responsibility and how the team approaches it every single week of the year.`).join('\n');
    const excerpt = full.split('\n').slice(0, 9).join('\n');
    expect(excerpt.length).toBeGreaterThan(1000);
    expect(compareJobs({ ...base, description: excerpt }, { ...base, description: full })).toMatchObject({ decision: 'auto' });
  });

  it('only asks about a short excerpt, which could just be boilerplate', () => {
    const excerpt = LONG_DESCRIPTION.slice(0, 300);
    expect(compareJobs({ ...base, description: excerpt }, base).decision).toBe('possible');
  });

  it('asks about the same title at a company with a related name, even when one site rewrote the text', () => {
    const a = { ...base, company: 'Devoted Health', description: OTHER_DESCRIPTION };
    const b = { ...base, company: 'Devoted Health Services, Inc' };
    expect(compareJobs(a, b).decision).toBe('possible');
  });

  it('does not treat shared boilerplate as the same job at a lower overlap', () => {
    const boilerplate = Array.from({ length: 8 }, (_, i) => `Benefit ${i} of working here is described in this standard sentence the company uses on every posting.`).join('\n');
    const roleA = Array.from({ length: 5 }, (_, i) => `On the payments team you will own ledger component ${i} and its reconciliation guarantees for merchants.`).join('\n');
    const roleB = Array.from({ length: 5 }, (_, i) => `On the identity team you will own session service ${i} and its authentication flows for customers.`).join('\n');
    const result = compareJobs({ ...base, description: `${roleA}\n${boilerplate}` }, { ...base, description: `${roleB}\n${boilerplate}` });
    expect(result.decision).toBe('possible');
  });

  it('flags a recruiter reposting the same text under its own name', () => {
    expect(compareJobs(base, { ...base, company: 'Fast Staffing' }).decision).toBe('possible');
  });

  it('ignores unrelated jobs', () => {
    expect(compareJobs(base, { company: 'Other', title: 'Nurse', location: null, description: OTHER_DESCRIPTION, identifiers: [] }).decision).toBe('none');
  });
});

describe('application-level duplicates', () => {
  it('another user on the same job adds an application and an avatar, not a job', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler', 'john');
    http.serve('https://company.com/jobs/1', jobPage({ title: 'Engineer', company: 'Company' }));

    const first: any = await users.tyler.addJob('https://company.com/jobs/1');
    await users.john.addJob('https://company.com/jobs/1');
    expect(jobCount(ctx)).toBe(1);
    const list = (await users.john.get('/api/jobs')).json;
    expect(list.items[0].id).toBe(first.jobId);
    expect(list.items[0].applicants.map((user: any) => user.username)).toEqual(['tyler', 'john']);
  });

  it('the same user applying twice is shown the existing application', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler');
    http.serve('https://company.com/jobs/1', jobPage({ title: 'Engineer', company: 'Company' }));

    const first: any = await users.tyler.addJob('https://company.com/jobs/1', { memo: 'original memo' });
    const again: any = await users.tyler.addJob('https://company.com/jobs/1?utm_source=x', { memo: 'different memo' });
    expect(again).toMatchObject({ outcome: 'already_applied', applicationId: first.applicationId, jobId: first.jobId, title: 'Engineer' });
    expect(applicationCount(ctx)).toBe(1);
    const detail = (await users.tyler.get(`/api/jobs/${first.jobId}`)).json;
    expect(detail.myApplication.memo).toBe('original memo');
  });

  it('two users adding the same new URL at the same moment get one job', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler', 'john');
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    http.serve('https://company.com/jobs/race', { body: jobPage({ title: 'Engineer', company: 'Company' }), delay: gate });

    const both = Promise.all([users.tyler.addJob('https://company.com/jobs/race'), users.john.addJob('https://company.com/jobs/race?utm_source=x')]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const results = await both;

    expect(results.map((result) => result.outcome)).toEqual(['created', 'created']);
    expect(new Set(results.map((result: any) => result.jobId)).size).toBe(1);
    expect(jobCount(ctx)).toBe(1);
    expect(applicationCount(ctx)).toBe(2);
    // One shared read of the page.
    expect(http.requests.filter((url) => url.includes('/jobs/race'))).toHaveLength(1);
  });

  it('two users adding different URLs for one posting at the same moment get one job', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler', 'john');
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const page = jobPage({ title: 'Software Engineer', company: 'Stripe', location: 'Remote' });
    http.serve('https://builtin.com/job/software-engineer/1', { body: page, delay: gate });
    http.serve('https://jobright.ai/jobs/info/1', { body: page, delay: gate });

    const both = Promise.all([users.tyler.addJob('https://builtin.com/job/software-engineer/1'), users.john.addJob('https://jobright.ai/jobs/info/1')]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const results: any[] = await both;

    expect(new Set(results.map((result) => result.jobId)).size).toBe(1);
    expect(jobCount(ctx)).toBe(1);
    expect(applicationCount(ctx)).toBe(2);
  });

  it('the same user double-submitting at the same moment still gets one application', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler');
    http.serve('https://company.com/jobs/1', jobPage({ title: 'Engineer', company: 'Company' }));
    const results = await Promise.all([users.tyler.addJob('https://company.com/jobs/1'), users.tyler.addJob('https://company.com/jobs/1')]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['already_applied', 'created']);
    expect(applicationCount(ctx)).toBe(1);
  });

  it('the database itself refuses a second application or a reused link', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler');
    http.serve('https://company.com/jobs/1', jobPage({ title: 'Engineer', company: 'Company' }));
    const first: any = await users.tyler.addJob('https://company.com/jobs/1');
    const userId = (await users.tyler.get('/api/auth/me')).json.id;
    const sqlite = ctx.db.$client;
    expect(() => sqlite.prepare('INSERT INTO applications (user_id, job_id) VALUES (?, ?)').run(userId, first.jobId)).toThrow(/UNIQUE/);
    expect(() =>
      sqlite
        .prepare('INSERT INTO job_urls (job_id, original_url, normalized_url) VALUES (?, ?, ?)')
        .run(first.jobId, 'https://company.com/jobs/1', 'https://company.com/jobs/1')
    ).toThrow(/UNIQUE/);
  });
});
