import { describe, expect, it } from 'vitest';
import type { ActivityPerson, ActivityResponse, CreateApplicationResponse } from '../src/shared/api';
import { mergeJobs } from '../src/server/services/job-merge';
import { comparedRanges, previousBuckets, previousRange, reachTimes } from '../src/server/services/trends';
import { createTestServer, createUsers, jobPage, type ApiClient } from './helpers';

type Created = Extract<CreateApplicationResponse, { outcome: 'created' }>;

describe('when an application reached each stage', () => {
  it('dates each stage by the first step at it or past it', () => {
    // Straight to Technical: the interview stage was passed on the way, at the same moment.
    expect(reachTimes([{ stage: 'Technical Interview', at: 5 }])).toEqual([5, 5, null, null]);
    // A rejection keeps what was reached.
    expect(reachTimes([{ stage: 'Final Interview', at: 3 }, { stage: 'Rejected', at: 9 }])).toEqual([3, 3, 3, null]);
    // An offer has passed every stage before it.
    expect(reachTimes([{ stage: 'Offer', at: 7 }])).toEqual([7, 7, 7, 7]);
  });

  it('reaches a stage once, at its first round, however many there are', () => {
    const rounds = [
      { stage: 'Recruiter Screen', at: 2 },
      { stage: 'Technical Interview', at: 4 },
      { stage: 'Technical Interview', at: 6 },
      { stage: 'Technical Interview', at: 8 }
    ];
    expect(reachTimes(rounds)).toEqual([2, 4, null, null]);
  });

  it('reads the steps by when they take place, in whatever order they come', () => {
    expect(reachTimes([{ stage: 'Final Interview', at: 9 }, { stage: 'Recruiter Screen', at: 2 }, { stage: 'Technical Interview', at: 5 }])).toEqual([2, 5, 9, null]);
    // A later screen does not move the interview reached on a technical before it.
    expect(reachTimes([{ stage: 'Technical Interview', at: 3 }, { stage: 'Recruiter Screen', at: 6 }])).toEqual([3, 3, null, null]);
  });

  it('reaches nothing without a step, or with only a rejection', () => {
    expect(reachTimes([])).toEqual([null, null, null, null]);
    expect(reachTimes([{ stage: 'Rejected', at: 3 }])).toEqual([null, null, null, null]);
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
      expect((await users.john.patch(`/api/applications/${added.applicationId}`, { appliedAt })).status).toBe(200);
      return added;
    };
    const read = async () => {
      server.ctx.readCache.invalidate();
      const response = await users.john.get('/api/activity?tz=UTC&today=2026-11-05&from=2026-11-02&to=2026-11-08');
      return byName(response.json as ActivityResponse).john;
    };
    // A technical interview on Tuesday last week with one copy; the other, added this week, got a screen on Wednesday.
    const first = await add(1, '2026-10-26T10:00:00.000Z');
    await users.john.addStep(first.applicationId, 'Technical Interview', '2026-10-27T10:00:00.000Z');
    const second = await add(2, '2026-11-03T10:00:00.000Z');
    await users.john.addStep(second.applicationId, 'Recruiter Screen', '2026-11-04T10:00:00.000Z');
    expect((await read()).trends.interviews).toEqual([0, 0, 1, 0, 0, 0, 0]);

    sqlite.transaction(() => mergeJobs(sqlite, first.jobId, second.jobId))();
    // One application now, with both timelines: it got its interview, and Technical, last Tuesday. Nothing new this week.
    const after = await read();
    expect(after.trends.interviews).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(after.trends.technical).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(after.previousTrends.interviews).toEqual([0, 1, 0, 0, 0, 0, 0]);
    expect(after.previousTrends.technical).toEqual([0, 1, 0, 0, 0, 0, 0]);
    // It is at the stage of its latest step, the screen, having reached Technical before.
    expect(sqlite.prepare('SELECT stage, furthest_rank FROM applications WHERE id = ?').get(first.applicationId)).toEqual({ stage: 'Recruiter Screen', furthest_rank: 2 });
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
  /** Applies, on the day the person says they did. */
  const apply = async (client: ApiClient, appliedAt: string) => {
    n += 1;
    server.http.serve(`https://careers.example.com/jobs/${n}`, jobPage({ title: `Engineer ${n}`, company: `Company ${n}` }));
    const added = (await client.addJob(`https://careers.example.com/jobs/${n}`)) as Created;
    expect((await client.patch(`/api/applications/${added.applicationId}`, { appliedAt })).status).toBe(200);
    return added.applicationId;
  };

  // Andy: an older application that gets a screen last week, then Technical and an offer this week.
  const older = await apply(users.andy, '2026-10-20T10:00:00.000Z');
  await users.andy.addStep(older, 'Recruiter Screen', '2026-10-27T10:00:00.000Z');
  await users.andy.addStep(older, 'Technical Interview', '2026-11-03T10:00:00.000Z');
  await users.andy.addStep(older, 'Offer', '2026-11-05T10:00:00.000Z');
  await apply(users.andy, '2026-10-28T10:00:00.000Z');
  const screened = await apply(users.andy, '2026-11-02T10:00:00.000Z');
  await users.andy.addStep(screened, 'Recruiter Screen', '2026-11-04T12:00:00.000Z');
  await users.andy.addStep(screened, 'Rejected', '2026-11-05T12:00:00.000Z');
  // A step put in by mistake and taken off again: nothing was reached.
  const slip = await apply(users.andy, '2026-11-05T09:00:00.000Z');
  const mistake = await users.andy.addStep(slip, 'Final Interview', '2026-11-05T10:00:00.000Z');
  expect((await users.andy.delete(`/api/steps/${mistake.id}`)).status).toBe(200);

  // John: a screen held on Wednesday, its record written a week before, which never counts; and last week one straight to Technical.
  const booked = await apply(users.john, '2026-11-03T10:00:00.000Z');
  const screen = await users.john.addStep(booked, 'Recruiter Screen', '2026-11-04T15:00:00.000Z');
  sqlite.prepare('UPDATE application_steps SET created_at = ?, updated_at = ? WHERE id = ?').run('2026-10-27T09:00:00.000Z', '2026-10-27T09:00:00.000Z', screen.id);
  const fast = await apply(users.john, '2026-10-29T10:00:00.000Z');
  await users.john.addStep(fast, 'Technical Interview', '2026-10-30T12:00:00.000Z');
  // Mia has applied to nothing.

  const read = async (client: ApiClient, query: Record<string, string>) => {
    server.ctx.readCache.invalidate();
    const response = await client.get(`/api/activity?${new URLSearchParams({ tz: 'UTC', today: '2026-11-05', ...query }).toString()}`);
    expect(response.status).toBe(200);
    return response.json as ActivityResponse;
  };
  return { users, read, sqlite, ids: { booked } };
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

const NEXT_WEEK = { from: '2026-11-09', to: '2026-11-15', today: '2026-11-15' };
const NOTHING = [0, 0, 0, 0, 0, 0, 0];

describe('an interview', () => {
  it('counts on the day it takes place, not the day it was put in', async () => {
    const { users, read, ids } = await setUp();
    // John's screen took place on Wednesday; its record says it was written the Tuesday before.
    const john = byName(await read(users.andy, THIS_WEEK)).john;
    expect(john.trends.interviews).toEqual([0, 0, 1, 0, 0, 0, 0]);
    // Last week only has his technical interview, on Friday.
    expect(john.previousTrends.interviews).toEqual([0, 0, 0, 0, 1, 0, 0]);

    // Booked today, Thursday, for a final next Thursday: nothing this week, and it counts next week.
    await users.john.addStep(ids.booked, 'Final Interview', '2026-11-12T15:00:00.000Z');
    const now = byName(await read(users.andy, THIS_WEEK)).john;
    expect(now.trends.final).toEqual(NOTHING);
    expect(now.trendTotals.final).toEqual({ current: 0, previous: 0 });
    const later = byName(await read(users.andy, NEXT_WEEK)).john;
    expect(later.trends.final).toEqual([0, 0, 0, 1, 0, 0, 0]);
    // Straight from the screen to a final passes Technical on the way, that same day.
    expect(later.trends.technical).toEqual([0, 0, 0, 1, 0, 0, 0]);
    // The application got its first interview the week before: that is not counted again.
    expect(later.trends.interviews).toEqual(NOTHING);
  });

  it('reaches a stage once, at the first round, however many rounds there are', async () => {
    const { users, read, ids } = await setUp();
    // Three technical rounds, Thursday to Saturday: Technical is reached once, on Thursday.
    for (const at of ['2026-11-05T09:00:00.000Z', '2026-11-06T09:00:00.000Z', '2026-11-07T09:00:00.000Z']) await users.john.addStep(ids.booked, 'Technical Interview', at);
    const john = byName(await read(users.andy, THIS_WEEK)).john;
    expect(john.trends.technical).toEqual([0, 0, 0, 1, 0, 0, 0]);
    expect(john.trends.interviews).toEqual([0, 0, 1, 0, 0, 0, 0]);
  });
});

describe('when records were written or changed', () => {
  it('changes no number: only the times the person entered count', async () => {
    const { users, read, sqlite } = await setUp();
    const ranges = [THIS_WEEK, NEXT_WEEK, { from: '2026-11-01', to: '2026-11-30' }, { from: '2026-11-05', to: '2026-11-05' }];
    const before: ActivityResponse[] = [];
    for (const range of ranges) before.push(await read(users.andy, range));
    // Every record said to be written long ago and changed long after.
    sqlite.prepare(`UPDATE applications SET created_at = '2019-01-01T00:00:00.000Z', updated_at = '2031-06-01T00:00:00.000Z'`).run();
    sqlite.prepare(`UPDATE application_steps SET created_at = '2019-01-01T00:00:00.000Z', updated_at = '2031-06-01T00:00:00.000Z'`).run();
    const after: ActivityResponse[] = [];
    for (const range of ranges) after.push(await read(users.andy, range));
    expect(after).toEqual(before);
    // John's screen still counts on Wednesday, the day it took place.
    expect(byName(after[0]).john.trends.interviews).toEqual([0, 0, 1, 0, 0, 0, 0]);
  });

  it('moves a bid when the person corrects the day they applied', async () => {
    const { users, read } = await setUp();
    const mine = (await users.john.get('/api/jobs?scope=mine&sort=applied')).json as { items: Array<{ applications: Array<{ id: number; isMine: boolean; appliedAt: string }> }> };
    const tuesday = mine.items.flatMap((job) => job.applications).find((application) => application.isMine && application.appliedAt.startsWith('2026-11-03'));
    expect(byName(await read(users.andy, THIS_WEEK)).john.trends.bids).toEqual([0, 1, 0, 0, 0, 0, 0]);
    // Applied on Saturday the 31st after all, only put in on Tuesday.
    expect((await users.john.patch(`/api/applications/${tuesday?.id}`, { appliedAt: '2026-10-31T18:00:00.000Z' })).status).toBe(200);
    const week = byName(await read(users.andy, THIS_WEEK)).john;
    expect(week.trends.bids).toEqual(NOTHING);
    expect(week.previousTrends.bids).toEqual([0, 0, 0, 1, 0, 1, 0]);
  });
});
