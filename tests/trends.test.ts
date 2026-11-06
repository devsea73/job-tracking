import { describe, expect, it } from 'vitest';
import type { ActivityPerson, ActivityResponse, CreateApplicationResponse } from '../src/shared/api';
import { mergeJobs } from '../src/server/services/job-merge';
import { comparedRanges, previousBuckets, previousRange, reachTimes } from '../src/server/services/trends';
import { createTestServer, createUsers, jobPage, type ApiClient } from './helpers';

type Created = Extract<CreateApplicationResponse, { outcome: 'created' }>;

describe('when an application reached each stage', () => {
  it('reads the statuses in the order they were set', () => {
    // Straight to Technical: the interview stage was passed on the way, at the same moment.
    expect(reachTimes([{ status: 'Applied', at: 1 }, { status: 'Technical Interview', at: 5 }], 2, null)).toEqual([5, 5, null, null]);
    // A rejection keeps what was reached.
    expect(reachTimes([{ status: 'Applied', at: 1 }, { status: 'Final Interview', at: 3 }, { status: 'Rejected', at: 9 }], 3, null)).toEqual([3, 3, 3, null]);
  });

  it('treats a move back as a correction: the stage counts from when it is set again', () => {
    const misclick = [
      { status: 'Applied', at: 1 },
      { status: 'Technical Interview', at: 2 },
      { status: 'Applied', at: 3 },
      { status: 'Technical Interview', at: 8 }
    ];
    expect(reachTimes(misclick, 2, null)).toEqual([8, 8, null, null]);
    // Corrected and never set again: never reached.
    expect(reachTimes(misclick.slice(0, 3), 0, null)).toEqual([null, null, null, null]);
  });

  it('counts an interview as got on the day one was booked, if that came first', () => {
    expect(reachTimes([], 0, 4)).toEqual([4, null, null, null]);
    expect(reachTimes([{ status: 'Recruiter Screen', at: 7 }], 1, 4)).toEqual([4, null, null, null]);
    expect(reachTimes([{ status: 'Recruiter Screen', at: 3 }], 1, 4)).toEqual([3, null, null, null]);
  });

  it('lets the stored furthest stage have the last word, as after two applications are merged', () => {
    const merged = [
      { status: 'Applied', at: 1 },
      { status: 'Final Interview', at: 2 },
      { status: 'Applied', at: 3 }
    ];
    expect(reachTimes(merged, 3, null)).toEqual([2, 2, 2, null]);
  });

  it('reads two merged applications as two runs of statuses, so each stage keeps the first day it was reached', () => {
    // Technical on day 2; the copy merged in was applied to on day 50 and got a screen on day 60.
    const merged = [
      { status: 'Applied', at: 1, old: null },
      { status: 'Technical Interview', at: 2, old: 'Applied' },
      { status: 'Applied', at: 50, old: null },
      { status: 'Recruiter Screen', at: 60, old: 'Applied' }
    ];
    expect(reachTimes(merged, 2, null)).toEqual([2, 2, null, null]);
    // Mixed together by when each was set: a status carries on the run it moved from.
    const mixed = [
      { status: 'Applied', at: 1, old: null },
      { status: 'Applied', at: 2, old: null },
      { status: 'Recruiter Screen', at: 3, old: 'Applied' },
      { status: 'Technical Interview', at: 4, old: 'Applied' }
    ];
    expect(reachTimes(mixed, 2, null)).toEqual([3, 4, null, null]);
    // Within one run, a move back is still a correction.
    const corrected = [
      { status: 'Applied', at: 1, old: null },
      { status: 'Technical Interview', at: 2, old: 'Applied' },
      { status: 'Applied', at: 3, old: 'Technical Interview' },
      { status: 'Technical Interview', at: 8, old: 'Applied' }
    ];
    expect(reachTimes(corrected, 2, null)).toEqual([8, 8, null, null]);
  });
});

