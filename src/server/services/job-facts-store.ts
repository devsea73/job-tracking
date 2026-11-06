import type Database from 'better-sqlite3';
import { isUnreadableNote } from '../../shared/unreadable';
import type { JobFacts, SalaryPeriod, EmploymentType, WorkArrangement } from '../../shared/api';
import { nowIso, prepared } from '../db/client';
import { combineFacts, deriveJobFacts, EMPTY_FACTS } from '../dedupe/job-facts';
import { EMPTY_FEATURES, FEATURES_VERSION, fromBlob, textFeatures, textSketchOf, toBlob, type TextFeatures } from '../dedupe/text-features';
import { hashDescription, normalizeCompany, normalizeTitle } from '../dedupe/text-normalize';
import { stripPersonalParams } from '../dedupe/url-normalize';
import { htmlToText, looksLikeHtml } from '../extraction/text';

export interface FactsRow {
  work_arrangement: WorkArrangement | null;
  employment_type: EmploymentType | null;
  clearance: string | null;
  is_federal: number | null;
  posted_at: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: SalaryPeriod | null;
}

export const FACTS_COLUMNS = `f.work_arrangement, f.employment_type, f.clearance, f.is_federal, f.posted_at, f.salary_min, f.salary_max, f.salary_currency, f.salary_period`;

export function toJobFacts(row: FactsRow | null | undefined): JobFacts {
  if (!row) return EMPTY_FACTS;
  return {
    workArrangement: row.work_arrangement ?? null,
    employmentType: row.employment_type ?? null,
    clearance: row.clearance ?? null,
    isFederal: row.is_federal === 1,
    postedAt: row.posted_at ?? null,
    salaryMin: row.salary_min ?? null,
    salaryMax: row.salary_max ?? null,
    salaryCurrency: row.salary_currency ?? null,
    salaryPeriod: row.salary_period ?? null
  };
}

export function readJobFacts(sqlite: Database.Database, jobId: number): JobFacts {
  return toJobFacts(prepared(sqlite, `SELECT ${FACTS_COLUMNS} FROM job_facts f WHERE f.job_id = ?`).get(jobId) as FactsRow | undefined);
}

function writeFacts(sqlite: Database.Database, jobId: number, facts: JobFacts, checkedAt: string | null): void {
  prepared(
    sqlite,
    `INSERT INTO job_facts (job_id, work_arrangement, employment_type, clearance, is_federal, posted_at, salary_min, salary_max, salary_currency, salary_period, checked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (job_id) DO UPDATE SET work_arrangement = excluded.work_arrangement, employment_type = excluded.employment_type, clearance = excluded.clearance,
       is_federal = excluded.is_federal, posted_at = excluded.posted_at, salary_min = excluded.salary_min, salary_max = excluded.salary_max,
       salary_currency = excluded.salary_currency, salary_period = excluded.salary_period, updated_at = excluded.updated_at`
  ).run(jobId, facts.workArrangement, facts.employmentType, facts.clearance, facts.isFederal ? 1 : 0, facts.postedAt, facts.salaryMin, facts.salaryMax, facts.salaryCurrency, facts.salaryPeriod, checkedAt, nowIso());
}

export interface FeatureRow {
  t_version: number | null;
  t_hash: string | null;
  t_length: number | null;
  t_shingles: Buffer | null;
  t_words: Buffer | null;
  t_requisitions: string | null;
}

export const FEATURE_COLUMNS = `t.version AS t_version, t.hash AS t_hash, t.length AS t_length, t.shingles AS t_shingles, t.words AS t_words, t.requisitions AS t_requisitions`;

export function toTextFeatures(row: FeatureRow): TextFeatures | null {
  if (row.t_version === null || row.t_version === undefined) return null;
  return { hash: row.t_hash, length: row.t_length ?? 0, shingles: fromBlob(row.t_shingles), words: fromBlob(row.t_words), requisitions: row.t_requisitions ? (JSON.parse(row.t_requisitions) as string[]) : [] };
}

