import type Database from 'better-sqlite3';
import { asc, eq, sql } from 'drizzle-orm';
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
  Step,
  TeamApplication,
  TeamApplicationSort,
  TeamApplicationsQuery,
  TeamApplicationsResponse,
  TeamBoardRow,
  TeamMember
} from '../../shared/api';
import { INTERVIEW_STAGES, STAGES, type InterviewStage, type Stage, type StepStage } from '../../shared/constants';
import { PIPELINE_STAGES, statsFromCounts, type ReachedCounts } from '../../shared/pipeline';
import type { AppContext } from '../context';
import { prepared, type Db } from '../db/client';
import { applicationSteps, jobs, jobUrls, users } from '../db/schema';
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

const STAGE_ORDER = `CASE x.stage ${STAGES.map((stage, index) => `WHEN '${stage}' THEN ${index}`).join(' ')} END`;

/** The stages that are interviews, as SQL. */
export const INTERVIEWS_SQL = INTERVIEW_STAGES.map((stage) => `'${stage}'`).join(', ');

/**
 * Which applications a listing is looking at: all of them, or those of one person or profile.
 * Interview dates and stages in the sort order come from these. Every id here has already
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
      // Mine: when I added it here, which an imported list or a corrected date can make differ from when I applied.
      if (query.scope === 'mine') return { join: keys('MAX(x.created_at)'), joinParams: [], order: 's.sort_key DESC' };
      return { join: '', joinParams: [], order: 'j.created_at DESC' };
    case 'applied':
      // Mine: when I first applied, with several of my profiles: the date the list shows. Otherwise: the first time anyone shown applied.
      return { join: keys('MIN(x.applied_at)'), joinParams: [], order: 's.sort_key IS NULL, s.sort_key DESC' };
    case 'updated':
      if (everyone) return { join: '', joinParams: [], order: 'j.last_activity_at DESC' };
      return { join: keys('MAX(x.updated_at)'), joinParams: [], order: "MAX(j.updated_at, COALESCE(s.sort_key, '')) DESC" };
    case 'company':
      return { join: '', joinParams: [], order: 'j.company_name COLLATE NOCASE ASC, j.title COLLATE NOCASE ASC' };
    case 'interview':
      return {
        join: `LEFT JOIN (SELECT x.job_id, MIN(n.at) AS sort_key FROM application_steps n JOIN applications x ON x.id = n.application_id WHERE n.stage IN (${INTERVIEWS_SQL}) AND n.at >= ? AND ${relevant} GROUP BY x.job_id) s ON s.job_id = j.id`,
        joinParams: [now],
        order: 's.sort_key IS NULL, s.sort_key ASC'
      };
    case 'stage':
      return { join: keys(`MIN(${STAGE_ORDER})`), joinParams: [], order: 's.sort_key IS NULL, s.sort_key ASC' };
    case 'applicants':
      return { join: '', joinParams: [], order: 'j.application_count DESC' };
  }
}

/**
 * How well a job matches a search, best first: the words in the company name (0), else in the
 * title (1), else only in its description or a memo (2). With several words, each counts where it
 * is found best, and the job by its worst: "acme engineer" with Acme in the company and Engineer in
 * the title is a title match. Jobs that match equally keep the order chosen, by default the applied date.
 */
function searchRelevance(tokens: string[]): { order: string; params: unknown[] } | null {
  if (tokens.length === 0) return null;
  const params: unknown[] = [];
  const places = tokens.map((token) => {
    const like = `%${escapeLike(token)}%`;
    params.push(like, like);
    return `CASE WHEN j.company_name LIKE ? ESCAPE '\\' THEN 0 WHEN j.title LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END`;
  });
  // max() with one argument would add up rows; one word needs none.
  return { order: places.length === 1 ? `${places[0]} ASC` : `MAX(${places.join(', ')}) ASC`, params };
}

