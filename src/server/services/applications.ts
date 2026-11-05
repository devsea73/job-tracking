import { and, eq } from 'drizzle-orm';
import type { InterviewInput, MyApplicationDetail, UpdateApplicationRequest } from '../../shared/api';
import type { AppContext } from '../context';
import { nowIso, type Db } from '../db/client';
import { applications, applicationStatusHistory, interviews, jobs } from '../db/schema';
import { notFound } from '../errors';
import { getMyApplicationDetail } from './job-queries';

type ApplicationRow = typeof applications.$inferSelect;

/**
 * Personal data has one way in: rows are looked up by id AND owner, so someone else's
 * application is simply "not found" rather than a permission error that confirms it exists.
 */
function getOwnApplication(db: Db, userId: number, applicationId: number): ApplicationRow {
  const row = db
    .select()
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.userId, userId)))
    .get();
  if (!row) throw notFound('That application was not found.');
  return row;
}

export function updateApplication(ctx: AppContext, userId: number, applicationId: number, body: UpdateApplicationRequest): MyApplicationDetail {
  const db = ctx.db;
  const existing = getOwnApplication(db, userId, applicationId);
  ctx.handle.sqlite
    .transaction(() => {
      const now = nowIso();
      db.update(applications)
        .set({
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.memo !== undefined ? { memo: body.memo } : {}),
          updatedAt: now
        })
        .where(eq(applications.id, applicationId))
        .run();
      if (body.status !== undefined && body.status !== existing.status) {
        db.insert(applicationStatusHistory).values({ applicationId, oldStatus: existing.status, newStatus: body.status, changedAt: now }).run();
      }
    })
    .immediate();
  return getMyApplicationDetail(db, applicationId) as MyApplicationDetail;
}

/** Withdraws the user's own record. The shared job stays for everyone else. */
export function deleteApplication(ctx: AppContext, userId: number, applicationId: number): void {
  const existing = getOwnApplication(ctx.db, userId, applicationId);
  ctx.db.delete(applications).where(eq(applications.id, applicationId)).run();
  ctx.events.publish('applications_changed', existing.jobId);
}

function touch(db: Db, applicationId: number): void {
  db.update(applications).set({ updatedAt: nowIso() }).where(eq(applications.id, applicationId)).run();
}

export function addInterview(ctx: AppContext, userId: number, applicationId: number, input: InterviewInput) {
  getOwnApplication(ctx.db, userId, applicationId);
  const row = ctx.db
    .insert(interviews)
    .values({
      applicationId,
      stage: input.stage,
      scheduledAt: new Date(input.scheduledAt).toISOString(),
      timezone: input.timezone,
      note: input.note?.trim() || null
    })
    .returning()
    .get();
  touch(ctx.db, applicationId);
  return row;
}

function getOwnInterview(db: Db, userId: number, interviewId: number) {
  const row = db
    .select({ interview: interviews })
    .from(interviews)
    .innerJoin(applications, eq(applications.id, interviews.applicationId))
    .where(and(eq(interviews.id, interviewId), eq(applications.userId, userId)))
    .get();
  if (!row) throw notFound('That interview was not found.');
  return row.interview;
}

export function updateInterview(ctx: AppContext, userId: number, interviewId: number, input: InterviewInput) {
  const existing = getOwnInterview(ctx.db, userId, interviewId);
  const row = ctx.db
    .update(interviews)
    .set({
      stage: input.stage,
      scheduledAt: new Date(input.scheduledAt).toISOString(),
      timezone: input.timezone,
      note: input.note?.trim() || null,
      updatedAt: nowIso()
    })
    .where(eq(interviews.id, interviewId))
    .returning()
    .get();
  touch(ctx.db, existing.applicationId);
  return row;
}

export function deleteInterview(ctx: AppContext, userId: number, interviewId: number): void {
  const existing = getOwnInterview(ctx.db, userId, interviewId);
  ctx.db.delete(interviews).where(eq(interviews.id, interviewId)).run();
  touch(ctx.db, existing.applicationId);
}

/** The one shared thing any user may change: a highlight is for everybody. */
export function setHighlight(ctx: AppContext, userId: number, jobId: number, highlighted: boolean): void {
  const result = ctx.db
    .update(jobs)
    .set({
      isHighlighted: highlighted,
      highlightedBy: highlighted ? userId : null,
      highlightedAt: highlighted ? nowIso() : null
    })
    .where(eq(jobs.id, jobId))
    .run();
  if (result.changes === 0) throw notFound('That job no longer exists.');
  ctx.events.publish('jobs_changed', jobId);
}
