import { describe, expect, it } from 'vitest';
import type { ActivityResponse, CreateApplicationResponse, TeamApplicationsResponse } from '../src/shared/api';
import { createTestServer, createUsers, jobPage, type ApiClient } from './helpers';

type Created = Extract<CreateApplicationResponse, { outcome: 'created' }>;

/** Three members applying at known moments. Today is Thursday 2026-11-05. */
async function setUp() {
  const server = await createTestServer();
  const { admin, users } = await createUsers(server.app, 'andy', 'john', 'mia');
  const sqlite = server.ctx.handle.sqlite;
  let n = 0;
  const apply = async (client: ApiClient, appliedAt: string, company = `Company ${n + 1}`) => {
    n += 1;
    server.http.serve(`https://careers.example.com/jobs/${n}`, jobPage({ title: `Engineer ${n}`, company }));
    const added = (await client.addJob(`https://careers.example.com/jobs/${n}`)) as Created;
    sqlite.prepare('UPDATE applications SET applied_at = ? WHERE id = ?').run(appliedAt, added.applicationId);
    return added;
  };
  const andyToday = await apply(users.andy, '2026-11-05T09:10:00.000Z', 'Stripe');
  const andyScreen = await apply(users.andy, '2026-11-05T14:30:00.000Z');
  await apply(users.andy, '2026-10-20T10:00:00.000Z');
  await apply(users.john, '2026-11-05T08:00:00.000Z');
  const johnRejected = await apply(users.john, '2026-11-04T16:00:00.000Z');
  const johnFinal = await apply(users.john, '2026-09-01T10:00:00.000Z');
  // Mia applied to nothing, and is still on the board.

  // Each one's timeline, at the times the steps take place.
  await users.andy.addStep(andyScreen.applicationId, 'Recruiter Screen', '2026-11-06T15:00:00.000Z');
  await users.john.addStep(johnRejected.applicationId, 'Technical Interview', '2026-11-05T10:00:00.000Z');
  await users.john.addStep(johnRejected.applicationId, 'Rejected', '2026-11-05T18:00:00.000Z');
  await users.john.addStep(johnFinal.applicationId, 'Final Interview', '2026-09-20T10:00:00.000Z');
  server.ctx.readCache.invalidate();

  const list = async (client: ApiClient, query: Record<string, string> = {}) => {
    const response = await client.get(`/api/team/applications?${new URLSearchParams(query).toString()}`);
    expect(response.status).toBe(200);
    return response.json as TeamApplicationsResponse;
  };
  return { server, admin, users, list, andyToday, johnRejected };
}

