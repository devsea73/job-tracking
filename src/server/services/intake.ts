import { and, eq } from 'drizzle-orm';
import type {
  CreateApplicationRequest,
  CreateApplicationResponse,
  DuplicateCandidate,
  CheckedJobSummary,
  CheckLinkResponse,
  ExtractedJobFields,
  JobFacts,
  KnownJobSummary,
  ManualJobFields,
  MatchedBy
} from '../../shared/api';
import { DEFAULT_STATUS } from '../../shared/constants';
import { isUnreadableNote, unreadableNote } from '../../shared/unreadable';
import type { AppContext } from '../context';
import { nowIso, prepared } from '../db/client';
import { applications, applicationStatusHistory, jobIdentifiers, jobs, jobUrls, profiles } from '../db/schema';
import { identifyAts, isAggregator, titleFromUrl } from '../dedupe/ats';
import { deriveJobFacts } from '../dedupe/job-facts';
import { buildEvidence, findContentMatches, findExactMatch, identifiersFromEvidence, isSpecificPage, type UrlEvidence } from '../dedupe/matcher';
import { hashDescription, normalizeCompany, normalizeTitle, descriptionSimilarity } from '../dedupe/text-normalize';
import { InvalidUrlError, parseUserUrl } from '../dedupe/url-normalize';
import { ApiError, notFound } from '../errors';
import { assertSafeUrlShape, UnsafeUrlError } from '../extraction/ip-guard';
import { extractJob } from '../extraction/pipeline';
import { htmlToText, looksLikeHtml } from '../extraction/text';
import { MIN_DESCRIPTION_LENGTH, type ExtractionResult, type ExtractionSuccess } from '../extraction/types';
import { loggableUrl } from '../logger';
import { markDistinct, recordPending } from './duplicates';
import { addFactsFromListing, readJobFacts, refreshJobFacts, saveNewJobFacts, saveSignatures } from './job-facts-store';
import { absorbDuplicates } from './job-merge';
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

const bareHost = (link: URL) => link.hostname.toLowerCase().replace(/^www\./, '');
const barePath = (link: URL) => link.pathname.replace(/\/+$/, '').toLowerCase();

/**
 * A canonical link names the page a posting really lives on, often the employer's own. One that
 * points at another page of the same site is more likely a page every posting there names, like
 * "all open roles", so it is no evidence: different openings would be taken for one job.
 */
function countsAsCanonical(page: URL, canonical: URL): boolean {
  return bareHost(page) !== bareHost(canonical) || barePath(page) === barePath(canonical) || identifyAts(canonical) !== null;
}

