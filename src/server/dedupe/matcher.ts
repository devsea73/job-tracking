import { and, eq } from 'drizzle-orm';
import { prepared, type Db } from '../db/client';
import { FACTS_COLUMNS, FEATURE_COLUMNS, loadTextFeatures, toJobFacts, toTextFeatures, type FactsRow, type FeatureRow } from '../services/job-facts-store';
import { jobIdentifiers, jobs, jobUrls } from '../db/schema';
import { AGGREGATOR_PROVIDERS, identifiersConflict, identifyAts, isAggregator, referencedIdentities, sourcePlatform, type AtsIdentity } from './ats';
import { compareJobs, featuresFor, THRESHOLDS, type ComparableJob, type ContentComparison } from './scoring';
import { textSketchOf } from './text-features';
import { normalizeCompany, normalizeTitle, titleSimilarity } from './text-normalize';
import { normalizeUrl, stripPersonalParams } from './url-normalize';

export type UrlKind = 'original' | 'canonical' | 'redirect' | 'discovered';

/** One link connected to a posting, with what can be derived from it. */
export interface UrlEvidence {
  raw: string;
  normalized: string;
  identity: AtsIdentity | null;
  /** Other listings the link names in its parameters, such as the Jobright id in jr_id. */
  references: AtsIdentity[];
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
      references: referencedIdentities(url),
      platform: sourcePlatform(url),
      kind
    };
  } catch {
    return null;
  }
}

/**
 * A site's home or careers landing page says nothing about which job this is. A query or a
 * fragment the normalized link kept ("/careers#backend-engineer", "/jobs?id=42") does.
 */
export function isSpecificPage(evidence: UrlEvidence): boolean {
  if (evidence.identity) return true;
  const { pathname, search, hash } = new URL(evidence.normalized);
  if (search || hash) return true;
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
    // A careers home page is shared by every job on it: the same link is not the same job.
    const byUrl = isSpecificPage(item) ? db.select({ jobId: jobUrls.jobId }).from(jobUrls).where(eq(jobUrls.normalizedUrl, item.normalized)).get() : undefined;
    if (byUrl) return { jobId: byUrl.jobId, matchedBy: 'url' };
    const byIdentity = findByIdentity(db, item.identity);
    if (byIdentity !== null) return { jobId: byIdentity, matchedBy: 'identifier' };
    for (const reference of item.references) {
      const byReference = findByIdentity(db, reference);
      if (byReference !== null && !contradictsJob(db, byReference, item.identity)) return { jobId: byReference, matchedBy: 'identifier' };
    }
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
    for (const reference of item.references) {
      const byReference = findByIdentity(db, reference);
      if (byReference !== null && titleFits(byReference) && !contradictsJob(db, byReference, item.identity)) return { jobId: byReference, matchedBy: 'identifier' };
    }
  }
  return null;
}

/**
 * The system hosting a posting is the authority on what it is. If it gives a job a different id
 * from this link's, a listing id tying the two together is not enough to call them one job.
 */