describe('two copies of a job merged into one', () => {
  it('keep the days the application’s stages were reached', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'john');
    const sqlite = server.ctx.handle.sqlite;
    const add = async (n: number, appliedAt: string) => {
      server.http.serve(`https://careers.example.com/jobs/${n}`, jobPage({ title: `Engineer ${n}`, company: `Company ${n}` }));
      const added = (await users.john.addJob(`https://careers.example.com/jobs/${n}`)) as Created;
      sqlite.prepare('UPDATE applications SET applied_at = ? WHERE id = ?').run(appliedAt, added.applicationId);
      sqlite.prepare('UPDATE application_status_history SET changed_at = ? WHERE application_id = ?').run(appliedAt, added.applicationId);
      return added;
    };
    const move = async (id: number, status: string, at: string) => {
      expect((await users.john.patch(`/api/applications/${id}`, { status })).status).toBe(200);
      sqlite.prepare('UPDATE application_status_history SET changed_at = ? WHERE id = (SELECT MAX(id) FROM application_status_history WHERE application_id = ?)').run(at, id);
    };
    const read = async () => {
      server.ctx.readCache.invalidate();
      const response = await users.john.get('/api/activity?tz=UTC&today=2026-11-05&from=2026-11-02&to=2026-11-08');
      return byName(response.json as ActivityResponse).john;
    };
    // Technical Interview on Tuesday last week with one copy; the other, added this week, got a screen on Wednesday.
    const first = await add(1, '2026-10-26T10:00:00.000Z');
    await move(first.applicationId, 'Technical Interview', '2026-10-27T10:00:00.000Z');
    const second = await add(2, '2026-11-03T10:00:00.000Z');
    await move(second.applicationId, 'Recruiter Screen', '2026-11-04T10:00:00.000Z');
    expect((await read()).trends.interviews).toEqual([0, 0, 1, 0, 0, 0, 0]);

    sqlite.transaction(() => mergeJobs(sqlite, first.jobId, second.jobId))();
    // One application now, which got its interview, and Technical, last Tuesday: nothing new this week.
    const after = await read();
    expect(after.trends.interviews).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(after.trends.technical).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(after.previousTrends.interviews).toEqual([0, 1, 0, 0, 0, 0, 0]);
    expect(after.previousTrends.technical).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });
});

describe('the period before, bucket for bucket', () => {
  it('moves weeks back to the same place, so the first week is set against the same days', () => {
    // The last 30 days from Wednesday 7 October: the period before starts on a Monday, 7 September.
    const range = { first: '2026-10-07', last: '2026-11-05' };
    expect(previousBuckets('week', range, previousRange(range)).map((bucket) => [bucket.first, bucket.last])).toEqual([
      ['2026-09-07', '2026-09-11'],
      ['2026-09-12', '2026-09-18'],
      ['2026-09-19', '2026-09-25'],
      ['2026-09-26', '2026-10-02'],
      ['2026-10-03', '2026-10-06']
    ]);
    // November against October: the same days of each month, the last week running to the 31st.
    const november = { first: '2026-11-01', last: '2026-11-30' };
    expect(previousBuckets('week', november, previousRange(november)).map((bucket) => [bucket.first, bucket.last])).toEqual([
      ['2026-10-01', '2026-10-01'],
      ['2026-10-02', '2026-10-08'],
      ['2026-10-09', '2026-10-15'],
      ['2026-10-16', '2026-10-22'],
      ['2026-10-23', '2026-10-29'],
      ['2026-10-30', '2026-10-31']
    ]);
    // March against the shorter February: the week that would start after it ends is left out.
    const march = { first: '2026-03-01', last: '2026-03-31' };
    expect(previousBuckets('week', march, previousRange(march)).map((bucket) => [bucket.first, bucket.last])).toEqual([
      ['2026-02-01', '2026-02-01'],
      ['2026-02-02', '2026-02-08'],
      ['2026-02-09', '2026-02-15'],
      ['2026-02-16', '2026-02-22'],
      ['2026-02-23', '2026-02-28']
    ]);
  });

  it('keeps the period’s own hours, days and calendar months, which line up already', () => {
    const year = { first: '2026-01-01', last: '2026-12-31' };
    expect(previousBuckets('month', year, previousRange(year)).map((bucket) => bucket.key)).toEqual(Array.from({ length: 12 }, (_, month) => `2025-${String(month + 1).padStart(2, '0')}`));
    const month = { first: '2026-11-01', last: '2026-11-30' };
    expect(previousBuckets('day', month, previousRange(month))).toHaveLength(31);
    // As many days before, months are moved back too.
    const days = { first: '2026-08-06', last: '2026-11-05' };
    expect(previousBuckets('month', days, previousRange(days)).map((bucket) => [bucket.first, bucket.last])).toEqual([
      ['2026-05-06', '2026-05-31'],
      ['2026-06-01', '2026-06-30'],
      ['2026-07-01', '2026-07-31'],
      ['2026-08-01', '2026-08-05']
    ]);
  });

  it('counts the period before in the moved buckets', async () => {
    const { users, read } = await setUp();
    const weeks = await read(users.andy, { from: '2026-11-01', to: '2026-11-30', group: 'week' });
    expect(weeks.previous.buckets.map((bucket) => bucket.first)).toEqual(['2026-10-01', '2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30']);
    // Andy applied on 20 and 28 October, and got a screen on the 27th.
    expect(byName(weeks).andy.previousTrends).toMatchObject({ bids: [0, 0, 0, 1, 1, 0], interviews: [0, 0, 0, 0, 1, 0] });
  });
});

