import { and, count, eq } from 'drizzle-orm';
import type { ApplicationDetail, Step, StepInput, StepSaved, UpdateApplicationRequest } from '../../shared/api';
import { isOutcomeStage } from '../../shared/constants';
import type { AppContext } from '../context';
import { nowIso, prepared, type Db } from '../db/client';
import { applications, applicationSteps, jobs } from '../db/schema';
import { forbidden, notFound } from '../errors';
import { getApplicationDetail, INTERVIEWS_SQL, toStep } from './job-queries';

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

/** The memo, and when the person applied. The stage is never set here: it comes from the timeline. */
export function updateApplication(ctx: AppContext, userId: number, applicationId: number, body: UpdateApplicationRequest): ApplicationDetail {
  const existing = getOwnApplication(ctx.db, userId, applicationId);
  ctx.db
    .update(applications)
    .set({
      ...(body.memo !== undefined ? { memo: body.memo } : {}),
      ...(body.appliedAt !== undefined ? { appliedAt: new Date(body.appliedAt).toISOString() } : {}),
      updatedAt: nowIso()
    })
    .where(eq(applications.id, applicationId))
    .run();
  ctx.events.publish('applications_changed', existing.jobId);
  return getApplicationDetail(ctx.db, userId, applicationId) as ApplicationDetail;
}

/** Withdraws this one application. The shared job stays for everyone else. */
export function deleteApplication(ctx: AppContext, userId: number, applicationId: number): void {
  const existing = getOwnApplication(ctx.db, userId, applicationId);
  ctx.db.delete(applications).where(eq(applications.id, applicationId)).run();
  ctx.events.publish('applications_changed', existing.jobId);
}

/** A timeline changed: the record says so, and everyone's view of the process hears about it. */
function touch(ctx: AppContext, application: { id: number; jobId: number }): void {
  ctx.db.update(applications).set({ updatedAt: nowIso() }).where(eq(applications.id, application.id)).run();
  ctx.events.publish('applications_changed', application.jobId);
}

/**
 * An offer or a rejection ends the process, so the interviews after it will not happen: they come
 * off the timeline and the calendars. Only interviews, and only later ones: whatever came before
 * stays, and so does another outcome (an offer taken back is a rejection after the offer).
 */
function interviewsAfter(ctx: AppContext, applicationId: number, at: string, except?: number): Step[] {
  return (
    prepared(ctx.handle.sqlite, `SELECT * FROM application_steps WHERE application_id = ? AND stage IN (${INTERVIEWS_SQL}) AND at > ? AND id != ? ORDER BY at, id`).all(applicationId, at, except ?? 0) as Array<
      Record<string, unknown>
    >
  ).map((row) => toStep(row));
}

function removeInterviewsAfter(ctx: AppContext, applicationId: number, input: { stage: string; at: string }, except?: number): Step[] {
  if (!isOutcomeStage(input.stage)) return [];
  const later = interviewsAfter(ctx, applicationId, input.at, except);
  for (const step of later) ctx.db.delete(applicationSteps).where(eq(applicationSteps.id, step.id)).run();
  return later;
}

export function addStep(ctx: AppContext, userId: number, applicationId: number, input: StepInput): StepSaved {
  const application = getOwnApplication(ctx.db, userId, applicationId);
  const at = new Date(input.at).toISOString();
  const saved = ctx.handle.sqlite
    .transaction(() => {
      const removed = removeInterviewsAfter(ctx, applicationId, { stage: input.stage, at });
      const row = ctx.db
        .insert(applicationSteps)
        .values({ applicationId, stage: input.stage, at, timezone: input.timezone, note: input.note?.trim() || null })
        .returning()
        .get();
      return { ...row, removed };
    })
    .immediate();
  touch(ctx, application);
  return saved;
}

function getOwnStep(db: Db, userId: number, stepId: number) {
  const row = db
    .select({ step: applicationSteps, jobId: applications.jobId })
    .from(applicationSteps)
    .innerJoin(applications, eq(applications.id, applicationSteps.applicationId))
    .where(and(eq(applicationSteps.id, stepId), eq(applications.userId, userId)))
    .get();
  if (!row) throw notFound('That step was not found.');
  return { ...row.step, jobId: row.jobId };
}

export function updateStep(ctx: AppContext, userId: number, stepId: number, input: StepInput): StepSaved {
  const existing = getOwnStep(ctx.db, userId, stepId);
  const at = new Date(input.at).toISOString();
  const saved = ctx.handle.sqlite
    .transaction(() => {
      const removed = removeInterviewsAfter(ctx, existing.applicationId, { stage: input.stage, at }, stepId);
      const row = ctx.db
        .update(applicationSteps)
        .set({ stage: input.stage, at, timezone: input.timezone, note: input.note?.trim() || null, updatedAt: nowIso() })
        .where(eq(applicationSteps.id, stepId))
        .returning()
        .get();
      return { ...row, removed };
    })
    .immediate();
  touch(ctx, { id: existing.applicationId, jobId: existing.jobId });
  return saved;
}

export function deleteStep(ctx: AppContext, userId: number, stepId: number): void {
  const existing = getOwnStep(ctx.db, userId, stepId);
  ctx.db.delete(applicationSteps).where(eq(applicationSteps.id, stepId)).run();
  touch(ctx, { id: existing.applicationId, jobId: existing.jobId });
}

/**
 * A job's title, company, location and description are shared, and anyone with a stake in the job
 * can put them right: someone one of whose profiles applied to it, whoever else applied too, and
 * the administrator. Someone who has not applied can read them but not change them.
 */
export function assertCanEditJob(ctx: AppContext, user: { id: number; role: string }, jobId: number): void {
  const job = ctx.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw notFound('That job no longer exists.');
  if (user.role === 'admin') return;
  const applied = ctx.db.select({ id: applications.id }).from(applications).where(and(eq(applications.jobId, jobId), eq(applications.userId, user.id))).limit(1).get();
  if (!applied) throw forbidden('You can only change a job one of your profiles applied to.');
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
