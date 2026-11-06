import type { CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { isSpaceCode, textOf } from './markup';
import { cleanInline, finishText, htmlToText, nodesToText } from './text';
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

const noiseByPage = new WeakMap<object, Set<Element>>();

/** The page's noise, found once per page: nothing changes the parsed page once it is read. */
function noiseOf($: CheerioAPI): Set<Element> {
  const page = $.root()[0];
  let noise = noiseByPage.get(page);
  if (!noise) {
    noise = new Set($.root().find(NOISE_SELECTOR).toArray() as Element[]);
    noiseByPage.set(page, noise);
  }
  return noise;
}

/** Far longer than any posting: such a block is read straight from the page rather than copied first. */
const HUGE_BLOCK_CHARS = 100_000;

/**
 * An element's text without the page's noise inside it: the element copied, the noise taken out,
 * and the rest written out and read as markup. A block far longer than any posting is read
 * straight from the parsed page instead, skipping the noise, by the same rules: copying and
 * reparsing a megabyte of markup takes the best part of a second.
 */
function containerText($: CheerioAPI, element: Element, size = textOf(element).length): string {
  if (size > HUGE_BLOCK_CHARS) {
    const noise = noiseOf($);
    return finishText(nodesToText(element.children, (node) => noise.has(node as Element)));
  }
  const clone = $(element).clone();
  clone.find(NOISE_SELECTOR).remove();
  return htmlToText(clone.html() ?? '');
}

const ANY_CONTENT_SELECTOR = CONTENT_SELECTORS.join(',');

/**
 * Pipeline step 3: well-known description containers used by job boards and career sites.
 *
 * The longest text wins, so an element inside one already read is passed over when everything in
 * it was part of that text, which is then at least as long: when neither it nor anything between
 * them is noise, which is left out of the text around it. Each element is read once, whichever
 * selectors find it, so a page nesting many of them costs no more than reading it once or twice.
 * The page is searched once for all the selectors, and each one then picks its own from those.
 */
export function extractKnownContainers($: CheerioAPI): string | null {
  let best: string | null = null;
  const read = new Map<Element, string>();
  const noise = noiseOf($);
  const covered = (element: Element): boolean => {
    if (noise.has(element)) return false;
    for (let node = element.parent; node; node = node.parent) {
      if (read.has(node as Element)) return true;
      if (noise.has(node as Element)) return false;
    }
    return false;
  };
  const found = $(ANY_CONTENT_SELECTOR);
  if (found.length === 0) return null;
  for (const selector of CONTENT_SELECTORS) {
    for (const element of found.filter(selector).toArray() as Element[]) {
      let text = read.get(element);
      if (text === undefined) {
        if (covered(element)) continue;
        text = containerText($, element);
        read.set(element, text);
      }
      if (text.length > (best?.length ?? 0)) best = text;
    }
    if (best && best.length >= 400) return best;
  }
  return best;
}

const CANDIDATE_TAGS = new Set(['main', 'article', 'section', 'div', 'td']);
const PARAGRAPH_TAGS = new Set(['p', 'li']);
/** A page that would take longer than this to score in full keeps the best block found so far. */
const MAX_SCORED_CHARS = 20_000_000;

/**
 * How a stretch of text comes out once its spaces are collapsed and trimmed: its visible
 * characters and the words they make. Two stretches put together merge a word across the join
 * when neither side has a space there, so the length of any element's collapsed text follows
 * from its children's without building it.
 */
interface TextShape {
  empty: boolean;
  visible: number;
  words: number;
  startsInWord: boolean;
  endsInWord: boolean;
}

const NO_TEXT: TextShape = { empty: true, visible: 0, words: 0, startsInWord: false, endsInWord: false };

function shapeOf(text: string): TextShape {
  if (text.length === 0) return NO_TEXT;
  let visible = 0;
  let words = 0;
  let inWord = false;
  for (let index = 0; index < text.length; index += 1) {
    if (isSpaceCode(text.charCodeAt(index))) inWord = false;
    else {
      visible += 1;
      if (!inWord) words += 1;
      inWord = true;
    }
  }
  return { empty: false, visible, words, startsInWord: !isSpaceCode(text.charCodeAt(0)), endsInWord: inWord };
}

function joined(first: TextShape, second: TextShape): TextShape {
  if (first.empty) return second;
  if (second.empty) return first;
  return {
    empty: false,
    visible: first.visible + second.visible,
    words: first.words + second.words - (first.endsInWord && second.startsInWord ? 1 : 0),
    startsInWord: first.startsInWord,
    endsInWord: second.endsInWord
  };
}

/** The length of `text.replace(/\s+/g, ' ').trim()`. */
const collapsedLength = (shape: TextShape) => shape.visible + Math.max(shape.words - 1, 0);

interface Block {
  element: Element;
  /** Its place in the page, in document order. */
  order: number;
  /** Where its text starts and ends in the page's text. */
  start: number;
  end: number;
  paragraphs: number;
  text: TextShape;
  links: TextShape;
}

const isTag = (node: AnyNode): node is Element => node.type === 'tag' || node.type === 'script' || node.type === 'style';

/**
 * Pipeline step 5: readability-style fallback. Scores blocks by how much prose they hold
 * and how much of it reads like a job posting, and penalizes link-heavy (navigation) blocks.
 *
 * The page is read once, in one pass without recursion: each block's paragraphs, the length of
 * its text and of its links' text add up from its children. Only blocks that could still win are
 * then scored on their actual text, best possible score first. The block chosen, and so the text,
 * is the one scoring every block in page order would choose.
 */
export function extractMainContent($: CheerioAPI): string | null {
  const noise = noiseOf($);
  const pageText: string[] = [];
  let textLength = 0;
  const blocks: Block[] = [];
  let order = 0;

  interface Frame {
    node: AnyNode & { children: AnyNode[] };
    /** Reached through elements only, as a selector query would find it. */
    findable: boolean;
    next: number;
    order: number;
    start: number;
    paragraphs: number;
    text: TextShape;
    links: TextShape;
  }
  const root = $.root()[0] as unknown as Frame['node'];
  const stack: Frame[] = [{ node: root, findable: true, next: 0, order: -1, start: 0, paragraphs: 0, text: NO_TEXT, links: NO_TEXT }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.next < frame.node.children.length) {
      const child = frame.node.children[frame.next];
      frame.next += 1;
      if (child.type === 'text') {
        pageText.push(child.data);
        textLength += child.data.length;
        frame.text = joined(frame.text, shapeOf(child.data));
      } else if (child.type !== 'comment' && 'children' in child && !noise.has(child as Element)) {
        const findable = frame.findable && isTag(child);
        stack.push({ node: child as Frame['node'], findable, next: 0, order: findable ? order++ : -1, start: textLength, paragraphs: 0, text: NO_TEXT, links: NO_TEXT });
      }
      continue;
    }
    stack.pop();
    const parent = stack[stack.length - 1];
    if (!parent) break;
    const element = frame.node as unknown as Element;
    const name = frame.findable ? element.name : '';
    if (CANDIDATE_TAGS.has(name)) {
      blocks.push({ element, order: frame.order, start: frame.start, end: textLength, paragraphs: frame.paragraphs, text: frame.text, links: frame.links });
    }
    parent.paragraphs += frame.paragraphs + (PARAGRAPH_TAGS.has(name) ? 1 : 0);
    parent.text = joined(parent.text, frame.text);
    // A link's own text, then the text of any link inside it: the order a selector query lists them.
    parent.links = joined(parent.links, name === 'a' ? joined(frame.text, frame.links) : frame.links);
  }

  const contenders: Array<{ block: Block; linkDensity: number; bound: number }> = [];
  for (const block of blocks) {
    if (block.paragraphs < 3) continue;
    const length = collapsedLength(block.text);
    if (length < 200) continue;
    const linkDensity = collapsedLength(block.links) / length;
    if (linkDensity > 0.4) continue;
    // The most it can score: as many job signals as count.
    contenders.push({ block, linkDensity, bound: (25 * 40 + block.paragraphs * 5) * (1 - linkDensity) - length / 120 });
  }
  contenders.sort((a, b) => b.bound - a.bound || a.block.order - b.block.order);

  const text = pageText.join('');
  let best: Block | null = null;
  let bestScore = 0;
  let budget = MAX_SCORED_CHARS;
  for (const { block, linkDensity, bound } of contenders) {
    // Scored in page order, the first of equal scores wins: a later one cannot beat it or tie with it.
    if (bound < bestScore) break;
    if (bound === bestScore && (!best || block.order > best.order)) continue;
    budget -= block.end - block.start;
    if (budget < 0) break;
    const prose = text.slice(block.start, block.end).replace(/\s+/g, ' ').trim();
    const jobSignals = (prose.match(JOB_WORDS) ?? []).length;
    if (jobSignals === 0) continue;
    // Rewards dense job prose, and stops an outer wrapper from beating its inner content.
    const score = (Math.min(jobSignals, 25) * 40 + block.paragraphs * 5) * (1 - linkDensity) - prose.length / 120;
    if (score > bestScore || (score === bestScore && best && block.order < best.order)) {
      bestScore = score;
      best = block;
    }
  }
  return best ? containerText($, best.element, best.end - best.start) : null;
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
