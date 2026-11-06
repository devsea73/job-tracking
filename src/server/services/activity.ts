import type Database from 'better-sqlite3';
import type { ActivityBucket, ActivityCounts, ActivityPerson, ActivityQuery, ActivityResponse, DaySpan } from '../../shared/api';
import { addDays, addMonths, autoGroup, daysBetween, monthEnd, monthStart, weekStart, type ActivityGroup } from '../../shared/calendar';
import { prepared } from '../db/client';
import { toUserRef } from './users';

/**
 * Applications per person, counted in the viewer's own calendar: today, yesterday, this week, this
 * month and a chosen range, the range split into hours, days, weeks or months, and how many of
 * those applications got an interview so far.
 *
 * Every period has both ends, so an application dated after today is never counted as today's.
 * Days begin where they begin in the viewer's time zone, daylight saving time included: a day can
 * be 23 or 25 hours long, and the host works that out instead of assuming a fixed offset.
 */

const QUARTER_HOUR_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;

interface WallClock {
  date: string;
  hour: number;
}

/** The time on the viewer's wall clock at a moment. The same quarter hours come up again and again, so each is worked out once. */
function zoneClock(tz: string): (ms: number) => WallClock {
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
function dayBegins(date: string, clock: (ms: number) => WallClock): number {
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

/** The range's buckets, and which bucket a wall-clock time falls in. */
function bucketsFor(group: ActivityGroup, range: DaySpan): { buckets: ActivityBucket[]; indexOf: (clock: WallClock) => number } {
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

const rate = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/** Reached Recruiter Screen or later, or has an interview booked. */
const GOT_INTERVIEW = `(a.furthest_rank >= 1 OR EXISTS (SELECT 1 FROM interviews i WHERE i.application_id = a.id))`;

export function getActivity(sqlite: Database.Database, viewerId: number, query: ActivityQuery): ActivityResponse {
  const clock = zoneClock(query.tz);
  const group = query.group ?? autoGroup(query.from, query.to);
  const week = weekStart(query.today);
  const month = monthStart(query.today);
  const periods = {
    today: { first: query.today, last: query.today },
    yesterday: { first: addDays(query.today, -1), last: addDays(query.today, -1) },
    week: { first: week, last: addDays(week, 6) },
    month: { first: month, last: monthEnd(month) },
    range: { first: query.from, last: query.to }
  };
  // Instants are stored as ISO-8601 UTC text, so they compare as text.
  const begins = (date: string) => new Date(dayBegins(date, clock)).toISOString();
  const span = (days: DaySpan) => [begins(days.first), begins(addDays(days.last, 1))];
  const [todayFrom, todayTo] = span(periods.today);
  const [yesterdayFrom, yesterdayTo] = span(periods.yesterday);
  const [weekFrom, weekTo] = span(periods.week);
  const [monthFrom, monthTo] = span(periods.month);
  const [from, to] = span(periods.range);

  const people = prepared(
    sqlite,
    `SELECT u.id, u.username, u.display_name, u.is_active, ua.updated_at AS avatar FROM users u LEFT JOIN user_avatars ua ON ua.user_id = u.id ORDER BY u.id`
  ).all() as Array<{ id: number; username: string; display_name: string | null; is_active: number; avatar: string | null }>;

  // One pass over the applications.
  const counts = new Map(
    (
      prepared(
        sqlite,
        `SELECT a.user_id,
                SUM(a.applied_at >= @todayFrom AND a.applied_at < @todayTo) AS today,
                SUM(a.applied_at >= @yesterdayFrom AND a.applied_at < @yesterdayTo) AS yesterday,
                SUM(a.applied_at >= @weekFrom AND a.applied_at < @weekTo) AS week,
                SUM(a.applied_at >= @monthFrom AND a.applied_at < @monthTo) AS month,
                SUM(a.applied_at >= @from AND a.applied_at < @to) AS in_range,
                SUM(a.applied_at >= @from AND a.applied_at < @to AND ${GOT_INTERVIEW}) AS interviews,
                COUNT(*) AS all_time,
                SUM(${GOT_INTERVIEW}) AS all_time_interviews
         FROM applications a GROUP BY a.user_id`
      ).all({ todayFrom, todayTo, yesterdayFrom, yesterdayTo, weekFrom, weekTo, monthFrom, monthTo, from, to }) as Array<{
        user_id: number;
        today: number;
        yesterday: number;
        week: number;
        month: number;
        in_range: number;
        interviews: number;
        all_time: number;
        all_time_interviews: number;
      }>
    ).map((row) => [row.user_id, row])
  );

  // Counted per quarter hour of UTC: inside one, every moment has the same wall-clock hour and day
  // in every time zone, so placing the quarter places all of its applications exactly.
  const { buckets, indexOf } = bucketsFor(group, periods.range);
  const series = new Map<number, number[]>();
  const quarters = prepared(
    sqlite,
    `SELECT a.user_id, substr(a.applied_at, 1, 14) || printf('%02d', CAST(substr(a.applied_at, 15, 2) AS INTEGER) / 15 * 15) AS quarter, COUNT(*) AS total
     FROM applications a WHERE a.applied_at >= @from AND a.applied_at < @to GROUP BY a.user_id, quarter`
  ).all({ from, to }) as Array<{ user_id: number; quarter: string; total: number }>;
  for (const { user_id: userId, quarter, total } of quarters) {
    const index = indexOf(clock(Date.parse(`${quarter}:00.000Z`)));
    if (index < 0 || index >= buckets.length) continue;
    let values = series.get(userId);
    if (!values) {
      values = new Array<number>(buckets.length).fill(0);
      series.set(userId, values);
    }
    values[index] += total;
  }

  const profiles = prepared(
    sqlite,
    `SELECT p.user_id, p.name, COUNT(*) AS total FROM applications a JOIN profiles p ON p.id = a.profile_id
     WHERE a.applied_at >= @from AND a.applied_at < @to GROUP BY p.id ORDER BY total DESC, p.name`
  ).all({ from, to }) as Array<{ user_id: number; name: string; total: number }>;

  const listed: ActivityPerson[] = people
    .map((person) => {
      const row = counts.get(person.id);
      const inRange = row?.in_range ?? 0;
      const interviews = row?.interviews ?? 0;
      const allTime = row?.all_time ?? 0;
      const allTimeInterviews = row?.all_time_interviews ?? 0;
      return {
        user: toUserRef({ id: person.id, username: person.username, displayName: person.display_name, avatarVersion: person.avatar }),
        isMe: person.id === viewerId,
        isActive: person.is_active === 1,
        today: row?.today ?? 0,
        yesterday: row?.yesterday ?? 0,
        week: row?.week ?? 0,
        month: row?.month ?? 0,
        inRange,
        interviews,
        interviewRate: rate(interviews, inRange),
        allTime,
        allTimeInterviews,
        allTimeInterviewRate: rate(allTimeInterviews, allTime),
        series: series.get(person.id) ?? new Array<number>(buckets.length).fill(0),
        profiles: profiles.filter((profile) => profile.user_id === person.id).map(({ name, total }) => ({ name, count: total })),
        rank: 0,
        behindLeader: 0
      };
    })
    // Someone switched off who did nothing in these periods is not part of the comparison.
    .filter((person) => person.isActive || person.isMe || person.inRange > 0 || person.today > 0 || person.yesterday > 0 || person.week > 0 || person.month > 0);

  const ranked = [...listed].sort((a, b) => b.inRange - a.inRange || b.today - a.today || a.user.username.localeCompare(b.user.username));
  const leader = ranked[0]?.inRange ?? 0;
  ranked.forEach((person, position) => {
    person.rank = position + 1;
    person.behindLeader = leader - person.inRange;
  });

  const sum = (key: 'today' | 'yesterday' | 'week' | 'month' | 'inRange' | 'interviews') => listed.reduce((total, person) => total + person[key], 0);
  const team: ActivityCounts = {
    today: sum('today'),
    yesterday: sum('yesterday'),
    week: sum('week'),
    month: sum('month'),
    inRange: sum('inRange'),
    interviews: sum('interviews'),
    interviewRate: rate(sum('interviews'), sum('inRange'))
  };

  return {
    tz: query.tz,
    group,
    periods,
    buckets,
    // The viewer first, then everyone else by rank.
    people: [...ranked.filter((person) => person.isMe), ...ranked.filter((person) => !person.isMe)],
    team
  };
}
