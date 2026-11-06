import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import type { JobFacts } from '../../src/shared/api';
import { identifyAts } from '../../src/server/dedupe/ats';
import { deriveJobFacts } from '../../src/server/dedupe/job-facts';
import { compareJobs, type ComparableJob, type ContentComparison } from '../../src/server/dedupe/scoring';
import { normalizeCompany } from '../../src/server/dedupe/text-normalize';
import { extractJob } from '../../src/server/extraction/pipeline';
import { SafeHttpClient } from '../../src/server/extraction/safe-fetch';

/**
 * How accurate duplicate detection is on real postings, without using ids. Links carrying jr_id
 * give true pairs: a Jobright page and the employer's page for one job. Everything else is a
 * true non-match, including different openings at the same company, the hardest case.
 *
 *   npm run survey -- --dedupe --file C:\path\job.txt [--sample 150] [--siblings 400] [--cache file.json] [--out report.txt]
 *
 * --siblings also reads that many links from companies listed more than once. Each of those is a
 * different opening at one company, so a merge between them is wrong, even with their ids hidden.
 *
 * Read from the live sites, so results shift as postings close. The list stays out of the repo.
 */

interface Reading {
  url: string;
  ok: boolean;
  reason?: string;
  company?: string;
  title?: string;
  location?: string | null;
  description?: string;
  facts?: JobFacts;
}

interface Cache {
  readings: Record<string, Reading>;
}

const args = (process.env.SURVEY_ARGS ?? '').split(' ').filter(Boolean);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

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

function comparable(reading: Reading, url: string): ComparableJob {
  const identity = identifyAts(url);
  return {
    company: reading.company ?? '',
    title: reading.title ?? '',
    location: reading.location ?? null,
    description: reading.description ?? '',
    facts: reading.facts ?? null,
    // The real matcher never treats a listing site's id as evidence against a match.
    identifiers: identity && !['jobright', 'linkedin', 'builtin', 'indeed'].includes(identity.provider) ? [{ provider: identity.provider, externalId: identity.externalId }] : []
  };
}

