import { describe, expect, it } from 'vitest';
import type { ActivityPerson, ActivityQuery, ActivityResponse, CreateApplicationResponse } from '../src/shared/api';
import { addDays, autoGroup, isCalendarDate, weekStart } from '../src/shared/calendar';
import { ReadCache } from '../src/server/read-cache';
import { getActivity } from '../src/server/services/activity';
import { createTestServer, createUsers, jobPage, type ApiClient } from './helpers';

type Created = Extract<CreateApplicationResponse, { outcome: 'created' }>;

/** A week of applying, at known moments, for three people. Today is Thursday 2026-11-05, in UTC. */
async function setUp() {
  const server = await createTestServer();
  const { admin, users } = await createUsers(server.app, 'andy', 'john', 'mia');
  const sqlite = server.ctx.handle.sqlite;
  let n = 0;
  const apply = async (client: ApiClient, appliedAt: string, profileId?: number) => {
    n += 1;
    server.http.serve(`https://careers.example.com/jobs/${n}`, jobPage({ title: `Engineer ${n}`, company: `Company ${n}` }));
    const added = (await client.addJob(`https://careers.example.com/jobs/${n}`, profileId ? { profileId } : {})) as Created;
    sqlite.prepare('UPDATE applications SET applied_at = ? WHERE id = ?').run(appliedAt, added.applicationId);
    return added;
  };
  // Andy: two today, one on Monday, one last month.
  await apply(users.andy, '2026-11-05T09:10:00.000Z');
  const screened = await apply(users.andy, '2026-11-05T14:30:00.000Z');
  await apply(users.andy, '2026-11-02T10:00:00.000Z');
  await apply(users.andy, '2026-10-20T10:00:00.000Z');
  // John: three today, one with an interview booked, and one yesterday.
  await apply(users.john, '2026-11-05T08:00:00.000Z');
  await apply(users.john, '2026-11-05T08:20:00.000Z');
  const booked = await apply(users.john, '2026-11-05T13:00:00.000Z');
  await apply(users.john, '2026-11-04T16:00:00.000Z');
  // Mia: nothing this week.
  await apply(users.mia, '2026-10-01T10:00:00.000Z');

  await users.andy.patch(`/api/applications/${screened.applicationId}`, { status: 'Recruiter Screen' });
  await users.john.post(`/api/applications/${booked.applicationId}/interviews`, { stage: 'Recruiter Screen', scheduledAt: '2026-11-10T15:00:00.000Z', timezone: 'UTC' });

  const query = (client: ApiClient, wanted: Partial<ActivityQuery> & Pick<ActivityQuery, 'from' | 'to'>) => {
    const params = new URLSearchParams({ tz: 'UTC', today: '2026-11-05', ...wanted } as Record<string, string>);
    return client.get(`/api/activity?${params.toString()}`);
  };
  const read = async (client: ApiClient, wanted: Partial<ActivityQuery> & Pick<ActivityQuery, 'from' | 'to'>) => {
    const response = await query(client, wanted);
    expect(response.status).toBe(200);
    return response.json as ActivityResponse;
  };
  return { server, admin, users, apply, query, read };
}

const THIS_WEEK = { from: '2026-11-02', to: '2026-11-08' };
const TODAY = { from: '2026-11-05', to: '2026-11-05' };
const byName = (response: ActivityResponse): Record<string, ActivityPerson> => Object.fromEntries(response.people.map((person) => [person.user.username, person]));

describe('calendar days', () => {
  it('know real dates, Mondays and the default grouping', () => {
    expect(isCalendarDate('2026-11-05')).toBe(true);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('2026-1-5')).toBe(false);
    expect(weekStart('2026-11-05')).toBe('2026-11-02');
    expect(weekStart('2026-11-08')).toBe('2026-11-02');
    expect(weekStart('2026-11-09')).toBe('2026-11-09');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect([autoGroup('2026-11-05', '2026-11-05'), autoGroup('2026-11-01', '2026-11-30'), autoGroup('2026-08-01', '2026-11-30'), autoGroup('2026-01-01', '2026-12-31')]).toEqual(['hour', 'day', 'week', 'month']);
  });
});

