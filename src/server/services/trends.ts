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
 * day the application got there: the day its status moved to that stage or past it (an interview
 * also counts as got on the day one was booked). So a line shows when things happened, not when the
 * job was applied to. Success is offers out of every application ever, as it stood at each point.
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

interface Thread {
  status: string | null;
  current: number;
  reached: Array<number | null>;
}

/**
 * When an application got an interview and reached Technical, Final and Offer, as far as is known
 * now, or null for a stage it has not reached. Statuses come in the order they were set. A rejection
 * keeps the stages reached; any other move back corrects a mistake, so the stages above it were not
 * reached until they are set again. The stored furthest stage has the last word.
 *
 * Two applications merged into one keep both histories, mixed together by when each status was set.
 * Each application's first status has no status before it, so one of those part-way through starts
 * the merged-in application's own run: a status carries on the run it moved from. Each run is read
 * on its own, and a stage counts from the first time either application reached it. Without that,
 * the start of the second run would read as a move back, and its later statuses would date stages
 * the first application had reached long before.
 */
export function reachTimes(statuses: Array<{ status: string; at: number; old?: string | null }>, furthest: number, booked: number | null): [number | null, number | null, number | null, number | null] {
  const first: Array<number | null> = [null, null, null, null, null];
  const threads: Thread[] = [];
  let latest: Thread | null = null;
  for (const { status, at, old } of statuses) {
    let thread: Thread | null = null;
    if (old !== null && latest) {
      if (old === undefined || latest.status === old) thread = latest;
      else {
        for (let index = threads.length - 1; index >= 0 && !thread; index -= 1) if (threads[index].status === old) thread = threads[index];
        thread ??= latest;
      }
    }
    if (!thread) {
      thread = { status: null, current: 0, reached: [null, null, null, null, null] };
      threads.push(thread);
    }
    thread.status = status;
    latest = thread;
    const rank = PIPELINE_STAGES.indexOf(status as PipelineStage);
    if (rank < 0) continue;
    for (let stage = 1; stage <= rank; stage += 1) first[stage] = first[stage] === null ? at : Math.min(first[stage] as number, at);
    if (rank > thread.current) for (let stage = thread.current + 1; stage <= rank; stage += 1) thread.reached[stage] = at;
    else for (let stage = rank + 1; stage <= thread.current; stage += 1) thread.reached[stage] = null;
    thread.current = rank;
  }
  const reached = (stage: number): number | null => {
    let earliest: number | null = null;
    for (const thread of threads) {
      const value = thread.reached[stage];
      if (value !== null && (earliest === null || value < earliest)) earliest = value;
    }
    return earliest;
  };
  // Merging two applications keeps the further one, whatever order their statuses were set in.
  const at = (stage: number) => (stage <= furthest ? (reached(stage) ?? first[stage]) : null);
  const screen = at(1);
  const interview = screen === null ? booked : booked === null ? screen : Math.min(screen, booked);
  return [interview, at(2), at(3), at(4)];
}

/** The statuses that are a stage past Applied, as SQL. */
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
 * with a status set or an interview booked in it. Every application that got an offer comes too,
 * whenever it did, since success counts offers from the beginning. Each one's whole history is
 * read, because what a status means depends on the ones set before it.
 */
export function stageEvents(sqlite: Database.Database, window: { from: string; to: string }, only?: number): StageEvent[] {
  // A stage is only ever reached by a status that is one: Applied and Rejected date nothing. Found
  // by the days, from the indexes on them; for one person, keeping only theirs. Today's few changes
  // are quicker to find that way than by looking through all of someone's applications.
  const ids = (
    only === undefined
      ? prepared(
          sqlite,
          `SELECT application_id FROM application_status_history WHERE new_status IN (${REACHING}) AND changed_at >= @from AND changed_at < @to
           UNION SELECT application_id FROM interviews WHERE created_at >= @from AND created_at < @to
           UNION SELECT id FROM applications WHERE furthest_rank >= 4`
        )
          .pluck()
          .all(window)
      : prepared(
          sqlite,
          `SELECT h.application_id FROM application_status_history h JOIN applications a ON a.id = h.application_id
             WHERE h.new_status IN (${REACHING}) AND h.changed_at >= @from AND h.changed_at < @to AND a.user_id = @only
           UNION SELECT i.application_id FROM interviews i JOIN applications a ON a.id = i.application_id WHERE i.created_at >= @from AND i.created_at < @to AND a.user_id = @only
           UNION SELECT id FROM applications WHERE furthest_rank >= 4 AND user_id = @only`
        )
          .pluck()
          .all({ ...window, only })
  ) as number[];
  if (ids.length === 0) return [];
  const picked = JSON.stringify(ids);
  const applications = prepared(sqlite, 'SELECT id, user_id, profile_id, furthest_rank FROM applications WHERE id IN (SELECT value FROM json_each(?))').raw(true).all(picked) as Array<
    [number, number, number, number]
  >;
  const booked = new Map(
    prepared(sqlite, 'SELECT application_id, MIN(created_at) FROM interviews WHERE application_id IN (SELECT value FROM json_each(?)) GROUP BY application_id')
      .raw(true)
      .all(picked) as Array<[number, string]>
  );
  // Only those past Applied have stages to date. Each one's statuses go in the order they were set.
  const staged = applications.filter(([, , , furthest]) => furthest >= 1).map(([id]) => id);
  const histories = new Map<number, Array<{ id: number; status: string; at: number; old: string | null }>>();
  if (staged.length > 0) {
    for (const [id, applicationId, old, status, at] of prepared(
      sqlite,
      'SELECT id, application_id, old_status, new_status, changed_at FROM application_status_history WHERE application_id IN (SELECT value FROM json_each(?))'
    )
      .raw(true)
      .all(JSON.stringify(staged)) as Array<[number, number, string | null, string, string]>) {
      let list = histories.get(applicationId);
      if (!list) {
        list = [];
        histories.set(applicationId, list);
      }
      list.push({ id, status, at: Date.parse(at), old });
    }
  }
  return applications.map(([id, userId, profileId, furthest]) => {
    const statuses = histories.get(id)?.sort((a, b) => a.id - b.id) ?? [];
    const first = booked.get(id);
    return { userId, profileId, times: reachTimes(statuses, furthest, first === undefined ? null : Date.parse(first)) };
  });
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
