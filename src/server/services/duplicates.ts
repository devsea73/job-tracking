import type Database from 'better-sqlite3';
import type { DuplicateJobSummary, DuplicatePair, DuplicatesResponse } from '../../shared/api';
import type { AppContext } from '../context';
import { prepared } from '../db/client';
import { findContentMatches, type ContentCandidate } from '../dedupe/matcher';
import { ApiError, notFound } from '../errors';
import { createBackup, listBackups } from './backups';
import { FACTS_COLUMNS, loadTextFeatures, readJobFacts, toJobFacts, type FactsRow } from './job-facts-store';
import { canMergeJobs, mergeJobs, pickKeeper } from './job-merge';

function pairKey(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

/** A person said these are different jobs, so nothing offers them as duplicates again. */
export function markDistinct(sqlite: Database.Database, a: number, b: number): void {
  const [low, high] = pairKey(a, b);
  prepared(sqlite, `INSERT INTO duplicate_candidates (job_id_low, job_id_high, status) VALUES (?, ?, 'distinct') ON CONFLICT (job_id_low, job_id_high) DO UPDATE SET status = 'distinct'`).run(low, high);
}

/** A pair for someone to look at on the Duplicates page. */
export function recordPending(sqlite: Database.Database, a: number, candidate: ContentCandidate): void {
  const [low, high] = pairKey(a, candidate.jobId);
  // A pair someone already called different stays that way.
  prepared(
    sqlite,
    `INSERT INTO duplicate_candidates (job_id_low, job_id_high, status, score, reasons) VALUES (?, ?, 'pending', ?, ?)
     ON CONFLICT (job_id_low, job_id_high) DO UPDATE SET score = excluded.score, reasons = excluded.reasons WHERE status = 'pending'`
  ).run(low, high, candidate.comparison.score, JSON.stringify(candidate.comparison.reasons));
}

function distinctFrom(sqlite: Database.Database, jobId: number): Set<number> {
  const rows = prepared(sqlite, `SELECT job_id_low AS low, job_id_high AS high FROM duplicate_candidates WHERE status = 'distinct' AND (job_id_low = ? OR job_id_high = ?)`).all(jobId, jobId) as Array<{ low: number; high: number }>;
  return new Set(rows.map((row) => (row.low === jobId ? row.high : row.low)));
}

export interface SweepResult {
  checked: number;
  merged: number;
  pending: number;
}

interface SweepOptions {
  batchSize?: number;
  /** Taken once, right before the first automatic merge. */
  backup?: () => Promise<unknown>;
  /** Stops the sweep early, on shutdown. */
  shouldStop?: () => boolean;
}

interface JobToCheck {
  id: number;
  company_name: string;
  title: string;
  location: string | null;
}

/**
 * Compares every job not yet compared with the rest. Certain matches merge, and uncertain ones
 * wait for someone to look at. Work is split into small batches between requests, so people
 * keep working while thousands of saved jobs are checked.
 */
export async function sweepDuplicates(ctx: AppContext, options: SweepOptions = {}): Promise<SweepResult> {
  const result: SweepResult = { checked: 0, merged: 0, pending: 0 };
  const batchSize = options.batchSize ?? 50;
  let backedUp = false;

  for (;;) {
    const batch = prepared(ctx.handle.sqlite, `SELECT j.id, j.company_name, j.title, j.location FROM job_facts f JOIN jobs j ON j.id = f.job_id WHERE f.checked_at IS NULL ORDER BY j.id LIMIT ?`).all(batchSize) as JobToCheck[];
    if (batch.length === 0) break;

    for (const listed of batch) {
      if (options.shouldStop?.()) return result;
      // Read again: the job may have been merged into another meanwhile, or deleted, or corrected.
      const job = prepared(ctx.handle.sqlite, 'SELECT id, company_name, title, location FROM jobs WHERE id = ?').get(listed.id) as JobToCheck | undefined;
      if (!job) continue;
      // Looks first without changing anything, so that a backup can be taken before the first merge.
      const matches = checkJob(ctx, job);
      if (matches.auto && !backedUp) {
        await options.backup?.();
        backedUp = true;
      }
      const sqlite = ctx.handle.sqlite;
      const merged = sqlite
        .transaction(() => {
          const didMerge = applyMatches(ctx, job.id, matches, result);
          if (!didMerge) prepared(sqlite, `UPDATE job_facts SET checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE job_id = ?`).run(job.id);
          return didMerge;
        })
        .immediate();
      result.checked += 1;
      if (merged) ctx.events.publish('jobs_changed');
      // Lets waiting requests go first, so that people can keep working during a long check.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  if (result.merged > 0 || result.pending > 0) {
    ctx.logger.info(result, 'Checked saved jobs for duplicates');
    ctx.events.publish('jobs_changed');
  }
  return result;
}

/** Checks now and again later, for jobs changed since. Only one check runs at a time. */
export function startDuplicateChecks(ctx: AppContext, options: { backup?: () => Promise<unknown>; intervalMs?: number } = {}): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> | null = null;
  const run = () => {
    if (stopped || running) return;
    running = sweepDuplicates(ctx, { backup: options.backup, shouldStop: () => stopped })
      .then(() => undefined)
      .catch((error: unknown) => ctx.logger.error({ err: error }, 'Could not check for duplicates'))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(run, options.intervalMs ?? 5 * 60 * 1000);
  timer.unref();
  run();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

function checkJob(ctx: AppContext, job: JobToCheck) {
  const sqlite = ctx.handle.sqlite;
  const identifiers = prepared(sqlite, `SELECT provider, external_id AS externalId FROM job_identifiers WHERE job_id = ? AND is_discovered = 0`).all(job.id) as Array<{ provider: string; externalId: string }>;
  const exclude = distinctFrom(sqlite, job.id);
  exclude.add(job.id);
  return findContentMatches(ctx.db, { company: job.company_name, title: job.title, location: job.location, text: loadTextFeatures(sqlite, job.id), facts: readJobFacts(sqlite, job.id), identifiers }, exclude);
}

function applyMatches(ctx: AppContext, jobId: number, matches: ReturnType<typeof findContentMatches>, result: SweepResult): boolean {
  const sqlite = ctx.handle.sqlite;
  // Anything could have changed while a backup was being taken.
  const exists = prepared(sqlite, 'SELECT id FROM jobs WHERE id = ?');
  if (!exists.get(jobId)) return true;
  if (matches.auto && !exists.get(matches.auto.jobId)) matches = { auto: null, possible: [] };
  matches = { auto: matches.auto, possible: matches.possible.filter((candidate) => exists.get(candidate.jobId)) };
  if (matches.auto && canMergeJobs(sqlite, jobId, matches.auto.jobId)) {
    const keep = pickKeeper(sqlite, jobId, matches.auto.jobId);
    const other = keep === jobId ? matches.auto.jobId : jobId;
    ctx.logger.info({ keep, merged: other, reasons: matches.auto.comparison.reasons }, 'Merged a duplicate job');
    mergeJobs(sqlite, keep, other);
    result.merged += 1;
    return true;
  }
  for (const candidate of matches.auto ? [matches.auto] : matches.possible) {
    recordPending(sqlite, jobId, candidate);
    result.pending += 1;
  }
  return false;
}

function summarize(sqlite: Database.Database, jobId: number): DuplicateJobSummary | null {
  const row = prepared(
    sqlite,
    `SELECT j.id, j.title, j.company_name, j.location, substr(j.description, 1, 400) AS preview, j.application_count, j.created_at, ${FACTS_COLUMNS}
     FROM jobs j LEFT JOIN job_facts f ON f.job_id = j.id WHERE j.id = ?`
  ).get(jobId) as (FactsRow & { id: number; title: string; company_name: string; location: string | null; preview: string; application_count: number; created_at: string }) | undefined;
  if (!row) return null;
  const urls = prepared(sqlite, `SELECT original_url AS url FROM job_urls WHERE job_id = ? AND kind != 'redirect' ORDER BY id LIMIT 4`).all(jobId) as Array<{ url: string }>;
  return {
    id: row.id,
    title: row.title,
    company: row.company_name,
    location: row.location,
    descriptionPreview: row.preview,
    applicationCount: row.application_count,
    createdAt: row.created_at,
    urls: urls.map((item) => item.url),
    facts: toJobFacts(row)
  };
}

export function countDuplicates(ctx: AppContext): number {
  return (prepared(ctx.handle.sqlite, `SELECT COUNT(*) AS total FROM duplicate_candidates WHERE status = 'pending'`).get() as { total: number }).total;
}

export function listDuplicates(ctx: AppContext, limit = 100): DuplicatesResponse {
  const sqlite = ctx.handle.sqlite;
  const rows = prepared(sqlite, `SELECT job_id_low AS low, job_id_high AS high, score, reasons FROM duplicate_candidates WHERE status = 'pending' ORDER BY score DESC, job_id_high DESC LIMIT ?`).all(limit) as Array<{ low: number; high: number; score: number; reasons: string }>;
  const pairs: DuplicatePair[] = [];
  for (const row of rows) {
    const jobA = summarize(sqlite, row.low);
    const jobB = summarize(sqlite, row.high);
    if (jobA && jobB) pairs.push({ jobA, jobB, score: Math.round(row.score * 100) / 100, reasons: JSON.parse(row.reasons) as string[] });
  }
  return { pairs, total: countDuplicates(ctx) };
}

function assertBothExist(sqlite: Database.Database, a: number, b: number): void {
  if (a === b) throw new ApiError(400, 'same_job', 'Those are the same job.');
  const found = prepared(sqlite, 'SELECT COUNT(*) AS total FROM jobs WHERE id IN (?, ?)').get(a, b) as { total: number };
  if (found.total !== 2) throw notFound('That job no longer exists.');
}

/** Only a pair waiting on the Duplicates page can be merged from it: not one a person already called different. */
function assertWaiting(sqlite: Database.Database, a: number, b: number): void {
  const [low, high] = pairKey(a, b);
  const row = prepared(sqlite, 'SELECT status FROM duplicate_candidates WHERE job_id_low = ? AND job_id_high = ?').get(low, high) as { status: string } | undefined;
  if (row?.status === 'distinct') throw new ApiError(409, 'pair_settled', 'Someone has already marked these as different jobs.');
  if (row?.status !== 'pending') throw new ApiError(409, 'pair_not_waiting', 'These two jobs are no longer waiting to be compared. Refresh the list.');
}

/** Merging cannot be undone, so the database is copied first. A run of merges shares one copy an hour. */
async function backupBeforeMerging(ctx: AppContext): Promise<void> {
  const latest = listBackups(ctx).find((backup) => backup.name.startsWith('before-merge-'));
  if (latest && Date.now() - Date.parse(latest.createdAt) < 3_600_000) return;
  await createBackup(ctx, 'before-merge');
}

/** Someone looked at both and says they are one job. Their word overrides the matcher's doubts. */
export async function mergeDuplicatePair(ctx: AppContext, a: number, b: number): Promise<{ keptJobId: number }> {
  assertBothExist(ctx.handle.sqlite, a, b);
  assertWaiting(ctx.handle.sqlite, a, b);
  await backupBeforeMerging(ctx);
  // Looked at again: while the copy was made, someone may have settled the pair or merged a job away.
  const sqlite = ctx.handle.sqlite;
  assertBothExist(sqlite, a, b);
  assertWaiting(sqlite, a, b);
  const keep = pickKeeper(sqlite, a, b);
  sqlite
    .transaction(() => {
      mergeJobs(sqlite, keep, keep === a ? b : a);
    })
    .immediate();
  ctx.logger.info({ keep, merged: keep === a ? b : a }, 'Merged jobs at a person’s request');
  ctx.events.publish('jobs_changed', keep);
  return { keptJobId: keep };
}

export function dismissDuplicatePair(ctx: AppContext, a: number, b: number): void {
  const sqlite = ctx.handle.sqlite;
  assertBothExist(sqlite, a, b);
  markDistinct(sqlite, a, b);
  ctx.events.publish('jobs_changed');
}