describe('applying activity', () => {
  it('counts today, yesterday, this week, this month and the range for each person', async () => {
    const { users, read } = await setUp();
    const people = byName(await read(users.andy, THIS_WEEK));
    expect(people.andy).toMatchObject({ isMe: true, today: 2, yesterday: 0, week: 3, month: 3, inRange: 3, allTime: 4 });
    expect(people.john).toMatchObject({ isMe: false, today: 3, yesterday: 1, week: 4, month: 4, inRange: 4 });
    expect(people.mia).toMatchObject({ today: 0, week: 0, month: 0, inRange: 0, allTime: 1 });
  });

  it('says which days each number covers', async () => {
    const { users, read } = await setUp();
    expect((await read(users.andy, THIS_WEEK)).periods).toEqual({
      today: { first: '2026-11-05', last: '2026-11-05' },
      yesterday: { first: '2026-11-04', last: '2026-11-04' },
      week: { first: '2026-11-02', last: '2026-11-08' },
      month: { first: '2026-11-01', last: '2026-11-30' },
      range: { first: '2026-11-02', last: '2026-11-08' }
    });
  });

  it('never counts an application dated after today as today’s', async () => {
    const { users, apply, read } = await setUp();
    await apply(users.mia, '2026-11-06T09:00:00.000Z');
    const mia = byName(await read(users.andy, TODAY)).mia;
    expect(mia).toMatchObject({ today: 0, week: 1, inRange: 0 });
  });

  it('counts an interview as received when it reached a screen or has one booked', async () => {
    const { users, read } = await setUp();
    const people = byName(await read(users.andy, THIS_WEEK));
    expect(people.andy).toMatchObject({ interviews: 1, interviewRate: 33.3, allTimeInterviews: 1, allTimeInterviewRate: 25 });
    expect(people.john).toMatchObject({ interviews: 1, interviewRate: 25 });
    // Nothing applied: no rate at all, rather than 0%.
    expect(people.mia).toMatchObject({ interviews: 0, interviewRate: null, allTimeInterviewRate: 0 });
  });

  it('adds the team together from the people listed', async () => {
    const { users, read } = await setUp();
    expect((await read(users.andy, THIS_WEEK)).team).toEqual({
      today: 5,
      yesterday: 1,
      week: 7,
      month: 7,
      inRange: 7,
      interviews: 2,
      interviewRate: 28.6,
      reached: { screen: 1, technical: 0, final: 0, offer: 0, rejected: 0 },
      scheduled: 0,
      scheduledToday: 0
    });
  });

  it('follows the range’s applications through the stages, at their furthest stage', async () => {
    const { users, read } = await setUp();
    const andy = byName(await read(users.andy, THIS_WEEK)).andy;
    const applied = (await users.andy.get('/api/jobs?scope=mine&sort=applied')).json as { items: Array<{ applications: Array<{ id: number; isMine: boolean; appliedAt: string }> }> };
    const monday = applied.items.flatMap((job) => job.applications).find((application) => application.isMine && application.appliedAt.startsWith('2026-11-02'));
    // Straight to Technical Interview, then turned down: it still reached the screen and the technical.
    await users.andy.patch(`/api/applications/${monday?.id}`, { status: 'Technical Interview' });
    await users.andy.patch(`/api/applications/${monday?.id}`, { status: 'Rejected' });
    const after = byName(await read(users.andy, THIS_WEEK)).andy;
    expect(andy.reached).toEqual({ screen: 1, technical: 0, final: 0, offer: 0, rejected: 0 });
    expect(after.reached).toEqual({ screen: 2, technical: 1, final: 0, offer: 0, rejected: 1 });
  });

  it('counts interviews by the day they take place', async () => {
    const { users, read } = await setUp();
    // John's screen is booked for Tuesday 10 November, 15:00 UTC.
    const nextWeek = await read(users.andy, { from: '2026-11-09', to: '2026-11-15' });
    const john = byName(nextWeek).john;
    expect(john).toMatchObject({ scheduled: 1, scheduledToday: 0, inRange: 0 });
    expect(nextWeek.team.scheduled).toBe(1);
    // Asked on the day itself, it is today's interview.
    expect(byName(await read(users.andy, { from: '2026-11-10', to: '2026-11-10', today: '2026-11-10' })).john).toMatchObject({ scheduled: 1, scheduledToday: 1 });
  });

  it('splits each person by profile, and their numbers add up to the person’s', async () => {
    const { users, apply, read } = await setUp();
    const created = (await users.andy.post('/api/profiles', { name: 'Backend' })).json as { id: number };
    await apply(users.andy, '2026-11-05T11:00:00.000Z', created.id);
    await apply(users.andy, '2026-11-03T11:00:00.000Z', created.id);
    const andy = byName(await read(users.andy, THIS_WEEK)).andy;
    expect(andy.profiles.map((profile) => [profile.name, profile.inRange, profile.today, profile.allTime])).toEqual([
      [andy.profiles[0].name, 3, 2, 4],
      ['Backend', 2, 1, 2]
    ]);
    expect(andy.profiles[1].series).toEqual([0, 1, 0, 1, 0, 0, 0]);
    expect(andy.profiles.reduce((total, profile) => total + profile.inRange, 0)).toBe(andy.inRange);
    andy.series.forEach((value, index) => expect(andy.profiles.reduce((total, profile) => total + profile.series[index], 0)).toBe(value));
  });

  it('gives only my own numbers when asked for me alone', async () => {
    const { users, read } = await setUp();
    const mine = await read(users.john, { ...THIS_WEEK, scope: 'me' });
    expect(mine.people.map((person) => person.user.username)).toEqual(['john']);
    expect(mine.team).toMatchObject({ today: 3, inRange: 4, interviews: 1 });
  });

  it('puts me first, then everyone else by applications in the range', async () => {
    const { users, read } = await setUp();
    const response = await read(users.mia, TODAY);
    expect(response.people.map((person) => person.user.username)).toEqual(['mia', 'john', 'andy']);
    expect(response.people.map((person) => [person.rank, person.behindLeader])).toEqual([
      [3, 3],
      [1, 0],
      [2, 1]
    ]);
  });

  it('lists every member, switched off or idle, and never the administrator', async () => {
    const { admin, users, read } = await setUp();
    const zoe = (await admin.post('/api/admin/users', { username: 'zoe', password: 'zoe-password' })).json as { id: number };
    await admin.patch(`/api/admin/users/${zoe?.id}`, { isActive: false });
    const team = await read(users.andy, THIS_WEEK);
    expect(team.people.map((person) => person.user.username).sort()).toEqual(['andy', 'john', 'mia', 'zoe']);
    expect(byName(team).zoe).toMatchObject({ isActive: false, inRange: 0 });
    // The administrator's own dashboard still has its own numbers.
    const own = (await admin.get('/api/activity?tz=UTC&today=2026-11-05&from=2026-11-02&to=2026-11-08&scope=me')).json as ActivityResponse;
    expect(own.people.map((person) => person.user.username)).toEqual(['admin']);
    expect(own.people[0].isMe).toBe(true);
  });

  it('gives one day by the hour, and a longer range by the day', async () => {
    const { users, read } = await setUp();
    const hours = await read(users.andy, TODAY);
    expect(hours.group).toBe('hour');
    expect(hours.buckets).toHaveLength(24);
    expect(hours.buckets[8]).toEqual({ key: '2026-11-05T08', first: '2026-11-05', last: '2026-11-05' });
    const john = byName(hours).john;
    expect(john.series[8]).toBe(2);
    expect(john.series[13]).toBe(1);
    const days = await read(users.andy, THIS_WEEK);
    expect(days.group).toBe('day');
    expect(days.buckets.map((bucket) => bucket.key)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    expect(byName(days).andy.series).toEqual([1, 0, 0, 2, 0, 0, 0]);
  });

  it('groups by week and by month, cutting the first and last to the range', async () => {
    const { users, read } = await setUp();
    const weeks = await read(users.andy, { from: '2026-10-28', to: '2026-11-10', group: 'week' });
    expect(weeks.buckets).toEqual([
      { key: '2026-10-26', first: '2026-10-28', last: '2026-11-01' },
      { key: '2026-11-02', first: '2026-11-02', last: '2026-11-08' },
      { key: '2026-11-09', first: '2026-11-09', last: '2026-11-10' }
    ]);
    expect(byName(weeks).andy.series).toEqual([0, 3, 0]);
    const months = await read(users.andy, { from: '2026-10-15', to: '2026-11-05', group: 'month' });
    expect(months.buckets).toEqual([
      { key: '2026-10', first: '2026-10-15', last: '2026-10-31' },
      { key: '2026-11', first: '2026-11-01', last: '2026-11-05' }
    ]);
    expect(byName(months).andy.series).toEqual([1, 3]);
    // Every application in the range lands in exactly one bucket.
    for (const person of months.people) expect(person.series.reduce((a, b) => a + b, 0)).toBe(person.inRange);
  });

  it('places applications in the viewer’s own hours and days', async () => {
    const { users, read } = await setUp();
    // Athens is UTC+2 in November: its 5 November runs from 4 November 22:00 UTC.
    const athens = await read(users.andy, { ...TODAY, tz: 'Europe/Athens' });
    const andy = byName(athens).andy;
    // 09:10 UTC is 11:10 there, 14:30 UTC is 16:30.
    expect(andy.series[11]).toBe(1);
    expect(andy.series[16]).toBe(1);
    // John's 16:00 UTC on the 4th is 18:00 there: still the 4th, so yesterday.
    expect(byName(athens).john).toMatchObject({ today: 3, yesterday: 1 });
  });

  it('gets daylight saving time right: the day the clocks go back has 25 hours', async () => {
    const { users, apply, read } = await setUp();
    // Chicago goes from UTC-5 to UTC-6 at 2:00 on Sunday 1 November 2026.
    await apply(users.mia, '2026-11-01T04:30:00.000Z'); // 23:30 on 31 October
    await apply(users.mia, '2026-11-01T06:30:00.000Z'); // 01:30, the first time
    await apply(users.mia, '2026-11-01T07:30:00.000Z'); // 01:30, the second time
    await apply(users.mia, '2026-11-02T05:30:00.000Z'); // 23:30 on 1 November, at UTC-6 now
    const days = await read(users.andy, { from: '2026-10-31', to: '2026-11-02', tz: 'America/Chicago', today: '2026-11-02' });
    expect(byName(days).mia.series).toEqual([1, 3, 0]);
    const hours = await read(users.andy, { from: '2026-11-01', to: '2026-11-01', tz: 'America/Chicago', today: '2026-11-02' });
    const mia = byName(hours).mia;
    expect(mia.series[1]).toBe(2);
    expect(mia.series[23]).toBe(1);
    expect(mia.yesterday).toBe(3);
  });

  it('refuses days the counting cannot work with, instead of failing on them', async () => {
    const { users, query } = await setUp();
    // The day after 9999-12-31 has no four-digit year.
    expect((await query(users.andy, { from: '9999-12-01', to: '9999-12-31' })).status).toBe(400);
    expect((await query(users.andy, { ...THIS_WEEK, today: '9999-12-31' })).status).toBe(400);
    expect((await query(users.andy, { from: '0999-01-01', to: '0999-01-31' })).status).toBe(400);
    expect((await users.andy.get('/api/team/applications?tz=UTC&from=9999-12-01&to=9999-12-31')).status).toBe(400);
    expect((await query(users.andy, { from: '9998-12-01', to: '9998-12-31', today: '9998-12-31' })).status).toBe(200);
  });

  it('works the numbers out once for everyone who looks, and again after a change', async () => {
    const { server, users, apply } = await setUp();
    const sqlite = server.ctx.handle.sqlite;
    const idOf = async (client: ApiClient) => ((await client.get('/api/auth/me')).json as { id: number }).id;
    const [andy, john, mia] = [await idOf(users.andy), await idOf(users.john), await idOf(users.mia)];
    const shared = new ReadCache();
    const query: ActivityQuery = { tz: 'UTC', today: '2026-11-05', ...THIS_WEEK };
    const asAndy = getActivity(sqlite, andy, query, shared);
    const asMia = getActivity(sqlite, mia, query, shared);
    // The same answers as when each is worked out alone, each with its own viewer first.
    expect(asAndy).toEqual(getActivity(sqlite, andy, query));
    expect(asMia).toEqual(getActivity(sqlite, mia, query));
    expect(asMia.people.map((person) => [person.user.username, person.isMe])).toEqual([
      ['mia', true],
      ['john', false],
      ['andy', false]
    ]);
    // John's numbers were counted once, for both of them, and for his own dashboard.
    const johnAsSeen = asAndy.people.find((person) => person.user.id === john);
    expect(asMia.people.find((person) => person.user.id === john)).toBe(johnAsSeen);
    const own = getActivity(sqlite, john, { ...query, scope: 'me' }, shared);
    expect(own).toEqual(getActivity(sqlite, john, { ...query, scope: 'me' }));
    expect(own.people[0].trends).toBe(johnAsSeen?.trends);
    expect(own.people[0]).toMatchObject({ isMe: true, rank: 1, behindLeader: 0 });
    // With nobody's counted yet, his own applications alone give the same.
    expect(getActivity(sqlite, john, { ...query, scope: 'me' }, new ReadCache())).toEqual(own);
    expect(getActivity(sqlite, andy, { ...query, scope: 'me' }, new ReadCache())).toEqual(getActivity(sqlite, andy, { ...query, scope: 'me' }, shared));

    // Kept until something changes.
    await apply(users.mia, '2026-11-05T12:00:00.000Z');
    expect(byName(getActivity(sqlite, andy, query, shared)).mia.today).toBe(0);
    shared.invalidate();
    expect(byName(getActivity(sqlite, andy, query, shared)).mia.today).toBe(1);
  });

  it('refuses a range that is backwards or too long, hours over several days, an unknown time zone, and needs a signed-in person', async () => {
    const { users, query } = await setUp();
    expect((await query(users.andy, { from: '2026-11-06', to: '2026-11-05' })).status).toBe(400);
    expect((await query(users.andy, { from: '2024-01-01', to: '2026-11-05' })).status).toBe(400);
    expect((await query(users.andy, { ...THIS_WEEK, group: 'hour' })).status).toBe(400);
    expect((await query(users.andy, { ...TODAY, tz: 'Mars/Olympus' })).status).toBe(400);
    expect((await query(users.andy, { from: '2026-02-30', to: '2026-03-01' })).status).toBe(400);
    const server = await createTestServer();
    expect((await server.app.inject({ method: 'GET', url: '/api/activity?tz=UTC&today=2026-11-05&from=2026-11-05&to=2026-11-05' })).statusCode).toBe(401);
  });
});
