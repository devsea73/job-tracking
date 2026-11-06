import { describe, expect, it } from 'vitest';
import type { CreateApplicationResponse, JobFacts } from '../src/shared/api';
import { UNREADABLE_NOTES } from '../src/shared/unreadable';
import { EMPTY_FACTS } from '../src/server/dedupe/job-facts';
import { compareJobs } from '../src/server/dedupe/scoring';
import { compareLocations } from '../src/server/dedupe/text-normalize';
import { createTestServer, createUsers, jobPage, LONG_DESCRIPTION } from './helpers';

type Created = Extract<CreateApplicationResponse, { outcome: 'created' }>;

function created(response: CreateApplicationResponse): Created {
  if (response.outcome !== 'created') throw new Error(`expected a saved application, got ${response.outcome}`);
  return response;
}

const NURSING = `About the role

Provide direct patient care on a busy medical surgical unit, working with physicians and the wider care team to plan, deliver and document treatment for adults recovering from surgery.

What you will do
- Assess patients, give medication and keep careful records through every shift
- Teach patients and families how to manage care after they go home
- Respond calmly to changes in a patient's condition

What you bring
- An active registered nurse license and current basic life support certification
- At least one year of acute care experience`;

const BILLING = `About the role

Join the revenue cycle team and keep claims moving: review charges, correct coding problems before claims go out, and follow up with insurers on anything they deny or underpay.

What you will do
- Check charges against records and fix what does not match
- Work denied claims until they are paid or closed
- Explain balances to patients on the phone, kindly and clearly

What you bring
- Two years of medical billing experience and knowledge of common coding systems`;

describe('locations', () => {
  it.each([
    ['Austin, TX', 'Houston, TX', 'conflict'],
    ['Austin, TX', 'Austin, Texas, United States', 'match'],
    ['New York, NY', 'New York City, NY 10001', 'match'],
    ['Seattle, WA', 'Greater Seattle Area', 'match'],
    ['Hybrid - Austin, TX', 'Austin TX', 'match'],
    ['Austin, TX', 'Austin, TX or Remote', 'match'],
    ['Portland, OR', 'Portland, ME', 'conflict'],
    ['London, United Kingdom', 'London, Ontario, Canada', 'conflict'],
    ['Manchester, England', 'London, England', 'conflict'],
    ['San Francisco, CA', 'San Jose, CA', 'conflict'],
    ['Texas', 'California', 'conflict'],
    ['Texas', 'Austin, TX', 'unknown'],
    ['United States', 'Austin, TX', 'unknown'],
    ['Remote', 'Remote', 'match'],
    ['Remote', 'Remote, US', 'match'],
    ['Remote', 'Austin, TX', 'unknown'],
    ['Multiple Locations', 'Austin, TX', 'unknown'],
    ['Remote - United States', 'Remote - Canada', 'conflict'],
    ['Washington, DC', 'Seattle, WA', 'conflict'],
    ['St. Louis, MO', 'Saint Louis, Missouri', 'match'],
    [null, 'Austin, TX', 'unknown']
  ])('%s and %s: %s', (a, b, expected) => {
    expect(compareLocations(a, b)).toBe(expected);
    expect(compareLocations(b, a)).toBe(expected);
  });
});

describe('one company, one title, one pay rate', () => {
  const facts: JobFacts = { ...EMPTY_FACTS, salaryMin: 78000, salaryMax: 96000, salaryCurrency: 'USD', salaryPeriod: 'year', workArrangement: 'onsite', employmentType: 'permanent' };
  const job = (location: string, description: string) => ({ company: 'Mercy Health', title: 'Registered Nurse', location, description, identifiers: [], facts });

  it('is not one job when the descriptions describe different work', () => {
    const comparison = compareJobs(job('Austin, TX', NURSING), job('Austin, TX', BILLING));
    expect(comparison.decision).not.toBe('auto');
  });

  it('is two openings when they are in two cities of one state', () => {
    const comparison = compareJobs(job('Austin, TX', NURSING), job('Houston, TX', NURSING));
    expect(comparison.decision).not.toBe('auto');
    expect(comparison.reasons).toContain('Different location');
  });
});

