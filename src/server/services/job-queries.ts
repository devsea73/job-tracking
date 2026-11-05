import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  Applicant,
  DashboardResponse,
  InterviewListItem,
  JobDetail,
  JobListItem,
  JobListQuery,
  JobListResponse,
  MyApplicationDetail
} from '../../shared/api';
import { APPLICATION_STATUSES, CLOSED_STATUSES, type ApplicationStatus, type InterviewStage } from '../../shared/constants';
import type { AppContext } from '../context';
import type { Db } from '../db/client';
import { applications, applicationStatusHistory, interviews, jobs, jobUrls, users } from '../db/schema';
import { notFound } from '../errors';
import { toApplicant } from './users';

const MEMO_PREVIEW_LENGTH = 140;

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function searchTokens(query: string): string[] {
  return (query.normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/gu) ?? []).slice(0, 8);
}

interface ListRow {
  id: number;
  title: string;
  company_name: string;
  location: string | null;
  is_highlighted: number;
  created_at: string;
  updated_at: string;
  app_id: number | null;
  status: ApplicationStatus | null;
  memo: string | null;
  applied_at: string | null;
  app_updated_at: string | null;
  next_interview: string | null;
}

const STATUS_ORDER = `CASE a.status ${APPLICATION_STATUSES.map((status, index) => `WHEN '${status}' THEN ${index}`).join(' ')} END`;

const SORTS: Record<NonNullable<JobListQuery['sort']>, (scope: JobListQuery['scope']) => string> = {
  recent: (scope) => (scope === 'mine' ? 'a.applied_at DESC' : 'j.created_at DESC'),
  updated: () => "MAX(j.updated_at, COALESCE(a.updated_at, '')) DESC",
  company: () => 'j.company_name COLLATE NOCASE ASC, j.title COLLATE NOCASE ASC',
  interview: () => 'next_interview IS NULL, next_interview ASC',
  status: () => `a.status IS NULL, ${STATUS_ORDER} ASC`
};

/**
 * The shared catalog seen through one user. Filters on the job (text, company, highlight)
 * apply to everyone's listing; filters on status and interviews look only at this user's
 * own application, so other people's private details can never influence the results.
 */
