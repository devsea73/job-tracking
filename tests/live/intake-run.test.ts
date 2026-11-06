import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import type { CreateApplicationResponse } from '../../src/shared/api';
import { buildApp } from '../../src/server/app';
import { createContext } from '../../src/server/create-context';
import { closeDatabase } from '../../src/server/db/client';
import { AGGREGATOR_PROVIDERS, identifyAts } from '../../src/server/dedupe/ats';
import { normalizeCompany, titleSimilarity } from '../../src/server/dedupe/text-normalize';
import { parseUserUrl, stripPersonalParams } from '../../src/server/dedupe/url-normalize';
import { PlaywrightRenderer } from '../../src/server/extraction/browser';
import { FetchError, SafeHttpClient, type FetchOptions, type FetchResult, type HttpClient } from '../../src/server/extraction/safe-fetch';
import type { PageRenderer, RenderedPage } from '../../src/server/extraction/types';
import { createFileLogger } from '../../src/server/logger';
import { sweepDuplicates } from '../../src/server/services/duplicates';
import { createUsers, type ApiClient } from '../helpers';

/**
 * Adds every link in a list through the real app, as people would, and reports what became of
 * them: new jobs, links recognized as a job already saved (and how), questions asked, pages that
 * could not be read, and same-company jobs with similar titles that were kept apart.
 *
 *   npm run survey -- --intake --file C:\path\job.txt --data C:\some\folder [--cache C:\folder] [--concurrency 6] [--out report.txt]
 *
 * --cache keeps every page read, so a second run gives the same answers without visiting the
 * sites again. The database stays in --data, to open in the app afterwards. Nothing here goes in
 * the repository: real links can carry personal tokens.
 */

const args = (process.env.SURVEY_ARGS ?? '').split(' ').filter(Boolean);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const key = (text: string) => createHash('sha1').update(text).digest('hex');

/** Remembers every answer from the web, errors included, keyed by what was asked. */
class RecordingHttp implements HttpClient {
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

class RecordingRenderer implements PageRenderer {
  constructor(
    private readonly inner: PageRenderer | null,
    private readonly folder: string | undefined
  ) {}

  async render(url: string): Promise<RenderedPage> {
    const file = this.folder ? join(this.folder, `page-${key(url)}.json`) : null;
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.error) throw new Error(saved.error);
      return saved.page;
    }
    if (!this.inner) throw new Error('No browser in this run.');
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
    await this.inner?.close();
  }
}

interface Outcome {
  index: number;
  url: string;
  stored: string;
  kind: 'new' | 'joined' | 'already' | 'asked' | 'manual' | 'error';
  matchedBy?: string;
  jobId?: number;
  reason?: string;
  title?: string | null;
  company?: string | null;
  candidates?: Array<{ jobId: number; title: string; company: string; reasons: string[] }>;
  ms: number;
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await run(item);
      }
    })
  );
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

