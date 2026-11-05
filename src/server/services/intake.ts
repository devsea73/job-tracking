import { and, eq } from 'drizzle-orm';
import type {
  CreateApplicationRequest,
  CreateApplicationResponse,
  DuplicateCandidate,
  ExtractedJobFields,
  ManualJobFields,
  MatchedBy
} from '../../shared/api';
import { DEFAULT_STATUS } from '../../shared/constants';
import type { AppContext } from '../context';
import { nowIso } from '../db/client';
import { applications, applicationStatusHistory, jobIdentifiers, jobs, jobUrls } from '../db/schema';
import { identifyAts, isAggregator } from '../dedupe/ats';
import { buildEvidence, findContentMatches, findExactMatch, isSpecificPage, type UrlEvidence } from '../dedupe/matcher';
import { hashDescription, normalizeCompany, normalizeTitle, descriptionSimilarity } from '../dedupe/text-normalize';
import { InvalidUrlError, parseUserUrl } from '../dedupe/url-normalize';
import { ApiError, notFound } from '../errors';
import { assertSafeUrlShape, UnsafeUrlError } from '../extraction/ip-guard';
import { extractJob } from '../extraction/pipeline';
import { MIN_DESCRIPTION_LENGTH, type ExtractionResult, type ExtractionSuccess } from '../extraction/types';
import { loggableUrl } from '../logger';
import { listApplicationsForJobs } from './job-queries';
import { requireOwnActiveProfile } from './profiles';

/** Pages being read right now. Two people adding the same link share one fetch. */
const inFlight = new WeakMap<AppContext, Map<string, Promise<ExtractionResult>>>();