test('duplicate detection on real postings', async () => {
  const file = option('--file');
  if (!file) throw new Error('Pass the list of links: npm run survey -- --dedupe --file C:\\path\\job.txt');
  const sample = Number(option('--sample') ?? 150);
  const cachePath = option('--cache');
  const cache: Cache = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : { readings: {} };

  const links: string[] = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (/^https?:\/\//.test(text)) links.push(text);
  }

  // The newest links are the likeliest to still be open.
  const pairs: Array<{ jr: string; employer: string; jobright: string }> = [];
  const seenIdentity = new Set<string>();
  for (const link of [...links].reverse()) {
    const url = new URL(link);
    const jr = url.searchParams.get('jr_id');
    if (!jr || pairs.length >= sample) continue;
    url.searchParams.delete('jr_id');
    const identity = identifyAts(url);
    const key = identity ? `${identity.provider}:${identity.externalId}` : url.toString();
    if (seenIdentity.has(key)) continue;
    seenIdentity.add(key);
    pairs.push({ jr, employer: url.toString(), jobright: `https://jobright.ai/jobs/info/${jr}` });
  }

  const siblingLimit = Number(option('--siblings') ?? 0);
  const byTenant = new Map<string, string[]>();
  for (const link of links) {
    const url = new URL(link);
    url.searchParams.delete('jr_id');
    const identity = identifyAts(url);
    const tenant = identity?.board ?? (identity?.externalId.includes('/') ? identity.externalId.split('/')[0] : null);
    if (!identity || !tenant) continue;
    const key = `${identity.provider}:${tenant}`.toLowerCase();
    const list = byTenant.get(key) ?? [];
    if (!list.some((item) => identifyAts(item)?.externalId === identity.externalId)) list.push(url.toString());
    byTenant.set(key, list);
  }
  const siblings = [...byTenant.values()].filter((list) => list.length > 1).flat().slice(0, siblingLimit);

  const http = new SafeHttpClient();
  const needed = [...new Set([...pairs.flatMap((pair) => [pair.employer, pair.jobright]), ...siblings])].filter((url) => !cache.readings[url]);
  await pool(needed, 5, async (url) => {
    try {
      const result = await extractJob(url, { http, renderer: null });
      cache.readings[url] = result.ok
        ? { url, ok: true, company: result.company, title: result.title, location: result.location, description: result.description, facts: result.facts }
        : { url, ok: false, reason: result.reason };
    } catch (error) {
      cache.readings[url] = { url, ok: false, reason: String(error) };
    }
    if (cachePath && Object.keys(cache.readings).length % 20 === 0) writeFileSync(cachePath, JSON.stringify(cache));
  });
  if (cachePath) writeFileSync(cachePath, JSON.stringify(cache));

  const out: string[] = [];
  const usable = pairs.filter((pair) => cache.readings[pair.employer]?.ok && cache.readings[pair.jobright]?.ok);
  out.push(`pairs requested ${pairs.length}, both pages readable ${usable.length}`);
  out.push(`employer unreadable ${pairs.filter((pair) => !cache.readings[pair.employer]?.ok).length}, jobright unreadable ${pairs.filter((pair) => !cache.readings[pair.jobright]?.ok).length}`);

  // True pairs: one job, seen on two sites. "none" here is a duplicate that would get through.
  const tally = { auto: 0, possible: 0, none: 0 };
  const missed: string[] = [];
  const features: Array<Record<string, unknown>> = [];
  for (const pair of usable) {
    const employer = cache.readings[pair.employer];
    const jobright = cache.readings[pair.jobright];
    const result: ContentComparison = compareJobs(comparable(jobright, pair.jobright), comparable(employer, pair.employer));
    tally[result.decision] += 1;
    features.push({ decision: result.decision, company: [jobright.company, employer.company], title: [jobright.title, employer.title], ...result.signals });
    if (result.decision !== 'auto') missed.push(`${result.decision.padEnd(8)} ${jobright.company} / ${employer.company} | ${jobright.title} / ${employer.title} | ${JSON.stringify(result.signals)}`);
  }
  out.push('');
  out.push(`TRUE PAIRS (same job on two sites): auto-merged ${tally.auto}, asked ${tally.possible}, missed ${tally.none} of ${usable.length}`);
  out.push(`  caught, automatically or by asking: ${(((tally.auto + tally.possible) / Math.max(1, usable.length)) * 100).toFixed(1)}%`);

  // Non-matches: every other combination. Any "auto" here is a wrong merge.
  const pairOf = new Map(pairs.flatMap((pair) => [[pair.employer, pair.jr] as const, [pair.jobright, pair.jr] as const]));
  const sameTenantSeen = new Set<string>();
  const documents = Object.values(cache.readings)
    .filter((reading) => reading.ok)
    .filter((reading) => {
      const identity = identifyAts(reading.url);
      const key = identity ? `${identity.provider}:${identity.externalId}` : reading.url;
      if (sameTenantSeen.has(key)) return false;
      sameTenantSeen.add(key);
      return true;
    })
    .map((reading) => ({ pair: pairOf.get(reading.url) ?? reading.url, url: reading.url, reading }));
  const wrong = { auto: 0, possible: 0, none: 0 };
  const hard = { auto: 0, possible: 0, none: 0 };
  const wrongList: string[] = [];
  const hardList: string[] = [];
  for (let a = 0; a < documents.length; a += 1) {
    for (let b = a + 1; b < documents.length; b += 1) {
      if (documents[a].pair === documents[b].pair) continue;
      const left = documents[a];
      const right = documents[b];
      const sameCompany = normalizeCompany(left.reading.company ?? '') === normalizeCompany(right.reading.company ?? '');
      const result = compareJobs(comparable(left.reading, left.url), comparable(right.reading, right.url));
      wrong[result.decision] += 1;
      if (sameCompany) hard[result.decision] += 1;
      const line = `${result.decision.padEnd(8)} ${left.reading.company}: ${left.reading.title} | ${right.reading.title} | ${left.url.slice(0, 60)} | ${right.url.slice(0, 60)} | ${(result.reasons ?? []).join(', ')}`;
      if (result.decision === 'auto') wrongList.push(line);
      else if (result.decision === 'possible' && sameCompany) hardList.push(line);
    }
  }
  out.push('');
  out.push(`DIFFERENT JOBS: ${wrong.none + wrong.possible + wrong.auto} combinations; auto-merged ${wrong.auto} (should be 0), asked ${wrong.possible}`);
  out.push(`  same company, different listing: ${hard.none + hard.possible + hard.auto}; auto-merged ${hard.auto}, asked ${hard.possible}, kept apart ${hard.none}`);
  out.push(...wrongList.slice(0, 40));
  out.push(...hardList.slice(0, 25));

  // Different openings at one company, with ids hidden: what a listing site's copy of one opening
  // would look like against another. Nothing but the content can keep these apart.
  const readable = [...new Set(siblings)].filter((url) => cache.readings[url]?.ok);
  const grouped = new Map<string, string[]>();
  for (const url of readable) {
    const key = normalizeCompany(cache.readings[url].company ?? '');
    grouped.set(key, [...(grouped.get(key) ?? []), url]);
  }
  const sibling = { auto: 0, possible: 0, none: 0 };
  const siblingWithIds = { auto: 0, possible: 0, none: 0 };
  const siblingAuto: string[] = [];
  const siblingAsked: string[] = [];
  const pagesRepeating = [...grouped.values()].filter((list) => list.length > 1);
  for (const list of pagesRepeating) {
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        const left = cache.readings[list[a]];
        const right = cache.readings[list[b]];
        const withIds = compareJobs(comparable(left, list[a]), comparable(right, list[b]));
        siblingWithIds[withIds.decision] += 1;
        const hidden = compareJobs({ ...comparable(left, list[a]), identifiers: [] }, { ...comparable(right, list[b]), identifiers: [] });
        sibling[hidden.decision] += 1;
        const line = `${left.company}: ${left.title} [${left.location}] | ${right.title} [${right.location}] | ${JSON.stringify(hidden.signals)}`;
        if (hidden.signals && hidden.signals.title >= 0.85) features.push({ ...hidden.signals, sibling: true, decision: hidden.decision, withIds: withIds.decision, company: left.company, titles: [left.title, right.title], locations: [left.location, right.location] });
        if (hidden.decision === 'auto') siblingAuto.push(line);
        else if (hidden.decision === 'possible') siblingAsked.push(line);
      }
    }
  }
  out.push('');
  out.push(`OPENINGS AT ONE COMPANY: ${readable.length} pages read, ${pagesRepeating.length} companies, ${sibling.auto + sibling.possible + sibling.none} pairs`);
  out.push(`  ids hidden: auto-merged ${sibling.auto} (should be about 0), asked ${sibling.possible}, kept apart ${sibling.none}`);
  out.push(`  ids known:  auto-merged ${siblingWithIds.auto} (must be 0), asked ${siblingWithIds.possible}, kept apart ${siblingWithIds.none}`);
  out.push('  AUTO WITH IDS HIDDEN');
  out.push(...siblingAuto.slice(0, 60));
  out.push('  ASKED WITH IDS HIDDEN');
  out.push(...siblingAsked.slice(0, 30));
  out.push('');
  out.push('TRUE PAIRS NOT AUTO-MERGED');
  out.push(...missed.slice(0, 80));

  // How much of each fact could be read, and whether the two sites agree.
  const readings = Object.values(cache.readings).filter((reading) => reading.ok && reading.facts);
  const count = (test: (facts: JobFacts) => boolean) => readings.filter((reading) => test(reading.facts as JobFacts)).length;
  out.push('');
  out.push(`FACTS FOUND across ${readings.length} pages: arrangement ${count((f) => !!f.workArrangement)}, type ${count((f) => !!f.employmentType)}, clearance ${count((f) => !!f.clearance)}, federal ${count((f) => f.isFederal)}, posted ${count((f) => !!f.postedAt)}, salary ${count((f) => f.salaryMin !== null)}`);
  const disagree = (read: (facts: JobFacts) => unknown) =>
    usable.filter((pair) => {
      const a = read(cache.readings[pair.jobright].facts as JobFacts);
      const b = read(cache.readings[pair.employer].facts as JobFacts);
      return a && b && a !== b;
    });
  const both = (read: (facts: JobFacts) => unknown) => usable.filter((pair) => read(cache.readings[pair.jobright].facts as JobFacts) && read(cache.readings[pair.employer].facts as JobFacts)).length;
  out.push(`AGREEMENT on the same job: arrangement ${both((f) => f.workArrangement) - disagree((f) => f.workArrangement).length}/${both((f) => f.workArrangement)}, type ${both((f) => f.employmentType) - disagree((f) => f.employmentType).length}/${both((f) => f.employmentType)}`);
  for (const pair of disagree((f) => f.workArrangement).slice(0, 10)) out.push(`  arrangement differs: ${cache.readings[pair.jobright].facts?.workArrangement} / ${cache.readings[pair.employer].facts?.workArrangement} ${pair.employer.slice(0, 80)} | location ${cache.readings[pair.employer].location}`);
  for (const pair of disagree((f) => f.employmentType).slice(0, 10)) out.push(`  type differs: ${cache.readings[pair.jobright].facts?.employmentType} / ${cache.readings[pair.employer].facts?.employmentType} ${pair.employer.slice(0, 80)}`);
  // Read again from the saved text, so that changing the rules needs no refetching.
  const tagged = new Set<string>();
  for (const reading of readings) {
    const facts = deriveJobFacts({ title: reading.title ?? '', company: reading.company ?? '', location: reading.location, description: reading.description ?? '', urls: [reading.url] });
    if (facts.clearance || facts.isFederal) tagged.add(`  tagged: clearance=${facts.clearance} federal=${facts.isFederal} ${reading.company}: ${reading.title}`);
  }
  out.push(...tagged);

  const report = out.join('\n');
  const outPath = option('--out') ?? 'dedupe-report.txt';
  writeFileSync(outPath, report);
  writeFileSync(`${outPath}.features.json`, JSON.stringify(features, null, 1));
  console.log(report);
}, 3_600_000);
