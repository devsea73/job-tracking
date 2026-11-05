import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { jobIdentifiers, jobs, jobUrls } from '../db/schema';
import { identifyAts, sourcePlatform, type AtsIdentity } from './ats';
import { compareJobs, type ComparableJob, type ContentComparison } from './scoring';
import { hashDescription, normalizeCompany, normalizeTitle, titleSimilarity } from './text-normalize';
import { normalizeUrl, stripPersonalParams } from './url-normalize';

export type UrlKind = 'original' | 'canonical' | 'redirect' | 'discovered';

/** One link connected to a posting, with what can be derived from it. */
export interface UrlEvidence {
  raw: string;
  normalized: string;
  identity: AtsIdentity | null;
  platform: string;
  kind: UrlKind;
}

export function buildEvidence(raw: string | URL, kind: UrlKind): UrlEvidence | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return {
      raw: stripPersonalParams(url),
      normalized: normalizeUrl(url),
      identity: identifyAts(url),
      platform: sourcePlatform(url),
      kind
    };
  } catch {
    return null;
  }
}

/** A site's home or careers landing page says nothing about which job this is. */
export function isSpecificPage(evidence: UrlEvidence): boolean {
  if (evidence.identity) return true;
  const { pathname } = new URL(evidence.normalized);
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  return !(segments.length === 1 && /^(careers?|jobs?|job-board|openings|positions|join-us|work-with-us)$/i.test(segments[0]));
}

export interface ExactMatch {
  jobId: number;
  matchedBy: 'url' | 'canonical' | 'identifier';
}

const RELATED_TITLE = 0.5;

/**
 * Layers A, B and C. The link the user pasted is direct evidence. Canonical links, redirect
 * targets and links found inside the page are indirect: a site can point all of its postings
 * at one canonical page, so those only count when the job they lead to has a related title.
 */
export function findExactMatch(db: Db, evidence: UrlEvidence[], incomingTitle?: string | null): ExactMatch | null {
  const direct = evidence.filter((item) => item.kind === 'original');
  const indirect = evidence.filter((item) => item.kind !== 'original' && isSpecificPage(item));

  for (const item of direct) {
    const byUrl = db.select({ jobId: jobUrls.jobId }).from(jobUrls).where(eq(jobUrls.normalizedUrl, item.normalized)).get();
    if (byUrl) return { jobId: byUrl.jobId, matchedBy: 'url' };
    const byIdentity = findByIdentity(db, item.identity);
    if (byIdentity !== null) return { jobId: byIdentity, matchedBy: 'identifier' };
  }

  const titleFits = (jobId: number): boolean => {
    if (!incomingTitle) return false;
    const job = db.select({ title: jobs.title }).from(jobs).where(eq(jobs.id, jobId)).get();
    return !!job && titleSimilarity(incomingTitle, job.title) >= RELATED_TITLE;
  };
  for (const item of indirect) {
    const byUrl = db.select({ jobId: jobUrls.jobId }).from(jobUrls).where(eq(jobUrls.normalizedUrl, item.normalized)).get();
    if (byUrl && titleFits(byUrl.jobId)) return { jobId: byUrl.jobId, matchedBy: item.kind === 'discovered' ? 'identifier' : 'canonical' };
    const byIdentity = findByIdentity(db, item.identity);
    if (byIdentity !== null && titleFits(byIdentity)) return { jobId: byIdentity, matchedBy: 'identifier' };
  }
  return null;
}

function findByIdentity(db: Db, identity: AtsIdentity | null): number | null {
  if (!identity) return null;
  const row = db
    .select({ jobId: jobIdentifiers.jobId })
    .from(jobIdentifiers)
    .where(and(eq(jobIdentifiers.provider, identity.provider), eq(jobIdentifiers.externalId, identity.externalId)))
    .get();
  return row?.jobId ?? null;
}

export interface ContentCandidate {
  jobId: number;
  comparison: ContentComparison;
}

export interface ContentMatches {
  /** Set only when exactly one existing job is a confident match. */
  auto: ContentCandidate | null;
  possible: ContentCandidate[];
}

const MAX_CANDIDATES = 300;
const MAX_POSSIBLE = 5;

/** Layer D: compares the posting's content against jobs that could plausibly be the same one. */
export function findContentMatches(db: Db, incoming: Omit<ComparableJob, 'identifiers'>, evidence: UrlEvidence[]): ContentMatches {
  const companyKey = normalizeCompany(incoming.company);
  const titleKey = normalizeTitle(incoming.title);
  const hash = hashDescription(incoming.description);
  const conditions = [eq(jobs.titleKey, titleKey)];
  if (companyKey) {
    conditions.push(eq(jobs.companyKey, companyKey));
    if (companyKey.length >= 4) {
      conditions.push(sql`${jobs.companyKey} like ${`${companyKey}%`}`);
      conditions.push(sql`(length(${jobs.companyKey}) >= 4 and ${companyKey} like ${jobs.companyKey} || '%')`);
    }
  }
  if (hash) conditions.push(eq(jobs.descriptionHash, hash));

  const rows = db
    .select({ id: jobs.id, company: jobs.companyName, title: jobs.title, location: jobs.location, description: jobs.description })
    .from(jobs)
    .where(or(...conditions))
    .limit(MAX_CANDIDATES)
    .all();
  if (rows.length === 0) return { auto: null, possible: [] };

  const identifiers = db
    .select({ jobId: jobIdentifiers.jobId, provider: jobIdentifiers.provider, externalId: jobIdentifiers.externalId, isDiscovered: jobIdentifiers.isDiscovered })
    .from(jobIdentifiers)
    .where(
      inArray(
        jobIdentifiers.jobId,
        rows.map((row) => row.id)
      )
    )
    .all();

  // A link found inside a page can be wrong, so only ids from a posting's own URL can
  // show that "the same system calls these two different".
  const incomingIdentifiers = evidence
    .filter((item) => item.identity && item.kind !== 'discovered')
    .map((item) => ({ provider: (item.identity as AtsIdentity).provider, externalId: (item.identity as AtsIdentity).externalId }));

  const scored: ContentCandidate[] = [];
  for (const row of rows) {
    const existing: ComparableJob = {
      company: row.company,
      title: row.title,
      location: row.location,
      description: row.description,
      identifiers: identifiers
        .filter((item) => item.jobId === row.id && !item.isDiscovered)
        .map(({ provider, externalId }) => ({ provider, externalId }))
    };
    const comparison = compareJobs({ ...incoming, identifiers: incomingIdentifiers }, existing);
    if (comparison.decision !== 'none') scored.push({ jobId: row.id, comparison });
  }
  scored.sort((a, b) => b.comparison.score - a.comparison.score);

  const autos = scored.filter((item) => item.comparison.decision === 'auto');
  // Two confident matches mean the data itself is ambiguous, so a person decides.
  if (autos.length === 1) return { auto: autos[0], possible: [] };
  return { auto: null, possible: scored.slice(0, MAX_POSSIBLE) };
}