/** A saved job's features, made from its text if it has none yet. */
export function loadTextFeatures(sqlite: Database.Database, jobId: number): TextFeatures {
  const row = prepared(sqlite, `SELECT ${FEATURE_COLUMNS} FROM job_text_features t WHERE t.job_id = ?`).get(jobId) as FeatureRow | undefined;
  const stored = row ? toTextFeatures(row) : null;
  if (stored) return stored;
  const job = prepared(sqlite, 'SELECT description FROM jobs WHERE id = ?').get(jobId) as { description: string } | undefined;
  return job && !isUnreadableNote(job.description) ? textFeatures(job.description) : EMPTY_FEATURES;
}

/**
 * Indexes a job's text for duplicate detection: hashed phrases and words, and a few of them as
 * fingerprints that find the posting again however its link or company is written.
 */
export function saveSignatures(sqlite: Database.Database, jobId: number, description: string): void {
  const features = isUnreadableNote(description) ? EMPTY_FEATURES : textFeatures(description);
  prepared(
    sqlite,
    `INSERT INTO job_text_features (job_id, version, hash, length, shingles, words, requisitions) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (job_id) DO UPDATE SET version = excluded.version, hash = excluded.hash, length = excluded.length, shingles = excluded.shingles, words = excluded.words, requisitions = excluded.requisitions`
  ).run(jobId, FEATURES_VERSION, features.hash, features.length, toBlob(features.shingles), toBlob(features.words), JSON.stringify(features.requisitions));
  prepared(sqlite, 'DELETE FROM job_signatures WHERE job_id = ?').run(jobId);
  const insert = prepared(sqlite, 'INSERT OR IGNORE INTO job_signatures (kind, value, job_id) VALUES (?, ?, ?)');
  for (const value of textSketchOf(features)) insert.run('text', value, jobId);
}

/**
 * Saved links lose what newer rules strip: tracking that can identify the person who clicked.
 * Only rewrites links that change, so it does nothing on later starts.
 */
export function cleanSavedLinks(sqlite: Database.Database): number {
  const rows = sqlite.prepare(`SELECT id, original_url FROM job_urls WHERE original_url LIKE '%?%'`).all() as Array<{ id: number; original_url: string }>;
  const update = sqlite.prepare('UPDATE job_urls SET original_url = ? WHERE id = ?');
  let cleaned = 0;
  sqlite.transaction(() => {
    for (const row of rows) {
      let clean: string;
      try {
        clean = stripPersonalParams(row.original_url);
      } catch {
        continue;
      }
      if (clean !== row.original_url) {
        update.run(clean, row.id);
        cleaned += 1;
      }
    }
  })();
  return cleaned;
}

/**
 * Brings every saved job up to the current way of comparing: normalized company and title keys,
 * and text features. Runs only when those rules changed, then compares every job again, since
 * jobs once thought different may now be found alike, and the other way round.
 */
export function reindexJobs(sqlite: Database.Database): number {
  const stale = sqlite
    .prepare(`SELECT j.id, j.company_name, j.title, j.company_key, j.title_key, j.description FROM jobs j LEFT JOIN job_text_features t ON t.job_id = j.id WHERE t.job_id IS NULL OR t.version != ?`)
    .all(FEATURES_VERSION) as Array<{ id: number; company_name: string; title: string; company_key: string; title_key: string; description: string }>;
  if (stale.length === 0) return 0;
  const setKeys = sqlite.prepare('UPDATE jobs SET company_key = ?, title_key = ? WHERE id = ?');
  sqlite.transaction(() => {
    for (const job of stale) {
      const companyKey = normalizeCompany(job.company_name);
      const titleKey = normalizeTitle(job.title);
      if (companyKey !== job.company_key || titleKey !== job.title_key) setKeys.run(companyKey, titleKey, job.id);
      saveSignatures(sqlite, job.id, job.description);
    }
    // Pairs judged by the old rules are judged again; a person's "different" stands.
    sqlite.prepare(`DELETE FROM duplicate_candidates WHERE status = 'pending'`).run();
    sqlite.prepare('UPDATE job_facts SET checked_at = NULL').run();
  })();
  return stale.length;
}