describe('the period a range is compared with', () => {
  it('is the month or year before a whole month or year, otherwise as many days just before', () => {
    expect(previousRange({ first: '2026-11-01', last: '2026-11-30' })).toEqual({ first: '2026-10-01', last: '2026-10-31' });
    expect(previousRange({ first: '2026-03-01', last: '2026-03-31' })).toEqual({ first: '2026-02-01', last: '2026-02-28' });
    expect(previousRange({ first: '2026-01-01', last: '2026-12-31' })).toEqual({ first: '2025-01-01', last: '2025-12-31' });
    expect(previousRange({ first: '2026-11-02', last: '2026-11-08' })).toEqual({ first: '2026-10-26', last: '2026-11-01' });
    expect(previousRange({ first: '2026-11-05', last: '2026-11-05' })).toEqual({ first: '2026-11-04', last: '2026-11-04' });
    expect(previousRange({ first: '2026-10-07', last: '2026-11-05' })).toEqual({ first: '2026-09-07', last: '2026-10-06' });
  });

  it('compares as much of it as has passed of the range', () => {
    expect(comparedRanges({ first: '2026-11-01', last: '2026-11-30' }, { first: '2026-10-01', last: '2026-10-31' }, '2026-11-05')).toEqual({
      current: { first: '2026-11-01', last: '2026-11-05' },
      previous: { first: '2026-10-01', last: '2026-10-05' }
    });
    // A longer month against a shorter one stops at the shorter one's end.
    expect(comparedRanges({ first: '2026-10-01', last: '2026-10-31' }, { first: '2026-09-01', last: '2026-09-30' }, '2026-11-05')).toEqual({
      current: { first: '2026-10-01', last: '2026-10-31' },
      previous: { first: '2026-09-01', last: '2026-09-30' }
    });
    expect(comparedRanges({ first: '2026-11-09', last: '2026-11-15' }, { first: '2026-11-02', last: '2026-11-08' }, '2026-11-05')).toBeNull();
  });
});

