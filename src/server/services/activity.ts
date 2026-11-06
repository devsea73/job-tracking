import type Database from 'better-sqlite3';
import type { ActivityPerson, ActivityQuery, ActivityResponse } from '../../shared/api';
import { prepared } from '../db/client';
import { toUserRef } from './users';

/**
 * Applications per person by when they applied: today, this week, this month and a chosen range,
 * with how many of the range's applications got an interview so far. The viewer's computer sets
 * where days and weeks begin, so "today" is their today, and places the hourly counts in its days.
 */
export function getActivity(sqlite: Database.Database, viewerId: number, query: ActivityQuery): ActivityResponse {
  const params = { day: query.day, week: query.week, month: query.month, from: query.from, to: query.to };

  const people = sqlite
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.is_active, ua.updated_at AS avatar FROM users u LEFT JOIN user_avatars ua ON ua.user_id = u.id ORDER BY u.id`
    )
    .all() as Array<{ id: number; username: string; display_name: string | null; is_active: number; avatar: string | null }>;

  // One pass over the applications. "Got an interview": reached Recruiter Screen or later, or has one scheduled.
  const counts = new Map(
    (
      prepared(
        sqlite,
        `SELECT a.user_id,
                SUM(a.applied_at >= @day) AS today,
                SUM(a.applied_at >= @week) AS week,
                SUM(a.applied_at >= @month) AS month,
                SUM(a.applied_at >= @from AND a.applied_at < @to) AS in_range,
                SUM(a.applied_at >= @from AND a.applied_at < @to AND (a.furthest_rank >= 1 OR EXISTS (SELECT 1 FROM interviews i WHERE i.application_id = a.id))) AS interviews,
                COUNT(*) AS all_time
         FROM applications a GROUP BY a.user_id`
      ).all(params) as Array<{ user_id: number; today: number; week: number; month: number; in_range: number; interviews: number; all_time: number }>
    ).map((row) => [row.user_id, row])
  );

  // UTC hours: the viewer's computer knows its own day boundaries, daylight saving time included.
  const hours = prepared(
    sqlite,
    `SELECT a.user_id, substr(a.applied_at, 1, 13) AS hour, COUNT(*) AS total
     FROM applications a WHERE a.applied_at >= @from AND a.applied_at < @to GROUP BY a.user_id, hour ORDER BY hour`
  ).all({ from: query.from, to: query.to }) as Array<{ user_id: number; hour: string; total: number }>;

  const profiles = prepared(
    sqlite,
    `SELECT p.user_id, p.name, COUNT(*) AS total FROM applications a JOIN profiles p ON p.id = a.profile_id
     WHERE a.applied_at >= @from AND a.applied_at < @to GROUP BY p.id ORDER BY total DESC`
  ).all({ from: query.from, to: query.to }) as Array<{ user_id: number; name: string; total: number }>;

  const result: ActivityPerson[] = people
    .map((person) => {
      const row = counts.get(person.id);
      const inRange = row?.in_range ?? 0;
      const interviews = row?.interviews ?? 0;
      return {
        user: toUserRef({ id: person.id, username: person.username, displayName: person.display_name, avatarVersion: person.avatar }),
        isMe: person.id === viewerId,
        isActive: person.is_active === 1,
        today: row?.today ?? 0,
        week: row?.week ?? 0,
        month: row?.month ?? 0,
        inRange,
        allTime: row?.all_time ?? 0,
        interviews,
        interviewRate: inRange > 0 ? Math.round((interviews / inRange) * 1000) / 10 : null,
        hours: hours.filter((point) => point.user_id === person.id).map((point): [string, number] => [point.hour, point.total]),
        profiles: profiles.filter((profile) => profile.user_id === person.id).map(({ name, total }) => ({ name, count: total }))
      };
    })
    // Someone who left and did nothing in this range is not part of the comparison.
    .filter((person) => person.isActive || person.inRange > 0 || person.isMe);

  // Ranked by applications in the range, then today's.
  const ranked = [...result].sort((a, b) => b.inRange - a.inRange || b.today - a.today || a.user.username.localeCompare(b.user.username));
  ranked.forEach((person, position) => {
    person.rank = position + 1;
  });
  const leader = ranked[0]?.inRange ?? 0;
  for (const person of result) person.behindLeader = leader - person.inRange;
  // The viewer first, then everyone else by rank.
  const ordered = [...ranked.filter((person) => person.isMe), ...ranked.filter((person) => !person.isMe)];
  return { from: query.from, to: query.to, people: ordered };
}
