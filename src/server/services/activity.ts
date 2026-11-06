import type Database from 'better-sqlite3';
import type { ActivityCounts, ActivityPerson, ActivityProfile, ActivityQuery, ActivityResponse, DaySpan, TrendSeries, TrendTotals } from '../../shared/api';
import { addDays, autoGroup, monthEnd, monthStart, weekStart, type ActivityGroup } from '../../shared/calendar';
import { prepared } from '../db/client';
import { comparedRanges, previousRange, rate, stageEvents, TrendTally, type EntityTrends } from './trends';
import { toUserRef } from './users';
import { dayBegins, zoneClock } from './zone';

/**
 * Applications per person and per profile, counted in the viewer's own calendar: today, yesterday,
 * this week, this month and a chosen range, the range split into hours, days, weeks or months; how
 * far the range's applications got; the interviews dated in the range; and the trends over the
 * range next to the period before it (see trends.ts).
 *
 * Every period has both ends, so an application dated after today is never counted as today's.
 *
 * The numbers are the same whoever looks: only "me" differs. So they are worked out once for
 * everyone, for a range and time zone, and kept while the data stays the same; each person's answer
 * is put together from them. Ten people with the Team page open cost one count after a change, not ten.
 */

/** Work kept while the data stays the same, shared by everyone's answers: the server's read cache. */
export interface SharedWork {
  value<T>(key: string, compute: () => T): T;
  /** What is kept already, without working it out. */
  peek?<T>(key: string): T | undefined;
}

interface ProfileCounts {
  today: number;
  yesterday: number;
  week: number;
  month: number;
  inRange: number;
  interviews: number;
  screen: number;
  technical: number;
  final: number;
  offer: number;
  rejected: number;
  scheduled: number;
  scheduledToday: number;
}

const noCounts = (): ProfileCounts => ({ today: 0, yesterday: 0, week: 0, month: 0, inRange: 0, interviews: 0, screen: 0, technical: 0, final: 0, offer: 0, rejected: 0, scheduled: 0, scheduledToday: 0 });

interface AllTime {
  applications: number;
  /** Reached Recruiter Screen or later, or has an interview booked. */
  interviews: number;
}

/**
 * Every profile's applications, and how many got an interview: whatever the range, so worked out
 * once while the data stays the same. Those past Applied are counted from the furthest stage kept on
 * each; the rest only need looking up when an interview was booked for one.
 */
function allTimeCounts(sqlite: Database.Database): Map<number, AllTime> {
  const counts = new Map<number, AllTime>();
  // Each from an index alone, without reading the applications themselves.
  for (const row of prepared(sqlite, `SELECT profile_id, COUNT(*) AS applications FROM applications GROUP BY profile_id`).all() as Array<{ profile_id: number; applications: number }>) {
    counts.set(row.profile_id, { applications: row.applications, interviews: 0 });
  }
  for (const row of prepared(sqlite, `SELECT profile_id, COUNT(*) AS screened FROM applications WHERE furthest_rank >= 1 GROUP BY profile_id`).all() as Array<{ profile_id: number; screened: number }>) {
    const found = counts.get(row.profile_id);
    if (found) found.interviews += row.screened;
  }
  for (const row of prepared(
    sqlite,
    `SELECT a.profile_id, COUNT(*) AS booked FROM (SELECT DISTINCT application_id AS id FROM interviews) i JOIN applications a ON a.id = i.id WHERE a.furthest_rank = 0 GROUP BY a.profile_id`
  ).all() as Array<{ profile_id: number; booked: number }>) {
    const found = counts.get(row.profile_id);
    if (found) found.interviews += row.booked;
  }
  return counts;
}

interface Model {
  base: Pick<ActivityResponse, 'tz' | 'group' | 'periods' | 'buckets' | 'previous'>;
  /** Everyone, administrators too: each person's own dashboard is theirs. Nobody is "me" here yet. */
  everyone: Map<number, ActivityPerson>;
  /** The team: every member, switched off or not, but no administrators. Ranked. */
  ranked: ActivityPerson[];
  team: ActivityCounts;
  teamTrends: TrendSeries;
  teamTrendTotals: TrendTotals;
}