/**
 * Three members over two weeks. Today is Thursday 5 November 2026, in UTC; this week runs from
 * Monday 2 November, the one before from Monday 26 October.
 */
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
    sqlite.prepare('UPDATE application_status_history SET changed_at = ? WHERE application_id = ?').run(appliedAt, added.applicationId);
    return added.applicationId;
  };
  /** Sets a status as if on the given moment. */
  const move = async (client: ApiClient, id: number, status: string, at: string) => {
    expect((await client.patch(`/api/applications/${id}`, { status })).status).toBe(200);
    sqlite.prepare('UPDATE application_status_history SET changed_at = ? WHERE id = (SELECT MAX(id) FROM application_status_history WHERE application_id = ?)').run(at, id);
  };

  // Andy: an older application that gets a screen last week, then Technical and an offer this week.
  const older = await apply(users.andy, '2026-10-20T10:00:00.000Z');
  await move(users.andy, older, 'Recruiter Screen', '2026-10-27T10:00:00.000Z');
  await move(users.andy, older, 'Technical Interview', '2026-11-03T10:00:00.000Z');
  await move(users.andy, older, 'Offer', '2026-11-05T10:00:00.000Z');
  await apply(users.andy, '2026-10-28T10:00:00.000Z');
  const screened = await apply(users.andy, '2026-11-02T10:00:00.000Z');
  await move(users.andy, screened, 'Recruiter Screen', '2026-11-04T12:00:00.000Z');
  await move(users.andy, screened, 'Rejected', '2026-11-05T12:00:00.000Z');
  // A slip of the mouse, put right a minute later: nothing was reached.
  const slip = await apply(users.andy, '2026-11-05T09:00:00.000Z');
  await move(users.andy, slip, 'Final Interview', '2026-11-05T10:00:00.000Z');
  await move(users.andy, slip, 'Applied', '2026-11-05T10:01:00.000Z');

  // John: an interview booked on Wednesday for an application still at Applied, and last week one straight to Technical.
  const booked = await apply(users.john, '2026-11-03T10:00:00.000Z');
  expect((await users.john.post(`/api/applications/${booked}/interviews`, { stage: 'Recruiter Screen', scheduledAt: '2026-11-10T15:00:00.000Z', timezone: 'UTC' })).status).toBe(201);
  sqlite.prepare('UPDATE interviews SET created_at = ? WHERE application_id = ?').run('2026-11-04T09:00:00.000Z', booked);
  const fast = await apply(users.john, '2026-10-29T10:00:00.000Z');
  await move(users.john, fast, 'Technical Interview', '2026-10-30T12:00:00.000Z');
  // Mia has applied to nothing.

  const read = async (client: ApiClient, query: Record<string, string>) => {
    server.ctx.readCache.invalidate();
    const response = await client.get(`/api/activity?${new URLSearchParams({ tz: 'UTC', today: '2026-11-05', ...query }).toString()}`);
    expect(response.status).toBe(200);
    return response.json as ActivityResponse;
  };
  return { users, read };
}

const THIS_WEEK = { from: '2026-11-02', to: '2026-11-08' };
const byName = (response: ActivityResponse): Record<string, ActivityPerson> => Object.fromEntries(response.people.map((person) => [person.user.username, person]));