/**
 * The shared list of jobs. Every filter that looks at applications has to match on one and the
 * same application: "Technical Interview" and "Tyler" together mean Tyler is at that stage, not
 * that Tyler applied while somebody else is.
 */
export function listJobs(db: Db, userId: number, query: JobListQuery): JobListResponse {
  const where: string[] = [];
  const params: unknown[] = [];

  const tokens = searchTokens(query.q ?? '');
  for (const token of tokens) {
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
  const relevance = searchRelevance(tokens);
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
  if (query.stage) {
    onApplication.push('a.stage = ?');
    applicationParams.push(query.stage);
  }
  if (query.interviewFrom || query.interviewTo) {
    const conditions = ['i.application_id = a.id', `i.stage IN (${INTERVIEWS_SQL})`];
    if (query.interviewFrom) {
      conditions.push('i.at >= ?');
      applicationParams.push(new Date(query.interviewFrom).toISOString());
    }
    if (query.interviewTo) {
      conditions.push('i.at <= ?');
      applicationParams.push(new Date(query.interviewTo).toISOString());
    }
    onApplication.push(`EXISTS (SELECT 1 FROM application_steps i WHERE ${conditions.join(' AND ')})`);
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
  // A search puts the best matches first, and only then the chosen order: see searchRelevance.
  const order = [relevance?.order ?? null, query.highlightFirst ? 'j.is_highlighted DESC' : null, plan.order, 'j.id DESC'].filter(Boolean).join(', ');
  const rows = prepared(
    sqlite,
    `SELECT j.id, j.title, j.company_name, j.location, j.is_highlighted, j.created_at, j.updated_at, ${FACTS_COLUMNS}
     FROM jobs j LEFT JOIN job_facts f ON f.job_id = j.id ${plan.join} ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...plan.joinParams, ...params, ...(relevance?.params ?? []), query.limit ?? 100, query.offset ?? 0) as JobRow[];

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
  stage: Stage;
  memo: string;
  furthest_rank: number;
  applied_at: string;
  created_at: string;
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
  link_id: number | null;
  link_url: string | null;
}

const APPLICATION_COLUMNS = `
  a.id, a.job_id, a.stage, a.memo, a.furthest_rank, a.applied_at, a.created_at, a.updated_at,
  u.id AS user_id, u.username, u.display_name, ua.updated_at AS user_avatar,
  p.id AS profile_id, p.name AS profile_name, p.is_archived, pa.updated_at AS profile_avatar,
  (SELECT MIN(n.at) FROM application_steps n WHERE n.application_id = a.id AND n.stage IN (${INTERVIEWS_SQL}) AND n.at >= @now) AS next_interview,
  (SELECT COUNT(*) FROM application_steps c WHERE c.application_id = a.id AND c.stage IN (${INTERVIEWS_SQL})) AS interview_count,
  l.id AS link_id, l.original_url AS link_url`;

const APPLICATION_JOINS = `
  FROM applications a
  JOIN users u ON u.id = a.user_id
  JOIN profiles p ON p.id = a.profile_id
  LEFT JOIN user_avatars ua ON ua.user_id = u.id
  LEFT JOIN profile_avatars pa ON pa.profile_id = p.id
  LEFT JOIN job_urls l ON l.id = a.job_url_id`;

function toApplicationSummary(row: ApplicationRow, viewerId: number): ApplicationSummary {
  return {
    id: row.id,
    owner: toUserRef({ id: row.user_id, username: row.username, displayName: row.display_name, avatarVersion: row.user_avatar }),
    profile: toProfileRef({ id: row.profile_id, name: row.profile_name, isArchived: row.is_archived === 1, avatarVersion: row.profile_avatar }),
    isMine: row.user_id === viewerId,
    stage: row.stage,
    furthestStage: PIPELINE_STAGES[row.furthest_rank] ?? PIPELINE_STAGES[0],
    memoPreview: row.memo.slice(0, MEMO_PREVIEW_LENGTH),
    nextInterviewAt: row.next_interview,
    interviewCount: row.interview_count,
    appliedAt: row.applied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    link: row.link_id !== null && row.link_url !== null ? { id: row.link_id, url: row.link_url } : null
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

/** A step as read with plain SQL. */
export function toStep(row: Record<string, unknown>): Step {
  return {
    id: row.id as number,
    applicationId: row.application_id as number,
    stage: row.stage as StepStage,
    at: row.at as string,
    timezone: row.timezone as string,
    note: (row.note as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  };
}

function toApplicationDetail(db: Db, row: ApplicationRow, viewerId: number): ApplicationDetail {
  return {
    ...toApplicationSummary(row, viewerId),
    memo: row.memo,
    // Oldest first, as the timeline reads.
    steps: db.select().from(applicationSteps).where(eq(applicationSteps.applicationId, row.id)).orderBy(asc(applicationSteps.at), asc(applicationSteps.id)).all()
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
  at: string;
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

/**
 * Interviews by the time they take place: the steps at an interview stage. The signed-in user's
 * own, unless the query asks for someone else's or everyone's. Soonest first, or latest first when
 * asked: the latest past ones are the ones worth seeing first.
 */
export function listInterviews(db: Db, viewerId: number, filter: InterviewQuery, limit = 2_000): InterviewListItem[] {
  const conditions: string[] = [`i.stage IN (${INTERVIEWS_SQL})`];
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
    conditions.push('i.at >= ?');
    params.push(new Date(filter.from).toISOString());
  }
  if (filter.to) {
    conditions.push('i.at <= ?');
    params.push(new Date(filter.to).toISOString());
  }
  if (filter.stage) {
    conditions.push('i.stage = ?');
    params.push(filter.stage);
  }
  const rows = prepared(
    db.$client,
    `SELECT i.id, i.application_id AS applicationId, i.stage, i.at, i.timezone, i.note,
              i.created_at AS createdAt, i.updated_at AS updatedAt, j.id AS jobId, j.title, j.company_name AS company, ${FACTS_COLUMNS},
              u.id AS user_id, u.username, u.display_name, ua.updated_at AS user_avatar,
              p.id AS profile_id, p.name AS profile_name, p.is_archived, pa.updated_at AS profile_avatar
       FROM application_steps i
       JOIN applications a ON a.id = i.application_id
       JOIN jobs j ON j.id = a.job_id
       JOIN users u ON u.id = a.user_id
       JOIN profiles p ON p.id = a.profile_id
       LEFT JOIN job_facts f ON f.job_id = j.id
       LEFT JOIN user_avatars ua ON ua.user_id = u.id
       LEFT JOIN profile_avatars pa ON pa.profile_id = p.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${filter.order === 'desc' ? 'i.at DESC, i.id DESC' : 'i.at ASC, i.id ASC'} LIMIT ?`
  ).all(...params, limit) as InterviewRow[];
  return rows.map((row): InterviewListItem => ({
    id: row.id,
    applicationId: row.applicationId,
    stage: row.stage,
    at: row.at,
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
            COALESCE(SUM(CASE WHEN stage = 'Rejected' THEN 0 ELSE 1 END), 0) AS active,
            COALESCE(SUM(CASE WHEN stage = 'Rejected' THEN 1 ELSE 0 END), 0) AS rejected
     FROM applications WHERE user_id = ?`
  ).get(userId) as { total: number; active: number; rejected: number };
  const now = new Date().toISOString();
  const upcoming = prepared(
    sqlite,
    `SELECT COUNT(*) AS total FROM application_steps i JOIN applications a ON a.id = i.application_id WHERE a.user_id = ? AND i.stage IN (${INTERVIEWS_SQL}) AND i.at >= ?`
  ).get(userId, now) as { total: number };
  return {
    totalApplications: counts.total,
    activeApplications: counts.active,
    rejectedApplications: counts.rejected,
    upcomingInterviews: upcoming.total,
    nextInterviews: listInterviews(db, userId, { from: now }, 5),
    recentApplications: listJobs(db, userId, { scope: 'mine', sort: 'applied', limit: 6 }).items,
    highlightedJobs: listJobs(db, userId, { highlighted: true, sort: 'recent', limit: 6 }).items
  };
}

const TEAM_APPLICATION_ORDER: Record<TeamApplicationSort, string> = {
  applied: 'a.applied_at DESC, a.id DESC',
  // Furthest along first; of those, the ones still going before the turned down.
  stage: "a.furthest_rank DESC, a.stage = 'Rejected' ASC, a.applied_at DESC, a.id DESC",
  updated: 'a.updated_at DESC, a.id DESC',
  company: 'j.company_name COLLATE NOCASE ASC, j.title COLLATE NOCASE ASC, a.applied_at DESC, a.id DESC'
};

interface TeamApplicationRow extends ApplicationRow, FactsRow {
  title: string;
  company_name: string;
  location: string | null;
}

/** Work kept while the data stays the same, shared by everyone's answers: the server's read cache. */
export interface SharedWork {
  value<T>(key: string, compute: () => T): T;
}

/**
 * Every member's applications in the range by the stage each is at, before anyone is marked as the
 * viewer: the same for everyone who looks. One got an interview when its timeline went past Applied.
 */
function teamBoard(sqlite: Database.Database, span: { from: string; to: string } | null): TeamBoardRow[] {
  const inRange = span ? 'a.applied_at >= @from AND a.applied_at < @to' : '1';
  const params = { from: span?.from ?? null, to: span?.to ?? null };
  const people = prepared(
    sqlite,
    `SELECT u.id, u.username, u.display_name, u.is_active, ua.updated_at AS avatar FROM users u LEFT JOIN user_avatars ua ON ua.user_id = u.id`
  ).all() as Array<{ id: number; username: string; display_name: string | null; is_active: number; avatar: string | null }>;
  const counted = prepared(sqlite, `SELECT a.user_id, a.stage, COUNT(*) AS total, SUM(a.furthest_rank >= 1) AS interviews FROM applications a WHERE ${inRange} GROUP BY a.user_id, a.stage`).all(params) as Array<{
    user_id: number;
    stage: Stage;
    total: number;
    interviews: number;
  }>;
  return people
    .map((person): TeamBoardRow => {
      const stages = Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<Stage, number>;
      let total = 0;
      let interviewed = 0;
      for (const row of counted) {
        if (row.user_id !== person.id) continue;
        stages[row.stage] += row.total;
        total += row.total;
        interviewed += row.interviews;
      }
      return {
        user: toUserRef({ id: person.id, username: person.username, displayName: person.display_name, avatarVersion: person.avatar }),
        isMe: false,
        isActive: person.is_active === 1,
        total,
        stages,
        interviews: interviewed,
        interviewRate: total > 0 ? Math.round((interviewed / total) * 1000) / 10 : null
      };
    })
    .sort((a, b) => b.total - a.total || a.user.username.localeCompare(b.user.username));
}

/**
 * A page of everyone's applications. The page is chosen first, from the few columns the filters
 * and the order need, and only its rows are then read in full: reading every application in full
 * and then keeping fifty took most of a second with tens of thousands.
 */
function teamApplicationPage(sqlite: Database.Database, query: TeamApplicationsQuery, span: { from: string; to: string } | null): { total: number; rows: TeamApplicationRow[] } {
  const where = ['1'];
  const params: Record<string, unknown> = {};
  if (span) {
    where.push('a.applied_at >= @from AND a.applied_at < @to');
    params.from = span.from;
    params.to = span.to;
  }
  if (query.person) {
    where.push('a.user_id = @person');
    params.person = query.person;
  }
  if (query.stage) {
    where.push('a.stage = @stage');
    params.stage = query.stage;
  }
  const tokens = searchTokens(query.q ?? '');
  tokens.forEach((token, index) => {
    where.push(`(j.title LIKE @q${index} ESCAPE '\\' OR j.company_name LIKE @q${index} ESCAPE '\\' OR p.name LIKE @q${index} ESCAPE '\\')`);
    params[`q${index}`] = `%${escapeLike(token)}%`;
  });
  const sort = query.sort ?? 'applied';
  const from = `FROM applications a${tokens.length > 0 || sort === 'company' ? ' JOIN jobs j ON j.id = a.job_id' : ''}${tokens.length > 0 ? ' JOIN profiles p ON p.id = a.profile_id' : ''}`;
  const filter = `WHERE ${where.join(' AND ')}`;
  const total = (prepared(sqlite, `SELECT COUNT(*) AS total ${from} ${filter}`).get(params) as { total: number }).total;
  const ids = prepared(sqlite, `SELECT a.id ${from} ${filter} ORDER BY ${TEAM_APPLICATION_ORDER[sort]} LIMIT @limit OFFSET @offset`)
    .pluck()
    .all({ ...params, limit: query.limit ?? 50, offset: query.offset ?? 0 }) as number[];
  if (ids.length === 0) return { total, rows: [] };
  const found = new Map(
    (
      prepared(
        sqlite,
        `SELECT ${APPLICATION_COLUMNS}, j.title, j.company_name, j.location, ${FACTS_COLUMNS} ${APPLICATION_JOINS} JOIN jobs j ON j.id = a.job_id LEFT JOIN job_facts f ON f.job_id = j.id
         WHERE a.id IN (SELECT value FROM json_each(@ids))`
      ).all({ now: new Date().toISOString(), ids: JSON.stringify(ids) }) as TeamApplicationRow[]
    ).map((row) => [row.id, row])
  );
  return { total, rows: ids.map((id) => found.get(id)).filter((row): row is TeamApplicationRow => row !== undefined) };
}

/**
 * Everyone's applications, one row per profile's application, with where each one is now, and a
 * board of every member's applications by current status. The board counts the range only, so it
 * stays put while the list below it is narrowed to a person, a status or a search.
 * Administrators are members like anyone. Everyone sees the same board and pages, so
 * with `shared` they are worked out once, and only "me" and "mine" are marked for each viewer.
 */
export function listTeamApplications(
  db: Db,
  viewerId: number,
  query: TeamApplicationsQuery,
  span: { from: string; to: string } | null,
  shared?: SharedWork
): Omit<TeamApplicationsResponse, 'range'> {
  const sqlite = db.$client;
  const once = <T>(key: string, compute: () => T): T => (shared ? shared.value(key, compute) : compute());
  const board = once(`team-board:${span?.from ?? ''}|${span?.to ?? ''}`, () => teamBoard(sqlite, span));
  const page = once(
    `team-page:${JSON.stringify([span?.from, span?.to, query.person, query.stage, query.q, query.sort, query.limit, query.offset])}`,
    () => teamApplicationPage(sqlite, query, span)
  );
  const mine = board.find((row) => row.user.id === viewerId);
  return {
    // The viewer first, then by applications.
    board: mine ? [{ ...mine, isMe: true }, ...board.filter((row) => row !== mine)] : board,
    total: page.total,
    items: page.rows.map((row): TeamApplication => ({
      ...toApplicationSummary(row, viewerId),
      job: { id: row.job_id, title: row.title, company: row.company_name, location: row.location, facts: toJobFacts(row) }
    }))
  };
}

/**
 * Every member's numbers, in total and for each of their profiles. Anyone with no
 * applications still appears, so that the page shows the whole team, administrators included:
 * they apply with their own profiles like anyone.
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
    (
      prepared(sqlite, `SELECT a.profile_id, COUNT(*) AS total FROM application_steps i JOIN applications a ON a.id = i.application_id WHERE i.stage IN (${INTERVIEWS_SQL}) GROUP BY a.profile_id`).all() as Array<{
        profile_id: number;
        total: number;
      }>
    ).map((row) => [row.profile_id, row.total])
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
