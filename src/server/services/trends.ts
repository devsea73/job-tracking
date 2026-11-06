import type Database from 'better-sqlite3';
import type { ActivityBucket, DaySpan, TrendSeries, TrendTotals } from '../../shared/api';
import { addDays, addMonths, daysBetween, monthEnd, monthStart, type ActivityGroup } from '../../shared/calendar';
import { PIPELINE_STAGES, type PipelineStage } from '../../shared/pipeline';
import { prepared } from '../db/client';
import { bucketedRange, dayBegins, type WallClock } from './zone';

/**
 * What each person did over a range, bucket by bucket, next to the period before it.
 *
 * Bids count on the day they were sent. An interview, Technical, Final and an Offer count on the
 * day the application got there: the day its status moved to that stage or past it (an interview
 * also counts as got on the day one was booked). So a line shows when things happened, not when the
 * job was applied to. Success is offers out of every application ever, as it stood at each point.
 */

export const rate = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

const COUNTED = ['bids', 'interviews', 'technical', 'final', 'offers'] as const;
type Counted = (typeof COUNTED)[number];

/** The period a range is compared with: the month or year before a whole month or year, otherwise as many days just before. */
export function previousRange(range: DaySpan): DaySpan {
  if (range.first === monthStart(range.first) && range.last === monthEnd(range.first)) {
    const first = addMonths(range.first, -1);
    return { first, last: monthEnd(first) };
  }
  const year = range.first.slice(0, 4);
  if (range.first === `${year}-01-01` && range.last === `${year}-12-31`) {
    const before = String(Number(year) - 1).padStart(4, '0');
    return { first: `${before}-01-01`, last: `${before}-12-31` };
  }
  const days = daysBetween(range.first, range.last) + 1;
  return { first: addDays(range.first, -days), last: addDays(range.first, -1) };
}

/**
 * The days whose totals are compared, so that a week or month under way is set against as much of
 * the one before: the range as far as today, and as many days from the start of the period before.
 * Null for a range that has not begun.
 */
export function comparedRanges(range: DaySpan, previous: DaySpan, today: string): { current: DaySpan; previous: DaySpan } | null {
  if (today < range.first) return null;
  const last = today < range.last ? today : range.last;
  const end = addDays(previous.first, daysBetween(range.first, last));
  return { current: { first: range.first, last }, previous: { first: previous.first, last: end < previous.last ? end : previous.last } };
}

/**
 * When an application got an interview and reached Technical, Final and Offer, as far as is known
 * now, or null for a stage it has not reached. Statuses come in the order they were set. A rejection
 * keeps the stages reached; any other move back corrects a mistake, so the stages above it were not
 * reached until they are set again. The stored furthest stage has the last word.
 */
export function reachTimes(statuses: Array<{ status: string; at: number }>, furthest: number, booked: number | null): [number | null, number | null, number | null, number | null] {
  const reached: Array<number | null> = [null, null, null, null, null];
  const first: Array<number | null> = [null, null, null, null, null];
  let current = 0;
  for (const { status, at } of statuses) {
    const rank = PIPELINE_STAGES.indexOf(status as PipelineStage);
    if (rank < 0) continue;
    for (let stage = 1; stage <= rank; stage += 1) first[stage] ??= at;
    if (rank > current) for (let stage = current + 1; stage <= rank; stage += 1) reached[stage] = at;
    else for (let stage = rank + 1; stage <= current; stage += 1) reached[stage] = null;
    current = rank;
  }
  // Merging two applications keeps the further one, whatever order their statuses were set in.
  const at = (stage: number) => (stage <= furthest ? (reached[stage] ?? first[stage]) : null);
  const screen = at(1);
  const interview = screen === null ? booked : booked === null ? screen : Math.min(screen, booked);
  return [interview, at(2), at(3), at(4)];
}

interface Tally {
  current: Record<Counted, number[]>;
  previous: Record<Counted, number[]>;
  compared: Record<Counted, { current: number; previous: number }>;
  /** Bids and offers before each range began, and up to the end of each compared stretch: what success is worked out from. */
  before: { current: Record<'bids' | 'offers', number>; previous: Record<'bids' | 'offers', number> };
  upTo: { current: Record<'bids' | 'offers', number>; previous: Record<'bids' | 'offers', number> };
}

export interface EntityTrends {
  trends: TrendSeries;
  previousTrends: TrendSeries;
  trendTotals: TrendTotals;
}

export interface TrendsResult {
  previousBuckets: ActivityBucket[];
  forPerson: (userId: number) => EntityTrends;
  forProfile: (profileId: number) => EntityTrends;
  team: EntityTrends;
}

interface ApplicationRow {
  id: number;
  user_id: number;
  profile_id: number;
  applied_at: string;
  furthest_rank: number;
}

