import { describe, expect, it } from 'vitest';
import type { JobBrief, ServerEvent } from '../src/shared/api';
import { deriveIndustry, deriveStack } from '../src/server/services/job-brief';
import { createTestServer, createUsers, jobPage } from './helpers';

const POSTING = `We help hospitals and clinics care for patients. Our clinical data platform serves healthcare providers across the country.
You will build services in Python and Go on AWS, with PostgreSQL and Kafka. Experience with Python, Go, Terraform and Kubernetes is a plus.
This is a fully remote position. The salary range is $150,000 - $180,000 per year.`;

describe('what a new-job notification shows', () => {
  it('finds the main stack, title first', () => {
    const stack = deriveStack('Senior Go Engineer', POSTING);
    expect(stack.slice(0, 2)).toEqual(['Go', 'Python']);
    expect(stack).toHaveLength(5);
    expect(stack).toContain('AWS');
    expect(deriveStack('Engineer', 'You will go to meetings and Go ahead with plans.')).toEqual([]);
    expect(deriveStack('C# Developer', 'Build .NET services in C# with React.')).toEqual(expect.arrayContaining(['C#', '.NET', 'React']));
    expect(deriveStack('Engineer', 'We write JavaScript, not Java.').sort()).toEqual(['Java', 'JavaScript']);
  });

  it('names the industry only when the posting is clearly about it', () => {
    expect(deriveIndustry('Acme Health', POSTING)).toBe('Healthcare');
    expect(deriveIndustry('Acme', 'We build tools. One customer is a hospital.')).toBeNull();
  });

  it('is offered to everyone else when someone applies, with who found it', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    const events: ServerEvent[] = [];
    server.ctx.events.subscribe((event) => events.push(event));
    server.http.serve('https://careers.example.com/jobs/1', jobPage({ title: 'Senior Go Engineer', company: 'Acme Health', location: 'Remote, US', description: POSTING }));

    const added = await users.tyler.addJob('https://careers.example.com/jobs/1');
    if (added.outcome !== 'created') throw new Error(added.outcome);
    const event = events.find((item) => item.type === 'application_added');
    expect(event).toMatchObject({ jobId: added.jobId, applicationId: added.applicationId });

    const forJohn = (await users.john.get(`/api/jobs/${added.jobId}/brief?application=${added.applicationId}`)).json as JobBrief;
    expect(forJohn).toMatchObject({ title: 'Senior Go Engineer', company: 'Acme Health', owner: 'tyler', profile: 'tyler', addedByMe: false, alreadyApplied: false, industry: 'Healthcare', url: 'https://careers.example.com/jobs/1' });
    expect(forJohn.stack[0]).toBe('Go');
    expect(forJohn.facts).toMatchObject({ workArrangement: 'remote', salaryMin: 150_000 });

    // Tyler found it, so his own app stays quiet.
    const forTyler = (await users.tyler.get(`/api/jobs/${added.jobId}/brief?application=${added.applicationId}`)).json as JobBrief;
    expect(forTyler).toMatchObject({ addedByMe: true, alreadyApplied: true });
  });

  it('knows when the viewer has applied already', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    server.http.serve('https://careers.example.com/jobs/2', jobPage({ title: 'Engineer', company: 'Acme' }));
    const first = await users.john.addJob('https://careers.example.com/jobs/2');
    const second = await users.tyler.addJob('https://careers.example.com/jobs/2');
    if (first.outcome !== 'created' || second.outcome !== 'created') throw new Error('not created');
    const brief = (await users.john.get(`/api/jobs/${second.jobId}/brief?application=${second.applicationId}`)).json as JobBrief;
    expect(brief).toMatchObject({ owner: 'tyler', addedByMe: false, alreadyApplied: true });
  });

  it('applies from the notification with the Apply call', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john');
    server.http.serve('https://careers.example.com/jobs/3', jobPage({ title: 'Engineer', company: 'Acme' }));
    const added = await users.tyler.addJob('https://careers.example.com/jobs/3');
    if (added.outcome !== 'created') throw new Error(added.outcome);
    const profileId = await users.john.defaultProfileId();
    const applied = await users.john.post(`/api/jobs/${added.jobId}/apply`, { profileId });
    expect(applied.json).toMatchObject({ outcome: 'created' });
    expect(((await users.john.get(`/api/jobs/${added.jobId}/brief`)).json as JobBrief).alreadyApplied).toBe(true);
  });

  it('says only of the first application that its person found the job, so teammates joining later do not offer it again', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler', 'john', 'zoe');
    server.http.serve('https://careers.example.com/jobs/4', jobPage({ title: 'Site Reliability Engineer', company: 'Hooli' }));
    const found = await users.tyler.addJob('https://careers.example.com/jobs/4');
    if (found.outcome !== 'created') throw new Error(found.outcome);
    const joined = await users.john.post(`/api/jobs/${found.jobId}/apply`, { profileId: await users.john.defaultProfileId() });
    const forZoe = (application: number) => users.zoe.get(`/api/jobs/${found.jobId}/brief?application=${application}`).then((response) => response.json as JobBrief);
    expect(await forZoe(found.applicationId)).toMatchObject({ owner: 'tyler', foundIt: true, alreadyApplied: false });
    expect(await forZoe(joined.json.applicationId)).toMatchObject({ owner: 'john', foundIt: false, alreadyApplied: false });
  });

  it('needs a signed-in person', async () => {
    const server = await createTestServer();
    expect((await server.app.inject({ method: 'GET', url: '/api/jobs/1/brief' })).statusCode).toBe(401);
  });
});
