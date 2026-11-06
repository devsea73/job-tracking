import { asc, desc, eq, sql } from 'drizzle-orm';
import type {
  ApplicationDetail,
  ApplicationSummary,
  DashboardResponse,
  InterviewListItem,
  InterviewQuery,
  JobDetail,
  JobListItem,
  JobListQuery,
  JobListResponse,
  TeamMember
} from '../../shared/api';
import { APPLICATION_STATUSES, CLOSED_STATUSES, type ApplicationStatus, type InterviewStage } from '../../shared/constants';
import { PIPELINE_STAGES, statsFromCounts, type ReachedCounts } from '../../shared/pipeline';
import type { AppContext } from '../context';
import { prepared, type Db } from '../db/client';
import { applicationStatusHistory, interviews, jobs, jobUrls, users } from '../db/schema';
import { notFound } from '../errors';
import { FACTS_COLUMNS, readJobFacts, toJobFacts, type FactsRow } from './job-facts-store';
import { toProfileRef } from './profiles';
import { toUserRef } from './users';

const MEMO_PREVIEW_LENGTH = 140;

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function searchTokens(query: string): string[] {
  return (query.normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/gu) ?? []).slice(0, 8);
}

interface JobRow extends FactsRow {
  id: number;
  title: string;
  company_name: string;
  location: string | null;
  is_highlighted: number;
  created_at: string;
  updated_at: string;
}

const STATUS_ORDER = `CASE x.status ${APPLICATION_STATUSES.map((status, index) => `WHEN '${status}' THEN ${index}`).join(' ')} END`;

/**
 * Which applications a listing is looking at: all of them, or those of one person or profile.
 * Interview dates and statuses in the sort order come from these. Every id here has already
 * been validated as an integer, and Number() keeps it that way inside the SQL text.
 */
function relevantApplications(userId: number, query: JobListQuery): string {
  const conditions: string[] = [];
  if (query.scope === 'mine') conditions.push(`x.user_id = ${Number(userId)}`);
  if (query.scope === 'others') conditions.push(`x.user_id != ${Number(userId)}`);
  if (query.personId) conditions.push(`x.user_id = ${Number(query.personId)}`);
  if (query.profileId) conditions.push(`x.profile_id = ${Number(query.profileId)}`);
  return conditions.length ? conditions.join(' AND ') : '1';
}

interface SortPlan {
  /** Joined once and read for every job, rather than asked for again per job. */
  join: string;
  joinParams: unknown[];
  order: string;
}

/**
 * Sorts by a counter kept on the job where one exists, which an index answers without touching
 * other rows. The rest gather the key for all jobs in one pass over the applications.
 */
function sortPlan(userId: number, query: JobListQuery, now: string): SortPlan {
  const relevant = relevantApplications(userId, query);
  const everyone = relevant === '1';
  const keys = (select: string, from = 'applications x') => `LEFT JOIN (SELECT x.job_id, ${select} AS sort_key FROM ${from} WHERE ${relevant} GROUP BY x.job_id) s ON s.job_id = j.id`;
  switch (query.sort ?? 'recent') {
    case 'recent':
      // Mine: when I added it here, which an imported list can make differ from when I applied.
      if (query.scope === 'mine') return { join: keys('MAX(x.id)'), joinParams: [], order: 's.sort_key DESC' };
      return { join: '', joinParams: [], order: 'j.created_at DESC' };
    case 'applied':
      // Mine: when I applied. Otherwise: the latest anyone shown applied.
      return { join: keys('MAX(x.applied_at)'), joinParams: [], order: 's.sort_key IS NULL, s.sort_key DESC' };
    case 'updated':
      if (everyone) return { join: '', joinParams: [], order: 'j.last_activity_at DESC' };
      return { join: keys('MAX(x.updated_at)'), joinParams: [], order: "MAX(j.updated_at, COALESCE(s.sort_key, '')) DESC" };
    case 'company':
      return { join: '', joinParams: [], order: 'j.company_name COLLATE NOCASE ASC, j.title COLLATE NOCASE ASC' };
    case 'interview':
      return {
        join: `LEFT JOIN (SELECT x.job_id, MIN(n.scheduled_at) AS sort_key FROM interviews n JOIN applications x ON x.id = n.application_id WHERE n.scheduled_at >= ? AND ${relevant} GROUP BY x.job_id) s ON s.job_id = j.id`,
        joinParams: [now],
        order: 's.sort_key IS NULL, s.sort_key ASC'
      };
    case 'status':
      return { join: keys(`MIN(${STATUS_ORDER})`), joinParams: [], order: 's.sort_key IS NULL, s.sort_key ASC' };
    case 'applicants':
      return { join: '', joinParams: [], order: 'j.application_count DESC' };
  }
}

