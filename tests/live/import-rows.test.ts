import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import type { CreateApplicationResponse } from '../../src/shared/api';
import { unreadableNote } from '../../src/shared/unreadable';
import { createContext } from '../../src/server/create-context';
import { closeDatabase } from '../../src/server/db/client';
import { titleFromUrl } from '../../src/server/dedupe/ats';
import { normalizeCompany, normalizeTitle } from '../../src/server/dedupe/text-normalize';
import { PlaywrightRenderer } from '../../src/server/extraction/browser';
import { FetchError, SafeHttpClient, type FetchOptions, type FetchResult, type HttpClient } from '../../src/server/extraction/safe-fetch';
import type { PageRenderer, RenderedPage } from '../../src/server/extraction/types';
import { createFileLogger } from '../../src/server/logger';
import { createBackup } from '../../src/server/services/backups';
import { createApplication } from '../../src/server/services/intake';
import { refreshJobFacts } from '../../src/server/services/job-facts-store';

/**
 * One-off import of spreadsheet rows into one profile, through the app's own add-a-job code.
 * IMPORT_DATA=<host-data folder>  SURVEY_ARGS: --rows rows.json --user 2 --profile 3 [--name William] [--cache folder] [--log file] [--out report.json]
 */

const args = (process.env.SURVEY_ARGS ?? '').split(' ').filter(Boolean);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const key = (text: string) => createHash('sha1').update(text).digest('hex');

class CachedHttp implements HttpClient {
  constructor(
    private readonly inner: HttpClient,
    private readonly folder: string | undefined
  ) {}
  async fetch(url: string, options?: FetchOptions): Promise<FetchResult> {
    const file = this.folder ? join(this.folder, `http-${key(`${options?.method ?? 'GET'} ${url} ${options?.body ?? ''}`)}.json`) : null;
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.error) throw new FetchError(saved.error.reason, saved.error.message);
      return saved.result;
    }
    try {
      const result = await this.inner.fetch(url, options);
      if (file) writeFileSync(file, JSON.stringify({ url, result }));
      return result;
    } catch (error) {
      if (file && error instanceof FetchError) writeFileSync(file, JSON.stringify({ url, error: { reason: error.reason, message: error.message } }));
      throw error;
    }
  }
}

class CachedRenderer implements PageRenderer {
  constructor(
    private readonly inner: PageRenderer,
    private readonly folder: string | undefined
  ) {}
  async render(url: string): Promise<RenderedPage> {
    const file = this.folder ? join(this.folder, `page-${key(url)}.json`) : null;
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.error) throw new Error(saved.error);
      return saved.page;
    }
    try {
      const page = await this.inner.render(url);
      if (file) writeFileSync(file, JSON.stringify({ url, page }));
      return page;
    } catch (error) {
      if (file) writeFileSync(file, JSON.stringify({ url, error: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  }
  async close(): Promise<void> {
    await this.inner.close();
  }
}

interface Row {
  n: number;
  url: string;
  company: string;
  position: string;
  detail: string;
  date: string;
}

interface Result {
  n: number;
  url: string;
  outcome: string;
  jobId?: number;
  matchedBy?: string;
  company?: string;
  companyFrom?: 'page' | 'sheet';
  title?: string;
  titleFrom?: string;
  reason?: string;
  candidates?: number[];
  error?: string;
}

/** "8/30" or "8/30/2026" to midday UTC, so the day is the same in every timezone. */
function isoDay(text: string, year: number): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(text.trim());
  if (!match) return null;
  const fullYear = match[3] ? (match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3])) : year;
  return new Date(Date.UTC(fullYear, Number(match[1]) - 1, Number(match[2]), 12)).toISOString();
}