test('add every link through the app', async () => {
  const file = option('--file');
  const dataDir = option('--data');
  if (!file || !dataDir) throw new Error('Pass --file C:\\path\\job.txt --data C:\\folder');
  const cacheDir = option('--cache');
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  if (existsSync(join(dataDir, 'job-tracker.sqlite'))) throw new Error(`${dataDir} already has a database. Use an empty folder.`);
  const concurrency = Number(option('--concurrency') ?? 6);

  const lines = readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim());
  const links = lines.filter((line) => /^https?:\/\//i.test(line));

  const renderer = new RecordingRenderer(args.includes('--no-browser') ? null : new PlaywrightRenderer(), cacheDir);
  const ctx = await createContext({
    dataDir,
    migrationsDir: join(__dirname, '..', '..', 'drizzle'),
    version: 'intake-run',
    http: new RecordingHttp(new SafeHttpClient(), cacheDir),
    renderer,
    logger: createFileLogger(join(dataDir, 'logs', 'server.log'))
  });
  const app = buildApp(ctx);
  await app.ready();

  // Two people with five profiles each, taking turns, like a small team sharing the list.
  const { users } = await createUsers(app, 'tyler', 'john');
  const profiles: Array<{ client: ApiClient; profileId: number }> = [];
  for (const client of Object.values(users)) {
    for (const name of ['Data Engineer', 'Backend', 'Analytics', 'Platform']) await client.post('/api/profiles', { name });
    const listed = (await client.get('/api/profiles')).json.profiles as Array<{ id: number }>;
    for (const profile of listed) profiles.push({ client, profileId: profile.id });
  }

  const outcomes: Outcome[] = [];
  const started = performance.now();
  let done = 0;
  await pool(
    links.map((url, index) => ({ url, index })),
    concurrency,
    async ({ url, index }) => {
      const { client, profileId } = profiles[index % profiles.length];
      let stored = url;
      try {
        stored = stripPersonalParams(parseUserUrl(url));
      } catch {
        // Reported below as the app's own answer.
      }
      const begun = performance.now();
      const outcome: Outcome = { index, url, stored, kind: 'error', ms: 0 };
      try {
        const response = await client.post('/api/applications', { url, profileId });
        if (response.status !== 200) {
          outcome.reason = `HTTP ${response.status}: ${response.json?.error?.message ?? ''}`;
        } else {
          const body = response.json as CreateApplicationResponse;
          if (body.outcome === 'created') {
            Object.assign(outcome, { kind: body.jobWasNew ? 'new' : 'joined', matchedBy: body.matchedBy, jobId: body.jobId });
          } else if (body.outcome === 'already_applied') {
            Object.assign(outcome, { kind: 'already', jobId: body.jobId, title: body.title, company: body.company });
          } else if (body.outcome === 'needs_manual') {
            Object.assign(outcome, { kind: 'manual', reason: body.reason, title: body.extracted.title, company: body.extracted.company });
          } else {
            // Nobody answers questions in this run. The job is saved, and the question goes to the
            // review list below instead of being treated as "different".
            outcome.kind = 'asked';
            outcome.title = body.extracted.title;
            outcome.company = body.extracted.company;
            outcome.candidates = body.candidates.map((candidate) => ({ jobId: candidate.jobId, title: candidate.title, company: candidate.company, reasons: candidate.reasons }));
            const saved = await client.post('/api/applications', { url, profileId, draftId: body.draftId, resolution: { action: 'new' } });
            if (saved.status === 200 && saved.json.outcome === 'created') outcome.jobId = saved.json.jobId;
          }
        }
      } catch (error) {
        outcome.reason = error instanceof Error ? error.message : String(error);
      }
      outcome.ms = performance.now() - begun;
      outcomes.push(outcome);
      done += 1;
      if (done % 50 === 0) console.log(`  ${done} of ${links.length} links, ${((performance.now() - started) / 1000).toFixed(0)}s`);
    }
  );
  const addMs = performance.now() - started;

  const sqlite = ctx.handle.sqlite;
  // No person answered "different" here, so every saved job is compared again in the background.
  sqlite.prepare(`DELETE FROM duplicate_candidates WHERE status = 'distinct'`).run();
  sqlite.prepare('UPDATE job_facts SET checked_at = NULL').run();
  const sweepStarted = performance.now();
  const swept = await sweepDuplicates(ctx);
  const sweepMs = performance.now() - sweepStarted;

  // ---- Report -------------------------------------------------------------------------------
  const out: string[] = [];
  const count = (kind: Outcome['kind']) => outcomes.filter((item) => item.kind === kind).length;
  const jobs = sqlite.prepare('SELECT COUNT(*) AS total FROM jobs').get() as { total: number };
  out.push(`LINKS: ${links.length} (${lines.filter(Boolean).length - links.length} other lines skipped), ${new Set(links).size} different strings`);
  out.push(`Added in ${(addMs / 1000).toFixed(0)}s with ${concurrency} at a time; background check of every job ${(sweepMs / 1000).toFixed(1)}s`);
  out.push('');
  out.push('WHAT EACH LINK BECAME');
  out.push(`  new job                         ${count('new')}`);
  const byLayer = new Map<string, number>();
  for (const item of outcomes.filter((entry) => entry.kind === 'joined')) byLayer.set(item.matchedBy ?? '?', (byLayer.get(item.matchedBy ?? '?') ?? 0) + 1);
  out.push(`  joined a saved job              ${count('joined')}  ${JSON.stringify(Object.fromEntries(byLayer))}`);
  out.push(`  same profile had applied        ${count('already')}`);
  out.push(`  asked "is this one of these?"   ${count('asked')}`);
  out.push(`  page unreadable, needs details  ${count('manual')}`);
  out.push(`  error                           ${count('error')}`);
  out.push('');
  out.push(`JOBS NOW: ${jobs.total}. Background check: ${swept.checked} compared, ${swept.merged} merged, ${swept.pending} pairs waiting for review`);

  // Jobs that hold more than one posting: what was folded together, and whether any of it conflicts.
  const multi = sqlite
    .prepare(
      `SELECT j.id, j.title, j.company_name AS company, COUNT(u.id) AS links FROM jobs j JOIN job_urls u ON u.job_id = j.id AND u.kind = 'original'
       GROUP BY j.id HAVING COUNT(u.id) > 1 ORDER BY links DESC, j.company_name`
    )
    .all() as Array<{ id: number; title: string; company: string; links: number }>;
  const conflicts = sqlite
    .prepare(
      `SELECT x.job_id AS jobId, x.provider, x.external_id AS a, y.external_id AS b FROM job_identifiers x JOIN job_identifiers y ON x.job_id = y.job_id AND x.provider = y.provider AND x.external_id < y.external_id
       WHERE x.is_discovered = 0 AND y.is_discovered = 0 AND x.provider NOT IN (${AGGREGATOR_PROVIDERS.map((name) => `'${name}'`).join(',')})`
    )
    .all() as Array<{ jobId: number; provider: string; a: string; b: string }>;
  out.push('');
  // Two ids are only a wrong merge when two links someone added carry them. A posting reposted
  // under a new id names the new one as its canonical page, and that is still one job.
  const linksOf = sqlite.prepare(`SELECT original_url AS url, kind FROM job_urls WHERE job_id = ?`);
  const wrong = conflicts.filter((conflict) => {
    const added = (linksOf.all(conflict.jobId) as Array<{ url: string; kind: string }>).filter((link) => link.kind === 'original').map((link) => identifyAts(link.url)?.externalId);
    return added.includes(conflict.a) && added.includes(conflict.b);
  });
  out.push(`JOBS WITH 2+ LINKS: ${multi.length}. Jobs where two added links carry different posting ids of one system: ${wrong.length} (a wrong merge if not 0)`);
  for (const conflict of conflicts) out.push(`  ${wrong.includes(conflict) ? 'WRONG' : 'reposted, the old id points to the new'} job ${conflict.jobId}: ${conflict.provider} ${conflict.a} / ${conflict.b}`);
  const urlsOf = sqlite.prepare(`SELECT original_url AS url FROM job_urls WHERE job_id = ? AND kind = 'original' ORDER BY id`);
  const howOf = new Map(outcomes.map((item) => [item.stored, item]));
  for (const job of multi) {
    const urls = (urlsOf.all(job.id) as Array<{ url: string }>).map((row) => row.url);
    const hows = urls.map((url) => howOf.get(url)?.matchedBy ?? howOf.get(url)?.kind ?? '?');
    const distinctPages = new Set(urls.map((url) => url.replace(/[?#].*$/, '').replace(/^https?:\/\/(www\.)?/, ''))).size;
    out.push(`  ${job.links} links${distinctPages > 1 ? ', different pages' : ''}: ${job.company} | ${job.title}`);
    urls.forEach((url, i) => out.push(`      ${hows[i].padEnd(10)} ${url.slice(0, 150)}`));
  }

  out.push('');
  out.push(`ASKED WHILE ADDING: ${count('asked')}`);
  for (const item of outcomes.filter((entry) => entry.kind === 'asked')) {
    out.push(`  ${item.company} | ${item.title}   ${item.url.slice(0, 110)}`);
    for (const candidate of item.candidates ?? []) out.push(`      ? ${candidate.company} | ${candidate.title} [${candidate.reasons.join(', ')}]`);
  }

  const pending = sqlite
    .prepare(
      `SELECT d.score, d.reasons, a.id AS idA, a.company_name AS companyA, a.title AS titleA, a.location AS locationA, b.id AS idB, b.company_name AS companyB, b.title AS titleB, b.location AS locationB
       FROM duplicate_candidates d JOIN jobs a ON a.id = d.job_id_low JOIN jobs b ON b.id = d.job_id_high WHERE d.status = 'pending' ORDER BY d.score DESC`
    )
    .all() as Array<Record<string, string | number>>;
  out.push('');
  out.push(`WAITING FOR REVIEW: ${pending.length}`);
  for (const pair of pending) {
    out.push(`  ${Number(pair.score).toFixed(2)} ${pair.companyA} | ${pair.titleA} [${pair.locationA}]  <->  ${pair.companyB} | ${pair.titleB} [${pair.locationB}]`);
    out.push(`       ${(JSON.parse(String(pair.reasons)) as string[]).join(', ')}`);
  }

  // Jobs kept apart that look alike: listed so a person can judge whether any were missed.
  const all = sqlite.prepare('SELECT id, company_name AS company, title, location FROM jobs').all() as Array<{ id: number; company: string; title: string; location: string | null }>;
  const byCompany = new Map<string, typeof all>();
  for (const job of all) {
    const company = normalizeCompany(job.company);
    byCompany.set(company, [...(byCompany.get(company) ?? []), job]);
  }
  const idsOf = sqlite.prepare(`SELECT provider || ':' || external_id AS id FROM job_identifiers WHERE job_id = ? AND is_discovered = 0`);
  const pairStatus = sqlite.prepare('SELECT status FROM duplicate_candidates WHERE job_id_low = ? AND job_id_high = ?');
  const alike: string[] = [];
  for (const group of byCompany.values()) {
    for (let a = 0; a < group.length; a += 1) {
      for (let b = a + 1; b < group.length; b += 1) {
        const similarity = titleSimilarity(group[a].title, group[b].title);
        if (similarity < 0.85) continue;
        const [low, high] = group[a].id < group[b].id ? [group[a], group[b]] : [group[b], group[a]];
        const status = (pairStatus.get(low.id, high.id) as { status: string } | undefined)?.status ?? 'kept apart';
        const ids = (job: typeof low) => (idsOf.all(job.id) as Array<{ id: string }>).map((row) => row.id).join(' ');
        alike.push(`  ${status.padEnd(10)} ${low.company} | ${low.title} [${low.location}] {${ids(low)}}  <->  ${high.title} [${high.location}] {${ids(high)}}`);
      }
    }
  }
  out.push('');
  out.push(`SAME COMPANY, SAME OR NEARLY THE SAME TITLE, STILL TWO JOBS: ${alike.length}`);
  out.push(...alike);

  const tags = sqlite
    .prepare(
      `SELECT SUM(work_arrangement = 'remote') AS remote, SUM(work_arrangement = 'hybrid') AS hybrid, SUM(work_arrangement = 'onsite') AS onsite,
              SUM(employment_type = 'contract') AS contract, SUM(employment_type = 'permanent') AS permanent, SUM(clearance IS NOT NULL) AS clearance,
              SUM(is_federal) AS federal, SUM(salary_min IS NOT NULL) AS salary, SUM(posted_at IS NOT NULL) AS posted, COUNT(*) AS jobs FROM job_facts`
    )
    .get();
  out.push('');
  out.push(`TAGS: ${JSON.stringify(tags)}`);
  const tagged = sqlite.prepare(`SELECT j.company_name AS company, j.title, f.clearance, f.is_federal AS federal FROM job_facts f JOIN jobs j ON j.id = f.job_id WHERE f.clearance IS NOT NULL OR f.is_federal = 1 ORDER BY j.company_name`).all() as Array<Record<string, unknown>>;
  for (const row of tagged) out.push(`  ${row.clearance ? `Clearance ${row.clearance}` : ''}${row.federal ? ' Federal' : ''}: ${row.company} | ${row.title}`);

  const manual = outcomes.filter((item) => item.kind === 'manual' || item.kind === 'error');
  const why = new Map<string, number>();
  for (const item of manual) why.set(`${host(item.url)} ${item.reason}`, (why.get(`${host(item.url)} ${item.reason}`) ?? 0) + 1);
  out.push('');
  out.push(`COULD NOT BE READ: ${manual.length}`);
  for (const [reason, total] of [...why.entries()].sort((a, b) => b[1] - a[1])) out.push(`  ${String(total).padStart(4)}  ${reason.slice(0, 160)}`);

  const times = outcomes.map((item) => item.ms).sort((a, b) => a - b);
  out.push('');
  out.push(`TIME PER LINK: median ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)}s, 95th ${(times[Math.floor(times.length * 0.95)] / 1000).toFixed(1)}s, slowest ${(times[times.length - 1] / 1000).toFixed(1)}s`);

  const report = out.join('\n');
  const outPath = option('--out') ?? join(dataDir, 'intake-report.txt');
  writeFileSync(outPath, report);
  writeFileSync(`${outPath}.json`, JSON.stringify(outcomes.sort((a, b) => a.index - b.index), null, 1));
  console.log(report.split('\n').slice(0, 30).join('\n'));

  await app.close();
  await renderer.close();
  closeDatabase(ctx.handle);
}, 4 * 60 * 60 * 1000);
