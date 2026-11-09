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

const INTERVIEW = { stage: 'Technical Interview', at: '2030-11-13T14:00:00-05:00', timezone: 'America/New_York' };

/** One person's application within a job's details, as they see it. */
const myApplication = async (client: ApiClient, jobId: number) => mine((await client.get(`/api/jobs/${jobId}`)).json);

describe('the stage of an application', () => {
  it('starts as Applied and follows each person’s own timeline', async () => {
    const server = await createTestServer();
    const { tyler, john, jobId, tylerApp, johnApp } = await jobWithTwoApplicants(server);
    expect(await myApplication(tyler, jobId)).toMatchObject({ stage: 'Applied', furthestStage: 'Applied', steps: [], interviewCount: 0 });

    await tyler.addStep(tylerApp, 'Technical Interview', '2030-11-13T14:00:00Z');
    await john.addStep(johnApp, 'Recruiter Screen', '2030-11-10T10:00:00Z');

    expect((await myApplication(tyler, jobId)).stage).toBe('Technical Interview');
    expect((await myApplication(john, jobId)).stage).toBe('Recruiter Screen');
  });

  it('is the stage of the latest step by when it takes place, not by when it was put in', async () => {
    const server = await createTestServer();
    const { tyler, jobId, tylerApp } = await jobWithTwoApplicants(server);
    await tyler.addStep(tylerApp, 'Final Interview', '2030-11-18T11:00:00Z');
    await tyler.addStep(tylerApp, 'Recruiter Screen', '2030-11-10T10:00:00Z');
    const application = await myApplication(tyler, jobId);
    expect(application).toMatchObject({ stage: 'Final Interview', furthestStage: 'Final Interview' });
    // The timeline reads oldest first.
    expect(application.steps.map((step: any) => step.stage)).toEqual(['Recruiter Screen', 'Final Interview']);
  });

  it('stays at Technical Interview through three technical rounds, each one an interview', async () => {
    const server = await createTestServer();
    const { tyler, jobId, tylerApp } = await jobWithTwoApplicants(server);
    for (const day of ['2030-11-10', '2030-11-12', '2030-11-15']) await tyler.addStep(tylerApp, 'Technical Interview', `${day}T15:00:00Z`);
    const application = await myApplication(tyler, jobId);
    expect(application).toMatchObject({ stage: 'Technical Interview', furthestStage: 'Technical Interview', interviewCount: 3 });
    expect(application.steps).toHaveLength(3);
    expect((await tyler.get('/api/interviews')).json).toHaveLength(3);
  });

  it('ends at an offer or a rejection, which takes the interviews after it off the timeline', async () => {
    const server = await createTestServer();
    const { tyler, jobId, tylerApp } = await jobWithTwoApplicants(server);
    await tyler.addStep(tylerApp, 'Recruiter Screen', '2030-11-01T10:00:00Z');
    await tyler.addStep(tylerApp, 'Technical Interview', '2030-11-05T10:00:00Z');
    const third = await tyler.addStep(tylerApp, 'Technical Interview', '2030-11-20T10:00:00Z');

    const rejected = await tyler.addStep(tylerApp, 'Rejected', '2030-11-10T09:00:00Z');
    expect(rejected.removed.map((step) => step.id)).toEqual([third.id]);
    const application = await myApplication(tyler, jobId);
    expect(application.steps.map((step: any) => [step.stage, step.at.slice(0, 10)])).toEqual([
      ['Recruiter Screen', '2030-11-01'],
      ['Technical Interview', '2030-11-05'],
      ['Rejected', '2030-11-10']
    ]);
    // Rejected, having reached Technical Interview.
    expect(application).toMatchObject({ stage: 'Rejected', furthestStage: 'Technical Interview', interviewCount: 2 });
    expect((await tyler.get('/api/interviews')).json.map((item: any) => item.at.slice(0, 10))).toEqual(['2030-11-01', '2030-11-05']);

    // An interview after the rejection is a second chance: the stage moves on to it.
    await tyler.addStep(tylerApp, 'Final Interview', '2030-11-25T10:00:00Z');
    expect((await myApplication(tyler, jobId)).stage).toBe('Final Interview');
  });

  it('takes later interviews off when a step is changed into an outcome too, and leaves other outcomes alone', async () => {
    const server = await createTestServer();
    const { tyler, jobId, tylerApp } = await jobWithTwoApplicants(server);
    const final = await tyler.addStep(tylerApp, 'Final Interview', '2030-11-05T10:00:00Z');
    const later = await tyler.addStep(tylerApp, 'Final Interview', '2030-11-12T10:00:00Z');
    const changed = await tyler.patch(`/api/steps/${final.id}`, { stage: 'Offer', at: '2030-11-06T10:00:00Z', timezone: 'UTC' });
    expect(changed.status).toBe(200);
    expect(changed.json.removed.map((step: any) => step.id)).toEqual([later.id]);
    // An offer taken back is a rejection after it: the offer stays on the timeline.
    const rejected = await tyler.addStep(tylerApp, 'Rejected', '2030-11-20T10:00:00Z');
    expect(rejected.removed).toEqual([]);
    const application = await myApplication(tyler, jobId);
    expect(application.steps.map((step: any) => step.stage)).toEqual(['Offer', 'Rejected']);
    expect(application).toMatchObject({ stage: 'Rejected', furthestStage: 'Offer' });
  });

  it('goes back to the step before when the latest is removed', async () => {
    const server = await createTestServer();
    const { tyler, jobId, tylerApp } = await jobWithTwoApplicants(server);
    await tyler.addStep(tylerApp, 'Technical Interview', '2030-11-05T10:00:00Z');
    const rejected = await tyler.addStep(tylerApp, 'Rejected', '2030-11-10T10:00:00Z');
    expect((await tyler.delete(`/api/steps/${rejected.id}`)).status).toBe(200);
    expect(await myApplication(tyler, jobId)).toMatchObject({ stage: 'Technical Interview', furthestStage: 'Technical Interview' });
  });

  it('cannot be set by hand: only steps move it', async () => {
    const server = await createTestServer();
    const { tyler, jobId, tylerApp } = await jobWithTwoApplicants(server);
    expect((await tyler.patch(`/api/applications/${tylerApp}`, { status: 'Offer' })).status).toBe(400);
    expect((await tyler.patch(`/api/applications/${tylerApp}`, { stage: 'Offer' })).status).toBe(400);
    expect((await myApplication(tyler, jobId)).stage).toBe('Applied');
  });

  it('rejects steps at stages that are not steps', async () => {
    const server = await createTestServer();
    const { tyler, tylerApp } = await jobWithTwoApplicants(server);
    for (const stage of ['Applied', 'Hiring Manager', 'Other', 'Hired!']) {
      expect((await tyler.post(`/api/applications/${tylerApp}/steps`, { ...INTERVIEW, stage })).status, stage).toBe(400);
    }
  });

  it('keeps when a step takes place apart from when it was saved', async () => {
    const server = await createTestServer();
    const { tyler, tylerApp } = await jobWithTwoApplicants(server);
    const step = await tyler.addStep(tylerApp, 'Recruiter Screen', '2020-03-01T10:00:00Z');
    expect(step.at).toBe('2020-03-01T10:00:00.000Z');
    expect(step.createdAt > '2025-01-01').toBe(true);
    const changed = (await tyler.patch(`/api/steps/${step.id}`, { stage: 'Recruiter Screen', at: '2020-03-02T10:00:00Z', timezone: 'UTC' })).json;
    expect(changed).toMatchObject({ at: '2020-03-02T10:00:00.000Z', createdAt: step.createdAt });
    expect(changed.updatedAt >= step.createdAt).toBe(true);
  });

  it('starts from the applied date, which only the owner can change', async () => {
    const server = await createTestServer();
    const { tyler, john, jobId, tylerApp } = await jobWithTwoApplicants(server);
    const before = await myApplication(tyler, jobId);
    expect(before.appliedAt).toBe(before.createdAt);

    const changed = await tyler.patch(`/api/applications/${tylerApp}`, { appliedAt: '2026-10-01T09:30:00-04:00' });
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({ appliedAt: '2026-10-01T13:30:00.000Z', createdAt: before.createdAt });
    expect((await john.patch(`/api/applications/${tylerApp}`, { appliedAt: '2026-01-01T00:00:00Z' })).status).toBe(404);
    expect((await tyler.patch(`/api/applications/${tylerApp}`, { appliedAt: '2026-10-01T09:30:00' })).status).toBe(400);
    expect((await myApplication(tyler, jobId)).appliedAt).toBe('2026-10-01T13:30:00.000Z');
  });

  it("cannot touch another user's application", async () => {
    const server = await createTestServer();
    const { john, jobId, tyler, tylerApp } = await jobWithTwoApplicants(server);
    const step = await tyler.addStep(tylerApp, 'Recruiter Screen', '2030-11-10T10:00:00Z');
    expect((await john.patch(`/api/applications/${tylerApp}`, { memo: 'hacked' })).status).toBe(404);
    expect((await john.delete(`/api/applications/${tylerApp}`)).status).toBe(404);
    expect((await john.post(`/api/applications/${tylerApp}/steps`, INTERVIEW)).status).toBe(404);
    expect((await john.post(`/api/applications/${tylerApp}/steps`, { ...INTERVIEW, stage: 'Rejected' })).status).toBe(404);
    expect((await john.patch(`/api/steps/${step.id}`, { ...INTERVIEW, stage: 'Rejected' })).status).toBe(404);
    expect((await john.delete(`/api/steps/${step.id}`)).status).toBe(404);
    const application = await myApplication(tyler, jobId);
    expect(application).toMatchObject({ stage: 'Recruiter Screen', memo: 'tyler memo' });
    expect(application.steps).toHaveLength(1);
  });
});