function extractOnce(ctx: AppContext, key: string, url: string): Promise<ExtractionResult> {
  let pending = inFlight.get(ctx);
  if (!pending) {
    pending = new Map();
    inFlight.set(ctx, pending);
  }
  const running = pending.get(key);
  if (running) return running;
  const started = Date.now();
  const promise = extractJob(url, { http: ctx.http, renderer: ctx.renderer })
    .then((result) => {
      ctx.logger.info(
        { url: loggableUrl(url), ok: result.ok, method: result.ok ? result.method : undefined, reason: result.ok ? undefined : result.reason, ms: Date.now() - started },
        'Read job page'
      );
      return result;
    })
    .finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

function toEvidence(url: URL, extraction: ExtractionResult | null): UrlEvidence[] {
  const list: Array<UrlEvidence | null> = [buildEvidence(url, 'original')];
  // A page that failed to read says nothing about its links: closed postings often
  // redirect to a general jobs page, which must not become part of this job's identity.
  if (extraction?.ok) {
    if (extraction.canonicalUrl) {
      try {
        list.push(buildEvidence(new URL(extraction.canonicalUrl, extraction.finalUrl ?? url), 'canonical'));
      } catch {
        // A malformed canonical link is simply no evidence.
      }
    }
    if (extraction.finalUrl) list.push(buildEvidence(extraction.finalUrl, 'redirect'));
    for (const hop of extraction.redirectChain) list.push(buildEvidence(hop, 'redirect'));
    for (const found of extraction.discoveredUrls) {
      // Only a link that identifies a posting on an ATS counts, not one to another listing site.
      const identity = identifyAts(found);
      if (identity && !isAggregator(identity.provider)) list.push(buildEvidence(found, 'discovered'));
    }
  }
  const seen = new Set<string>();
  return list.filter((item): item is UrlEvidence => {
    if (!item || seen.has(item.normalized)) return false;
    seen.add(item.normalized);
    return true;
  });
}

interface JobFields {
  title: string;
  company: string;
  description: string;
  location: string | null;
  method: string;
  extractedAt: string | null;
}

function fieldsFrom(extraction: ExtractionResult | null, manual: ManualJobFields | undefined): JobFields | null {
  if (manual) {
    return {
      title: manual.title,
      company: manual.company,
      description: manual.description,
      location: manual.location?.trim() || null,
      method: 'manual',
      extractedAt: null
    };
  }
  if (extraction?.ok) {
    return {
      title: extraction.title,
      company: extraction.company,
      description: extraction.description,
      location: extraction.location,
      method: extraction.method,
      extractedAt: nowIso()
    };
  }
  return null;
}

function extractedFields(extraction: ExtractionResult | null): ExtractedJobFields {
  if (!extraction) return { title: null, company: null, description: null, location: null };
  if (extraction.ok) {
    return { title: extraction.title, company: extraction.company, description: extraction.description, location: extraction.location };
  }
  const { title, company, description, location } = extraction.partial;
  return { title, company, description, location };
}

/** Adds any links the job does not have yet. A link can belong to only one job, enforced by a unique index. */
function addAliases(ctx: AppContext, jobId: number, evidence: UrlEvidence[]): boolean {
  let added = false;
  for (const item of evidence) {
    if (item.kind !== 'original' && !isSpecificPage(item)) continue;
    const url = ctx.db
      .insert(jobUrls)
      .values({
        jobId,
        originalUrl: item.raw,
        normalizedUrl: item.normalized,
        sourcePlatform: item.platform,
        externalJobId: item.identity?.externalId ?? null,
        kind: item.kind
      })
      .onConflictDoNothing()
      .run();
    if (url.changes > 0) added = true;
    if (item.identity) {
      ctx.db
        .insert(jobIdentifiers)
        .values({ jobId, provider: item.identity.provider, externalId: item.identity.externalId, isDiscovered: item.kind === 'discovered' })
        .onConflictDoNothing()
        .run();
    }
  }
  return added;
}

/** Who is applying: a signed-in user, under one of their own profiles. */
interface ApplyingProfile {
  userId: number;
  profileId: number;
  profileName: string;
}

/** Links a profile to a job: each profile applies to a job once, enforced by a unique index. */
function linkProfile(
  ctx: AppContext,
  applicant: ApplyingProfile,
  jobId: number,
  memo: string,
  evidence: UrlEvidence[],
  jobWasNew: boolean,
  matchedBy: MatchedBy,
  better: JobFields | null
): CreateApplicationResponse {
  const db = ctx.db;
  const response = ctx.handle.sqlite
    .transaction((): CreateApplicationResponse => {
      const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      if (!job) throw notFound('That job no longer exists.');

      const aliasAdded = addAliases(ctx, jobId, evidence);
      // An aggregator's excerpt is replaced when the employer's full posting comes along.
      if (better && better.description.length > job.description.length * 1.2) {
        const overlap = descriptionSimilarity(better.description, job.description);
        if (overlap.containment >= 0.6) {
          db.update(jobs)
            .set({ description: better.description, descriptionHash: hashDescription(better.description), extractionMethod: better.method, lastExtractedAt: better.extractedAt })
            .where(eq(jobs.id, jobId))
            .run();
        }
      }

      const existing = db
        .select({ id: applications.id })
        .from(applications)
        .where(and(eq(applications.profileId, applicant.profileId), eq(applications.jobId, jobId)))
        .get();
      if (existing) {
        return { outcome: 'already_applied', applicationId: existing.id, jobId, title: job.title, company: job.companyName, profileName: applicant.profileName };
      }

      const application = db
        .insert(applications)
        .values({ userId: applicant.userId, profileId: applicant.profileId, jobId, memo, status: DEFAULT_STATUS })
        .returning({ id: applications.id })
        .get();
      db.insert(applicationStatusHistory).values({ applicationId: application.id, oldStatus: null, newStatus: DEFAULT_STATUS }).run();
      if (aliasAdded || !jobWasNew) db.update(jobs).set({ updatedAt: nowIso() }).where(eq(jobs.id, jobId)).run();
      return { outcome: 'created', applicationId: application.id, jobId, jobWasNew, matchedBy };
    })
    .immediate();
  if (response.outcome === 'created') {
    ctx.events.publish(jobWasNew ? 'jobs_changed' : 'applications_changed', jobId);
  }
  return response;
}

function toCandidates(ctx: AppContext, userId: number, matches: Array<{ jobId: number; comparison: { score: number; reasons: string[] } }>): DuplicateCandidate[] {
  const applicationsByJob = listApplicationsForJobs(
    ctx.db,
    userId,
    matches.map((match) => match.jobId)
  );
  return matches.map(({ jobId, comparison }) => {
    const job = ctx.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (!job) throw notFound('That job no longer exists.');
    return {
      jobId,
      title: job.title,
      company: job.companyName,
      location: job.location,
      score: Math.round(comparison.score * 100) / 100,
      reasons: comparison.reasons,
      descriptionPreview: job.description.slice(0, 400),
      urls: ctx.db
        .select({ url: jobUrls.originalUrl })
        .from(jobUrls)
        .where(eq(jobUrls.jobId, jobId))
        .limit(5)
        .all()
        .map((row) => row.url),
      applications: applicationsByJob.get(jobId) ?? []
    };
  });
}

function validateUrl(input: string): URL {
  let url: URL;
  try {
    url = parseUserUrl(input);
    assertSafeUrlShape(url);
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw new ApiError(400, 'unsafe_url', error.message);
    if (error instanceof InvalidUrlError) throw new ApiError(400, 'invalid_url', error.message);
    throw error;
  }
  return url;
}

/**
 * The whole "add a job" flow. Everything after the page has been read runs without
 * yielding to the event loop, so concurrent requests are decided strictly one at a time
 * against what the previous one committed, and unique indexes back that up.
 */
export async function createApplication(ctx: AppContext, userId: number, body: CreateApplicationRequest): Promise<CreateApplicationResponse> {
  const url = validateUrl(body.url);
  // Checked before the page is read: a wrong profile should not cost a slow fetch.
  const profile = requireOwnActiveProfile(ctx.db, userId, body.profileId);
  const applicant: ApplyingProfile = { userId, profileId: profile.id, profileName: profile.name };
  const memo = body.memo?.trim() ?? '';
  const original = buildEvidence(url, 'original');
  if (!original) throw new ApiError(400, 'invalid_url', 'That does not look like a valid job URL.');

  // The person already answered "this is the same job".
  if (body.resolution?.action === 'merge') {
    const draft = ctx.drafts.get(body.draftId, userId, original.normalized);
    const evidence = toEvidence(url, draft?.extraction ?? null);
    const response = linkProfile(ctx, applicant, body.resolution.jobId, memo, evidence, false, 'user_confirmed', fieldsFrom(draft?.extraction ?? null, body.manual));
    ctx.drafts.delete(body.draftId);
    return response;
  }

  // Layers A and C need no network: most repeats end here.
  const early = findExactMatch(ctx.db, [original]);
  if (early) return linkProfile(ctx, applicant, early.jobId, memo, [original], false, early.matchedBy, null);

  const draft = ctx.drafts.get(body.draftId, userId, original.normalized);
  const extraction = draft?.extraction ?? (await extractOnce(ctx, original.normalized, original.raw));

  if (!extraction.ok && extraction.reason === 'unsafe_url') {
    throw new ApiError(400, 'unsafe_url', extraction.message);
  }

  const fields = fieldsFrom(extraction, body.manual);
  const evidence = toEvidence(url, extraction);

  // Layers B and C again, now knowing where the link really leads.
  const exact = findExactMatch(ctx.db, evidence, fields?.title ?? extractedFields(extraction).title);
  if (exact) {
    ctx.drafts.delete(body.draftId);
    return linkProfile(ctx, applicant, exact.jobId, memo, evidence, false, exact.matchedBy, fields);
  }

  if (!fields) {
    const failed = extraction as Exclude<ExtractionResult, ExtractionSuccess>;
    const known = extractedFields(extraction);
    const missing: Array<keyof ManualJobFields> = [];
    if (!known.title) missing.push('title');
    if (!known.company) missing.push('company');
    if (!known.description || known.description.length < MIN_DESCRIPTION_LENGTH) missing.push('description');
    return {
      outcome: 'needs_manual',
      draftId: draft?.id ?? ctx.drafts.create(userId, original.normalized, extraction),
      reason: failed.reason,
      message: failed.message,
      extracted: known,
      missing
    };
  }

  // Layer D: same posting under a URL we have never seen?
  if (body.resolution?.action !== 'new') {
    const content = findContentMatches(ctx.db, { company: fields.company, title: fields.title, location: fields.location, description: fields.description }, evidence);
    if (content.auto) {
      ctx.drafts.delete(body.draftId);
      return linkProfile(ctx, applicant, content.auto.jobId, memo, evidence, false, 'content', fields);
    }
    if (content.possible.length > 0) {
      return {
        outcome: 'possible_duplicate',
        draftId: draft?.id ?? ctx.drafts.create(userId, original.normalized, extraction),
        extracted: { title: fields.title, company: fields.company, description: fields.description, location: fields.location },
        candidates: toCandidates(ctx, userId, content.possible)
      };
    }
  }

  // The job, its links and the application commit together or not at all.
  const response = ctx.handle.sqlite
    .transaction(() => {
      const job = ctx.db
        .insert(jobs)
        .values({
          companyName: fields.company,
          title: fields.title,
          description: fields.description,
          location: fields.location,
          descriptionHash: hashDescription(fields.description),
          canonicalUrl: extraction.canonicalUrl ?? null,
          companyKey: normalizeCompany(fields.company),
          titleKey: normalizeTitle(fields.title),
          extractionMethod: fields.method,
          createdBy: userId,
          lastExtractedAt: fields.extractedAt
        })
        .returning({ id: jobs.id })
        .get();
      return linkProfile(ctx, applicant, job.id, memo, evidence, true, 'new', null);
    })
    .immediate();
  ctx.drafts.delete(body.draftId);
  return response;
}

/** "I applied too": joins a job already in the shared catalog, no link needed. */
export function applyToExistingJob(ctx: AppContext, userId: number, jobId: number, profileId: number, memo: string): CreateApplicationResponse {
  const profile = requireOwnActiveProfile(ctx.db, userId, profileId);
  return linkProfile(ctx, { userId, profileId: profile.id, profileName: profile.name }, jobId, memo.trim(), [], false, 'user_confirmed', null);
}
