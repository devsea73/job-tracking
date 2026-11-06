import { describe, expect, it } from 'vitest';
import type { ActivityResponse, CreateApplicationResponse } from '../src/shared/api';
import { createTestServer, createUsers, jobPage, type ApiClient } from './helpers';

type Created = Extract<CreateApplicationResponse, { outcome: 'created' }>;

/** A week of applying, at known moments, for three people. "Now" is Thursday 2026-11-05 15:00 UTC. */
async function setUp() {
  const server = await createTestServer();
  const { users } = await createUsers(server.app, 'andy', 'john', 'mia');
  const sqlite = server.ctx.handle.sqlite;
  let n = 0;
  const apply = async (client: ApiClient, appliedAt: string) => {
    n += 1;
    server.http.serve(`https://careers.example.com/jobs/${n}`, jobPage({ title: `Engineer ${n}`, company: `Company ${n}` }));
    const added = (await client.addJob(`https://careers.example.com/jobs/${n}`)) as Created;
    sqlite.prepare('UPDATE applications SET applied_at = ? WHERE id = ?').run(appliedAt, added.applicationId);
    return added;
  };
  // Andy: two today, one on Monday, one last month.
  await apply(users.andy, '2026-11-05T09:10:00.000Z');
  const screened = await apply(users.andy, '2026-11-05T14:30:00.000Z');
  await apply(users.andy, '2026-11-02T10:00:00.000Z');
  await apply(users.andy, '2026-10-20T10:00:00.000Z');
  // John: three today, one with an interview scheduled.
  await apply(users.john, '2026-11-05T08:00:00.000Z');
  await apply(users.john, '2026-11-05T08:20:00.000Z');
  const booked = await apply(users.john, '2026-11-05T13:00:00.000Z');
  // Mia: nothing this week.
  await apply(users.mia, '2026-10-01T10:00:00.000Z');

  await users.andy.patch(`/api/applications/${screened.applicationId}`, { status: 'Recruiter Screen' });
  await users.john.post(`/api/applications/${booked.applicationId}/interviews`, { stage: 'Recruiter Screen', scheduledAt: '2026-11-10T15:00:00.000Z', timezone: 'UTC' });

  const today = { from: '2026-11-05T00:00:00.000Z', to: '2026-11-06T00:00:00.000Z' };
  const week = { from: '2026-11-02T00:00:00.000Z', to: '2026-11-09T00:00:00.000Z' };
  const query = (client: ApiClient, range: { from: string; to: string }, offset = 0) =>
    client.get(`/api/activity?from=${range.from}&to=${range.to}&day=${today.from}&week=${week.from}&month=2026-11-01T00:00:00.000Z&offset=${offset}`);
  return { users, query, today, week };
}

describe('applying activity', () => {
  it('counts today, this week and this month, and the range, for each person', async () => {
    const { users, query, week } = await setUp();
    const response = (await query(users.andy, week)).json as ActivityResponse;
    const byName = Object.fromEntries(response.people.map((person) => [person.user.username, person]));
    expect(byName.andy).toMatchObject({ isMe: true, today: 2, week: 3, month: 3, inRange: 3, allTime: 4 });
    expect(byName.john).toMatchObject({ isMe: false, today: 3, week: 3, month: 3, inRange: 3 });
    expect(byName.mia).toMatchObject({ today: 0, week: 0, month: 0, inRange: 0, allTime: 1 });
  });

  it('counts an interview as received when it reached a screen or has one booked', async () => {
    const { users, query, week } = await setUp();
    const response = (await query(users.andy, week)).json as ActivityResponse;
    const byName = Object.fromEntries(response.people.map((person) => [person.user.username, person]));
    expect(byName.andy).toMatchObject({ interviews: 1, interviewRate: 33.3 });
    expect(byName.john).toMatchObject({ interviews: 1, interviewRate: 33.3 });
    expect(byName.mia).toMatchObject({ interviews: 0, interviewRate: null });
  });

  it('puts me first, then everyone else by applications in the range', async () => {
    const { users, query, today } = await setUp();
    const response = (await query(users.mia, today)).json as ActivityResponse;
    expect(response.people.map((person) => person.user.username)).toEqual(['mia', 'john', 'andy', 'admin']);
    // Mia and admin both applied to nothing today: the tie goes by name.
    expect(response.people.map((person) => [person.rank, person.behindLeader])).toEqual([
      [4, 3],
      [1, 0],
      [2, 1],
      [3, 3]
    ]);
  });

  it('gives one day by the hour, and a longer range by the day', async () => {
    const { users, query, today, week } = await setUp();
    const hours = (await query(users.andy, today)).json as ActivityResponse;
    expect(hours.unit).toBe('hour');
    expect(hours.buckets).toHaveLength(24);
    const john = hours.people.find((person) => person.user.username === 'john');
    expect(john?.series[8]).toBe(2);
    expect(john?.series[13]).toBe(1);
    const days = (await query(users.andy, week)).json as ActivityResponse;
    expect(days.unit).toBe('day');
    expect(days.buckets).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    expect(days.people.find((person) => person.isMe)?.series).toEqual([1, 0, 0, 2, 0, 0, 0]);
  });

  it('places applications in the viewer’s own hours', async () => {
    const { users, query } = await setUp();
    // UTC+2: the viewer's 5 November runs from 4 November 22:00 UTC.
    const local = (await query(users.andy, { from: '2026-11-04T22:00:00.000Z', to: '2026-11-05T22:00:00.000Z' }, 120)).json as ActivityResponse;
    expect(local.buckets[0]).toBe('2026-11-05T00');
    const andy = local.people.find((person) => person.isMe);
    // 09:10 UTC is 11:10 there, 14:30 UTC is 16:30.
    expect(andy?.series[11]).toBe(1);
    expect(andy?.series[16]).toBe(1);
  });

  it('refuses a range that is backwards or too long, and needs a signed-in person', async () => {
    const { users, query } = await setUp();
    expect((await query(users.andy, { from: '2026-11-06T00:00:00.000Z', to: '2026-11-05T00:00:00.000Z' })).status).toBe(400);
    expect((await query(users.andy, { from: '2024-01-01T00:00:00.000Z', to: '2026-11-05T00:00:00.000Z' })).status).toBe(400);
    const server = await createTestServer();
    expect((await server.app.inject({ method: 'GET', url: '/api/activity?from=2026-11-05T00:00:00.000Z&to=2026-11-06T00:00:00.000Z&day=2026-11-05T00:00:00.000Z&week=2026-11-02T00:00:00.000Z&month=2026-11-01T00:00:00.000Z&offset=0' })).statusCode).toBe(401);
  });
});
