import { discoverAtsLinks, identifyAts, type AtsIdentity } from '../dedupe/ats';
import { deriveJobFacts, type JobHints } from '../dedupe/job-facts';
import { stripPersonalParams } from '../dedupe/url-normalize';
import type { ExtractionFailureReason } from '../../shared/api';
import { findAdapter, findEmbeddedBoard, humanizeSlug, type AdapterContext, type SiteAdapter } from './adapters';
import { detectBlockedPage, detectClosedPosting, detectLoginWall, visibleText } from './blocked';
import {
  canonicalLink,
  cleanCompanyName,
  cleanTitle,
  extractKnownContainers,
  extractMainContent,
  extractMetadata,
  jobSignalCount,
  trimDescription,
  usableTitle
} from './html';
import { assertSafeUrlShape, UnsafeUrlError } from './ip-guard';
import { extractJsonLd } from './jsonld';
import { loadPage } from './markup';
import { FetchError, type FetchResult, type HttpClient } from './safe-fetch';
import { tidyText } from './text';
import {
  MIN_DESCRIPTION_LENGTH,
  type ExtractionFailure,
  type ExtractionMethod,
  type ExtractionResult,
  type PageRenderer,
  type PartialJob
} from './types';

export interface PipelineDeps {
  http: HttpClient;
  renderer: PageRenderer | null;
}

interface Attempt {
  job: PartialJob;
  method: ExtractionMethod;
}

/** One document's worth of findings. */
interface PageReading {
  attempts: Attempt[];
  canonicalUrl: string | null;
  discovered: string[];
  blockedMessage: string | null;
  closed: boolean;
  loginWall: boolean;
}

/** Most reliable source first. A person's search for facts stops at the first good one. */
const METHOD_RANK: ExtractionMethod[] = ['api', 'json-ld', 'embedded-data', 'site-html', 'open-graph', 'content'];

/** Sources where the job system itself says what this posting is. */
const STRUCTURED_METHODS: ExtractionMethod[] = ['api', 'json-ld', 'embedded-data'];

/** Page metadata is usually a teaser. It only counts when it clearly holds the whole posting. */
const MIN_METADATA_DESCRIPTION = 1000;
const MIN_CONTENT_DESCRIPTION = 400;
const MIN_CONTENT_JOB_SIGNALS = 3;

const CLOSED_MESSAGE = 'This posting appears to have been closed or removed from the site.';
const LOGIN_MESSAGE = 'This page requires signing in, so its details cannot be read automatically.';

function readPage(html: string, status: number | null, adapter: SiteAdapter | null, ctx: AdapterContext): PageReading {
  // The page as parsed is kept in check (see loadPage); what looks for text in the raw markup
  // reads all of it, as that takes no longer than the markup is long.
  const $ = loadPage(html);
  const pageTitle = $('title').first().text().trim();
  const bodyText = visibleText($);
  const attempts: Attempt[] = [];

  const metadata = extractMetadata($);
  const jsonLd = extractJsonLd($);
  if (jsonLd) attempts.push({ job: jsonLd, method: 'json-ld' });

  const embedded = adapter?.embedded?.($, html, ctx);
  if (embedded) attempts.push({ job: embedded, method: 'embedded-data' });

  const container = extractKnownContainers($);
  if (container) attempts.push({ job: { ...metadata, description: container }, method: 'site-html' });

  const main = extractMainContent($);
  if (main) attempts.push({ job: { ...metadata, description: main }, method: 'content' });

  attempts.push({ job: metadata, method: 'open-graph' });

  return {
    attempts,
    canonicalUrl: canonicalLink($),
    discovered: discoverAtsLinks(html, identifyAts(ctx.url)).map((link) => link.url),
    blockedMessage: detectBlockedPage($, html, status),
    // Structured data on the page means the posting is really there, whatever else the page says.
    closed: !jsonLd && !embedded && detectClosedPosting(bodyText, pageTitle),
    loginWall: detectLoginWall($)
  };
}

