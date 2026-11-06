import type Database from 'better-sqlite3';
import { isUnreadableNote } from '../../shared/unreadable';
import type { AppContext } from '../context';
import { nowIso, prepared } from '../db/client';
import { AGGREGATOR_PROVIDERS, type AtsIdentity } from '../dedupe/ats';
import { normalizeCompany, titleSimilarity } from '../dedupe/text-normalize';
import { combineFacts } from '../dedupe/job-facts';
import { buildEvidence, type UrlEvidence, type UrlKind } from '../dedupe/matcher';
import { backfillJobFacts, readJobFacts, saveSignatures } from './job-facts-store';

const AGGREGATORS_SQL = AGGREGATOR_PROVIDERS.map((name) => `'${name}'`).join(',');

interface JobRow {
  id: number;
  company_name: string;
  title: string;
  description: string;
  description_hash: string | null;
  location: string | null;
  company_key: string;
  title_key: string;
  is_highlighted: number;
  highlighted_by: number | null;
  highlighted_at: string | null;
  created_at: string;
  last_activity_at: string | null;
}

/**
 * Two jobs can only be one if nothing says otherwise. The system that hosts a posting is the
 * authority, so two different ids on it mean two postings. A listing site can list one job
 * several times, so its ids say nothing either way.
 */
function haveConflictingIds(sqlite: Database.Database, a: number, b: number): boolean {
  return !!prepared(
    sqlite,
    `SELECT 1 FROM job_identifiers x JOIN job_identifiers y ON x.provider = y.provider AND x.external_id != y.external_id
     WHERE x.job_id = ? AND y.job_id = ? AND x.is_discovered = 0 AND y.is_discovered = 0 AND x.provider NOT IN (${AGGREGATORS_SQL}) LIMIT 1`
  ).get(a, b);
}