/**
 * The shared list of jobs. Every filter that looks at applications has to match on one and the
 * same application: "Technical Interview" and "Tyler" together mean Tyler is at that stage, not
 * that Tyler applied while somebody else is.
 */
export function listJobs(db: Db, userId: number, query: JobListQuery): JobListResponse {
  const where: string[] = [];
  const params: unknown[] = [];

  for (const token of searchTokens(query.q ?? '')) {
    const like = `%${escapeLike(token)}%`;
    const match = `"${token.replace(/"/g, '""')}"*`;
    where.push(`(
      j.id IN (
        SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?
        UNION SELECT m.job_id FROM applications_fts f JOIN applications m ON m.id = f.rowid WHERE applications_fts MATCH ?
      )
      OR j.company_name LIKE ? ESCAPE '\\'
      OR j.title LIKE ? ESCAPE '\\'
    )`);
    params.push(match, match, like, like);
  }
  if (query.company) {
    where.push(`j.company_name LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(query.company)}%`);
  }
  if (query.highlighted) where.push('j.is_highlighted = 1');

  const onApplication: string[] = [];
  const applicationParams: unknown[] = [];
  if (query.scope === 'mine') {
    onApplication.push('a.user_id = ?');
    applicationParams.push(userId);
  }
  if (query.scope === 'others') {
    onApplication.push('a.user_id != ?');
    applicationParams.push(userId);
  }
  if (query.personId) {
    onApplication.push('a.user_id = ?');
    applicationParams.push(query.personId);
  }
  if (query.profileId) {
    onApplication.push('a.profile_id = ?');
    applicationParams.push(query.profileId);
  }
  if (query.status) {
    onApplication.push('a.status = ?');
    applicationParams.push(query.status);
  }
  if (query.stage || query.interviewFrom || query.interviewTo) {
    const conditions = ['i.application_id = a.id'];
    if (query.stage) {
      conditions.push('i.stage = ?');
      applicationParams.push(query.stage);
    }
    if (query.interviewFrom) {
      conditions.push('i.scheduled_at >= ?');
      applicationParams.push(new Date(query.interviewFrom).toISOString());
    }
    if (query.interviewTo) {
      conditions.push('i.scheduled_at <= ?');
      applicationParams.push(new Date(query.interviewTo).toISOString());
    }
    onApplication.push(`EXISTS (SELECT 1 FROM interviews i WHERE ${conditions.join(' AND ')})`);
  }
  if (onApplication.length > 0) {
    // Worked out once from the applications, rather than checked again for each of 10,000 jobs.
    where.push(`j.id IN (SELECT a.job_id FROM applications a WHERE ${onApplication.join(' AND ')})`);
    params.push(...applicationParams);
  }

  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sqlite = db.$client;
  const total = prepared(sqlite, `SELECT COUNT(*) AS total FROM jobs j ${filter}`).get(...params) as { total: number };

  const plan = sortPlan(userId, query, new Date().toISOString());
  const order = [query.highlightFirst ? 'j.is_highlighted DESC' : null, plan.order, 'j.id DESC'].filter(Boolean).join(', ');
  const rows = prepared(
    sqlite,
    `SELECT j.id, j.title, j.company_name, j.location, j.is_highlighted, j.created_at, j.updated_at, ${FACTS_COLUMNS}
     FROM jobs j LEFT JOIN job_facts f ON f.job_id = j.id ${plan.join} ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...plan.joinParams, ...params, query.limit ?? 100, query.offset ?? 0) as JobRow[];

  const byJob = listApplicationsForJobs(
    db,
    userId,
    rows.map((row) => row.id)
  );
  return {
    total: total.total,
    items: rows.map(
      (row): JobListItem => ({
        id: row.id,
        title: row.title,
        company: row.company_name,
        location: row.location,
        isHighlighted: row.is_highlighted === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        facts: toJobFacts(row),
        applications: byJob.get(row.id) ?? []
      })
    )
  };
}

interface ApplicationRow {
  id: number;
  job_id: number;
  status: ApplicationStatus;
  memo: string;
  furthest_rank: number;
  applied_at: string;
  updated_at: string;
  user_id: number;
  username: string;
  display_name: string | null;
  user_avatar: string | null;
  profile_id: number;
  profile_name: string;
  is_archived: number;
  profile_avatar: string | null;
  next_interview: string | null;
  interview_count: number;
}

const APPLICATION_COLUMNS = `
  a.id, a.job_id, a.status, a.memo, a.furthest_rank, a.applied_at, a.updated_at,
  u.id AS user_id, u.username, u.display_name, ua.updated_at AS user_avatar,
  p.id AS profile_id, p.name AS profile_name, p.is_archived, pa.updated_at AS profile_avatar,
  (SELECT MIN(n.scheduled_at) FROM interviews n WHERE n.application_id = a.id AND n.scheduled_at >= @now) AS next_interview,
  (SELECT COUNT(*) FROM interviews c WHERE c.application_id = a.id) AS interview_count`;

const APPLICATION_JOINS = `
  FROM applications a
  JOIN users u ON u.id = a.user_id
  JOIN profiles p ON p.id = a.profile_id
  LEFT JOIN user_avatars ua ON ua.user_id = u.id
  LEFT JOIN profile_avatars pa ON pa.profile_id = p.id`;

function toApplicationSummary(row: ApplicationRow, viewerId: number): ApplicationSummary {
  return {
    id: row.id,
    owner: toUserRef({ id: row.user_id, username: row.username, displayName: row.display_name, avatarVersion: row.user_avatar }),
    profile: toProfileRef({ id: row.profile_id, name: row.profile_name, isArchived: row.is_archived === 1, avatarVersion: row.profile_avatar }),
    isMine: row.user_id === viewerId,
    status: row.status,
    furthestStage: PIPELINE_STAGES[row.furthest_rank] ?? PIPELINE_STAGES[0],
    memoPreview: row.memo.slice(0, MEMO_PREVIEW_LENGTH),
    nextInterviewAt: row.next_interview,
    interviewCount: row.interview_count,
    appliedAt: row.applied_at,
    updatedAt: row.updated_at
  };
}

/** Everyone's applications for these jobs, oldest first, read together in one query. */
export function listApplicationsForJobs(db: Db, viewerId: number, jobIds: number[]): Map<number, ApplicationSummary[]> {
  const result = new Map<number, ApplicationSummary[]>();
  if (jobIds.length === 0) return result;
  const rows = prepared(
    db.$client,
    `SELECT ${APPLICATION_COLUMNS} ${APPLICATION_JOINS} WHERE a.job_id IN (SELECT value FROM json_each(@jobIds)) ORDER BY a.applied_at ASC, a.id ASC`
  ).all({ now: new Date().toISOString(), jobIds: JSON.stringify(jobIds) }) as ApplicationRow[];
  for (const row of rows) {
    const list = result.get(row.job_id) ?? [];
    list.push(toApplicationSummary(row, viewerId));
    result.set(row.job_id, list);
  }
  return result;
}

function toApplicationDetail(db: Db, row: ApplicationRow, viewerId: number): ApplicationDetail {
  return {
    ...toApplicationSummary(row, viewerId),
    memo: row.memo,
    interviews: db
      .select()
      .from(interviews)
      .where(eq(interviews.applicationId, row.id))
      .orderBy(asc(interviews.scheduledAt))
      .all()
      .map((interview) => ({ ...interview, stage: interview.stage as InterviewStage })),
    history: db
      .select()
      .from(applicationStatusHistory)
      .where(eq(applicationStatusHistory.applicationId, row.id))
      .orderBy(desc(applicationStatusHistory.changedAt), desc(applicationStatusHistory.id))
      .all()
      .map((entry) => ({ id: entry.id, oldStatus: entry.oldStatus, newStatus: entry.newStatus, changedAt: entry.changedAt }))
  };
}

export function getApplicationDetail(db: Db, viewerId: number, applicationId: number): ApplicationDetail | null {
  const row = prepared(db.$client, `SELECT ${APPLICATION_COLUMNS} ${APPLICATION_JOINS} WHERE a.id = @id`).get({ now: new Date().toISOString(), id: applicationId }) as ApplicationRow | undefined;
  return row ? toApplicationDetail(db, row, viewerId) : null;
}

export function listCompanies(db: Db): string[] {
  return db
    .selectDistinct({ company: jobs.companyName })
    .from(jobs)
    .orderBy(sql`${jobs.companyName} collate nocase`)
    .limit(2_000)
    .all()
    .map((row) => row.company);
}

export function getJobDetail(ctx: AppContext, viewerId: number, jobId: number): JobDetail {
  const db = ctx.db;
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw notFound('That job no longer exists.');
  const highlighter = job.highlightedBy ? db.select({ username: users.username }).from(users).where(eq(users.id, job.highlightedBy)).get() : null;
  const rows = prepared(db.$client, `SELECT ${APPLICATION_COLUMNS} ${APPLICATION_JOINS} WHERE a.job_id = @jobId ORDER BY a.applied_at ASC, a.id ASC`).all({
    now: new Date().toISOString(),
    jobId
  }) as ApplicationRow[];
  return {
    id: job.id,
    title: job.title,
    company: job.companyName,
    location: job.location,
    description: job.description,
    canonicalUrl: job.canonicalUrl,
    isHighlighted: job.isHighlighted,
    highlightedBy: highlighter?.username ?? null,
    highlightedAt: job.highlightedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastExtractedAt: job.lastExtractedAt,
    extractionMethod: job.extractionMethod,
    urls: db.select().from(jobUrls).where(eq(jobUrls.jobId, jobId)).orderBy(asc(jobUrls.id)).all(),
    facts: readJobFacts(db.$client, jobId),
    applications: rows.map((row) => toApplicationDetail(db, row, viewerId))
  };
}

interface InterviewRow extends FactsRow {
  id: number;
  applicationId: number;
  stage: InterviewStage;
  scheduledAt: string;
  timezone: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  jobId: number;
  title: string;
  company: string;
  user_id: number;
  username: string;
  display_name: string | null;
  user_avatar: string | null;
  profile_id: number;
  profile_name: string;
  is_archived: number;
  profile_avatar: string | null;
}

/** The signed-in user's own interviews, unless the query asks for someone else's or everyone's. */
export function listInterviews(db: Db, viewerId: number, filter: InterviewQuery, limit = 2_000): InterviewListItem[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.person !== 'all') {
    conditions.push('a.user_id = ?');
    params.push(filter.person ?? viewerId);
  }
  if (filter.profileId) {
    conditions.push('a.profile_id = ?');
    params.push(filter.profileId);
  }
  if (filter.from) {
    conditions.push('i.scheduled_at >= ?');
    params.push(new Date(filter.from).toISOString());
  }
  if (filter.to) {
    conditions.push('i.scheduled_at <= ?');
    params.push(new Date(filter.to).toISOString());
  }
  if (filter.stage) {
    conditions.push('i.stage = ?');
    params.push(filter.stage);
  }
  const rows = prepared(
    db.$client,
    `SELECT i.id, i.application_id AS applicationId, i.stage, i.scheduled_at AS scheduledAt, i.timezone, i.note,
              i.created_at AS createdAt, i.updated_at AS updatedAt, j.id AS jobId, j.title, j.company_name AS company, ${FACTS_COLUMNS},
              u.id AS user_id, u.username, u.display_name, ua.updated_at AS user_avatar,
              p.id AS profile_id, p.name AS profile_name, p.is_archived, pa.updated_at AS profile_avatar
       FROM interviews i
       JOIN applications a ON a.id = i.application_id
       JOIN jobs j ON j.id = a.job_id
       JOIN users u ON u.id = a.user_id
       JOIN profiles p ON p.id = a.profile_id
       LEFT JOIN job_facts f ON f.job_id = j.id
       LEFT JOIN user_avatars ua ON ua.user_id = u.id
       LEFT JOIN profile_avatars pa ON pa.profile_id = p.id
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY i.scheduled_at ASC LIMIT ?`
  ).all(...params, limit) as InterviewRow[];
  return rows.map((row): InterviewListItem => ({
    id: row.id,
    applicationId: row.applicationId,
    stage: row.stage,
    scheduledAt: row.scheduledAt,
    timezone: row.timezone,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    jobId: row.jobId,
    title: row.title,
    company: row.company,
    facts: toJobFacts(row),
    owner: toUserRef({ id: row.user_id, username: row.username, displayName: row.display_name, avatarVersion: row.user_avatar }),
    profile: toProfileRef({ id: row.profile_id, name: row.profile_name, isArchived: row.is_archived === 1, avatarVersion: row.profile_avatar }),
    isMine: row.user_id === viewerId
  }));
}

export function getDashboard(db: Db, userId: number): DashboardResponse {
  const sqlite = db.$client;
  const counts = prepared(
    sqlite,
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status IN (${CLOSED_STATUSES.map(() => '?').join(',')}) THEN 0 ELSE 1 END), 0) AS active,
            COALESCE(SUM(CASE WHEN status = 'Rejected' THEN 1 ELSE 0 END), 0) AS rejected
     FROM applications WHERE user_id = ?`
  ).get(...CLOSED_STATUSES, userId) as { total: number; active: number; rejected: number };
  const now = new Date().toISOString();
  const upcoming = prepared(sqlite, `SELECT COUNT(*) AS total FROM interviews i JOIN applications a ON a.id = i.application_id WHERE a.user_id = ? AND i.scheduled_at >= ?`).get(userId, now) as { total: number };
  return {
    totalApplications: counts.total,
    activeApplications: counts.active,
    rejectedApplications: counts.rejected,
    upcomingInterviews: upcoming.total,
    nextInterviews: listInterviews(db, userId, { from: now }, 5),
    recentApplications: listJobs(db, userId, { scope: 'mine', sort: 'recent', limit: 6 }).items,
    highlightedJobs: listJobs(db, userId, { highlighted: true, sort: 'recent', limit: 6 }).items
  };
}