function countsOf(person: ActivityPerson): ActivityCounts {
  return {
    today: person.today,
    yesterday: person.yesterday,
    week: person.week,
    month: person.month,
    inRange: person.inRange,
    interviews: person.interviews,
    interviewRate: person.interviewRate,
    reached: { ...person.reached },
    scheduled: person.scheduled,
    scheduledToday: person.scheduledToday
  };
}

/** Everyone's numbers, or with `only` one person's: their own applications are all their numbers need. */
function buildModel(sqlite: Database.Database, query: ActivityQuery, group: ActivityGroup, shared?: SharedWork, only?: number): Model {
  const clock = zoneClock(query.tz);
  const week = weekStart(query.today);
  const month = monthStart(query.today);
  const periods = {
    today: { first: query.today, last: query.today },
    yesterday: { first: addDays(query.today, -1), last: addDays(query.today, -1) },
    week: { first: week, last: addDays(week, 6) },
    month: { first: month, last: monthEnd(month) },
    range: { first: query.from, last: query.to }
  };
  const span = (days: DaySpan) => ({ from: dayBegins(days.first, clock), to: dayBegins(addDays(days.last, 1), clock) });
  const today = span(periods.today);
  const yesterday = span(periods.yesterday);
  const thisWeek = span(periods.week);
  const thisMonth = span(periods.month);
  const range = span(periods.range);
  // Instants are stored as ISO-8601 UTC text, so they compare as text.
  const iso = (ms: number) => new Date(ms).toISOString();

  const people = prepared(
    sqlite,
    `SELECT u.id, u.username, u.display_name, u.is_active, u.role, ua.updated_at AS avatar FROM users u LEFT JOIN user_avatars ua ON ua.user_id = u.id ORDER BY u.id`
  )
    .all()
    .filter((person) => only === undefined || (person as { id: number }).id === only) as Array<{ id: number; username: string; display_name: string | null; is_active: number; role: string; avatar: string | null }>;
  const profileRows = (prepared(sqlite, `SELECT id, user_id, name, is_archived FROM profiles ORDER BY id`).all() as Array<{ id: number; user_id: number; name: string; is_archived: number }>).filter(
    (profile) => only === undefined || profile.user_id === only
  );
  // Administrators look after accounts and the database and are not part of the team. One person alone has no team to add up.
  const members = new Set(only === undefined ? people.filter((person) => person.role !== 'admin').map((person) => person.id) : []);

  // Every measure over the range and the period before it, for the trend charts.
  const previous = previousRange(periods.range);
  const compared = comparedRanges(periods.range, previous, query.today);
  const tally = new TrendTally({ clock, group, range: periods.range, previous, compared }, (userId) => members.has(userId));
  const window = tally.window;
  const allTime = shared ? shared.value('activity:all-time', () => allTimeCounts(sqlite)) : allTimeCounts(sqlite);

  // Applications from the earliest day anything here begins: the period before, or this month or week.
  const counts = new Map<number, ProfileCounts>();
  const countsFor = (profileId: number) => {
    let found = counts.get(profileId);
    if (!found) {
      found = noCounts();
      counts.set(profileId, found);
    }
    return found;
  };
  const since = new Map<number, number>();
  const earliest = Math.min(window.from, yesterday.from, thisWeek.from, thisMonth.from);
  const rows = prepared(
    sqlite,
    // Whether one got an interview only matters for the range's, and only takes looking up for those still at Applied.
    `SELECT a.user_id, a.profile_id, a.applied_at, a.furthest_rank, a.status = 'Rejected',
            CASE WHEN a.furthest_rank >= 1 THEN 1 WHEN a.applied_at >= @from AND a.applied_at < @to THEN EXISTS (SELECT 1 FROM interviews iv WHERE iv.application_id = a.id) ELSE 0 END
     FROM applications a WHERE a.applied_at >= @earliest${only === undefined ? '' : ' AND a.user_id = @only'}`
  )
    .raw(true)
    .all({ earliest: iso(earliest), from: iso(range.from), to: iso(range.to), ...(only === undefined ? {} : { only }) }) as Array<[number, number, string, number, number, number]>;
  for (const [userId, profileId, appliedAt, furthest, rejected, interviewed] of rows) {
    const at = Date.parse(appliedAt);
    const own = countsFor(profileId);
    if (at >= today.from && at < today.to) own.today += 1;
    if (at >= yesterday.from && at < yesterday.to) own.yesterday += 1;
    if (at >= thisWeek.from && at < thisWeek.to) own.week += 1;
    if (at >= thisMonth.from && at < thisMonth.to) own.month += 1;
    if (at >= range.from && at < range.to) {
      own.inRange += 1;
      if (interviewed) own.interviews += 1;
      if (furthest >= 1) own.screen += 1;
      if (furthest >= 2) own.technical += 1;
      if (furthest >= 3) own.final += 1;
      if (furthest >= 4) own.offer += 1;
      if (rejected) own.rejected += 1;
    }
    if (!(at < window.from)) {
      since.set(profileId, (since.get(profileId) ?? 0) + 1);
      tally.add(userId, profileId, 'bids', at);
    }
  }
  // Every earlier bid counts towards success, all at once.
  const owners = new Map(profileRows.map((profile) => [profile.id, profile.user_id]));
  for (const [profileId, total] of allTime) {
    const owner = owners.get(profileId);
    if (owner !== undefined) tally.addBefore(owner, profileId, 'bids', total.applications - (since.get(profileId) ?? 0));
  }
  for (const { userId, profileId, times } of stageEvents(sqlite, { from: iso(window.from), to: iso(window.to) }, only)) {
    tally.add(userId, profileId, 'interviews', times[0]);
    tally.add(userId, profileId, 'technical', times[1]);
    tally.add(userId, profileId, 'final', times[2]);
    tally.add(userId, profileId, 'offers', times[3]);
  }

  // Interviews by the date they take place, whenever their application was made.
  for (const row of prepared(
    sqlite,
    `SELECT a.profile_id,
            SUM(i.scheduled_at >= @from AND i.scheduled_at < @to) AS scheduled,
            SUM(i.scheduled_at >= @todayFrom AND i.scheduled_at < @todayTo) AS scheduled_today
     FROM interviews i JOIN applications a ON a.id = i.application_id
     WHERE ((i.scheduled_at >= @from AND i.scheduled_at < @to) OR (i.scheduled_at >= @todayFrom AND i.scheduled_at < @todayTo))${only === undefined ? '' : ' AND a.user_id = @only'}
     GROUP BY a.profile_id`
  ).all({ from: iso(range.from), to: iso(range.to), todayFrom: iso(today.from), todayTo: iso(today.to), ...(only === undefined ? {} : { only }) }) as Array<{ profile_id: number; scheduled: number; scheduled_today: number }>) {
    const own = countsFor(row.profile_id);
    own.scheduled = row.scheduled;
    own.scheduledToday = row.scheduled_today;
  }

  const everyone = new Map<number, ActivityPerson>();
  for (const person of people) {
    const totals = noCounts();
    let applications = 0;
    let interviewed = 0;
    const profiles: ActivityProfile[] = [];
    for (const profile of profileRows) {
      if (profile.user_id !== person.id) continue;
      const own = counts.get(profile.id) ?? noCounts();
      const ever = allTime.get(profile.id);
      for (const key of Object.keys(totals) as Array<keyof ProfileCounts>) totals[key] += own[key];
      applications += ever?.applications ?? 0;
      interviewed += ever?.interviews ?? 0;
      // An archived profile with no history is left out; one in use always shows, even at nothing.
      if (profile.is_archived === 1 && !ever) continue;
      const profileTrends = tally.forProfile(profile.id);
      profiles.push({
        id: profile.id,
        name: profile.name,
        isArchived: profile.is_archived === 1,
        today: own.today,
        inRange: own.inRange,
        interviews: own.interviews,
        interviewRate: rate(own.interviews, own.inRange),
        allTime: ever?.applications ?? 0,
        allTimeInterviews: ever?.interviews ?? 0,
        allTimeInterviewRate: rate(ever?.interviews ?? 0, ever?.applications ?? 0),
        // The range's applications, bucket by bucket, are the bids line itself.
        series: profileTrends.trends.bids as number[],
        trends: profileTrends.trends,
        trendTotals: profileTrends.trendTotals
      });
    }
    profiles.sort((a, b) => b.inRange - a.inRange || b.allTime - a.allTime || a.name.localeCompare(b.name));
    const personTrends: EntityTrends = tally.forPerson(person.id);
    everyone.set(person.id, {
      user: toUserRef({ id: person.id, username: person.username, displayName: person.display_name, avatarVersion: person.avatar }),
      isMe: false,
      isActive: person.is_active === 1,
      today: totals.today,
      yesterday: totals.yesterday,
      week: totals.week,
      month: totals.month,
      inRange: totals.inRange,
      interviews: totals.interviews,
      interviewRate: rate(totals.interviews, totals.inRange),
      reached: { screen: totals.screen, technical: totals.technical, final: totals.final, offer: totals.offer, rejected: totals.rejected },
      scheduled: totals.scheduled,
      scheduledToday: totals.scheduledToday,
      allTime: applications,
      allTimeInterviews: interviewed,
      allTimeInterviewRate: rate(interviewed, applications),
      series: personTrends.trends.bids as number[],
      profiles,
      rank: 0,
      behindLeader: 0,
      ...personTrends
    });
  }

  // Ties go to whoever did more today, then this week, then this month, and only then by name.
  const ranked = [...everyone.values()]
    .filter((person) => members.has(person.user.id))
    .sort((a, b) => b.inRange - a.inRange || b.today - a.today || b.week - a.week || b.month - a.month || a.user.username.localeCompare(b.user.username));
  const leader = ranked[0]?.inRange ?? 0;
  ranked.forEach((person, position) => {
    person.rank = position + 1;
    person.behindLeader = leader - person.inRange;
  });

  const sum = (pick: (person: ActivityPerson) => number) => ranked.reduce((total, person) => total + pick(person), 0);
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
  const teamTrends = tally.forTeam();

  return {
    base: { tz: query.tz, group, periods, buckets: tally.current.buckets, previous: { range: previous, buckets: tally.earlier.buckets, compared } },
    everyone,
    ranked,
    team,
    teamTrends: teamTrends.trends,
    teamTrendTotals: teamTrends.trendTotals
  };
}