describe('trends over a range, next to the period before', () => {
  it('counts each measure on the day it happened, for each person', async () => {
    const { users, read } = await setUp();
    const week = await read(users.mia, THIS_WEEK);
    const { andy, john, mia } = byName(week);
    expect(andy.trends).toEqual({
      bids: [1, 0, 0, 1, 0, 0, 0],
      interviews: [0, 0, 1, 0, 0, 0, 0],
      technical: [0, 1, 0, 0, 0, 0, 0],
      final: [0, 0, 0, 1, 0, 0, 0],
      offers: [0, 0, 0, 1, 0, 0, 0],
      // Offers out of every application so far: 2 before the week, 3 from Monday, 4 and an offer on Thursday.
      success: [0, 0, 0, 25, 25, 25, 25]
    });
    expect(andy.trends.bids).toEqual(andy.series);
    expect(john.trends).toMatchObject({ bids: [0, 1, 0, 0, 0, 0, 0], interviews: [0, 0, 1, 0, 0, 0, 0], technical: [0, 0, 0, 0, 0, 0, 0], success: [0, 0, 0, 0, 0, 0, 0] });
    // Nothing sent yet: no rate at all, rather than 0%.
    expect(mia.trends.success).toEqual([null, null, null, null, null, null, null]);
    expect(mia.trends.bids).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('gives the period before, bucket for bucket, and totals for as much of each as has passed', async () => {
    const { users, read } = await setUp();
    const week = await read(users.andy, THIS_WEEK);
    expect(week.previous.range).toEqual({ first: '2026-10-26', last: '2026-11-01' });
    expect(week.previous.buckets.map((bucket) => bucket.key)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    expect(week.previous.compared).toEqual({ current: { first: '2026-11-02', last: '2026-11-05' }, previous: { first: '2026-10-26', last: '2026-10-29' } });

    const { andy, john } = byName(week);
    expect(andy.previousTrends).toMatchObject({ bids: [0, 0, 1, 0, 0, 0, 0], interviews: [0, 1, 0, 0, 0, 0, 0], offers: [0, 0, 0, 0, 0, 0, 0], success: [0, 0, 0, 0, 0, 0, 0] });
    // John had sent nothing before Thursday 29 October.
    expect(john.previousTrends).toMatchObject({ bids: [0, 0, 0, 1, 0, 0, 0], interviews: [0, 0, 0, 0, 1, 0, 0], technical: [0, 0, 0, 0, 1, 0, 0], success: [null, null, null, 0, 0, 0, 0] });

    expect(andy.trendTotals).toEqual({
      bids: { current: 2, previous: 1 },
      interviews: { current: 1, previous: 1 },
      technical: { current: 1, previous: 0 },
      final: { current: 1, previous: 0 },
      offers: { current: 1, previous: 0 },
      success: { current: 25, previous: 0 }
    });
    // John's Technical came on Friday 30 October, after the stretch compared with Monday to Thursday.
    expect(john.trendTotals).toMatchObject({ bids: { current: 1, previous: 1 }, interviews: { current: 1, previous: 0 }, technical: { current: 0, previous: 0 } });
    expect(byName(week).mia.trendTotals.success).toEqual({ current: null, previous: null });
  });

  it('adds the team together, and works out its own success rate', async () => {
    const { users, read } = await setUp();
    const week = await read(users.andy, THIS_WEEK);
    expect(week.teamTrends).toEqual({
      bids: [1, 1, 0, 1, 0, 0, 0],
      interviews: [0, 0, 2, 0, 0, 0, 0],
      technical: [0, 1, 0, 0, 0, 0, 0],
      final: [0, 0, 0, 1, 0, 0, 0],
      offers: [0, 0, 0, 1, 0, 0, 0],
      success: [0, 0, 0, 16.7, 16.7, 16.7, 16.7]
    });
    expect(week.teamTrendTotals).toMatchObject({ bids: { current: 3, previous: 2 }, interviews: { current: 2, previous: 1 }, offers: { current: 1, previous: 0 }, success: { current: 16.7, previous: 0 } });
  });

  it('draws the same lines for everyone who looks', async () => {
    const { users, read } = await setUp();
    const lines = (response: ActivityResponse) =>
      [...response.people].sort((a, b) => a.user.id - b.user.id).map((person) => ({ id: person.user.id, trends: person.trends, previous: person.previousTrends, totals: person.trendTotals }));
    const [asAndy, asJohn, asMia] = await Promise.all([read(users.andy, THIS_WEEK), read(users.john, THIS_WEEK), read(users.mia, THIS_WEEK)]);
    expect(lines(asJohn)).toEqual(lines(asAndy));
    expect(lines(asMia)).toEqual(lines(asAndy));
    expect(asMia.teamTrends).toEqual(asAndy.teamTrends);
  });

  it('compares a month with the month before, as far as today', async () => {
    const { users, read } = await setUp();
    const month = await read(users.andy, { from: '2026-11-01', to: '2026-11-30' });
    expect(month.previous.range).toEqual({ first: '2026-10-01', last: '2026-10-31' });
    expect(month.previous.compared).toEqual({ current: { first: '2026-11-01', last: '2026-11-05' }, previous: { first: '2026-10-01', last: '2026-10-05' } });
    expect(month.buckets).toHaveLength(30);
    expect(month.previous.buckets).toHaveLength(31);
    const andy = byName(month).andy;
    // Nothing happened in the first five days of October.
    expect(andy.trendTotals.bids).toEqual({ current: 2, previous: 0 });
    expect(andy.previousTrends.bids.reduce<number>((sum, value) => sum + (value ?? 0), 0)).toBe(2);
  });

  it('gives only my own lines when asked for me alone', async () => {
    const { users, read } = await setUp();
    const mine = await read(users.john, { ...THIS_WEEK, scope: 'me' });
    expect(mine.people.map((person) => person.user.username)).toEqual(['john']);
    expect(mine.teamTrends).toEqual(mine.people[0].trends);
    expect(mine.people[0].profiles[0].trends.bids).toEqual(mine.people[0].trends.bids);
    expect(mine.people[0].profiles[0].trendTotals).toEqual(mine.people[0].trendTotals);
  });
});

describe('a booked interview', () => {
  it('counts on the day it was booked, not the day it takes place', async () => {
    const { users, read } = await setUp();
    // Booked on Wednesday 4 November for Tuesday 10 November: nothing in the week it takes place.
    const nextWeek = await read(users.andy, { from: '2026-11-09', to: '2026-11-15', today: '2026-11-15' });
    expect(byName(nextWeek).john.trends.interviews).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(byName(await read(users.andy, THIS_WEEK)).john.trends.interviews).toEqual([0, 0, 1, 0, 0, 0, 0]);
  });
});