describe('everyone’s applications on the Team page', () => {
  it('lists every member’s applications with the stage each is at, newest first, the administrator among the members', async () => {
    const { admin, users, list } = await setUp();
    const all = await list(users.mia);
    expect(all.range).toBeNull();
    expect(all.total).toBe(6);
    expect(all.items.map((item) => [item.owner.username, item.job.company, item.stage])).toEqual([
      ['andy', 'Company 2', 'Recruiter Screen'],
      ['andy', 'Stripe', 'Applied'],
      ['john', 'Company 4', 'Applied'],
      ['john', 'Company 5', 'Rejected'],
      ['andy', 'Company 3', 'Applied'],
      ['john', 'Company 6', 'Final Interview']
    ]);
    const rejected = all.items.find((item) => item.stage === 'Rejected');
    expect(rejected).toMatchObject({ furthestStage: 'Technical Interview', isMine: false, link: { url: 'https://careers.example.com/jobs/5' } });

    // The board: the viewer first, even with nothing, then by applications. Everyone is on it.
    expect(all.board.map((row) => [row.user.username, row.isMe, row.total])).toEqual([
      ['mia', true, 0],
      ['andy', false, 3],
      ['john', false, 3],
      ['admin', false, 0]
    ]);
    const john = all.board.find((row) => row.user.username === 'john');
    expect(john?.stages).toEqual({ Applied: 1, 'Recruiter Screen': 0, 'Technical Interview': 0, 'Final Interview': 1, Offer: 0, Rejected: 1 });
    // Interviews are counted by how far each timeline got, so the rejected one still had one.
    expect(john).toMatchObject({ interviews: 2, interviewRate: 66.7 });
    expect(all.board.find((row) => row.user.username === 'mia')?.interviewRate).toBeNull();

    // The administrator applies too, and is on the board like anyone, marked as themselves.
    const asAdmin = await list(admin);
    expect(asAdmin.board.map((row) => [row.user.username, row.isMe])).toEqual([
      ['admin', true],
      ['andy', false],
      ['john', false],
      ['mia', false]
    ]);
  });

  it('narrows to a person, a stage or a search, while the board stays the same', async () => {
    const { users, list } = await setUp();
    const andy = (await list(users.mia)).board.find((row) => row.user.username === 'andy');
    const johnId = (await list(users.mia)).board.find((row) => row.user.username === 'john')?.user.id;
    const johns = await list(users.mia, { person: String(johnId) });
    expect(johns.total).toBe(3);
    expect(johns.items.every((item) => item.owner.username === 'john')).toBe(true);
    expect(johns.board.find((row) => row.user.username === 'andy')).toEqual(andy);

    expect((await list(users.mia, { stage: 'Rejected' })).items.map((item) => item.owner.username)).toEqual(['john']);
    expect((await list(users.mia, { stage: 'Recruiter Screen' })).items.map((item) => item.job.company)).toEqual(['Company 2']);
    expect((await list(users.mia, { q: 'stripe' })).items.map((item) => item.job.company)).toEqual(['Stripe']);
    expect((await list(users.mia, { q: 'engineer 6' })).total).toBe(1);
    // Furthest along first.
    expect((await list(users.mia, { sort: 'stage' })).items.slice(0, 3).map((item) => item.stage)).toEqual(['Final Interview', 'Rejected', 'Recruiter Screen']);
    // A page at a time, with the full count.
    const page = await list(users.mia, { limit: '2', offset: '2' });
    expect(page.total).toBe(6);
    expect(page.items.map((item) => item.job.company)).toEqual(['Company 4', 'Company 5']);
  });

  it('counts a range of days in the viewer’s calendar, the same as the leaderboard', async () => {
    const { users, list } = await setUp();
    const today = await list(users.andy, { tz: 'UTC', from: '2026-11-05', to: '2026-11-05' });
    expect(today.range).toEqual({ first: '2026-11-05', last: '2026-11-05' });
    expect(today.total).toBe(3);
    expect(today.board.map((row) => [row.user.username, row.total])).toEqual([
      ['andy', 2],
      ['john', 1],
      ['admin', 0],
      ['mia', 0]
    ]);
    const activity = (await users.andy.get('/api/activity?tz=UTC&today=2026-11-05&from=2026-11-05&to=2026-11-05')).json as ActivityResponse;
    for (const row of today.board) expect(row.total).toBe(activity.people.find((person) => person.user.id === row.user.id)?.inRange);

    // In Tokyo the 5th begins at 15:00 UTC on the 4th, so John's application at 16:00 UTC that day is the 5th's.
    const tokyo = await list(users.andy, { tz: 'Asia/Tokyo', from: '2026-11-05', to: '2026-11-05' });
    expect(tokyo.items.map((item) => item.job.company)).toEqual(['Company 2', 'Stripe', 'Company 4', 'Company 5']);
  });

  it('orders by company or by the latest change, the same rows for everyone, each marked for its viewer', async () => {
    const { users, list, andyToday } = await setUp();
    expect((await list(users.mia, { sort: 'company' })).items.map((item) => item.job.company)).toEqual(['Company 2', 'Company 3', 'Company 4', 'Company 5', 'Company 6', 'Stripe']);
    await users.andy.patch(`/api/applications/${andyToday.applicationId}`, { memo: 'Followed up by email' });
    const asMia = await list(users.mia, { sort: 'updated' });
    expect(asMia.items[0].id).toBe(andyToday.applicationId);
    const asAndy = await list(users.andy, { sort: 'updated' });
    expect(asAndy.items.map((item) => item.id)).toEqual(asMia.items.map((item) => item.id));
    expect(asAndy.items.filter((item) => item.isMine).map((item) => item.owner.username)).toEqual(['andy', 'andy', 'andy']);
    expect(asMia.items.some((item) => item.isMine)).toBe(false);
    expect(asAndy.board.map((row) => [row.user.username, row.isMe])).toEqual([
      ['andy', true],
      ['john', false],
      ['admin', false],
      ['mia', false]
    ]);
    // A page past the end has nothing on it, and the full count to step back with.
    expect(await list(users.mia, { limit: '2', offset: '10' })).toMatchObject({ total: 6, items: [] });
  });

  it('refuses a half-given range, and anyone not signed in', async () => {
    const { server, users } = await setUp();
    expect((await users.andy.get('/api/team/applications?tz=UTC&from=2026-11-05')).status).toBe(400);
    expect((await users.andy.get('/api/team/applications?tz=UTC&from=2026-11-05&to=2026-11-01')).status).toBe(400);
    expect((await users.andy.get('/api/team/applications?stage=Hired')).status).toBe(400);
    expect((await server.app.inject({ method: 'GET', url: '/api/team/applications' })).statusCode).toBe(401);
  });
});
