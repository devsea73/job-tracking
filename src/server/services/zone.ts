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

/** The time on the viewer's wall clock at a moment. The same quarter hours come up again and again, so each is worked out once. */
export function zoneClock(tz: string): (ms: number) => WallClock {
  const format = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
  const seen = new Map<number, WallClock>();
  return (ms) => {
    let clock = seen.get(ms);
    if (!clock) {
      const parts = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
      clock = { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
      seen.set(ms, clock);
    }
    return clock;
  };
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

/**
 * A range of days, in instants, split into its buckets: which bucket a moment falls in, or -1
 * outside the range. A moment is placed by its quarter hour of UTC: inside one, every moment has
 * the same wall-clock hour and day in every time zone.
 */
export function bucketedRange(group: ActivityGroup, range: DaySpan, clock: (ms: number) => WallClock): { buckets: ActivityBucket[]; from: number; to: number; place: (ms: number) => number } {
  const { buckets, indexOf } = bucketsFor(group, range);
  const from = dayBegins(range.first, clock);
  const to = dayBegins(addDays(range.last, 1), clock);
  return {
    buckets,
    from,
    to,
    place: (ms) => {
      if (!(ms >= from && ms < to)) return -1;
      const index = indexOf(clock(Math.floor(ms / QUARTER_HOUR_MS) * QUARTER_HOUR_MS));
      return index >= 0 && index < buckets.length ? index : -1;
    }
  };
}