describe('links that only differ in what names the job', () => {
  it('keeps two BambooHR postings apart, and still matches the same one', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'alice', 'bob', 'carol');
    server.http.serve('https://acme.bamboohr.com/jobs/view.php?id=42', jobPage({ title: 'Backend Engineer', company: 'Acme' }));
    server.http.serve('https://acme.bamboohr.com/jobs/view.php?id=57', jobPage({ title: 'Office Manager', company: 'Acme', description: BILLING }));
    const alice = created(await users.alice.addJob('https://acme.bamboohr.com/jobs/view.php?id=42'));
    const bob = created(await users.bob.addJob('https://acme.bamboohr.com/jobs/view.php?id=57'));
    expect(bob.jobId).not.toBe(alice.jobId);
    expect(bob.jobWasNew).toBe(true);
    // The newer shape of the same link is the same posting, without reading it again.
    const carol = created(await users.carol.addJob('https://acme.bamboohr.com/careers/42'));
    expect(carol).toMatchObject({ jobId: alice.jobId, matchedBy: 'identifier' });
  });

  it('does not file a job under another one on the same careers page', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'alice', 'bob');
    server.http.serve('https://smallco.com/careers#backend-engineer', jobPage({ title: 'Backend Engineer', company: 'SmallCo' }));
    server.http.serve('https://smallco.com/careers#office-manager', jobPage({ title: 'Office Manager', company: 'SmallCo', description: BILLING }));
    const alice = created(await users.alice.addJob('https://smallco.com/careers#backend-engineer'));
    const bob = created(await users.bob.addJob('https://smallco.com/careers#office-manager'));
    expect(bob.jobId).not.toBe(alice.jobId);
    expect(server.http.requests.filter((url) => url.includes('office-manager'))).toHaveLength(1);
  });

  it('never takes the same bare careers page for the same job', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'alice', 'bob');
    server.http.serve('https://smallco.com/careers', jobPage({ title: 'Backend Engineer', company: 'SmallCo' }));
    const alice = created(await users.alice.addJob('https://smallco.com/careers'));
    // A week later the page shows its next opening.
    server.http.serve('https://smallco.com/careers', jobPage({ title: 'Office Manager', company: 'SmallCo', description: BILLING }));
    const bob = created(await users.bob.addJob('https://smallco.com/careers'));
    expect(bob.jobId).not.toBe(alice.jobId);
  });

  it('does not take related openings for one job because their site names one page for all of them', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'alice', 'bob');
    const canonical = 'https://company.com/careers/all-open-roles';
    server.http.serve('https://company.com/careers/role-1', jobPage({ title: 'Senior Backend Engineer', company: 'Company', canonical }));
    server.http.serve('https://company.com/careers/role-2', jobPage({ title: 'Backend Engineer', company: 'Company', description: BILLING, canonical }));
    const alice = created(await users.alice.addJob('https://company.com/careers/role-1'));
    const bob = await users.bob.addJob('https://company.com/careers/role-2');
    expect(bob.outcome === 'created' && bob.jobId === alice.jobId).toBe(false);
  });
});

describe('a job saved without its text', () => {
  it('gets the real text when a readable link for it comes along', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'alice', 'bob');
    const blocked = 'https://job-boards.greenhouse.io/acme/jobs/5550123';
    server.http.serve('https://boards-api.greenhouse.io/v1/boards/acme/jobs/5550123', { status: 403, body: 'denied' });
    server.http.serve(blocked, { status: 403, body: '<html><title>Access denied</title><body>Access denied</body></html>' });
    const first = await users.alice.addJob(blocked);
    expect(first.outcome).toBe('needs_manual');
    if (first.outcome !== 'needs_manual') return;
    const saved = created(await users.alice.addJob(blocked, { draftId: first.draftId, manual: { title: 'Data Engineer', company: 'Acme', description: UNREADABLE_NOTES.refused } }));

    // The same posting, wrapped in the employer's own careers page, which reads fine.
    server.http.serve('https://acme.com/careers?gh_jid=5550123', jobPage({ title: 'Data Engineer', company: 'Acme', description: LONG_DESCRIPTION }));
    const bob = created(await users.bob.addJob('https://acme.com/careers?gh_jid=5550123'));
    expect(bob.jobId).toBe(saved.jobId);
    const job = (await users.bob.get(`/api/jobs/${saved.jobId}`)).json;
    expect(job.description).toContain('payments infrastructure');
  });
});

