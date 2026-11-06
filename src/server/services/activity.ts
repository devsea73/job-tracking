import type Database from 'better-sqlite3';
import type { ActivityBucket, ActivityCounts, ActivityPerson, ActivityProfile, ActivityQuery, ActivityResponse, DaySpan } from '../../shared/api';
import { addDays, addMonths, autoGroup, daysBetween, monthEnd, monthStart, weekStart, type ActivityGroup } from '../../shared/calendar';
import { prepared } from '../db/client';
import { toUserRef } from './users';

/**
 * Applications per person and per profile, counted in the viewer's own calendar: today, yesterday,
 * this week, this month and a chosen range, the range split into hours, days, weeks or months; how
 * far the range's applications got; and the interviews dated in the range.
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
const GOT_INTERVIEW = `(a.furthest_rank >= 1 OR EXISTS (SELECT 1 FROM interviews iv WHERE iv.application_id = a.id))`;

/** A quarter hour of UTC, from an ISO-8601 instant column: 2026-11-05T14:30. */
const quarterOf = (column: string) => `substr(${column}, 1, 14) || printf('%02d', CAST(substr(${column}, 15, 2) AS INTEGER) / 15 * 15)`;

interface ProfileRow {
  profile_id: number;
  today: number;
  yesterday: number;
  week: number;
  month: number;
  in_range: number;
  interviews: number;
  screen: number;
  technical: number;
  final: number;
  offer: number;
  rejected: number;
  all_time: number;
  all_time_interviews: number;
}

const COUNTED = ['today', 'yesterday', 'week', 'month', 'in_range', 'interviews', 'screen', 'technical', 'final', 'offer', 'rejected', 'all_time', 'all_time_interviews'] as const;
type Totals = Record<(typeof COUNTED)[number] | 'scheduled' | 'scheduled_today', number>;
const nothing = (): Totals => Object.fromEntries([...COUNTED, 'scheduled', 'scheduled_today'].map((key) => [key, 0])) as Totals;