/**
 * The numbers as one person sees them: everyone on the team, with the viewer first, or the viewer
 * alone. With `shared`, the counting behind the team's is done once for everyone who asks. The
 * viewer alone comes from the team's when those are counted already, and otherwise only the
 * viewer's own applications are counted: a tenth of the work, on a team of ten.
 */
export function getActivity(sqlite: Database.Database, viewerId: number, query: ActivityQuery, shared?: SharedWork): ActivityResponse {
  const group = query.group ?? autoGroup(query.from, query.to);
  const key = `activity:${query.tz}|${query.today}|${query.from}|${query.to}|${group}`;

  if (query.scope === 'me') {
    const counted = shared?.peek?.<Model>(key);
    const model = counted?.everyone.has(viewerId) ? counted : buildModel(sqlite, query, group, shared, viewerId);
    const own = model.everyone.get(viewerId);
    if (!own) throw new Error(`No user ${viewerId} to count for.`);
    const me: ActivityPerson = { ...own, isMe: true, rank: 1, behindLeader: 0 };
    return { ...model.base, people: [me], team: countsOf(me), teamTrends: me.trends, teamTrendTotals: me.trendTotals };
  }
  const build = () => buildModel(sqlite, query, group, shared);
  const model = shared ? shared.value(key, build) : build();
  // The viewer first, then everyone else by rank.
  const people = model.ranked.map((person) => (person.user.id === viewerId ? { ...person, isMe: true } : person));
  return {
    ...model.base,
    people: [...people.filter((person) => person.isMe), ...people.filter((person) => !person.isMe)],
    team: model.team,
    teamTrends: model.teamTrends,
    teamTrendTotals: model.teamTrendTotals
  };
}
