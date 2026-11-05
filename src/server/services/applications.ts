import { and, count, eq } from 'drizzle-orm';
import type { ApplicationDetail, InterviewInput, UpdateApplicationRequest } from '../../shared/api';
import type { AppContext } from '../context';
import { nowIso, type Db } from '../db/client';
import { applications, applicationStatusHistory, interviews, jobs } from '../db/schema';
import { forbidden, notFound } from '../errors';
import { getApplicationDetail } from './job-queries';

type ApplicationRow = typeof applications.$inferSelect;

/**
 * Everyone can read every application, but only its owner can change it. Changes look rows
 * up by id AND owner, so all of them share one guard and none can forget the ownership check.
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

export function updateApplication(ctx: AppContext, userId: number, applicationId: number, body: UpdateApplicationRequest): ApplicationDetail {
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
  ctx.events.publish('applications_changed', existing.jobId);
  return getApplicationDetail(db, userId, applicationId) as ApplicationDetail;
}

/** Withdraws this one application. The shared job stays for everyone else. */
export function deleteApplication(ctx: AppContext, userId: number, applicationId: number): void {
  const existing = getOwnApplication(ctx.db, userId, applicationId);
  ctx.db.delete(applications).where(eq(applications.id, applicationId)).run();
  ctx.events.publish('applications_changed', existing.jobId);
}

/** An interview changed: everyone's process view needs to hear about it. */
function touch(ctx: AppContext, application: { id: number; jobId: number }): void {
  ctx.db.update(applications).set({ updatedAt: nowIso() }).where(eq(applications.id, application.id)).run();
  ctx.events.publish('applications_changed', application.jobId);
}

export function addInterview(ctx: AppContext, userId: number, applicationId: number, input: InterviewInput) {
  const application = getOwnApplication(ctx.db, userId, applicationId);
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
  touch(ctx, application);
  return row;
}

function getOwnInterview(db: Db, userId: number, interviewId: number) {
  const row = db
    .select({ interview: interviews, jobId: applications.jobId })
    .from(interviews)
    .innerJoin(applications, eq(applications.id, interviews.applicationId))
    .where(and(eq(interviews.id, interviewId), eq(applications.userId, userId)))
    .get();
  if (!row) throw notFound('That interview was not found.');
  return { ...row.interview, jobId: row.jobId };
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
  touch(ctx, { id: existing.applicationId, jobId: existing.jobId });
  return row;
}

export function deleteInterview(ctx: AppContext, userId: number, interviewId: number): void {
  const existing = getOwnInterview(ctx.db, userId, interviewId);
  ctx.db.delete(interviews).where(eq(interviews.id, interviewId)).run();
  touch(ctx, { id: existing.applicationId, jobId: existing.jobId });
}

/**
 * A job can be deleted by the administrator, or by someone whose own profiles are the only ones
 * that applied to it, since then nobody else loses anything. The checks and the delete run
 * together, so nobody can apply in between.
 */
export function deleteJob(ctx: AppContext, user: { id: number; role: string }, jobId: number): void {
  ctx.handle.sqlite
    .transaction(() => {
      const job = ctx.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId)).get();
      if (!job) throw notFound('That job no longer exists.');
      if (user.role !== 'admin') {
        const total = ctx.db.select({ total: count() }).from(applications).where(eq(applications.jobId, jobId)).get()?.total ?? 0;
        const mine = ctx.db.select({ total: count() }).from(applications).where(and(eq(applications.jobId, jobId), eq(applications.userId, user.id))).get()?.total ?? 0;
        if (total === 0 || mine !== total) throw forbidden('You can only delete a job when your own profile is the only one that applied to it.');
      }
      ctx.db.delete(jobs).where(eq(jobs.id, jobId)).run();
    })
    .immediate();
  ctx.events.publish('jobs_changed', jobId);
}

/** A highlight is for everybody, so anyone may change it. */
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