function countsOf(totals: Totals): ActivityCounts {
  return {
    today: totals.today,
    yesterday: totals.yesterday,
    week: totals.week,
    month: totals.month,
    inRange: totals.in_range,
    interviews: totals.interviews,
    interviewRate: rate(totals.interviews, totals.in_range),
    reached: { screen: totals.screen, technical: totals.technical, final: totals.final, offer: totals.offer, rejected: totals.rejected },
    scheduled: totals.scheduled,
    scheduledToday: totals.scheduled_today
  };
}

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
    `SELECT u.id, u.username, u.display_name, u.is_active, u.role, ua.updated_at AS avatar FROM users u LEFT JOIN user_avatars ua ON ua.user_id = u.id ORDER BY u.id`
  ).all() as Array<{ id: number; username: string; display_name: string | null; is_active: number; role: string; avatar: string | null }>;
  const profileRows = prepared(sqlite, `SELECT id, user_id, name, is_archived FROM profiles ORDER BY id`).all() as Array<{ id: number; user_id: number; name: string; is_archived: number }>;

  // One pass over the applications, per profile. A person's numbers are their profiles' added up.
  const inRange = `a.applied_at >= @from AND a.applied_at < @to`;
  const byProfile = new Map(
    (
      prepared(
        sqlite,
        `SELECT a.profile_id,
                SUM(a.applied_at >= @todayFrom AND a.applied_at < @todayTo) AS today,
                SUM(a.applied_at >= @yesterdayFrom AND a.applied_at < @yesterdayTo) AS yesterday,
                SUM(a.applied_at >= @weekFrom AND a.applied_at < @weekTo) AS week,
                SUM(a.applied_at >= @monthFrom AND a.applied_at < @monthTo) AS month,
                SUM(${inRange}) AS in_range,
                SUM(${inRange} AND ${GOT_INTERVIEW}) AS interviews,
                SUM(${inRange} AND a.furthest_rank >= 1) AS screen,
                SUM(${inRange} AND a.furthest_rank >= 2) AS technical,
                SUM(${inRange} AND a.furthest_rank >= 3) AS final,
                SUM(${inRange} AND a.furthest_rank >= 4) AS offer,
                SUM(${inRange} AND a.status = 'Rejected') AS rejected,
                COUNT(*) AS all_time,
                SUM(${GOT_INTERVIEW}) AS all_time_interviews
         FROM applications a GROUP BY a.profile_id`
      ).all({ todayFrom, todayTo, yesterdayFrom, yesterdayTo, weekFrom, weekTo, monthFrom, monthTo, from, to }) as ProfileRow[]
    ).map((row) => [row.profile_id, row])
  );

  // Interviews by the date they take place, whenever their application was made.
  const scheduled = new Map(
    (
      prepared(
        sqlite,
        `SELECT a.profile_id,
                SUM(i.scheduled_at >= @from AND i.scheduled_at < @to) AS scheduled,
                SUM(i.scheduled_at >= @todayFrom AND i.scheduled_at < @todayTo) AS scheduled_today
         FROM interviews i JOIN applications a ON a.id = i.application_id
         WHERE (i.scheduled_at >= @from AND i.scheduled_at < @to) OR (i.scheduled_at >= @todayFrom AND i.scheduled_at < @todayTo)
         GROUP BY a.profile_id`
      ).all({ from, to, todayFrom, todayTo }) as Array<{ profile_id: number; scheduled: number; scheduled_today: number }>
    ).map((row) => [row.profile_id, row])
  );

  // Counted per quarter hour of UTC: inside one, every moment has the same wall-clock hour and day
  // in every time zone, so placing the quarter places everything in it exactly.
  const { buckets, indexOf } = bucketsFor(group, periods.range);
  const empty = () => new Array<number>(buckets.length).fill(0);
  const place = (rows: Array<{ id: number; quarter: string; total: number }>): Map<number, number[]> => {
    const series = new Map<number, number[]>();
    for (const { id, quarter, total } of rows) {
      const index = indexOf(clock(Date.parse(`${quarter}:00.000Z`)));
      if (index < 0 || index >= buckets.length) continue;
      let values = series.get(id);
      if (!values) {
        values = empty();
        series.set(id, values);
      }
      values[index] += total;
    }
    return series;
  };
  type QuarterRow = { id: number; quarter: string; total: number };
  const profileSeries = place(
    prepared(sqlite, `SELECT a.profile_id AS id, ${quarterOf('a.applied_at')} AS quarter, COUNT(*) AS total FROM applications a WHERE ${inRange} GROUP BY a.profile_id, quarter`).all({ from, to }) as QuarterRow[]
  );
  const interviewSeries = place(
    prepared(
      sqlite,
      `SELECT a.user_id AS id, ${quarterOf('i.scheduled_at')} AS quarter, COUNT(*) AS total FROM interviews i JOIN applications a ON a.id = i.application_id
       WHERE i.scheduled_at >= @from AND i.scheduled_at < @to GROUP BY a.user_id, quarter`
    ).all({ from, to }) as QuarterRow[]
  );

  // Me alone; or every member of the team, switched off or not. Administrators look after
  // accounts and the database and are not part of the team.
  const listed: ActivityPerson[] = people
    .filter((person) => (query.scope === 'me' ? person.id === viewerId : person.role !== 'admin'))
    .map((person) => {
      const totals = nothing();
      const series = empty();
      const profiles: ActivityProfile[] = [];
      for (const profile of profileRows) {
        if (profile.user_id !== person.id) continue;
        const row = byProfile.get(profile.id);
        const booked = scheduled.get(profile.id);
        for (const key of COUNTED) totals[key] += row?.[key] ?? 0;
        totals.scheduled += booked?.scheduled ?? 0;
        totals.scheduled_today += booked?.scheduled_today ?? 0;
        const own = profileSeries.get(profile.id);
        own?.forEach((value, index) => (series[index] += value));
        // An archived profile with no history is left out; one in use always shows, even at nothing.
        if (profile.is_archived === 1 && !row) continue;
        profiles.push({
          id: profile.id,
          name: profile.name,
          isArchived: profile.is_archived === 1,
          today: row?.today ?? 0,
          inRange: row?.in_range ?? 0,
          interviews: row?.interviews ?? 0,
          interviewRate: rate(row?.interviews ?? 0, row?.in_range ?? 0),
          allTime: row?.all_time ?? 0,
          allTimeInterviews: row?.all_time_interviews ?? 0,
          allTimeInterviewRate: rate(row?.all_time_interviews ?? 0, row?.all_time ?? 0),
          series: own ?? empty()
        });
      }
      profiles.sort((a, b) => b.inRange - a.inRange || b.allTime - a.allTime || a.name.localeCompare(b.name));
      return {
        user: toUserRef({ id: person.id, username: person.username, displayName: person.display_name, avatarVersion: person.avatar }),
        isMe: person.id === viewerId,
        isActive: person.is_active === 1,
        ...countsOf(totals),
        allTime: totals.all_time,
        allTimeInterviews: totals.all_time_interviews,
        allTimeInterviewRate: rate(totals.all_time_interviews, totals.all_time),
        series,
        interviewSeries: interviewSeries.get(person.id) ?? empty(),
        profiles,
        rank: 0,
        behindLeader: 0
      };
    });

  // Ties go to whoever did more today, then this week, then this month, and only then by name.
  const ranked = [...listed].sort((a, b) => b.inRange - a.inRange || b.today - a.today || b.week - a.week || b.month - a.month || a.user.username.localeCompare(b.user.username));
  const leader = ranked[0]?.inRange ?? 0;
  ranked.forEach((person, position) => {
    person.rank = position + 1;
    person.behindLeader = leader - person.inRange;
  });

  const sum = (pick: (person: ActivityPerson) => number) => listed.reduce((total, person) => total + pick(person), 0);
  const team: ActivityCounts = {
    today: sum((person) => person.today),
    yesterday: sum((person) => person.yesterday),
    week: sum((person) => person.week),
    month: sum((person) => person.month),
    inRange: sum((person) => person.inRange),
    interviews: sum((person) => person.interviews),
    interviewRate: rate(
      sum((person) => person.interviews),
      sum((person) => person.inRange)
    ),
    reached: {
      screen: sum((person) => person.reached.screen),
      technical: sum((person) => person.reached.technical),
      final: sum((person) => person.reached.final),
      offer: sum((person) => person.reached.offer),
      rejected: sum((person) => person.reached.rejected)
    },
    scheduled: sum((person) => person.scheduled),
    scheduledToday: sum((person) => person.scheduledToday)
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