function usableDescription(job: PartialJob, method: ExtractionMethod): string | null {
  const text = job.description ? trimDescription(tidyText(job.description)) : null;
  if (!text || text.length < MIN_DESCRIPTION_LENGTH) return null;
  if (method === 'open-graph') {
    return text.length >= MIN_METADATA_DESCRIPTION && !/(\.\.\.|…)$/.test(text) ? text : null;
  }
  if (method === 'content') {
    return text.length >= MIN_CONTENT_DESCRIPTION && jobSignalCount(text) >= MIN_CONTENT_JOB_SIGNALS ? text : null;
  }
  return text;
}

interface Combined {
  job: PartialJob;
  /** The source of the description, null when no source had a real one. */
  method: ExtractionMethod | null;
  description: string | null;
}

const textHint = (value: unknown): string | null => (typeof value === 'string' ? value : null);
/** An amount, as a number or as the text of one ("120000"). */
const numberHint = (value: unknown): number | null => {
  const amount = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
};

/**
 * A site's data says anything it likes. A hint is only taken in the shape it is read in, so that a
 * list or an object where text belongs is left out rather than failing the whole posting.
 */
function usableHint(field: keyof JobHints, value: unknown): unknown {
  switch (field) {
    case 'postedAt':
      return typeof value === 'string' || typeof value === 'number' ? value : null;
    case 'salary': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const salary = value as Record<string, unknown>;
      return { min: numberHint(salary.min), max: numberHint(salary.max), currency: textHint(salary.currency), period: textHint(salary.period) };
    }
    default:
      return textHint(value);
  }
}

/** ".../jobs/580106338-data-analyst-at-booz-allen-hamilton-inc" names the employer in the link. */
function companyFromSlug(url: URL): string | null {
  const slug = url.pathname.split('/').filter(Boolean).pop()?.match(/-at-([a-z0-9-]{3,60})$/i)?.[1];
  return slug ? humanizeSlug(slug) : null;
}

/** Takes each field from the most reliable source that has a believable value. */
function combine(attempts: Attempt[], identity: AtsIdentity | null, url: URL): Combined {
  const ranked = [...attempts].sort((a, b) => METHOD_RANK.indexOf(a.method) - METHOD_RANK.indexOf(b.method));
  const withDescription = ranked.map((attempt) => ({ attempt, description: usableDescription(attempt.job, attempt.method) })).find((entry) => entry.description);
  const first = (read: (job: PartialJob) => string | null | undefined): string | null => {
    for (const attempt of ranked) {
      const value = read(attempt.job);
      if (value) return value;
    }
    return null;
  };
  const title = first((job) => (usableTitle(job.title) ? cleanTitle(job.title) : null));
  // Each hint from the most reliable source that has it. Data calls with no value leave it open.
  const hints: JobHints = {};
  for (const attempt of ranked) {
    for (const [key, raw] of Object.entries(attempt.job.hints ?? {})) {
      const field = key as keyof JobHints;
      const value = usableHint(field, raw);
      if (hints[field] === undefined && value !== null && value !== undefined && value !== '') (hints as Record<string, unknown>)[field] = value;
    }
  }
  return {
    job: {
      title,
      company: first((job) => {
        const company = cleanCompanyName(job.company);
        return company && company !== title ? company : null;
      }) ?? humanizeSlug(identity?.board) ?? companyFromSlug(url),
      location: first((job) => job.location),
      description: first((job) => job.description),
      requisitionId: first((job) => job.requisitionId),
      canonicalUrl: first((job) => job.canonicalUrl),
      hints
    },
    method: withDescription?.attempt.method ?? null,
    description: withDescription?.description ?? null
  };
}

function failure(
  reason: ExtractionFailureReason,
  message: string,
  partial: PartialJob = { title: null, company: null, description: null, location: null },
  extras: Partial<Pick<ExtractionFailure, 'finalUrl' | 'canonicalUrl' | 'redirectChain' | 'discoveredUrls'>> = {}
): ExtractionFailure {
  return {
    ok: false,
    reason,
    message,
    partial,
    finalUrl: extras.finalUrl ?? null,
    canonicalUrl: extras.canonicalUrl ?? null,
    redirectChain: extras.redirectChain ?? [],
    discoveredUrls: extras.discoveredUrls ?? []
  };
}

