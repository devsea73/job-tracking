import type { ActivityBucket, DaySpan } from '../../shared/api';
import { addDays, addMonths, daysBetween, monthEnd, monthStart, weekStart, type ActivityGroup } from '../../shared/calendar';

/**
 * Days and hours in the viewer's own time zone. Days begin where they begin there, daylight saving
 * time included: a day can be 23 or 25 hours long, and the host works that out instead of assuming
 * a fixed offset.
 */

export const QUARTER_HOUR_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;

export interface WallClock {
  date: string;
  hour: number;
}

/** Each zone's wall clock, kept between requests: the same quarter hours come up in every one. */
const clocks = new Map<string, (ms: number) => WallClock>();
const CLOCK_ZONES = 16;
const CLOCK_TIMES = 100_000;

/** The time on the viewer's wall clock at a moment. The same quarter hours come up again and again, so each is worked out once. */
export function zoneClock(tz: string): (ms: number) => WallClock {
  const known = clocks.get(tz);
  if (known) return known;
  const format = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
  const seen = new Map<number, WallClock>();
  const clock = (ms: number): WallClock => {
    let found = seen.get(ms);
    if (!found) {
      const parts = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
      found = { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
      if (seen.size >= CLOCK_TIMES) seen.clear();
      seen.set(ms, found);
    }
    return found;
  };
  if (clocks.size >= CLOCK_ZONES) clocks.clear();
  clocks.set(tz, clock);
  return clock;
}

/**
 * The first moment of a day in the viewer's time zone. Every zone's offset, and every daylight
 * saving change, falls on a quarter hour, so the answer lies on the quarter-hour grid; it is found
 * by halving the 30 hours around midnight UTC, inside which every zone's midnight falls.
 */
export function dayBegins(date: string, clock: (ms: number) => WallClock): number {
  const midnightUtc = Date.parse(`${date}T00:00:00.000Z`);
  let before = Math.floor((midnightUtc - 15 * HOUR_MS) / QUARTER_HOUR_MS);
  let after = Math.ceil((midnightUtc + 15 * HOUR_MS) / QUARTER_HOUR_MS);
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    if (clock(middle * QUARTER_HOUR_MS).date >= date) after = middle;
    else before = middle;
  }
  return after * QUARTER_HOUR_MS;
}

/** Where a run of days in the viewer's calendar begins, and where the day after it begins: [from, to), as UTC instants. */
export function instantsOf(tz: string, days: DaySpan): { from: string; to: string } {
  const clock = zoneClock(tz);
  return { from: new Date(dayBegins(days.first, clock)).toISOString(), to: new Date(dayBegins(addDays(days.last, 1), clock)).toISOString() };
}

/** The range's buckets, and which bucket a wall-clock time falls in. */
export function bucketsFor(group: ActivityGroup, range: DaySpan): { buckets: ActivityBucket[]; indexOf: (clock: WallClock) => number } {
  const buckets: ActivityBucket[] = [];
  const clip = (first: string, last: string) => ({ first: first < range.first ? range.first : first, last: last > range.last ? range.last : last });
  switch (group) {
    case 'hour':
      for (let hour = 0; hour < 24; hour += 1) buckets.push({ key: `${range.first}T${String(hour).padStart(2, '0')}`, first: range.first, last: range.first });
      // A day with a clock change has an hour twice, or not at all: both times count in that hour.
      return { buckets, indexOf: (clock) => clock.hour };
    case 'day':
      for (let day = range.first; day <= range.last; day = addDays(day, 1)) buckets.push({ key: day, first: day, last: day });
      return { buckets, indexOf: (clock) => daysBetween(range.first, clock.date) };
    case 'week': {
      const firstWeek = weekStart(range.first);
      for (let week = firstWeek; week <= range.last; week = addDays(week, 7)) buckets.push({ key: week, ...clip(week, addDays(week, 6)) });
      return { buckets, indexOf: (clock) => daysBetween(firstWeek, weekStart(clock.date)) / 7 };
    }
    case 'month': {
      const firstMonth = monthStart(range.first);
      for (let month = firstMonth; month <= range.last; month = addMonths(month, 1)) buckets.push({ key: month.slice(0, 7), ...clip(month, monthEnd(month)) });
      const monthNumber = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));
      return { buckets, indexOf: (clock) => monthNumber(clock.date) - monthNumber(firstMonth) };
    }
  }
}

export interface BucketedRange {
  buckets: ActivityBucket[];
  from: number;
  to: number;
  /** The bucket a moment falls in, or -1 outside them all. */
  place: (ms: number) => number;
}

/**
 * Buckets that are each a run of whole days, one after the other, in instants. A moment falls in
 * the last bucket that began at or before it: the days are worked out once per bucket, not per moment.
 */
export function bucketedDays(buckets: ActivityBucket[], clock: (ms: number) => WallClock): BucketedRange {
  if (buckets.length === 0) return { buckets, from: 0, to: 0, place: () => -1 };
  const starts = buckets.map((bucket) => dayBegins(bucket.first, clock));
  const from = starts[0];
  const to = dayBegins(addDays(buckets[buckets.length - 1].last, 1), clock);
  return {
    buckets,
    from,
    to,
    place: (ms) => {
      if (!(ms >= from && ms < to)) return -1;
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle] <= ms) low = middle;
        else high = middle - 1;
      }
      return low;
    }
  };
}

/**
 * A range of days, in instants, split into its buckets: which bucket a moment falls in, or -1
 * outside the range. Hours go by the wall clock, each quarter hour of the day looked up once: inside
 * a quarter hour of UTC, every moment has the same wall-clock hour in every time zone.
 */
export function bucketedRange(group: ActivityGroup, range: DaySpan, clock: (ms: number) => WallClock): BucketedRange {
  const { buckets, indexOf } = bucketsFor(group, range);
  if (group !== 'hour') return bucketedDays(buckets, clock);
  const from = dayBegins(range.first, clock);
  const to = dayBegins(addDays(range.last, 1), clock);
  const hours: number[] = [];
  for (let quarter = from; quarter < to; quarter += QUARTER_HOUR_MS) hours.push(indexOf(clock(quarter)));
  return { buckets, from, to, place: (ms) => (ms >= from && ms < to ? hours[Math.floor((ms - from) / QUARTER_HOUR_MS)] : -1) };
}