describe('memos', () => {
  it('can be edited by their owner', async () => {
    const server = await createTestServer();
    const { tyler, jobId, tylerApp } = await jobWithTwoApplicants(server);
    await tyler.patch(`/api/applications/${tylerApp}`, { memo: 'updated' });
    expect(mine((await tyler.get(`/api/jobs/${jobId}`)).json).memo).toBe('updated');
  });

  it('are shared with everyone, along with the notes on each step', async () => {
    const server = await createTestServer();
    const { john, jobId, tylerApp, tyler } = await jobWithTwoApplicants(server);
    await tyler.post(`/api/applications/${tylerApp}/steps`, { ...INTERVIEW, note: 'tyler note' });
    const job = (await john.get(`/api/jobs/${jobId}`)).json;
    const tylers = job.applications.find((application: any) => application.owner.username === 'tyler');
    expect(tylers).toMatchObject({ memo: 'tyler memo', isMine: false, stage: 'Technical Interview' });
    expect(tylers.steps[0].note).toBe('tyler note');
    expect((await john.get('/api/jobs')).json.items[0].applications[0].memoPreview).toBe('tyler memo');
    // Anyone's memo can be found by searching.
    expect((await john.get('/api/jobs?q=tyler%20memo')).json.total).toBe(1);
  });
});