describe('what a person said, against what happened meanwhile', () => {
  it('puts "same job" for a link a teammate just saved on that link’s job, and asks about the pair', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'alice', 'bob');
    server.http.serve('https://careers.example.com/jobs/1', jobPage({ title: 'Senior Data Engineer', company: 'Devoted Health Services, Inc' }));
    const link = 'https://other.example.org/jobs/1';
    server.http.serve(link, jobPage({ title: 'Senior Data Engineer', company: 'Devoted Health', description: `${LONG_DESCRIPTION.split('\n\n').reverse().join('\n\n')} Apply today.` }));
    const older = created(await users.alice.addJob('https://careers.example.com/jobs/1'));
    const check = (await users.alice.post('/api/applications/check', { url: link })).json;
    expect(check.status).toBe('possible');
    // Bob saves the link itself as a job of its own, without being shown anything.
    const bobs = created(await users.bob.addJob(link, { resolution: { action: 'new' } }));
    expect(bobs.jobId).not.toBe(older.jobId);

    const alices = created(await users.alice.addJob(link, { draftId: check.draftId, resolution: { action: 'merge', jobId: older.jobId } }));
    expect(alices.jobId).toBe(bobs.jobId);
    const pair = server.ctx.db.$client.prepare('SELECT status FROM duplicate_candidates WHERE job_id_low = ? AND job_id_high = ?').get(Math.min(older.jobId, bobs.jobId), Math.max(older.jobId, bobs.jobId));
    expect(pair).toEqual({ status: 'pending' });
  });

  it('refuses a profile archived while its page was being read', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'alice');
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.http.serve('https://slow.example.com/jobs/1', { body: jobPage({ title: 'Data Engineer', company: 'Slow Co' }), delay: slow });
    const profileId = await users.alice.defaultProfileId();
    // Someone keeps one active profile at least.
    expect((await users.alice.post('/api/profiles', { name: 'Other' })).status).toBe(201);
    const saving = users.alice.post('/api/applications', { url: 'https://slow.example.com/jobs/1', profileId });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const archived = await users.alice.patch(`/api/profiles/${profileId}`, { isArchived: true });
    expect(archived.status, JSON.stringify(archived.json)).toBe(200);
    release();
    const response = await saving;
    expect(response.status).toBe(409);
    expect(response.json.error.code).toBe('profile_unavailable');
    expect(server.ctx.db.$client.prepare('SELECT COUNT(*) AS total FROM applications').get()).toEqual({ total: 0 });
  });

  it('applies from a notification only if none of the person’s profiles applied yet', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'alice', 'bob');
    server.http.serve('https://careers.example.com/jobs/9', jobPage({ title: 'Platform Engineer', company: 'Acme' }));
    const job = created(await users.alice.addJob('https://careers.example.com/jobs/9'));
    const first = await users.bob.defaultProfileId();
    const second = (await users.bob.post('/api/profiles', { name: 'Second' })).json.id as number;
    // Bob added it in the main window a moment ago, with his first profile.
    created(await users.bob.addJob('https://careers.example.com/jobs/9', { profileId: first }));
    const fromCard = (await users.bob.post(`/api/jobs/${job.jobId}/apply`, { profileId: second, unlessApplied: true })).json;
    expect(fromCard).toMatchObject({ outcome: 'already_applied', profileName: 'bob' });
    expect(server.ctx.db.$client.prepare('SELECT COUNT(*) AS total FROM applications WHERE user_id = (SELECT id FROM users WHERE username = ?)').get('bob')).toEqual({ total: 1 });
    // Applying on purpose with another profile still works.
    expect((await users.bob.post(`/api/jobs/${job.jobId}/apply`, { profileId: second })).json.outcome).toBe('created');
  });
});
