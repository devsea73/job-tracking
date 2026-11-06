import { describe, expect, it } from 'vitest';
import type { ActivityPerson, ActivityQuery, ActivityResponse, CreateApplicationResponse } from '../src/shared/api';
import { addDays, autoGroup, isCalendarDate, weekStart } from '../src/shared/calendar';
import { createTestServer, createUsers, jobPage, type ApiClient } from './helpers';

type Created = Extract<CreateApplicationResponse, { outcome: 'created' }>;

/** A week of applying, at known moments, for three people. Today is Thursday 2026-11-05, in UTC. */
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
  return { server, users, apply, query, read };
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
    expect((await read(users.andy, THIS_WEEK)).team).toEqual({ today: 5, yesterday: 1, week: 7, month: 7, inRange: 7, interviews: 2, interviewRate: 28.6 });
  });

  it('puts me first, then everyone else by applications in the range', async () => {
    const { users, read } = await setUp();
    const response = await read(users.mia, TODAY);
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