describe('interviews', () => {
  it('supports several per application, stored in UTC with their timezone', async () => {
    const server = await createTestServer();
    const { tyler, jobId, tylerApp } = await jobWithTwoApplicants(server);
    const created = await tyler.post(`/api/applications/${tylerApp}/steps`, INTERVIEW);
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ at: '2030-11-13T19:00:00.000Z', timezone: 'America/New_York', stage: 'Technical Interview', removed: [] });
    await tyler.post(`/api/applications/${tylerApp}/steps`, { stage: 'Recruiter Screen', at: '2030-11-10T10:00:00Z', timezone: 'UTC', note: 'Call' });
    await tyler.post(`/api/applications/${tylerApp}/steps`, { stage: 'Final Interview', at: '2030-11-18T11:00:00Z', timezone: 'UTC' });
    const list = (await myApplication(tyler, jobId)).steps;
    expect(list.map((item: any) => item.stage)).toEqual(['Recruiter Screen', 'Technical Interview', 'Final Interview']);
  });

  it('rejects ambiguous times and unknown timezones', async () => {
    const server = await createTestServer();
    const { tyler, tylerApp } = await jobWithTwoApplicants(server);
    expect((await tyler.post(`/api/applications/${tylerApp}/steps`, { ...INTERVIEW, at: '2030-11-13T14:00:00' })).status).toBe(400);
    expect((await tyler.post(`/api/applications/${tylerApp}/steps`, { ...INTERVIEW, timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await tyler.post(`/api/applications/${tylerApp}/steps`, { ...INTERVIEW, stage: 'Coffee' })).status).toBe(400);
  });

  it('can be edited and removed by their owner only', async () => {
    const server = await createTestServer();
    const { tyler, john, tylerApp } = await jobWithTwoApplicants(server);
    const { id } = (await tyler.post(`/api/applications/${tylerApp}/steps`, INTERVIEW)).json;

    expect((await john.patch(`/api/steps/${id}`, INTERVIEW)).status).toBe(404);
    expect((await john.delete(`/api/steps/${id}`)).status).toBe(404);

    const updated = await tyler.patch(`/api/steps/${id}`, { ...INTERVIEW, stage: 'Final Interview', note: 'moved' });
    expect(updated.json).toMatchObject({ stage: 'Final Interview', note: 'moved' });
    expect((await tyler.delete(`/api/steps/${id}`)).status).toBe(200);
    expect((await tyler.get('/api/interviews')).json).toEqual([]);
  });

  it('are what the calendars list: offers and rejections are not interviews', async () => {
    const server = await createTestServer();
    const { tyler, john, tylerApp, johnApp } = await jobWithTwoApplicants(server);
    await tyler.addStep(tylerApp, 'Recruiter Screen', '2030-11-10T10:00:00Z');
    await tyler.addStep(tylerApp, 'Offer', '2030-11-20T10:00:00Z');
    await john.addStep(johnApp, 'Technical Interview', '2030-11-12T10:00:00Z');
    await john.addStep(johnApp, 'Rejected', '2030-11-14T10:00:00Z');

    // My own by default; the whole team's on request, each marked as mine or not.
    expect((await tyler.get('/api/interviews')).json.map((item: any) => item.stage)).toEqual(['Recruiter Screen']);
    const everyone = (await tyler.get('/api/interviews?person=all')).json;
    expect(everyone.map((item: any) => [item.owner.username, item.stage, item.isMine])).toEqual([
      ['tyler', 'Recruiter Screen', true],
      ['john', 'Technical Interview', false]
    ]);
    expect(everyone[1]).toMatchObject({ company: 'Stripe', title: 'Engineer', at: '2030-11-12T10:00:00.000Z', applicationId: johnApp });
    expect((await tyler.get('/api/interviews?person=all&stage=Offer')).status).toBe(400);
  });

  it('shows upcoming interviews on the dashboard, and filters by date and stage', async () => {
    const server = await createTestServer();
    const { tyler, tylerApp } = await jobWithTwoApplicants(server);
    await tyler.post(`/api/applications/${tylerApp}/steps`, { stage: 'Recruiter Screen', at: '2020-01-01T10:00:00Z', timezone: 'UTC' });
    await tyler.post(`/api/applications/${tylerApp}/steps`, { stage: 'Technical Interview', at: '2030-11-13T10:00:00Z', timezone: 'UTC' });
    await tyler.post(`/api/applications/${tylerApp}/steps`, { stage: 'Final Interview', at: '2031-01-13T10:00:00Z', timezone: 'UTC' });

    const dashboard = (await tyler.get('/api/dashboard')).json;
    expect(dashboard.upcomingInterviews).toBe(2);
    expect(dashboard.nextInterviews[0]).toMatchObject({ stage: 'Technical Interview', company: 'Stripe' });

    const inRange = (await tyler.get(`/api/interviews?from=${encodeURIComponent('2030-11-01T00:00:00Z')}&to=${encodeURIComponent('2030-12-01T00:00:00Z')}`)).json;
    expect(inRange.map((item: any) => item.stage)).toEqual(['Technical Interview']);
    const byStage = (await tyler.get('/api/interviews?stage=Final%20Interview')).json;
    expect(byStage.map((item: any) => item.stage)).toEqual(['Final Interview']);
  });

  it('lists past interviews from the latest back, so a page of them is the most recent', async () => {
    const server = await createTestServer();
    const { tyler, tylerApp } = await jobWithTwoApplicants(server);
    for (const day of ['2020-01-01', '2020-02-01', '2020-03-01']) {
      expect((await tyler.post(`/api/applications/${tylerApp}/steps`, { stage: 'Recruiter Screen', at: `${day}T10:00:00Z`, timezone: 'UTC' })).status).toBe(201);
    }
    const before = encodeURIComponent('2025-01-01T00:00:00Z');
    const days = (items: any[]) => items.map((item) => item.at.slice(0, 10));
    expect(days((await tyler.get(`/api/interviews?to=${before}&order=desc&limit=2`)).json)).toEqual(['2020-03-01', '2020-02-01']);
    expect(days((await tyler.get(`/api/interviews?to=${before}&limit=2`)).json)).toEqual(['2020-01-01', '2020-02-01']);
    expect((await tyler.get('/api/interviews?order=sideways')).status).toBe(400);
  });
});

