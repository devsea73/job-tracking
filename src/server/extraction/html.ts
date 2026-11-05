import type { CheerioAPI } from 'cheerio';
import { cleanInline, htmlToText } from './text';
import type { PartialJob } from './types';

/** Pipeline step 2: page metadata. Gives title/company but rarely a complete description. */
export function extractMetadata($: CheerioAPI): PartialJob {
  const meta = (selector: string): string | null => cleanInline($(selector).first().attr('content'));
  const ogTitle = meta('meta[property="og:title"]') ?? meta('meta[name="twitter:title"]');
  const pageTitle = cleanInline($('title').first().text());
  const heading = cleanInline($('h1').first().text());
  const siteName = meta('meta[property="og:site_name"]') ?? meta('meta[name="application-name"]');

  const parsed = parseTitleCompany(ogTitle ?? pageTitle ?? '');
  const title = heading && heading.length < 160 && !/^(careers?|jobs?|apply|job details?)$/i.test(heading) ? heading : parsed.title;
  const description = meta('meta[property="og:description"]') ?? meta('meta[name="description"]');

  return {
    title,
    company: parsed.company ?? siteName,
    description,
    location: null,
    canonicalUrl: canonicalLink($)
  };
}

/** Handles "Title at Company", "Company - Title", "Title | Company" and similar. */
export function parseTitleCompany(raw: string): { title: string | null; company: string | null } {
  const text = raw
    .replace(/^job application for\s+/i, '')
    .replace(/\s*[-|–—]\s*(careers?|jobs?|job board|job details?)\s*$/i, '')
    .trim();
  if (!text) return { title: null, company: null };

  const at = text.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[-|–—].*)?$/i);
  if (at) return { title: at[1].trim(), company: at[2].trim() };

  const parts = text
    .split(/\s+[|–—-]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const roleWords = /(engineer|developer|manager|analyst|architect|scientist|designer|director|lead|specialist|consultant|administrator|intern|associate|officer|recruiter|representative|technician|coordinator)/i;
    if (roleWords.test(parts[0]) || !roleWords.test(parts[parts.length - 1])) {
      return { title: parts[0], company: parts[parts.length - 1] };
    }
    return { title: parts[parts.length - 1], company: parts[0] };
  }
  return { title: text, company: null };
}

export function canonicalLink($: CheerioAPI): string | null {
  const href = $('link[rel="canonical"]').first().attr('href') ?? $('meta[property="og:url"]').first().attr('content');
  return href?.trim() || null;
}

const NOISE_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'svg',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="dialog"]',
  '[aria-hidden="true"]',
  '[hidden]',
  '.cookie',
  '.cookies',
  '#cookie',
  '.nav',
  '.navbar',
  '.menu',
  '.sidebar',
  '.footer',
  '.header',
  '.breadcrumb',
  '.breadcrumbs',
  '.social',
  '.share',
  '.related',
  '.similar',
  '.ad',
  '.ads',
  '.advert',
  '.advertisement'
].join(',');

const CONTENT_SELECTORS = [
  '[itemprop="description"]',
  '[data-automation-id="jobPostingDescription"]',
  '#job-description',
  '#jobDescription',
  '#jobdescription',
  '#job_description',
  '.job-description',
  '.jobDescription',
  '.job_description',
  '.jobdescription',
  '.job-details',
  '.jobDetails',
  '.job-detail',
  '.posting-description',
  '.description__text',
  '.show-more-less-html__markup',
  '#content .content',
  '.job-post',
  '.job__description',
  '.opening-description',
  '.ats-description',
  '.iCIMS_JobContent',
  '.iCIMS_InfoMsg_Job',
  '.jv-job-detail-description',
  '.gem-job-description',
  '[class*="JobDescription"]',
  '[class*="job-description"]',
  '[class*="jobDescription"]',
  '[id*="job-description"]',
  '[id*="jobDescription"]'
];

const JOB_WORDS =
  /\b(responsibilit|requirement|qualification|experience|skills|you will|you'll|what you|about the role|about the job|the role|benefits|salary|compensation|equal opportunity|we are looking)/gi;

/** Pipeline step 3: well-known description containers used by job boards and career sites. */
export function extractKnownContainers($: CheerioAPI): string | null {
  let best: string | null = null;
  for (const selector of CONTENT_SELECTORS) {
    $(selector).each((_, element) => {
      const clone = $(element).clone();
      clone.find(NOISE_SELECTOR).remove();
      const text = htmlToText(clone.html() ?? '');
      if (text.length > (best?.length ?? 0)) best = text;
    });
    if (best && (best as string).length >= 400) return best;
  }
  return best;
}

/**
 * Pipeline step 5: readability-style fallback. Scores blocks by how much prose they hold
 * and how much of it reads like a job posting, and penalizes link-heavy (navigation) blocks.
 */
export function extractMainContent($: CheerioAPI): string | null {
  const doc = $.root().clone();
  doc.find(NOISE_SELECTOR).remove();

  let bestText: string | null = null;
  let bestScore = 0;
  doc.find('main, article, section, div, td').each((_, element) => {
    const node = $(element);
    const paragraphs = node.find('p, li').length;
    if (paragraphs < 3) return;
    const text = node.text().replace(/\s+/g, ' ').trim();
    if (text.length < 200) return;
    const linkText = node.find('a').text().replace(/\s+/g, ' ').trim().length;
    const linkDensity = linkText / text.length;
    if (linkDensity > 0.4) return;
    const jobSignals = (text.match(JOB_WORDS) ?? []).length;
    if (jobSignals === 0) return;
    // Rewards dense job prose, and stops an outer wrapper from beating its inner content.
    const score = (Math.min(jobSignals, 25) * 40 + paragraphs * 5) * (1 - linkDensity) - text.length / 120;
    if (score > bestScore) {
      bestScore = score;
      bestText = htmlToText(node.html() ?? '');
    }
  });
  return bestText;
}

/** Strips a trailing "apply" form and legal boilerplate that some sites put into the description. */
export function trimDescription(text: string): string {
  return text
    .replace(/\n+(apply (now|for this job)|submit (your )?application|create (a )?job alert)[\s\S]{0,400}$/i, '')
    .trim();
}
