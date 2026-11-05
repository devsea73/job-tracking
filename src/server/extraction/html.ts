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

  const fromOg = parseTitleCompany(ogTitle ?? '');
  const fromPage = parseTitleCompany(pageTitle ?? '');
  const parsedTitle = [fromOg.title, fromPage.title].find((value) => usableTitle(value)) ?? null;
  const title = cleanTitle(chooseHeading(heading, parsedTitle) ?? parsedTitle);
  const company = [fromOg.company, fromPage.company, siteName].map(cleanCompanyName).find((value) => value && value !== title) ?? null;
  const description = meta('meta[property="og:description"]') ?? meta('meta[name="description"]');

  return {
    title,
    company,
    description,
    location: null,
    canonicalUrl: canonicalLink($)
  };
}

/**
 * The page's main heading is usually the role, but it can also wrap a whole page header
 * ("Texture Senior Data Engineer Remote · Full time Apply for Senior Data Engineer").
 */
function chooseHeading(heading: string | null, parsedTitle: string | null): string | null {
  if (!heading || !usableTitle(heading)) return null;
  const applyFor = heading.match(/\bapply for (.{3,80})$/i)?.[1];
  if (applyFor && heading.length > applyFor.length + 12) return applyFor;
  if (parsedTitle && heading.length > parsedTitle.length * 1.5 && heading.toLowerCase().includes(parsedTitle.toLowerCase())) return parsedTitle;
  return heading.length < 100 ? heading : null;
}

/** "Data Engineer -" and "| Data Engineer" are the leftovers of a page title template. */
export function cleanTitle(title: string | null | undefined): string | null {
  return (
    title
      ?.replace(/^\s*\[(remote|hybrid|on-?site)\]\s*/i, '')
      .replace(/^[\s|–—-]+|[\s|–—-]+$/g, '')
      .trim() || null
  );
}

const GENERIC_TITLE =
  /^(careers?( at .*| page| site| portal)?|.* careers?( \| .*)?|jobs?( at .*| board| details?| search)?|search( for)? jobs|job search|apply( now)?|job details?|job seeker support|recruitment|current openings?( at .*)?|open (positions|roles)|join (the|our) team|login|sign in|home|welcome|.*\| latest jobs|.* open jobs|no job found.*|job not found|page not found)$/i;

const LANDING_PAGE_TITLE = /\b(open positions|job openings|careers? (and|&)|job search results|job seeker|candidate portal|careers? portal)\b/i;

/** False for what is the name of a page rather than of a role, or an unfilled template. */
export function usableTitle(title: string | null | undefined): boolean {
  const text = title?.trim();
  if (!text || text.length < 2 || text.length > 200) return false;
  if (text.includes('{{') || text.includes('}}') || /^[|\-–—\s]+$/.test(text)) return false;
  // "1.Introduction" is a section of a notice, "mainPage.jobDetailsPage" an unfilled label.
  if (/^\d+\.\s*\S/.test(text) || /^[a-z]+(\.[a-zA-Z]+)+$/.test(text)) return false;
  return !GENERIC_TITLE.test(text) && !LANDING_PAGE_TITLE.test(text);
}

/** "Infoblox Careers" names the site, "Infoblox" names the employer. */
export function cleanCompanyName(company: string | null | undefined): string | null {
  const text = company
    ?.replace(/^[\s|–—-]+|[\s|–—-]+$/g, '')
    // Payroll entity codes in Workday's names: "6090-Johnson & Johnson", "8100 United States - Genesys".
    .replace(/^\d{3,6}-(?=[A-Za-z])/, '')
    .replace(/^(\d{3,6}\s+)?(United States|USA?)\s+-\s+/i, '')
    .replace(/\s+Legal Entity$/i, '')
    .replace(/\s+(careers?( site| page| portal)?|jobs|job board|recruiting|recruitment|hiring)$/i, '')
    .trim();
  if (!text || text.length < 2 || text.length > 100 || text.includes('{{') || NOT_A_COMPANY.test(text)) return null;
  // "Snowflake in Remote, United States" came from splitting a title, it is not an employer.
  if (/\bin\s+(remote\b|[A-Z][\w .-]*,\s*[A-Z])/.test(text)) return null;
  // Logo alt text can hold a whole sentence: "*Thanks for your interest in HomeServices' ...".
  if (/^\W/.test(text) || /\bthanks?\b|\binterest in\b/i.test(text)) return null;
  return text;
}

const ROLE_WORDS =
  /(engineer|developer|manager|analyst|architect|scientist|designer|director|lead|specialist|consultant|administrator|intern|associate|officer|recruiter|representative|technician|coordinator|programmer|modeler)/i;

/** Page-title segments that describe the page rather than name an employer. */
const NOT_A_COMPANY = /^(\d+%\s*remote|remote( job)?|hybrid|on-?site|full[- ]time|part[- ]time|contract|careers?( page| site)?|jobs?( board)?|job details?|job openings?|(job |career )?opportunities|apply( now)?|home|recruitment|united states|usa?)$/i;

/** Handles "Title at Company", "Company - Title", "Title | Company" and similar. */
export function parseTitleCompany(raw: string): { title: string | null; company: string | null } {
  const text = raw
    .replace(/^(job application for|apply (now )?(to|for)|apply:)\s+/i, '')
    .replace(/\s*[-|–—]\s*(careers?|career page|jobs?|job board|job details?)\s*$/i, '')
    .replace(/^[\s|–—-]+|[\s|–—-]+$/g, '')
    .trim();
  if (!text) return { title: null, company: null };

  const at = text.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s*[-|–—].*)?$/i);
  if (at) return { title: at[1].trim(), company: at[2].trim() };

  const parts = text
    .split(/\s+[|–—-]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    // "Everest Technologies - Data Engineer - Remote Job": the role can sit in any position.
    const titleIndex = parts.findIndex((part) => ROLE_WORDS.test(part));
    const title = parts[titleIndex === -1 ? 0 : titleIndex];
    const company = parts.find((part) => part !== title && !NOT_A_COMPANY.test(part)) ?? null;
    return { title, company };
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
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="onetrust" i]',
  '[class*="consent" i]',
  '[data-automation-id="skipToMainContent"]',
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

/** How many different kinds of job-posting language a text uses. */
export function jobSignalCount(text: string): number {
  return new Set((text.match(JOB_WORDS) ?? []).map((word) => word.toLowerCase())).size;
}

/** Strips a trailing "apply" form and legal boilerplate that some sites put into the description. */
export function trimDescription(text: string): string {
  return text
    .replace(/\n+(apply (now|for this job)|submit (your )?application|create (a )?job alert)[\s\S]{0,400}$/i, '')
    .trim();
}