/**
 * Reads a job posting from a link. Tries the site's data endpoint, structured data, site
 * markup, a content heuristic and page metadata, then the same again on a page rendered in
 * a real browser. It reports success only with a believable title, company and description
 * in hand; otherwise it says what went wrong and passes on what it did find.
 */
export async function extractJob(input: string, deps: PipelineDeps, depth = 0): Promise<ExtractionResult> {
  let url: URL;
  try {
    url = new URL(stripPersonalParams(input));
    assertSafeUrlShape(url);
  } catch (error) {
    return failure('unsafe_url', error instanceof UnsafeUrlError ? error.message : 'That link is not a valid URL.');
  }

  let identity: AtsIdentity | null = identifyAts(url);
  const ctx: AdapterContext = { url, identity, http: deps.http };
  const adapter = findAdapter(ctx);
  const attempts: Attempt[] = [];

  const success = (fetched?: { finalUrl: string; chain: string[] }, reading?: PageReading, usedBrowser = false): ExtractionResult | null => {
    const sources = adapter?.structuredOnly ? attempts.filter((attempt) => attempt.method !== 'content' && attempt.method !== 'open-graph') : attempts;
    const { job, method, description } = combine(sources, identity, url);
    if (!method || !description || !job.title || !job.company) return null;
    return {
      ok: true,
      title: job.title,
      company: job.company,
      description,
      location: job.location,
      requisitionId: job.requisitionId ?? null,
      facts: deriveJobFacts({ title: job.title, company: job.company, location: job.location, description, hints: job.hints, urls: [url.toString(), fetched?.finalUrl ?? ''] }),
      method: usedBrowser && method !== 'api' ? 'browser' : method,
      usedBrowser,
      finalUrl: fetched?.finalUrl ?? url.toString(),
      canonicalUrl: job.canonicalUrl ?? reading?.canonicalUrl ?? null,
      redirectChain: fetched?.chain ?? [],
      discoveredUrls: reading?.discovered ?? []
    };
  };

  // Data endpoints first.
  try {
    const fromApi = await adapter?.api?.(ctx);
    if (fromApi) attempts.push({ job: fromApi, method: 'api' });
  } catch (error) {
    if (error instanceof FetchError && error.reason === 'unsafe_url') return failure(error.reason, error.message);
  }
  const fromData = success();
  if (fromData) return fromData;

  // Then the page itself.
  const pageUrl = adapter?.pageUrl?.(ctx) ?? url.toString();
  let page: FetchResult | null = null;
  let fetchFailure: FetchError | null = null;
  try {
    page = await deps.http.fetch(pageUrl);
  } catch (error) {
    if (!(error instanceof FetchError)) throw error;
    if (error.reason === 'unsafe_url' || error.reason === 'too_large' || error.reason === 'not_html') {
      return failure(error.reason, error.message);
    }
    fetchFailure = error;
  }

  let reading: PageReading | undefined;
  const extras = () => ({
    finalUrl: page?.finalUrl ?? null,
    canonicalUrl: reading?.canonicalUrl ?? null,
    redirectChain: page?.chain ?? [],
    discoveredUrls: reading?.discovered ?? []
  });
  const known = () => combine(attempts, identity, url).job;

  if (page) {
    reading = readPage(page.body, page.status, adapter, ctx);
    // What a bot check or sign-in page says is about that page, not about the job.
    if (!reading.blockedMessage && !reading.loginWall) attempts.push(...reading.attempts);

    // A company's wrapper page often names its ATS board, which its own URL leaves out.
    if (identity && !identity.board && (identity.provider === 'greenhouse' || identity.provider === 'ashby')) {
      const board = findEmbeddedBoard(page.body, identity);
      if (board) {
        identity = { ...identity, board };
        const direct = identity.provider === 'greenhouse' ? `https://job-boards.greenhouse.io/${board}/jobs/${identity.externalId}` : `https://jobs.ashbyhq.com/${board}/${identity.externalId}`;
        if (depth === 0) {
          const result = await extractJob(direct, deps, depth + 1);
          if (result.ok) return { ...result, discoveredUrls: [direct, ...result.discoveredUrls] };
        }
      }
    }

    // When the job system says the posting is gone, a company blurb in the page's metadata is not the job.
    const believable = !ctx.gone || attempts.some((attempt) => STRUCTURED_METHODS.includes(attempt.method));
    const fromPage = reading.blockedMessage || !believable ? null : success(page, reading);
    if (fromPage && !reading.closed && page.status < 400) return fromPage;

    // Taking the site's word for it saves opening a browser.
    if (page.status === 404 || page.status === 410 || reading.closed || ctx.gone) {
      return failure('not_found', CLOSED_MESSAGE, known(), extras());
    }
  }

  // Finally a real browser, for pages that build themselves with JavaScript.
  let browserProblem: string | null = null;
  let blockedInBrowser = false;
  if (deps.renderer) {
    try {
      const rendered = await deps.renderer.render(pageUrl);
      assertSafeUrlShape(new URL(rendered.finalUrl));

      // A career site showing the posting in an ATS iframe: read it from the source.
      if (depth === 0) {
        for (const frame of rendered.frames ?? []) {
          const frameIdentity = identifyAts(frame.url);
          if (!frameIdentity?.board) continue;
          const result = await extractJob(frame.url, deps, depth + 1);
          if (result.ok) return { ...result, discoveredUrls: [frame.url, ...result.discoveredUrls] };
          if (result.reason === 'not_found') return result;
        }
      }

      const browserReading = readPage(rendered.html, rendered.status, adapter, ctx);
      reading = browserReading;
      const hasPosting = browserReading.attempts.some((attempt) => STRUCTURED_METHODS.includes(attempt.method));
      if (browserReading.closed || (ctx.gone && !hasPosting)) {
        return failure('not_found', CLOSED_MESSAGE, known(), { ...extras(), finalUrl: rendered.finalUrl });
      }
      if (browserReading.blockedMessage) {
        blockedInBrowser = true;
      } else {
        if (!browserReading.loginWall) attempts.push(...browserReading.attempts);
        const result = success({ finalUrl: rendered.finalUrl, chain: page?.chain ?? [rendered.finalUrl] }, browserReading, true);
        if (result && !browserReading.loginWall) return result;
      }
    } catch (error) {
      if (error instanceof UnsafeUrlError) return failure('unsafe_url', error.message);
      browserProblem = error instanceof Error ? error.message.split('\n')[0] : 'The browser could not open this page.';
    }
  }

  // Nothing worked: say why, and hand back whatever was found for the manual form.
  // A site that blocks the page has shown nothing about the job. Its page title ("Candidate
  // Portal") would only have to be erased, so only what the job system itself said is offered.
  const fromJobSystem = () => ({ ...combine(attempts.filter((attempt) => STRUCTURED_METHODS.includes(attempt.method)), identity, url).job, description: null });
  const blockedMessage = reading?.blockedMessage ?? (blockedInBrowser ? 'This job site showed a bot check instead of the posting.' : null);
  if (blockedMessage) return failure('blocked', `${blockedMessage} Please enter the details yourself.`, fromJobSystem(), extras());
  if (reading?.loginWall) return failure('blocked', LOGIN_MESSAGE, fromJobSystem(), extras());
  if (fetchFailure) return failure(fetchFailure.reason, fetchFailure.message, known(), extras());
  if (page && page.status >= 400) return failure('http_error', `The job site responded with an error (HTTP ${page.status}).`, known(), extras());

  const { job, description } = combine(attempts, identity, url);
  const missing = [!job.title && 'job title', !job.company && 'company', !description && 'description'].filter(Boolean).join(', ');
  return failure('incomplete', `Could not find the ${missing || 'job details'} on this page.${browserProblem ? ` ${browserProblem}` : ''}`, job, extras());
}