/**
 * Every person's numbers, in total and for each of their profiles. Anyone with no
 * applications still appears, so that the page shows the whole team.
 */
export function getTeam(db: Db): TeamMember[] {
  const sqlite = db.$client;
  const people = sqlite
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.is_active, ua.updated_at AS avatar
       FROM users u LEFT JOIN user_avatars ua ON ua.user_id = u.id
       ORDER BY u.username COLLATE NOCASE ASC`
    )
    .all() as Array<{ id: number; username: string; display_name: string | null; is_active: number; avatar: string | null }>;
  const profileRows = sqlite
    .prepare(
      `SELECT p.id, p.user_id, p.name, p.is_archived, pa.updated_at AS avatar
       FROM profiles p LEFT JOIN profile_avatars pa ON pa.profile_id = p.id
       ORDER BY p.is_archived ASC, p.name COLLATE NOCASE ASC`
    )
    .all() as Array<{ id: number; user_id: number; name: string; is_archived: number; avatar: string | null }>;
  // One pass over the applications, using the furthest stage already kept on each of them.
  const byProfile = new Map(
    (
      prepared(
        sqlite,
        `SELECT profile_id, COUNT(*) AS applications, SUM(furthest_rank >= 1) AS screen, SUM(furthest_rank >= 2) AS technical,
                SUM(furthest_rank >= 3) AS final, SUM(furthest_rank >= 4) AS offers
         FROM applications GROUP BY profile_id`
      ).all() as Array<ReachedCounts & { profile_id: number }>
    ).map((row) => [row.profile_id, row])
  );
  const interviewCounts = new Map(
    (prepared(sqlite, `SELECT a.profile_id, COUNT(*) AS total FROM interviews i JOIN applications a ON a.id = i.application_id GROUP BY a.profile_id`).all() as Array<{ profile_id: number; total: number }>).map((row) => [row.profile_id, row.total])
  );
  const NOTHING: ReachedCounts = { applications: 0, screen: 0, technical: 0, final: 0, offers: 0 };

  return people.map((person): TeamMember => {
    const own = profileRows.filter((profile) => profile.user_id === person.id);
    const totals = { ...NOTHING };
    let totalInterviews = 0;
    const profiles = own.map((profile) => {
      const reached = byProfile.get(profile.id) ?? NOTHING;
      const interviewCount = interviewCounts.get(profile.id) ?? 0;
      totals.applications += reached.applications;
      totals.screen += reached.screen;
      totals.technical += reached.technical;
      totals.final += reached.final;
      totals.offers += reached.offers;
      totalInterviews += interviewCount;
      return {
        profile: toProfileRef({ id: profile.id, name: profile.name, isArchived: profile.is_archived === 1, avatarVersion: profile.avatar }),
        stats: statsFromCounts(reached, interviewCount)
      };
    });
    return {
      user: toUserRef({ id: person.id, username: person.username, displayName: person.display_name, avatarVersion: person.avatar }),
      isActive: person.is_active === 1,
      stats: statsFromCounts(totals, totalInterviews),
      profiles
    };
  });
}