function toEvidence(url: URL, extraction: ExtractionResult | null): UrlEvidence[] {
  const list: Array<UrlEvidence | null> = [buildEvidence(url, 'original')];
  // A page that failed to read says nothing about its links: closed postings often
  // redirect to a general jobs page, which must not become part of this job's identity.
  if (extraction?.ok) {
    if (extraction.canonicalUrl) {
      try {
        const page = new URL(extraction.finalUrl ?? url);
        const canonical = new URL(extraction.canonicalUrl, page);
        if (countsAsCanonical(page, canonical)) list.push(buildEvidence(canonical, 'canonical'));
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
  facts: JobFacts;
}

/** Text pasted from a page's source, or what a failed reading picked up, can still be markup. */
const plainText = (text: string) => (looksLikeHtml(text) ? htmlToText(text) || text : text);

function fieldsFrom(extraction: ExtractionResult | null, manual: ManualJobFields | undefined, urls: string[] = []): JobFields | null {
  if (manual) {
    const description = plainText(manual.description);
    return {
      title: manual.title,
      company: manual.company,
      description,
      location: manual.location?.trim() || null,
      method: 'manual',
      extractedAt: null,
      // What the site stated still counts when the person only had to type in what was missing.
      facts: deriveJobFacts({ title: manual.title, company: manual.company, location: manual.location, description, urls })
    };
  }
  if (extraction?.ok) {
    return {
      title: extraction.title,
      company: extraction.company,
      description: extraction.description,
      location: extraction.location,
      method: extraction.method,
      extractedAt: nowIso(),
      facts: extraction.facts
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
  return { title, company, description: description ? plainText(description) : description, location };
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
    for (const reference of item.references) {
      ctx.db.insert(jobIdentifiers).values({ jobId, provider: reference.provider, externalId: reference.externalId, isDiscovered: true }).onConflictDoNothing().run();
    }
  }
  return added;
}

/**
 * The saved link an application came through: the one the person pasted, or, without one, a link
 * of this job they picked (the one a notification copied). Either way it must belong to this job.
 */
function sourceLink(ctx: AppContext, jobId: number, evidence: UrlEvidence[], chosen: number | null): number | null {
  const pasted = evidence.find((item) => item.kind === 'original');
  const row = pasted
    ? (prepared(ctx.handle.sqlite, 'SELECT id FROM job_urls WHERE normalized_url = ? AND job_id = ?').get(pasted.normalized, jobId) as { id: number } | undefined)
    : chosen
      ? (prepared(ctx.handle.sqlite, 'SELECT id FROM job_urls WHERE id = ? AND job_id = ?').get(chosen, jobId) as { id: number } | undefined)
      : undefined;
  return row?.id ?? null;
}

/** Who is applying: a signed-in user, under one of their own profiles. */
interface ApplyingProfile {
  userId: number;
  profileId: number;
  profileName: string;
}

/**
 * Links a profile to a job: each profile applies to a job once, enforced by a unique index.
 * With `anyProfile`, an application from any of the person's profiles counts as applied: a
 * notification only offers jobs none of them has, and the main window may have just added it.
 */
function linkProfile(
  ctx: AppContext,
  applicant: ApplyingProfile,
  jobId: number,
  memo: string,
  evidence: UrlEvidence[],
  jobWasNew: boolean,
  matchedBy: MatchedBy,
  better: JobFields | null,
  chosenLink: number | null = null,
  anyProfile = false
): CreateApplicationResponse {
  const db = ctx.db;
  let merged = false;
  const response = ctx.handle.sqlite
    .transaction((): CreateApplicationResponse => {
      if (!db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId)).get()) throw notFound('That job no longer exists.');
      // This job's own ids go in first, so that merging can see when the hosting system says two jobs differ.
      const aliasAdded = addAliases(ctx, jobId, evidence);
      // Before reading the job: folding another one in can change its details.
      merged = absorbDuplicates(ctx, jobId, evidence);
      const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
      if (!job) throw notFound('That job no longer exists.');

      // An aggregator's excerpt is replaced when the employer's full posting comes along, and a note
      // saying the posting could not be read gives way to its real text, whatever the length.
      const replacesNote = !!better && isUnreadableNote(job.description) && !isUnreadableNote(better.description) && better.description.length >= MIN_DESCRIPTION_LENGTH;
      if (better && (replacesNote || (better.description.length > job.description.length * 1.2 && descriptionSimilarity(better.description, job.description).containment >= 0.6))) {
        db.update(jobs)
          .set({ description: better.description, descriptionHash: hashDescription(better.description), extractionMethod: better.method, lastExtractedAt: better.extractedAt })
          .where(eq(jobs.id, jobId))
          .run();
        // Now readable, a note's job is compared again, with what its text says.
        if (replacesNote) refreshJobFacts(ctx.handle.sqlite, jobId);
        else saveSignatures(ctx.handle.sqlite, jobId, better.description);
      }
      // This listing may say what the first one did not: a salary, a date, a work arrangement.
      if (better) addFactsFromListing(ctx.handle.sqlite, jobId, better.facts);

      const existing = db
        .select({ id: applications.id, profileId: applications.profileId })
        .from(applications)
        .where(and(anyProfile ? eq(applications.userId, applicant.userId) : eq(applications.profileId, applicant.profileId), eq(applications.jobId, jobId)))
        .get();
      if (existing) {
        const profileName =
          existing.profileId === applicant.profileId ? applicant.profileName : (db.select({ name: profiles.name }).from(profiles).where(eq(profiles.id, existing.profileId)).get()?.name ?? applicant.profileName);
        return { outcome: 'already_applied', applicationId: existing.id, jobId, title: job.title, company: job.companyName, profileName };
      }
      // Reading the page can take a while: the profile may have been archived or deleted meanwhile.
      const profile = db
        .select({ isArchived: profiles.isArchived })
        .from(profiles)
        .where(and(eq(profiles.id, applicant.profileId), eq(profiles.userId, applicant.userId)))
        .get();
      if (!profile || profile.isArchived) {
        throw new ApiError(409, 'profile_unavailable', `The profile "${applicant.profileName}" was archived or removed while this was being saved. Choose another profile and save again.`);
      }

      const application = db
        .insert(applications)
        .values({ userId: applicant.userId, profileId: applicant.profileId, jobId, memo, status: DEFAULT_STATUS, jobUrlId: sourceLink(ctx, jobId, evidence, chosenLink) })
        .returning({ id: applications.id })
        .get();
      db.insert(applicationStatusHistory).values({ applicationId: application.id, oldStatus: null, newStatus: DEFAULT_STATUS }).run();
      if (aliasAdded || !jobWasNew) db.update(jobs).set({ updatedAt: nowIso() }).where(eq(jobs.id, jobId)).run();
      return { outcome: 'created', applicationId: application.id, jobId, jobWasNew, matchedBy };
    })
    .immediate();
  if (response.outcome === 'created') {
    ctx.events.publish(jobWasNew || merged ? 'jobs_changed' : 'applications_changed', jobId);
    // Lets everyone else's app offer this job to them, if they have not applied to it.
    ctx.events.publish('application_added', jobId, { userId: applicant.userId, applicationId: response.applicationId });
  } else if (merged) {
    ctx.events.publish('jobs_changed', jobId);
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
      facts: readJobFacts(ctx.handle.sqlite, jobId),
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
    const fields = fieldsFrom(draft?.extraction ?? null, body.manual);
    const chosen = body.resolution.jobId;
    // Someone else may have saved this very link since, as a job of its own. The application goes
    // where the link is, and whether the two are one job is left for someone to settle.
    const saved = findExactMatch(ctx.db, [original]);
    if (saved && saved.jobId !== chosen) {
      const response = linkProfile(ctx, applicant, saved.jobId, memo, evidence, false, saved.matchedBy, fields);
      askAboutPair(ctx, saved.jobId, chosen, 'Someone said these are the same job');
      ctx.drafts.delete(body.draftId);
      return response;
    }
    const response = linkProfile(ctx, applicant, chosen, memo, evidence, false, 'user_confirmed', fields);
    ctx.drafts.delete(body.draftId);
    return response;
  }

  // Layers A and C need no network: most repeats end here. A job saved without its text (the
  // page could not be read then) is read again through this link, which may work now.
  const early = findExactMatch(ctx.db, [original]);
  if (early && !lacksText(ctx, early.jobId)) return linkProfile(ctx, applicant, early.jobId, memo, [original], false, early.matchedBy, null);

  const draft = ctx.drafts.get(body.draftId, userId, original.normalized);
  const extraction = draft?.extraction ?? (await extractOnce(ctx, original.normalized, original.raw));

  if (!extraction.ok && extraction.reason === 'unsafe_url') {
    throw new ApiError(400, 'unsafe_url', extraction.message);
  }

  const fields = fieldsFrom(extraction, body.manual, [url.toString()]);
  const evidence = toEvidence(url, extraction);
  if (early) {
    ctx.drafts.delete(body.draftId);
    return linkProfile(ctx, applicant, early.jobId, memo, evidence, false, early.matchedBy, extraction.ok ? fields : null);
  }

  // Layers B and C again, now knowing where the link really leads.
  const titleHint = titleFromUrl(url);
  const exact = findExactMatch(ctx.db, evidence, fields?.title ?? extractedFields(extraction).title ?? titleHint);
  if (exact) {
    ctx.drafts.delete(body.draftId);
    return linkProfile(ctx, applicant, exact.jobId, memo, evidence, false, exact.matchedBy, fields);
  }

  if (!fields) {
    const failed = extraction as Exclude<ExtractionResult, ExtractionSuccess>;
    const known = extractedFields(extraction);
    // The page could not be read, but the link itself may say what the job is called.
    known.title ??= titleHint;
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
  const content = findContentMatches(ctx.db, {
    company: fields.company,
    title: fields.title,
    location: fields.location,
    description: fields.description,
    facts: fields.facts,
    identifiers: identifiersFromEvidence(evidence)
  });
  const found = content.auto ? [content.auto, ...content.possible] : content.possible;
  const askPerson = (): CreateApplicationResponse => ({
    outcome: 'possible_duplicate',
    draftId: draft?.id ?? ctx.drafts.create(userId, original.normalized, extraction),
    extracted: { title: fields.title, company: fields.company, description: fields.description, location: fields.location },
    candidates: toCandidates(ctx, userId, found)
  });
  // "A new job" answers only for the jobs the person was shown. The likeliest match has to be one
  // of them: one that turned up since (someone just saved it) is put to them first. Without a
  // list (an import, say), nobody was shown anything: saved as new, and every match waits for review.
  const seen = body.resolution?.action === 'new' ? body.resolution.seen : undefined;
  const shown = new Set(seen ?? []);
  if (body.resolution?.action !== 'new') {
    if (content.auto) {
      ctx.drafts.delete(body.draftId);
      return linkProfile(ctx, applicant, content.auto.jobId, memo, evidence, false, 'content', fields);
    }
    if (content.possible.length > 0) return askPerson();
  } else if (seen && found.length > 0 && !shown.has(found[0].jobId)) {
    return askPerson();
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
      saveNewJobFacts(ctx.handle.sqlite, job.id, fields.facts, fields.description);
      for (const candidate of found) {
        // Someone looked at this one and said it is a different job, so it is not offered again.
        if (shown.has(candidate.jobId)) markDistinct(ctx.handle.sqlite, job.id, candidate.jobId);
        // Nobody did: it waits on the Duplicates page instead of being forgotten.
        else recordPending(ctx.handle.sqlite, job.id, candidate);
      }
      return linkProfile(ctx, applicant, job.id, memo, evidence, true, 'new', null);
    })
    .immediate();
  ctx.drafts.delete(body.draftId);
  return response;
}

/** Text an unreadable page shows in place of a job title: an error, a home page, a sign-in wall. */
const NOT_A_TITLE_WORDS = /not found|could not be found|\berror\b|careers? (home|page)|opportunit|let'?s connect|isn'?t available|\bdomain\b|^home$|welcome|access denied|just a moment|attention required|sign ?in|log ?in|^jobs?$|^careers?$/i;

function usableTitle(title: string | null | undefined, company: string | null | undefined): string | null {
  if (!title?.trim()) return null;
  const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (NOT_A_TITLE_WORDS.test(title) || (company && squash(title) === squash(company))) return null;
  return title.trim();
}

function knownJob(ctx: AppContext, userId: number, jobId: number): KnownJobSummary {
  const sqlite = ctx.handle.sqlite;
  const job = sqlite.prepare('SELECT id, title, company_name, location, application_count FROM jobs WHERE id = ?').get(jobId) as { id: number; title: string; company_name: string; location: string | null; application_count: number };
  const mine = sqlite.prepare('SELECT profile_id FROM applications WHERE job_id = ? AND user_id = ?').all(jobId, userId) as Array<{ profile_id: number }>;
  return { id: job.id, title: job.title, company: job.company_name, location: job.location, facts: readJobFacts(sqlite, jobId), applicationCount: job.application_count, myProfileIds: mine.map((row) => row.profile_id) };
}

/**
 * Reads a pasted link and runs every duplicate check, saving nothing. The page read is kept as a
 * draft, so that saving afterwards needs no second visit to the site and adds no wait.
 */
export async function checkLink(ctx: AppContext, userId: number, input: string): Promise<CheckLinkResponse> {
  const url = validateUrl(input);
  const original = buildEvidence(url, 'original');
  if (!original) throw new ApiError(400, 'invalid_url', 'That does not look like a valid job URL.');

  const early = findExactMatch(ctx.db, [original]);
  if (early && !lacksText(ctx, early.jobId)) return { status: 'known', draftId: null, matchedBy: early.matchedBy, job: knownJob(ctx, userId, early.jobId) };

  const extraction = await extractOnce(ctx, original.normalized, original.raw);
  if (!extraction.ok && extraction.reason === 'unsafe_url') throw new ApiError(400, 'unsafe_url', extraction.message);
  const draftId = ctx.drafts.create(userId, original.normalized, extraction);
  // Known, without its text: what was just read goes with saving, so the job gets it.
  if (early) return { status: 'known', draftId, matchedBy: early.matchedBy, job: knownJob(ctx, userId, early.jobId) };
  const fields = fieldsFrom(extraction, undefined, [url.toString()]);
  const evidence = toEvidence(url, extraction);
  const titleHint = titleFromUrl(url);
  const exact = findExactMatch(ctx.db, evidence, fields?.title ?? extractedFields(extraction).title ?? titleHint);
  if (exact) return { status: 'known', draftId, matchedBy: exact.matchedBy, job: knownJob(ctx, userId, exact.jobId) };

  if (!fields) {
    const failed = extraction as Exclude<ExtractionResult, ExtractionSuccess>;
    const known = extractedFields(extraction);
    const description = known.description && known.description.length >= MIN_DESCRIPTION_LENGTH ? known.description : unreadableNote(failed.reason, failed.message);
    return {
      status: 'unreadable',
      draftId,
      reason: failed.reason,
      message: failed.message,
      description,
      // The link names the job reliably; an unreadable page's own text often does not.
      job: { title: titleHint ?? usableTitle(known.title, known.company), company: known.company, location: known.location, facts: null }
    };
  }

  const content = findContentMatches(ctx.db, { company: fields.company, title: fields.title, location: fields.location, description: fields.description, facts: fields.facts, identifiers: identifiersFromEvidence(evidence) });
  const job: CheckedJobSummary = { title: fields.title, company: fields.company, location: fields.location, facts: fields.facts };
  if (content.auto) return { status: 'known', draftId, matchedBy: 'content', job: knownJob(ctx, userId, content.auto.jobId) };
  if (content.possible.length > 0) return { status: 'possible', draftId, job, candidates: toCandidates(ctx, userId, content.possible) };
  return { status: 'fresh', draftId, job };
}

/**
 * "I applied too": joins a job already in the shared catalog, no link needed. A notification names
 * the link it copied, and applies only if none of the person's profiles has applied yet.
 */
export function applyToExistingJob(
  ctx: AppContext,
  userId: number,
  jobId: number,
  profileId: number,
  memo: string,
  urlId: number | null = null,
  options: { unlessApplied?: boolean } = {}
): CreateApplicationResponse {
  const profile = requireOwnActiveProfile(ctx.db, userId, profileId);
  return linkProfile(ctx, { userId, profileId: profile.id, profileName: profile.name }, jobId, memo.trim(), [], false, 'user_confirmed', null, urlId, options.unlessApplied === true);
}

/** A job saved with a note in place of its text, because its page could not be read at the time. */
function lacksText(ctx: AppContext, jobId: number): boolean {
  const row = prepared(ctx.handle.sqlite, 'SELECT description FROM jobs WHERE id = ?').get(jobId) as { description: string } | undefined;
  return !!row && isUnreadableNote(row.description);
}

/** Two jobs a person tied together, for someone to settle on the Duplicates page, unless already settled. */
function askAboutPair(ctx: AppContext, a: number, b: number, reason: string): void {
  const exists = prepared(ctx.handle.sqlite, 'SELECT COUNT(*) AS total FROM jobs WHERE id IN (?, ?)').get(a, b) as { total: number };
  if (a === b || exists.total !== 2) return;
  recordPending(ctx.handle.sqlite, a, { jobId: b, comparison: { decision: 'possible', score: 1, reasons: [reason] } });
  ctx.events.publish('jobs_changed');
}