test('import rows into one profile', async () => {
  const rows = JSON.parse(readFileSync(option('--rows') as string, 'utf8')) as Row[];
  // From the environment: the usual folder has a space in it, which the argument list would split.
  const dataDir = process.env.IMPORT_DATA as string;
  if (!dataDir || !existsSync(join(dataDir, 'job-tracker.sqlite'))) throw new Error(`No database in ${dataDir}`);
  const userId = Number(option('--user'));
  const profileId = Number(option('--profile'));
  const cache = option('--cache');
  const renderer = new CachedRenderer(new PlaywrightRenderer(), cache);
  const ctx = await createContext({
    dataDir,
    migrationsDir: join(__dirname, '..', '..', 'drizzle'),
    version: 'import',
    http: new CachedHttp(new SafeHttpClient(), cache),
    renderer,
    logger: createFileLogger(option('--log') ?? join(dataDir, 'logs', 'import.log'))
  });
  const owner = ctx.handle.sqlite.prepare('SELECT user_id FROM profiles WHERE id = ?').get(profileId) as { user_id: number } | undefined;
  if (owner?.user_id !== userId) throw new Error(`Profile ${profileId} does not belong to user ${userId}`);
  const backup = await createBackup(ctx, 'before-import');
  console.log(`backup: ${backup.name}`);

  const results: Result[] = [];
  let next = 0;
  let done = 0;
  const work = async () => {
    while (next < rows.length) {
      const row = rows[next];
      next += 1;
      const result: Result = { n: row.n, url: row.url, outcome: 'error' };
      const memo = row.position.trim();
      let manual: { title: string; company: string; description: string; location: string | null } | undefined;
      try {
        let response: CreateApplicationResponse = await createApplication(ctx, userId, { url: row.url, profileId, memo });
        if (response.outcome === 'needs_manual') {
          // The page could not be read. What it did give is a guess (a company from the link, a
          // page title that is only the company's name), so the sheet comes first here.
          const guessCompany = response.extracted.company?.trim() ?? '';
          // Nothing anywhere names the company: kept, so the application is not lost, and easy to find and correct.
          const company = row.company.trim() || guessCompany || 'Unknown company';
          const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(inc|llc|ltd|corp)$/, '');
          const pageTitle = response.extracted.title?.trim() ?? '';
          const usableTitle = pageTitle && ![company, guessCompany].some((name) => name && squash(name) === squash(pageTitle)) ? pageTitle : '';
          const fromLink = titleFromUrl(row.url) ?? '';
          // A link names the job reliably; an unreadable page's own text often does not.
          const title = row.detail.trim() || fromLink || usableTitle || 'Unknown title';
          result.reason = response.reason;
          result.companyFrom = row.company.trim() ? 'sheet' : 'page';
          if (!row.company.trim() && !guessCompany) result.error = 'no company on the page or in the sheet';
          result.titleFrom = row.detail.trim() ? 'sheet' : fromLink ? 'link' : usableTitle ? 'page' : 'unknown';
          // The link in the text keeps two unreadable jobs at one company from looking identical.
          const description = response.extracted.description?.trim() || unreadableNote(response.reason, response.message);
          manual = { title, company, description, location: response.extracted.location ?? null };
          response = await createApplication(ctx, userId, { url: row.url, profileId, memo, draftId: response.draftId, manual });
        }
        if (response.outcome === 'possible_duplicate') {
          // Nobody answers here: saved as its own job, and the question goes to the review page.
          result.candidates = response.candidates.map((candidate) => candidate.jobId);
          response = await createApplication(ctx, userId, { url: row.url, profileId, memo, draftId: response.draftId, resolution: { action: 'new' }, manual });
          result.outcome = 'asked';
        }
        if (response.outcome === 'created') {
          if (result.outcome !== 'asked') result.outcome = result.reason ? 'typed' : response.jobWasNew ? 'new' : 'joined';
          result.jobId = response.jobId;
          result.matchedBy = response.matchedBy;
          const job = ctx.handle.sqlite.prepare('SELECT title, company_name FROM jobs WHERE id = ?').get(response.jobId) as { title: string; company_name: string };
          result.title = job.title;
          result.company = job.company_name;
          result.companyFrom ??= 'page';
        } else if (response.outcome === 'already_applied') {
          result.outcome = 'already';
          result.jobId = response.jobId;
          result.title = response.title;
          result.company = response.company;
        } else if (response.outcome === 'needs_manual') {
          result.outcome = 'skipped';
          result.error = response.message;
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
      results.push(result);
      done += 1;
      if (done % 200 === 0) console.log(`  ${done} of ${rows.length}`);
    }
  };
  await Promise.all(Array.from({ length: Number(option('--concurrency') ?? 6) }, work));

  // Questions nobody answered: not "different", but waiting for review.
  const sqlite = ctx.handle.sqlite;
  const clear = sqlite.prepare(`DELETE FROM duplicate_candidates WHERE status = 'distinct' AND (job_id_low = ? OR job_id_high = ?)`);
  const recheck = sqlite.prepare('UPDATE job_facts SET checked_at = NULL WHERE job_id = ?');
  sqlite.transaction(() => {
    for (const result of results.filter((item) => item.outcome === 'asked' && item.jobId)) {
      clear.run(result.jobId, result.jobId);
      recheck.run(result.jobId);
    }
  })();

  // Every row's own details, now that each row knows its job: the date it was applied, the
  // Position column as the memo, and the sheet's title where nothing better was found.
  const rowByNumber = new Map(rows.map((row) => [row.n, row]));
  const byJob = new Map<number, Row[]>();
  for (const result of results) {
    if (!result.jobId) continue;
    byJob.set(result.jobId, [...(byJob.get(result.jobId) ?? []), rowByNumber.get(result.n) as Row]);
  }
  const year = Number(option('--year') ?? new Date().getFullYear());
  const application = sqlite.prepare('SELECT id FROM applications WHERE job_id = ? AND profile_id = ?');
  const setApplication = sqlite.prepare('UPDATE applications SET memo = ?, applied_at = COALESCE(?, applied_at) WHERE id = ?');
  const jobRow = sqlite.prepare('SELECT title, application_count AS count FROM jobs WHERE id = ?');
  const setTitle = sqlite.prepare('UPDATE jobs SET title = ?, title_key = ? WHERE id = ?');
  const setCompany = sqlite.prepare('UPDATE jobs SET company_name = ?, company_key = ? WHERE id = ?');
  // --sheet-first: the sheet's title and company are the job's, for jobs this import created.
  // A job someone else had already saved keeps its own, so nobody else's job is renamed.
  const sheetFirst = args.includes('--sheet-first');
  const createdHere = new Set(results.filter((item) => item.jobId && (item.outcome === 'new' || item.outcome === 'typed' || item.outcome === 'asked')).map((item) => item.jobId as number));
  let sheetTitles = 0;
  let sheetCompanies = 0;
  let fixedTitles = 0;
  let dated = 0;
  sqlite.transaction(() => {
    for (const [jobId, jobRows] of byJob) {
      const app = application.get(jobId, profileId) as { id: number } | undefined;
      if (!app) continue;
      // "snowflake, databricks" and "snowflake" on two rows of one job: each word once.
      const seen = new Set<string>();
      const terms: string[] = [];
      for (const term of jobRows.flatMap((row) => row.position.split(',')).map((item) => item.trim())) {
        if (term && !seen.has(term.toLowerCase())) {
          seen.add(term.toLowerCase());
          terms.push(term);
        }
      }
      const days = jobRows.map((row) => isoDay(row.date, year)).filter((day): day is string => !!day).sort();
      // The applied date is what bids are counted by; when the record was written stays as it is.
      setApplication.run(terms.join(', '), days[0] ?? null, app.id);
      if (days[0]) dated += 1;
      const job = jobRow.get(jobId) as { title: string; count: number };
      const detail = jobRows.map((row) => row.detail.trim()).find(Boolean);
      if (sheetFirst && createdHere.has(jobId) && job.count === 1) {
        const company = jobRows.map((row) => row.company.trim()).find(Boolean);
        let changed = false;
        if (detail && detail !== job.title) {
          setTitle.run(detail, normalizeTitle(detail), jobId);
          sheetTitles += 1;
          changed = true;
        }
        const current = (sqlite.prepare('SELECT company_name FROM jobs WHERE id = ?').get(jobId) as { company_name: string }).company_name;
        if (company && company !== current) {
          setCompany.run(company, normalizeCompany(company), jobId);
          sheetCompanies += 1;
          changed = true;
        }
        if (changed) refreshJobFacts(sqlite, jobId);
      } else if (job.title === 'Unknown title' && detail && job.count === 1) {
        setTitle.run(detail, normalizeTitle(detail), jobId);
        refreshJobFacts(sqlite, jobId);
        fixedTitles += 1;
      }
    }
  })();

  writeFileSync(option('--out') ?? 'import-report.json', JSON.stringify(results.sort((a, b) => a.n - b.n), null, 1));
  const tally: Record<string, number> = {};
  for (const result of results) tally[result.outcome] = (tally[result.outcome] ?? 0) + 1;
  console.log(JSON.stringify({ ...tally, jobs: byJob.size, dated, fixedTitles, sheetTitles, sheetCompanies }));
  await renderer.close();
  closeDatabase(ctx.handle);
}, 6 * 60 * 60 * 1000);