function contradictsJob(db: Db, jobId: number, identity: AtsIdentity | null): boolean {
  if (!identity || isAggregator(identity.provider)) return false;
  const others = db
    .select({ externalId: jobIdentifiers.externalId })
    .from(jobIdentifiers)
    .where(and(eq(jobIdentifiers.jobId, jobId), eq(jobIdentifiers.provider, identity.provider), eq(jobIdentifiers.isDiscovered, false)))
    .all();
  return others.some((other) => identifiersConflict({ provider: identity.provider, externalId: other.externalId }, identity));
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

const MAX_SAME_COMPANY = 5000;
const MAX_SAME_TITLE = 200;
const MAX_COMPARED = 200;
const MAX_POSSIBLE = 5;
/** Shared samples needed before another company's posting counts as a repost worth comparing. */
const MIN_SHARED_SAMPLES = 3;

/** Only the hosting system's own ids can show that two postings differ. */
export function identifiersFromEvidence(evidence: UrlEvidence[]): Array<{ provider: string; externalId: string }> {
  return evidence
    .filter((item) => item.identity && item.kind !== 'discovered')
    .map((item) => ({ provider: (item.identity as AtsIdentity).provider, externalId: (item.identity as AtsIdentity).externalId }));
}

/**
 * The jobs worth comparing: everything at the same or a similarly named company, plus any posting
 * with the same wording under another name. Title alone never brings a job in, since thousands
 * of unrelated jobs share one and they would crowd out the real match.
 */
function findCandidateIds(db: Db, incoming: Pick<ComparableJob, 'company' | 'title' | 'description' | 'text'>, exclude: ReadonlySet<number>): number[] {
  const sqlite = db.$client;
  const companyKey = normalizeCompany(incoming.company);
  const titleScores = new Map<number, number>();

  if (companyKey) {
    // "Devoted Health" finds "Devoted Health Services", and the other way around.
    const shorter: string[] = [];
    for (let length = Math.min(4, companyKey.length); length <= companyKey.length; length += 1) shorter.push(companyKey.slice(0, length));
    const sameCompany = prepared(
      sqlite,
      `SELECT id, title FROM jobs WHERE company_key IN (SELECT value FROM json_each(?)) OR (company_key >= ? AND company_key < ?) ORDER BY id DESC LIMIT ${MAX_SAME_COMPANY}`
    ).all(JSON.stringify(shorter), companyKey, `${companyKey}{`) as Array<{ id: number; title: string }>;
    // The same title at the same company is always compared, however many jobs that company has.
    const sameTitle = prepared(sqlite, `SELECT id, title FROM jobs WHERE company_key = ? AND title_key = ? ORDER BY id DESC LIMIT ${MAX_SAME_TITLE}`).all(companyKey, normalizeTitle(incoming.title)) as Array<{ id: number; title: string }>;
    for (const row of [...sameTitle, ...sameCompany]) {
      if (titleScores.has(row.id) || exclude.has(row.id)) continue;
      const score = titleSimilarity(incoming.title, row.title);
      if (score >= THRESHOLDS.possibleTitle) titleScores.set(row.id, score);
    }
  }

  // Jobs found by their wording get places of their own, so a big company's many similar titles cannot push them out.
  const byWording = new Set<number>();
  const add = (ids: Array<{ id: number }>) => {
    for (const { id } of ids) if (!exclude.has(id) && !titleScores.has(id)) byWording.add(id);
  };
  const features = featuresFor(incoming);
  if (features.hash) add(prepared(sqlite, 'SELECT job_id AS id FROM job_text_features WHERE hash = ? LIMIT 50').all(features.hash) as Array<{ id: number }>);
  const sketch = textSketchOf(features);
  if (sketch.length > 0) {
    add(
      prepared(
        sqlite,
        `SELECT job_id AS id FROM job_signatures WHERE kind = 'text' AND value IN (SELECT value FROM json_each(?)) GROUP BY job_id HAVING COUNT(*) >= ${MIN_SHARED_SAMPLES} ORDER BY COUNT(*) DESC LIMIT 50`
      ).all(JSON.stringify(sketch)) as Array<{ id: number }>
    );
  }

  const byTitle = [...titleScores.entries()]
    .sort(([idA, scoreA], [idB, scoreB]) => scoreB - scoreA || idB - idA)
    .slice(0, MAX_COMPARED)
    .map(([id]) => id);
  return [...byTitle, ...byWording];
}

/** Scores every plausible job against the posting, best first, with what each was compared as. */
function scoreCandidates(db: Db, incoming: ComparableJob, exclude: ReadonlySet<number>): Array<ContentCandidate & { job: ComparableJob }> {
  const ids = findCandidateIds(db, incoming, exclude);
  if (ids.length === 0) return [];
  const sqlite = db.$client;
  const idList = JSON.stringify(ids);

  const rows = prepared(
    sqlite,
    `SELECT j.id, j.company_name AS company, j.title, j.location, ${FACTS_COLUMNS}, ${FEATURE_COLUMNS}
     FROM jobs j LEFT JOIN job_facts f ON f.job_id = j.id LEFT JOIN job_text_features t ON t.job_id = j.id WHERE j.id IN (SELECT value FROM json_each(?))`
  ).all(idList) as Array<FactsRow & FeatureRow & { id: number; company: string; title: string; location: string | null }>;

  const identifiers = prepared(sqlite, `SELECT job_id AS jobId, provider, external_id AS externalId, is_discovered AS isDiscovered FROM job_identifiers WHERE job_id IN (SELECT value FROM json_each(?))`).all(idList) as Array<{
    jobId: number;
    provider: string;
    externalId: string;
    isDiscovered: number;
  }>;
  // A listing site can list one job under several ids, and a link found inside a page can be
  // wrong, so only ids from the system hosting the posting can show that two jobs differ.
  const counts = (item: { provider: string }) => !AGGREGATOR_PROVIDERS.includes(item.provider);
  const hostingIds = incoming.identifiers.filter(counts);

  const scored: Array<ContentCandidate & { job: ComparableJob }> = [];
  for (const row of rows) {
    const existing: ComparableJob = {
      company: row.company,
      title: row.title,
      location: row.location,
      // Compared on the stored features: no posting text is read back for this.
      text: toTextFeatures(row) ?? loadTextFeatures(sqlite, row.id),
      facts: toJobFacts(row),
      identifiers: identifiers.filter((item) => item.jobId === row.id && !item.isDiscovered && counts(item)).map(({ provider, externalId }) => ({ provider, externalId }))
    };
    const comparison = compareJobs({ ...incoming, identifiers: hostingIds }, existing);
    if (comparison.decision !== 'none') scored.push({ jobId: row.id, comparison, job: existing });
  }
  return scored.sort((a, b) => b.comparison.score - a.comparison.score);
}

/**
 * Layer D: compares the posting's content against jobs that could plausibly be the same one.
 * A merge needs both sides to agree: the posting has exactly one confident match, and that job
 * has no other confident match of its own. A listing site's copy of one of two near-identical
 * openings is otherwise merged into whichever happens to be checked first.
 */
export function findContentMatches(db: Db, incoming: ComparableJob, exclude: ReadonlySet<number> = new Set()): ContentMatches {
  const scored = scoreCandidates(db, incoming, exclude);
  const toCandidate = ({ jobId, comparison }: ContentCandidate): ContentCandidate => ({ jobId, comparison });
  const autos = scored.filter((item) => item.comparison.decision === 'auto');
  if (autos.length === 1) {
    const [only] = autos;
    const rivals = scoreCandidates(db, only.job, new Set([...exclude, only.jobId])).filter((item) => item.comparison.decision === 'auto');
    if (rivals.length === 0) return { auto: toCandidate(only), possible: [] };
    // The rival is worth showing too: it is the reason this needs a person.
    const shown = new Set(scored.map((item) => item.jobId));
    return { auto: null, possible: [...scored.map(toCandidate), ...rivals.filter((item) => !shown.has(item.jobId)).map(toCandidate)].slice(0, MAX_POSSIBLE) };
  }
  // Two confident matches mean the data itself is ambiguous, so a person decides.
  return { auto: null, possible: scored.slice(0, MAX_POSSIBLE).map(toCandidate) };
}