/** Records a job just compared with everything else, so that the background check can skip it. */
export function saveNewJobFacts(sqlite: Database.Database, jobId: number, facts: JobFacts, description: string): void {
  writeFacts(sqlite, jobId, facts, nowIso());
  saveSignatures(sqlite, jobId, description);
}

/** Another listing of a known job can fill in what its first listing did not say. */
export function addFactsFromListing(sqlite: Database.Database, jobId: number, facts: JobFacts): void {
  writeFacts(sqlite, jobId, combineFacts(readJobFacts(sqlite, jobId), facts), null);
}

/** After details are corrected by hand. What sites stated as data is kept, and the text is read again. */
export function refreshJobFacts(sqlite: Database.Database, jobId: number): void {
  const job = prepared(sqlite, 'SELECT title, company_name, location, description FROM jobs WHERE id = ?').get(jobId) as { title: string; company_name: string; location: string | null; description: string } | undefined;
  if (!job) return;
  const fresh = deriveJobFacts({ title: job.title, company: job.company_name, location: job.location, description: job.description });
  writeFacts(sqlite, jobId, combineFacts(fresh, readJobFacts(sqlite, jobId)), null);
  saveSignatures(sqlite, jobId, job.description);
  prepared(sqlite, 'UPDATE job_facts SET checked_at = NULL WHERE job_id = ?').run(jobId);
}

/**
 * Turns descriptions saved as markup into text, for jobs saved before markup was always caught.
 * Only touches descriptions that still contain tags, so it does nothing on later starts.
 */
export function repairHtmlDescriptions(sqlite: Database.Database): number {
  const rows = sqlite.prepare(`SELECT id, description FROM jobs WHERE description LIKE '%<%>%' OR description LIKE '%&lt;%&gt;%'`).all() as Array<{ id: number; description: string }>;
  const update = sqlite.prepare('UPDATE jobs SET description = ?, description_hash = ? WHERE id = ?');
  let fixed = 0;
  sqlite.transaction(() => {
    for (const row of rows) {
      if (!looksLikeHtml(row.description)) continue;
      const text = htmlToText(row.description);
      if (!text || text === row.description) continue;
      update.run(text, hashDescription(text), row.id);
      // The tags, the fingerprints and the duplicate check all read the description.
      if (sqlite.prepare('SELECT 1 FROM job_facts WHERE job_id = ?').get(row.id)) refreshJobFacts(sqlite, row.id);
      fixed += 1;
    }
  })();
  return fixed;
}

/**
 * Gives jobs saved before facts were collected their tags and fingerprints, from their saved
 * text. Runs once for each such job. Dates and data-only details stay unknown for them.
 */
export function backfillJobFacts(sqlite: Database.Database): number {
  const missing = sqlite
    .prepare(
      `SELECT j.id, j.title, j.company_name, j.location, j.description,
              (SELECT GROUP_CONCAT(u.original_url, ' ') FROM job_urls u WHERE u.job_id = j.id) AS urls
       FROM jobs j LEFT JOIN job_facts f ON f.job_id = j.id WHERE f.job_id IS NULL`
    )
    .all() as Array<{ id: number; title: string; company_name: string; location: string | null; description: string; urls: string | null }>;
  if (missing.length === 0) return 0;
  sqlite.transaction(() => {
    for (const job of missing) {
      const facts = deriveJobFacts({ title: job.title, company: job.company_name, location: job.location, description: job.description, urls: job.urls ? job.urls.split(' ') : [] });
      writeFacts(sqlite, job.id, facts, null);
      saveSignatures(sqlite, job.id, job.description);
    }
  })();
  return missing.length;
}