function getJob(sqlite: Database.Database, id: number): JobRow | undefined {
  return prepared(sqlite, 'SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
}

/** Merging is hard to undo, so it also needs the two jobs to look alike. */
export function canMergeJobs(sqlite: Database.Database, keepId: number, otherId: number): boolean {
  if (keepId === otherId) return false;
  const keep = getJob(sqlite, keepId);
  const other = getJob(sqlite, otherId);
  if (!keep || !other || haveConflictingIds(sqlite, keepId, otherId)) return false;
  const sameCompany = !!keep.company_key && keep.company_key === normalizeCompany(other.company_name);
  return sameCompany || titleSimilarity(keep.title, other.title) >= 0.5;
}

/** The job with the hosting system's own id stays, otherwise the one saved first. */
export function pickKeeper(sqlite: Database.Database, a: number, b: number): number {
  const ownA = hasOwnPostingId(sqlite, a);
  const ownB = hasOwnPostingId(sqlite, b);
  if (ownA !== ownB) return ownA ? a : b;
  return Math.min(a, b);
}

function hasOwnPostingId(sqlite: Database.Database, jobId: number): boolean {
  return !!prepared(sqlite, `SELECT 1 FROM job_identifiers WHERE job_id = ? AND is_discovered = 0 AND provider NOT IN (${AGGREGATORS_SQL}) LIMIT 1`).get(jobId);
}

interface ApplicationRow {
  id: number;
  profile_id: number;
  status: string;
  memo: string;
  furthest_rank: number;
  applied_at: string;
  updated_at: string;
  job_url_id: number | null;
}

const APPLICATION_FIELDS = 'id, profile_id, status, memo, furthest_rank, applied_at, updated_at, job_url_id';

/**
 * Folds one job into another: links, posting ids and applications all move. If one profile
 * applied to both, they become one application that keeps its furthest progress, both memos,
 * and every interview and history entry. Run inside a transaction.
 */
export function mergeJobs(sqlite: Database.Database, keepId: number, otherId: number): void {
  const keep = getJob(sqlite, keepId);
  const other = getJob(sqlite, otherId);
  if (!keep || !other) return;

  // Read before anything moves: this is what each listing knows, and whose posting it is.
  const keepFacts = readJobFacts(sqlite, keepId);
  const otherFacts = readJobFacts(sqlite, otherId);
  const keepIsOwn = hasOwnPostingId(sqlite, keepId);
  const otherIsOwn = hasOwnPostingId(sqlite, otherId);

  const incoming = prepared(sqlite, `SELECT ${APPLICATION_FIELDS} FROM applications WHERE job_id = ?`).all(otherId) as ApplicationRow[];
  for (const application of incoming) {
    const existing = prepared(sqlite, `SELECT ${APPLICATION_FIELDS} FROM applications WHERE job_id = ? AND profile_id = ?`).get(keepId, application.profile_id) as ApplicationRow | undefined;
    if (!existing) {
      prepared(sqlite, 'UPDATE applications SET job_id = ? WHERE id = ?').run(keepId, application.id);
      continue;
    }
    prepared(sqlite, 'UPDATE interviews SET application_id = ? WHERE application_id = ?').run(existing.id, application.id);
    prepared(sqlite, 'UPDATE application_status_history SET application_id = ? WHERE application_id = ?').run(existing.id, application.id);
    const incomingLeads = application.furthest_rank > existing.furthest_rank || (application.furthest_rank === existing.furthest_rank && application.updated_at > existing.updated_at);
    const memos = [...new Set([existing.memo, application.memo].map((memo) => memo.trim()).filter(Boolean))];
    prepared(sqlite, 'DELETE FROM applications WHERE id = ?').run(application.id);
    // The link stays with the earlier application, which the kept date belongs to.
    const earlier = existing.applied_at <= application.applied_at ? existing : application;
    const later = earlier === existing ? application : existing;
    prepared(sqlite, 'UPDATE applications SET status = ?, memo = ?, furthest_rank = ?, applied_at = ?, updated_at = ?, job_url_id = ? WHERE id = ?').run(
      incomingLeads ? application.status : existing.status,
      memos.join('\n\n'),
      Math.max(existing.furthest_rank, application.furthest_rank),
      earlier.applied_at,
      existing.updated_at > application.updated_at ? existing.updated_at : application.updated_at,
      earlier.job_url_id ?? later.job_url_id,
      existing.id
    );
  }

  prepared(sqlite, 'UPDATE job_urls SET job_id = ? WHERE job_id = ?').run(keepId, otherId);
  prepared(sqlite, 'UPDATE job_identifiers SET job_id = ? WHERE job_id = ?').run(keepId, otherId);

  // The hosting system's wording beats a listing site's rewrite of it. Otherwise the fuller text wins.
  const preferOther = otherIsOwn && !keepIsOwn;
  // Real text always beats a note saying a posting could not be read.
  const keepIsNote = isUnreadableNote(keep.description);
  const otherIsNote = isUnreadableNote(other.description);
  const useOtherText = keepIsNote !== otherIsNote ? keepIsNote : preferOther || (otherIsOwn === keepIsOwn && other.description.length > keep.description.length);
  const highlighted = keep.is_highlighted || other.is_highlighted;
  prepared(
    sqlite,
    `UPDATE jobs SET title = ?, title_key = ?, company_name = ?, company_key = ?, description = ?, description_hash = ?, location = ?,
       is_highlighted = ?, highlighted_by = ?, highlighted_at = ?, created_at = ?, updated_at = ?,
       application_count = (SELECT COUNT(*) FROM applications a WHERE a.job_id = jobs.id) WHERE id = ?`
  ).run(
    preferOther ? other.title : keep.title,
    preferOther ? other.title_key : keep.title_key,
    preferOther ? other.company_name : keep.company_name,
    preferOther ? other.company_key : keep.company_key,
    useOtherText ? other.description : keep.description,
    useOtherText ? other.description_hash : keep.description_hash,
    keep.location ?? other.location,
    highlighted ? 1 : 0,
    keep.highlighted_by ?? other.highlighted_by,
    keep.highlighted_at ?? other.highlighted_at,
    keep.created_at < other.created_at ? keep.created_at : other.created_at,
    nowIso(),
    keepId
  );
  // Someone said the merged-away job differs from a third one, which now holds for the job it joined.
  prepared(
    sqlite,
    `INSERT OR REPLACE INTO duplicate_candidates (job_id_low, job_id_high, status)
     SELECT MIN(@keep, third), MAX(@keep, third), 'distinct' FROM (
       SELECT CASE WHEN job_id_low = @other THEN job_id_high ELSE job_id_low END AS third FROM duplicate_candidates
       WHERE status = 'distinct' AND (job_id_low = @other OR job_id_high = @other)
     ) WHERE third != @keep`
  ).run({ keep: keepId, other: otherId });
  prepared(sqlite, 'DELETE FROM jobs WHERE id = ?').run(otherId);

  const facts = combineFacts(keepFacts, otherFacts);
  prepared(
    sqlite,
    `INSERT INTO job_facts (job_id, work_arrangement, employment_type, clearance, is_federal, posted_at, salary_min, salary_max, salary_currency, salary_period, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (job_id) DO UPDATE SET work_arrangement = excluded.work_arrangement, employment_type = excluded.employment_type, clearance = excluded.clearance, is_federal = excluded.is_federal,
       posted_at = excluded.posted_at, salary_min = excluded.salary_min, salary_max = excluded.salary_max, salary_currency = excluded.salary_currency, salary_period = excluded.salary_period, checked_at = NULL`
  ).run(keepId, facts.workArrangement, facts.employmentType, facts.clearance, facts.isFederal ? 1 : 0, facts.postedAt, facts.salaryMin, facts.salaryMax, facts.salaryCurrency, facts.salaryPeriod);
  const merged = getJob(sqlite, keepId) as JobRow;
  saveSignatures(sqlite, keepId, merged.description);
}

function identitiesOf(item: UrlEvidence): Array<AtsIdentity & { discovered: boolean }> {
  return [
    ...(item.identity ? [{ ...item.identity, discovered: item.kind === 'discovered' }] : []),
    ...item.references.map((reference) => ({ ...reference, discovered: true }))
  ];
}

/**
 * A link can tie together two jobs that were saved separately: a Greenhouse link carrying the id
 * of a Jobright listing someone added earlier. This folds them into one. Run inside a transaction.
 */
export function absorbDuplicates(ctx: AppContext, jobId: number, evidence: UrlEvidence[]): boolean {
  const sqlite = ctx.handle.sqlite;
  let merged = false;
  for (const item of evidence) {
    if (item.kind !== 'original') continue;
    for (const identity of identitiesOf(item)) {
      const row = prepared(sqlite, 'SELECT job_id FROM job_identifiers WHERE provider = ? AND external_id = ?').get(identity.provider, identity.externalId) as { job_id: number } | undefined;
      if (!row || row.job_id === jobId || !canMergeJobs(sqlite, jobId, row.job_id)) continue;
      ctx.logger.info({ jobId, merged: row.job_id, provider: identity.provider }, 'Merged a duplicate job');
      mergeJobs(sqlite, jobId, row.job_id);
      merged = true;
    }
  }
  return merged;
}

export interface ReconcileResult {
  identifiersAdded: number;
  jobsMerged: number;
}

/**
 * Brings saved links up to what the current rules can see in them. Ids were once ignored in links
 * that are already in the database, so this records them and folds together any jobs they show
 * to be one. It does nothing on later runs. A backup is taken first, only when a merge is needed.
 */
export async function reconcileJobIdentities(ctx: AppContext, options: { backup?: () => Promise<unknown> } = {}): Promise<ReconcileResult> {
  const sqlite = ctx.handle.sqlite;
  backfillJobFacts(sqlite);
  const rows = sqlite.prepare('SELECT job_id, original_url, kind FROM job_urls').all() as Array<{ job_id: number; original_url: string; kind: UrlKind }>;
  const known = new Map((sqlite.prepare('SELECT provider, external_id, job_id FROM job_identifiers').all() as Array<{ provider: string; external_id: string; job_id: number }>).map((row) => [`${row.provider}\n${row.external_id}`, row.job_id]));

  const additions: Array<{ jobId: number; provider: string; externalId: string; discovered: boolean }> = [];
  const pairs: Array<[number, number]> = [];
  for (const row of rows) {
    const evidence = buildEvidence(row.original_url, row.kind);
    if (!evidence) continue;
    for (const identity of identitiesOf(evidence)) {
      const key = `${identity.provider}\n${identity.externalId}`;
      const owner = known.get(key);
      if (owner === undefined) {
        known.set(key, row.job_id);
        additions.push({ jobId: row.job_id, provider: identity.provider, externalId: identity.externalId, discovered: identity.discovered });
      } else if (owner !== row.job_id && row.kind === 'original') {
        pairs.push([Math.min(owner, row.job_id), Math.max(owner, row.job_id)]);
      }
    }
  }
  if (additions.length === 0 && pairs.length === 0) return { identifiersAdded: 0, jobsMerged: 0 };

  const insert = sqlite.prepare('INSERT OR IGNORE INTO job_identifiers (job_id, provider, external_id, is_discovered) VALUES (?, ?, ?, ?)');
  sqlite.transaction(() => {
    for (const item of additions) insert.run(item.jobId, item.provider, item.externalId, item.discovered ? 1 : 0);
  })();

  // A pair can refer to a job already folded into another, so each is followed to where it went.
  const mergedInto = new Map<number, number>();
  const current = (id: number): number => {
    let found = id;
    while (mergedInto.has(found)) found = mergedInto.get(found) as number;
    return found;
  };
  const mergeable = pairs.filter(([a, b]) => canMergeJobs(sqlite, a, b));
  if (mergeable.length > 0) await options.backup?.();

  let jobsMerged = 0;
  sqlite.transaction(() => {
    for (const [a, b] of mergeable) {
      const keep = current(a);
      const other = current(b);
      if (keep === other || !canMergeJobs(sqlite, keep, other)) continue;
      mergeJobs(sqlite, keep, other);
      mergedInto.set(other, keep);
      jobsMerged += 1;
    }
  })();
  if (additions.length > 0 || jobsMerged > 0) ctx.logger.info({ identifiersAdded: additions.length, jobsMerged }, 'Reconciled job identities');
  return { identifiersAdded: additions.length, jobsMerged };
}
