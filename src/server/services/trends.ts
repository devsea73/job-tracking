import type Database from 'better-sqlite3';
import type { ActivityBucket, DaySpan, TrendSeries, TrendTotals } from '../../shared/api';
import { addDays, addMonths, daysBetween, monthEnd, monthStart, type ActivityGroup } from '../../shared/calendar';
import { PIPELINE_STAGES, type PipelineStage } from '../../shared/pipeline';
import { prepared } from '../db/client';
import { bucketedDays, bucketedRange, bucketsFor, dayBegins, type BucketedRange, type WallClock } from './zone';

/**
 * What each person did over a range, bucket by bucket, next to the period before it.
 *
 * Bids count on the day they were sent. An interview, Technical, Final and an Offer count on the
 * day the application got there: the time of its first step at that stage or past it, as entered,
 * so an interview counts on the day it takes place. When a record was saved or changed never counts.
 * So a line shows when things happened, not when the job was applied to. Success is offers out of
 * every application ever, as it stood at each point.
 */

export const rate = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

const COUNTED = ['bids', 'interviews', 'technical', 'final', 'offers'] as const;
export type Counted = (typeof COUNTED)[number];

const isWholeMonth = (range: DaySpan) => range.first === monthStart(range.first) && range.last === monthEnd(range.first);
const isWholeYear = (range: DaySpan) => range.first === `${range.first.slice(0, 4)}-01-01` && range.last === `${range.first.slice(0, 4)}-12-31`;

/** The period a range is compared with: the month or year before a whole month or year, otherwise as many days just before. */
export function previousRange(range: DaySpan): DaySpan {
  if (isWholeMonth(range)) {
    const first = addMonths(range.first, -1);
    return { first, last: monthEnd(first) };
  }
  if (isWholeYear(range)) {
    const before = String(Number(range.first.slice(0, 4)) - 1).padStart(4, '0');
    return { first: `${before}-01-01`, last: `${before}-12-31` };
  }
  const days = daysBetween(range.first, range.last) + 1;
  return { first: addDays(range.first, -days), last: addDays(range.first, -1) };
}

/**
 * The period before, bucket for bucket with the range. Hours and days are its own, which line up
 * one for one already; so are months, when it is the month or year before. Weeks, and months when
 * it is as many days before, are the range's own buckets moved back to the same place in it: the
 * first days of a month are set against the first days of the month before, and a week that starts
 * on a Thursday against the stretch the same days in. A bucket that would start after the period
 * ends is left out; the last one runs to its end. Each is named by its first day.
 */