export function listJobs(db: Db, userId: number, query: JobListQuery): JobListResponse {
  const where: string[] = [];
  const params: unknown[] = [];

  for (const token of searchTokens(query.q ?? '')) {
    const like = `%${escapeLike(token)}%`;
    // Memo is checked on `a`, which is joined to this user's application only.
    where.push(`(
      j.id IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)
      OR j.company_name LIKE ? ESCAPE '\\'
      OR j.title LIKE ? ESCAPE '\\'
      OR a.memo LIKE ? ESCAPE '\\'
    )`);
    params.push(`"${token.replace(/"/g, '""')}"*`, like, like, like);
  }
  if (query.company) {
    where.push(`j.company_name LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(query.company)}%`);
  }
  if (query.highlighted) where.push('j.is_highlighted = 1');
  if (query.scope === 'mine') where.push('a.id IS NOT NULL');
  if (query.scope === 'others') {
    where.push('EXISTS (SELECT 1 FROM applications other WHERE other.job_id = j.id AND other.user_id != ?)');
    params.push(userId);
  }
  if (query.status) {
    where.push('a.status = ?');
    params.push(query.status);
  }
  if (query.stage || query.interviewFrom || query.interviewTo) {
    const conditions = ['i.application_id = a.id'];
    if (query.stage) {
      conditions.push('i.stage = ?');
      params.push(query.stage);
    }
    if (query.interviewFrom) {
      conditions.push('i.scheduled_at >= ?');
      params.push(new Date(query.interviewFrom).toISOString());
    }
    if (query.interviewTo) {
      conditions.push('i.scheduled_at <= ?');
      params.push(new Date(query.interviewTo).toISOString());
    }
    where.push(`EXISTS (SELECT 1 FROM interviews i WHERE ${conditions.join(' AND ')})`);
  }

  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM jobs j LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = ?`;
  const sqlite = db.$client;
  const total = sqlite.prepare(`SELECT COUNT(*) AS total ${from} ${filter}`).get(userId, ...params) as { total: number };

  const order = [
    query.highlightFirst ? 'j.is_highlighted DESC' : null,
    SORTS[query.sort ?? 'recent'](query.scope),
    'j.id DESC'
  ]
    .filter(Boolean)
    .join(', ');

  const now = new Date().toISOString();
  const rows = sqlite
    .prepare(
      `SELECT j.id, j.title, j.company_name, j.location, j.is_highlighted, j.created_at, j.updated_at,
              a.id AS app_id, a.status, a.memo, a.applied_at, a.updated_at AS app_updated_at,
              (SELECT MIN(n.scheduled_at) FROM interviews n WHERE n.application_id = a.id AND n.scheduled_at >= ?) AS next_interview
       ${from} ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`
    )
    .all(now, userId, ...params, query.limit ?? 100, query.offset ?? 0) as ListRow[];

  const applicants = applicantsByJob(
    db,
    rows.map((row) => row.id)
  );
  return {
    total: total.total,
    items: rows.map((row): JobListItem => ({
      id: row.id,
      title: row.title,
      company: row.company_name,
      location: row.location,
      isHighlighted: row.is_highlighted === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      applicants: applicants.get(row.id) ?? [],
      myApplication:
        row.app_id === null
          ? null
          : {
              id: row.app_id,
              status: row.status as ApplicationStatus,
              memoPreview: (row.memo ?? '').slice(0, MEMO_PREVIEW_LENGTH),
              nextInterviewAt: row.next_interview,
              appliedAt: row.applied_at as string,
              updatedAt: row.app_updated_at as string
            }
    }))
  };
}

/** Only names are selected here: applicants' statuses, memos and interviews are never read. */
function applicantsByJob(db: Db, jobIds: number[]): Map<number, Applicant[]> {
  const result = new Map<number, Applicant[]>();
  if (jobIds.length === 0) return result;
  const rows = db
    .select({ jobId: applications.jobId, id: users.id, username: users.username, displayName: users.displayName })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.userId))
    .where(inArray(applications.jobId, jobIds))
    .orderBy(asc(applications.appliedAt), asc(applications.id))
    .all();
  for (const row of rows) {
    const list = result.get(row.jobId) ?? [];
    list.push(toApplicant(row));
    result.set(row.jobId, list);
  }
  return result;
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

export function getMyApplicationDetail(db: Db, applicationId: number): MyApplicationDetail | null {
  const application = db.select().from(applications).where(eq(applications.id, applicationId)).get();
  if (!application) return null;
  return {
    id: application.id,
    status: application.status,
    memo: application.memo,
    appliedAt: application.appliedAt,
    updatedAt: application.updatedAt,
    interviews: db
      .select()
      .from(interviews)
      .where(eq(interviews.applicationId, applicationId))
      .orderBy(asc(interviews.scheduledAt))
      .all()
      .map((row) => ({ ...row, stage: row.stage as InterviewStage })),
    history: db
      .select()
      .from(applicationStatusHistory)
      .where(eq(applicationStatusHistory.applicationId, applicationId))
      .orderBy(desc(applicationStatusHistory.changedAt), desc(applicationStatusHistory.id))
      .all()
      .map((row) => ({ id: row.id, oldStatus: row.oldStatus, newStatus: row.newStatus, changedAt: row.changedAt }))
  };
}

export function getJobDetail(ctx: AppContext, userId: number, jobId: number): JobDetail {
  const db = ctx.db;
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw notFound('That job no longer exists.');
  const mine = db
    .select({ id: applications.id })
    .from(applications)
    .where(sql`${applications.jobId} = ${jobId} and ${applications.userId} = ${userId}`)
    .get();
  const highlighter = job.highlightedBy
    ? db.select({ username: users.username }).from(users).where(eq(users.id, job.highlightedBy)).get()
    : null;
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
    applicants: applicantsByJob(db, [jobId]).get(jobId) ?? [],
    myApplication: mine ? getMyApplicationDetail(db, mine.id) : null
  };
}

export function listMyInterviews(db: Db, userId: number, filter: { from?: string; to?: string; stage?: InterviewStage }, limit = 500): InterviewListItem[] {
  const conditions = ['a.user_id = ?'];
  const params: unknown[] = [userId];
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
  const rows = db.$client
    .prepare(
      `SELECT i.id, i.application_id AS applicationId, i.stage, i.scheduled_at AS scheduledAt, i.timezone, i.note,
              i.created_at AS createdAt, i.updated_at AS updatedAt, j.id AS jobId, j.title, j.company_name AS company
       FROM interviews i
       JOIN applications a ON a.id = i.application_id
       JOIN jobs j ON j.id = a.job_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY i.scheduled_at ASC LIMIT ?`
    )
    .all(...params, limit);
  return rows as InterviewListItem[];
}

export function getDashboard(db: Db, userId: number): DashboardResponse {
  const counts = db.$client
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status IN (${CLOSED_STATUSES.map(() => '?').join(',')}) THEN 0 ELSE 1 END), 0) AS active,
              COALESCE(SUM(CASE WHEN status = 'Rejected' THEN 1 ELSE 0 END), 0) AS rejected
       FROM applications WHERE user_id = ?`
    )
    .get(...CLOSED_STATUSES, userId) as { total: number; active: number; rejected: number };
  const upcoming = listMyInterviews(db, userId, { from: new Date().toISOString() });
  return {
    totalApplications: counts.total,
    activeApplications: counts.active,
    rejectedApplications: counts.rejected,
    upcomingInterviews: upcoming.length,
    nextInterviews: upcoming.slice(0, 5),
    recentApplications: listJobs(db, userId, { scope: 'mine', sort: 'recent', limit: 6 }).items,
    highlightedJobs: listJobs(db, userId, { highlighted: true, sort: 'recent', limit: 6 }).items
  };
}