describe('my applications by applied date', () => {
  it('sort by the date they show: the first time I applied, with several of my profiles', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const tyler = users.tyler;
    const sqlite = server.ctx.handle.sqlite;
    server.http.serve('https://company.com/jobs/1', jobPage({ title: 'Engineer', company: 'Stripe' }));
    server.http.serve('https://other.com/jobs/2', jobPage({ title: 'Designer', company: 'Figma' }));
    const first: any = await tyler.addJob('https://company.com/jobs/1');
    const second: any = await tyler.addJob('https://other.com/jobs/2');
    const backend = (await tyler.post('/api/profiles', { name: 'Backend' })).json as { id: number };
    const again: any = (await tyler.post(`/api/jobs/${first.jobId}/apply`, { profileId: backend.id })).json;
    // Stripe first in January and again in March; Figma in February.
    sqlite.prepare('UPDATE applications SET applied_at = ? WHERE id = ?').run('2026-01-10T10:00:00.000Z', first.applicationId);
    sqlite.prepare('UPDATE applications SET applied_at = ? WHERE id = ?').run('2026-03-10T10:00:00.000Z', again.applicationId);
    sqlite.prepare('UPDATE applications SET applied_at = ? WHERE id = ?').run('2026-02-10T10:00:00.000Z', second.applicationId);
    server.ctx.readCache.invalidate();
    const listed = (await tyler.get('/api/jobs?scope=mine&sort=applied')).json;
    expect(listed.items.map((job: any) => job.company)).toEqual(['Figma', 'Stripe']);
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
    await users.tyler.addStep(stripe.applicationId, 'Technical Interview', '2030-11-13T14:00:00Z');
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

  it('puts company matches first, then title matches, then description and memo matches, each group by applied date', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'tyler');
    const add = async (slug: string, title: string, company: string, description: string, appliedAt: string, memo = '') => {
      server.http.serve(`https://${slug}.com/jobs/1`, jobPage({ title, company, description: `${description} ${'filler words for this particular posting number '.repeat(8)}${slug}` }));
      const added = (await users.tyler.addJob(`https://${slug}.com/jobs/1`, { memo })) as any;
      expect(added.outcome, slug).toBe('created');
      expect((await users.tyler.patch(`/api/applications/${added.applicationId}`, { appliedAt })).status).toBe(200);
    };
    // Applied in this order: the newest first within each group.
    await add('a', 'Data Engineer', 'Atlas Health', 'Pipelines for Snowflake users.', '2026-10-01T10:00:00.000Z');
    await add('b', 'Snowflake Administrator', 'Beacon Retail', 'Run the warehouse.', '2026-10-02T10:00:00.000Z');
    await add('c', 'Platform Engineer', 'Snowflake', 'Build the data cloud.', '2026-10-03T10:00:00.000Z');
    await add('d', 'Analyst', 'Delta Media', 'Dashboards and reports.', '2026-10-04T10:00:00.000Z', 'asked about snowflake');
    await add('e', 'Snowflake Data Engineer', 'Evergreen Labs', 'Streaming work.', '2026-10-05T10:00:00.000Z');
    await add('f', 'Lead', 'Snowflake Partners', 'Consulting.', '2026-10-06T10:00:00.000Z');
    await add('g', 'Engineer', 'Granite', 'We use Snowflake daily.', '2026-10-07T10:00:00.000Z');

    const order = async (q: string, sort = 'applied') => ((await users.tyler.get(`/api/jobs?q=${encodeURIComponent(q)}&sort=${sort}`)).json.items as any[]).map((job) => job.company);
    expect(await order('snowflake')).toEqual(['Snowflake Partners', 'Snowflake', 'Evergreen Labs', 'Beacon Retail', 'Granite', 'Delta Media', 'Atlas Health']);
    // Another order keeps the groups, and sorts inside each.
    expect(await order('snowflake', 'company')).toEqual(['Snowflake', 'Snowflake Partners', 'Beacon Retail', 'Evergreen Labs', 'Atlas Health', 'Delta Media', 'Granite']);
    // Several words: each counts where it is found best, the job by its worst.
    // Snowflake (company) + Engineer (title) is a title match, like Evergreen's title holding both.
    expect(await order('snowflake engineer')).toEqual(['Evergreen Labs', 'Snowflake', 'Granite', 'Atlas Health']);
    // No search: the applied date alone.
    expect(((await users.tyler.get('/api/jobs?scope=mine&sort=applied')).json.items as any[]).map((job) => job.company)[0]).toBe('Granite');
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
    expect(titles(await tyler.get('/api/jobs?company=stripe&stage=Technical%20Interview&q=recruiter'))).toEqual(['Stripe']);
    expect(titles(await tyler.get('/api/jobs?company=stripe&stage=Applied'))).toEqual([]);
    expect(titles(await tyler.get('/api/jobs?company=figma&q=recruiter'))).toEqual([]);
  });

  it('filters by who applied', async () => {
    const { tyler, john } = await catalog();
    expect(titles(await tyler.get('/api/jobs?scope=mine&sort=company'))).toEqual(['Figma', 'Stripe']);
    expect(titles(await tyler.get('/api/jobs?scope=others'))).toEqual(['Notion']);
    expect(titles(await tyler.get('/api/jobs?scope=all&sort=company'))).toEqual(['Figma', 'Notion', 'Stripe']);
    expect(titles(await john.get('/api/jobs?scope=mine'))).toEqual(['Notion']);
  });

  it("matches the stage on anyone's application, unless narrowed to your own", async () => {
    const { tyler, john } = await catalog();
    expect(titles(await john.get('/api/jobs?stage=Technical%20Interview'))).toEqual(['Stripe']);
    expect(titles(await john.get('/api/jobs?stage=Technical%20Interview&scope=mine'))).toEqual([]);
    expect(titles(await tyler.get('/api/jobs?stage=Technical%20Interview&scope=mine'))).toEqual(['Stripe']);
    expect((await tyler.get('/api/jobs?stage=Hiring%20Manager')).status).toBe(400);
  });

  it('filters by the stage each is at now, and by interview dates', async () => {
    const { tyler } = await catalog();
    expect(titles(await tyler.get('/api/jobs?stage=Technical%20Interview'))).toEqual(['Stripe']);
    expect(titles(await tyler.get('/api/jobs?stage=Final%20Interview'))).toEqual([]);
    expect(titles(await tyler.get('/api/jobs?stage=Applied&sort=company'))).toEqual(['Figma', 'Notion']);
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
    expect(titles(await tyler.get('/api/jobs?scope=mine&sort=stage'))).toEqual(['Figma', 'Stripe']);
    expect((await tyler.get('/api/jobs?sort=status')).status).toBe(400);
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
    await tyler.addStep(figma.applicationId, 'Rejected', '2026-10-01T10:00:00Z');
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
    await users.tyler.addStep(added.applicationId, 'Recruiter Screen', '2026-10-01T10:00:00Z', { note: 'first call' });
    await users.tyler.addStep(added.applicationId, 'Offer', '2026-10-20T10:00:00Z');
    await admin.post(`/api/jobs/${added.jobId}/highlight`, { highlighted: true });
    await first.app.close();
    (await import('../src/server/db/client')).closeDatabase(first.ctx.handle);

    const second = await createTestServer({ dataDir });
    const tyler = new ApiClient(second.app);
    await tyler.login('tyler', 'tyler-password');
    const kept = (await tyler.get(`/api/jobs/${added.jobId}`)).json;
    expect(kept).toMatchObject({ title: 'Engineer', isHighlighted: true });
    expect(mine(kept)).toMatchObject({ stage: 'Offer', furthestStage: 'Offer', memo: 'keep me' });
    expect(mine(kept).steps.map((step: any) => [step.stage, step.at, step.note])).toEqual([
      ['Recruiter Screen', '2026-10-01T10:00:00.000Z', 'first call'],
      ['Offer', '2026-10-20T10:00:00.000Z', null]
    ]);
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
    // Each new application is also announced, so others' apps can offer the job to them.
    expect(seen).toEqual(['jobs_changed', 'application_added']);
    await users.john.addJob('https://company.com/jobs/1');
    expect(seen).toEqual(['jobs_changed', 'application_added', 'applications_changed', 'application_added']);
    await users.john.post(`/api/jobs/${first.jobId}/highlight`, { highlighted: true });
    expect(seen).toEqual(['jobs_changed', 'application_added', 'applications_changed', 'application_added', 'jobs_changed']);
  });
});