export function previousBuckets(group: ActivityGroup, range: DaySpan, previous: DaySpan): ActivityBucket[] {
  if (group === 'hour' || group === 'day') return bucketsFor(group, previous).buckets;
  if (group === 'month' && (isWholeMonth(range) || isWholeYear(range))) return bucketsFor(group, previous).buckets;
  const moved: ActivityBucket[] = [];
  const place = (date: string) => addDays(previous.first, daysBetween(range.first, date));
  for (const bucket of bucketsFor(group, range).buckets) {
    const first = place(bucket.first);
    if (first > previous.last) break;
    const end = place(bucket.last);
    moved.push({ key: first, first, last: bucket.last === range.last || end > previous.last ? previous.last : end });
  }
  return moved;
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
 * When an application got an interview and reached Technical, Final and Offer, from the steps on
 * its timeline, or null for a stage it has not reached. Each is the time of its first step at that
 * stage or past it, as the person entered it: three technical rounds reach Technical once, at the
 * first; going straight to a final has passed Technical too, then. A rejection reaches nothing.
 */
export function reachTimes(steps: Array<{ stage: string; at: number }>): [number | null, number | null, number | null, number | null] {
  const first: Array<number | null> = [null, null, null, null, null];
  for (const { stage, at } of steps) {
    const rank = PIPELINE_STAGES.indexOf(stage as PipelineStage);
    for (let reached = 1; reached <= rank; reached += 1) if (first[reached] === null || at < (first[reached] as number)) first[reached] = at;
  }
  return [first[1], first[2], first[3], first[4]];
}

/** The steps that are a stage past Applied, as SQL: a rejection dates nothing. */
const REACHING = PIPELINE_STAGES.slice(1)
  .map((stage) => `'${stage}'`)
  .join(', ');

export interface StageEvent {
  userId: number;
  profileId: number;
  /** When it got an interview, reached Technical, Final and an Offer: see reachTimes. */
  times: [number | null, number | null, number | null, number | null];
}

/**
 * The stages reached by every application that could have reached one inside the window: those
 * with a step dated in it. Every application that got an offer comes too, whenever it did, since
 * success counts offers from the beginning. Steps count by when they take place, never by when they
 * were saved, so an interview booked today for next week counts next week.
 */
export function stageEvents(sqlite: Database.Database, window: { from: string; to: string }, only?: number): StageEvent[] {
  // Found by the days, from the index on them; for one person, keeping only theirs.
  const ids = (
    only === undefined
      ? prepared(
          sqlite,
          `SELECT application_id FROM application_steps WHERE stage IN (${REACHING}) AND at >= @from AND at < @to
           UNION SELECT id FROM applications WHERE furthest_rank >= 4`
        )
          .pluck()
          .all(window)
      : prepared(
          sqlite,
          `SELECT s.application_id FROM application_steps s JOIN applications a ON a.id = s.application_id
             WHERE s.stage IN (${REACHING}) AND s.at >= @from AND s.at < @to AND a.user_id = @only
           UNION SELECT id FROM applications WHERE furthest_rank >= 4 AND user_id = @only`
        )
          .pluck()
          .all({ ...window, only })
  ) as number[];
  if (ids.length === 0) return [];
  const picked = JSON.stringify(ids);
  const owners = prepared(sqlite, 'SELECT id, user_id, profile_id FROM applications WHERE id IN (SELECT value FROM json_each(?))').raw(true).all(picked) as Array<[number, number, number]>;
  const stepsOf = new Map<number, Array<{ stage: string; at: number }>>();
  for (const [applicationId, stage, at] of prepared(sqlite, `SELECT application_id, stage, at FROM application_steps WHERE stage IN (${REACHING}) AND application_id IN (SELECT value FROM json_each(?))`)
    .raw(true)
    .all(picked) as Array<[number, string, string]>) {
    let list = stepsOf.get(applicationId);
    if (!list) {
      list = [];
      stepsOf.set(applicationId, list);
    }
    list.push({ stage, at: Date.parse(at) });
  }
  return owners.map(([id, userId, profileId]) => ({ userId, profileId, times: reachTimes(stepsOf.get(id) ?? []) }));
}

interface Counts {
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

/**
 * The trends of everyone at once, for each person, each profile and the team, from what happened
 * and when. The team is whoever `inTeam` says.
 */
export class TrendTally {
  readonly current: BucketedRange;
  readonly earlier: BucketedRange;
  private readonly comparedNow: { from: number; to: number } | null;
  private readonly comparedThen: { from: number; to: number } | null;
  private readonly team: Counts;
  private readonly people = new Map<number, Counts>();
  private readonly profiles = new Map<number, Counts>();

  constructor(
    options: { clock: (ms: number) => WallClock; group: ActivityGroup; range: DaySpan; previous: DaySpan; compared: { current: DaySpan; previous: DaySpan } | null },
    private readonly inTeam: (userId: number) => boolean
  ) {
    const { clock, group, range, previous, compared } = options;
    this.current = bucketedRange(group, range, clock);
    this.earlier = group === 'hour' ? bucketedRange(group, previous, clock) : bucketedDays(previousBuckets(group, range, previous), clock);
    const window = (days: DaySpan) => ({ from: dayBegins(days.first, clock), to: dayBegins(addDays(days.last, 1), clock) });
    this.comparedNow = compared ? window(compared.current) : null;
    this.comparedThen = compared ? window(compared.previous) : null;
    this.team = this.empty();
  }

  /** From the start of the period before to the end of the range: where anything counted in a bucket happened. */
  get window(): { from: number; to: number } {
    return { from: this.earlier.from, to: this.current.to };
  }

  private empty(): Counts {
    const zeros = (length: number) => Object.fromEntries(COUNTED.map((metric) => [metric, new Array<number>(length).fill(0)])) as Record<Counted, number[]>;
    return {
      current: zeros(this.current.buckets.length),
      previous: zeros(this.earlier.buckets.length),
      compared: Object.fromEntries(COUNTED.map((metric) => [metric, { current: 0, previous: 0 }])) as Counts['compared'],
      before: { current: { bids: 0, offers: 0 }, previous: { bids: 0, offers: 0 } },
      upTo: { current: { bids: 0, offers: 0 }, previous: { bids: 0, offers: 0 } }
    };
  }

  private of(map: Map<number, Counts>, id: number): Counts {
    let found = map.get(id);
    if (!found) {
      found = this.empty();
      map.set(id, found);
    }
    return found;
  }

  /** Something that happened at a moment: a bid sent, a stage reached. Null for never. */
  add(userId: number, profileId: number, metric: Counted, at: number | null): void {
    if (at === null || Number.isNaN(at)) return;
    const inCurrent = this.current.place(at);
    const inEarlier = this.earlier.place(at);
    const now = this.comparedNow !== null && at >= this.comparedNow.from && at < this.comparedNow.to;
    const then = this.comparedThen !== null && at >= this.comparedThen.from && at < this.comparedThen.to;
    const bump = (counts: Counts) => {
      if (inCurrent >= 0) counts.current[metric][inCurrent] += 1;
      if (inEarlier >= 0) counts.previous[metric][inEarlier] += 1;
      if (now) counts.compared[metric].current += 1;
      if (then) counts.compared[metric].previous += 1;
      if (metric === 'bids' || metric === 'offers') {
        if (at < this.current.from) counts.before.current[metric] += 1;
        if (at < this.earlier.from) counts.before.previous[metric] += 1;
        if (this.comparedNow && at < this.comparedNow.to) counts.upTo.current[metric] += 1;
        if (this.comparedThen && at < this.comparedThen.to) counts.upTo.previous[metric] += 1;
      }
    };
    if (this.inTeam(userId)) bump(this.team);
    bump(this.of(this.people, userId));
    bump(this.of(this.profiles, profileId));
  }

  /** Bids or offers from before the period before began, all at once: they count towards success, and nothing else. */
  addBefore(userId: number, profileId: number, metric: 'bids' | 'offers', count: number): void {
    if (count <= 0) return;
    const bump = (counts: Counts) => {
      counts.before.current[metric] += count;
      counts.before.previous[metric] += count;
      if (this.comparedNow) counts.upTo.current[metric] += count;
      if (this.comparedThen) counts.upTo.previous[metric] += count;
    };
    if (this.inTeam(userId)) bump(this.team);
    bump(this.of(this.people, userId));
    bump(this.of(this.profiles, profileId));
  }

  private finish(counts: Counts): EntityTrends {
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
    const compared = this.comparedNow !== null;
    return {
      trends: { ...counts.current, success: success(counts.before.current, counts.current.bids, counts.current.offers) },
      previousTrends: { ...counts.previous, success: success(counts.before.previous, counts.previous.bids, counts.previous.offers) },
      trendTotals: {
        ...(Object.fromEntries(COUNTED.map((metric) => [metric, compared ? { ...counts.compared[metric] } : { current: null, previous: null }])) as Record<Counted, TrendTotals[Counted]>),
        success: compared ? { current: rate(counts.upTo.current.offers, counts.upTo.current.bids), previous: rate(counts.upTo.previous.offers, counts.upTo.previous.bids) } : { current: null, previous: null }
      }
    };
  }

  forPerson(userId: number): EntityTrends {
    return this.finish(this.people.get(userId) ?? this.empty());
  }

  forProfile(profileId: number): EntityTrends {
    return this.finish(this.profiles.get(profileId) ?? this.empty());
  }

  forTeam(): EntityTrends {
    return this.finish(this.team);
  }
}