export function computeTrends(
  sqlite: Database.Database,
  options: {
    clock: (ms: number) => WallClock;
    group: ActivityGroup;
    range: DaySpan;
    previous: DaySpan;
    compared: { current: DaySpan; previous: DaySpan } | null;
    viewerId: number;
    scope: 'me' | 'team';
  }
): TrendsResult {
  const { clock, group, compared } = options;
  const current = bucketedRange(group, options.range, clock);
  const earlier = bucketedRange(group, options.previous, clock);
  const window = (days: DaySpan) => ({ from: dayBegins(days.first, clock), to: dayBegins(addDays(days.last, 1), clock) });
  const comparedNow = compared ? window(compared.current) : null;
  const comparedThen = compared ? window(compared.previous) : null;

  // The same people as the rest of the answer: me alone, or every member but the administrators.
  const who = options.scope === 'me' ? 'a.user_id = @viewer' : `a.user_id IN (SELECT id FROM users WHERE role <> 'admin')`;
  const params = { viewer: options.viewerId };
  const applications = prepared(sqlite, `SELECT a.id, a.user_id, a.profile_id, a.applied_at, a.furthest_rank FROM applications a WHERE ${who}`).all(params) as ApplicationRow[];
  // Only an application past Applied has stages to date.
  const histories = new Map<number, Array<{ status: string; at: number }>>();
  for (const row of prepared(
    sqlite,
    `SELECT h.application_id AS id, h.new_status AS status, h.changed_at AS at FROM application_status_history h JOIN applications a ON a.id = h.application_id
     WHERE a.furthest_rank >= 1 AND ${who} ORDER BY h.application_id, h.id`
  ).all(params) as Array<{ id: number; status: string; at: string }>) {
    const list = histories.get(row.id) ?? [];
    list.push({ status: row.status, at: Date.parse(row.at) });
    histories.set(row.id, list);
  }
  const booked = new Map(
    (prepared(sqlite, `SELECT i.application_id AS id, MIN(i.created_at) AS at FROM interviews i JOIN applications a ON a.id = i.application_id WHERE ${who} GROUP BY i.application_id`).all(params) as Array<{ id: number; at: string }>).map((row) => [
      row.id,
      Date.parse(row.at)
    ])
  );

  const zeros = (length: number) => Object.fromEntries(COUNTED.map((metric) => [metric, new Array<number>(length).fill(0)])) as Record<Counted, number[]>;
  const tally = (): Tally => ({
    current: zeros(current.buckets.length),
    previous: zeros(earlier.buckets.length),
    compared: Object.fromEntries(COUNTED.map((metric) => [metric, { current: 0, previous: 0 }])) as Tally['compared'],
    before: { current: { bids: 0, offers: 0 }, previous: { bids: 0, offers: 0 } },
    upTo: { current: { bids: 0, offers: 0 }, previous: { bids: 0, offers: 0 } }
  });
  const team = tally();
  const people = new Map<number, Tally>();
  const profiles = new Map<number, Tally>();
  const of = (map: Map<number, Tally>, id: number) => {
    let found = map.get(id);
    if (!found) {
      found = tally();
      map.set(id, found);
    }
    return found;
  };

  for (const application of applications) {
    const times = [Date.parse(application.applied_at), ...reachTimes(histories.get(application.id) ?? [], application.furthest_rank, booked.get(application.id) ?? null)];
    const tallies = [team, of(people, application.user_id), of(profiles, application.profile_id)];
    COUNTED.forEach((metric, index) => {
      const at = times[index];
      if (at === null || Number.isNaN(at)) return;
      const inCurrent = current.place(at);
      const inEarlier = earlier.place(at);
      const now = comparedNow !== null && at >= comparedNow.from && at < comparedNow.to;
      const then = comparedThen !== null && at >= comparedThen.from && at < comparedThen.to;
      for (const counts of tallies) {
        if (inCurrent >= 0) counts.current[metric][inCurrent] += 1;
        if (inEarlier >= 0) counts.previous[metric][inEarlier] += 1;
        if (now) counts.compared[metric].current += 1;
        if (then) counts.compared[metric].previous += 1;
        if (metric === 'bids' || metric === 'offers') {
          if (at < current.from) counts.before.current[metric] += 1;
          if (at < earlier.from) counts.before.previous[metric] += 1;
          if (comparedNow && at < comparedNow.to) counts.upTo.current[metric] += 1;
          if (comparedThen && at < comparedThen.to) counts.upTo.previous[metric] += 1;
        }
      }
    });
  }

  /** Offers out of every application so far, at the end of each bucket. */
  const success = (start: Record<'bids' | 'offers', number>, bids: number[], offers: number[]) => {
    let sent = start.bids;
    let offered = start.offers;
    return bids.map((value, index) => {
      sent += value;
      offered += offers[index];
      return rate(offered, sent);
    });
  };
  const finish = (counts: Tally): EntityTrends => ({
    trends: { ...counts.current, success: success(counts.before.current, counts.current.bids, counts.current.offers) },
    previousTrends: { ...counts.previous, success: success(counts.before.previous, counts.previous.bids, counts.previous.offers) },
    trendTotals: {
      ...(Object.fromEntries(COUNTED.map((metric) => [metric, compared ? { ...counts.compared[metric] } : { current: null, previous: null }])) as Record<Counted, TrendTotals[Counted]>),
      success: compared ? { current: rate(counts.upTo.current.offers, counts.upTo.current.bids), previous: rate(counts.upTo.previous.offers, counts.upTo.previous.bids) } : { current: null, previous: null }
    }
  });

  return {
    previousBuckets: earlier.buckets,
    forPerson: (userId) => finish(people.get(userId) ?? tally()),
    forProfile: (profileId) => finish(profiles.get(profileId) ?? tally()),
    team: finish(team)
  };
}
