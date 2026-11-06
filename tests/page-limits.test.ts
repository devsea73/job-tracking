import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { isAside, titleTokens } from '../src/server/dedupe/text-normalize';
import { extractKnownContainers, extractMainContent } from '../src/server/extraction/html';
import { extractJsonLd } from '../src/server/extraction/jsonld';
import { boundMarkup, isSpaceCode, loadPage, MAX_MARKUP_CHARS, MAX_NESTING } from '../src/server/extraction/markup';
import { extractJob } from '../src/server/extraction/pipeline';
import { bulletsToDashes, htmlToText, looksLikeHtml, tidyText } from '../src/server/extraction/text';
import { createTestServer, createUsers, FakeHttp } from './helpers';

/*
 * A page is untrusted input up to 8 MB. These check that no page can make reading it take long,
 * or overflow the stack, and that ordinary pages read exactly as they did: each rewritten piece is
 * compared with a copy of how it worked before, on many generated pages and titles.
 */

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)];

const elapsed = (run: () => unknown): number => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

// ---- How things worked before, for comparison ----------------------------------------------

const ORIGINAL_ASIDE =
  /^(?:\d+%\s*)?(?:(?:fully|100%)\s+)?(?:remote|hybrid|on-?site|in-?office|usa?|united states|north america|anywhere|nationwide|worldwide|east coast|west coast|contract(?:or)?|contract to hire|c2c|w-?2|1099|full[- ]?time|part[- ]?time|permanent|temporary|all levels|multiple (?:levels|locations)|company name withheld|confidential|urgent(?:ly)? hiring|hiring now|immediate (?:start|hire)|[m|f|w|d|x](?:\s*\/\s*[m|f|w|d|x]){1,2}|[a-z .'-]+,\s*[a-z]{2}|[a-z]+ remote|remote[ ,-]+[a-z ,]+|[\s,/&-]|and|or)+$/i;

function originalTidyText(text: string): string {
  return text
    .replace(/ /g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+(?!- )(?=\S)/g, (match) => (/\n {2,}- /.test(match) ? match : '\n'))
    .replace(/(\S)[ \t]{2,}/g, '$1 ')
    .replace(/^\s*[•·▪◦‣]\s*/gm, '- ')
    .replace(/\n(?:- *\n)+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ORIGINAL_HTML_TAG = /<\/?(?:p|div|span|ul|ol|li|br|strong|em|b|i|u|h[1-6]|table|thead|tbody|tr|td|th|a|section|article|header|footer|blockquote|pre|code|font|hr)\b[^>]*>/i;
const ENCODED_TAG = /&lt;\/?[a-z][a-z0-9]*\b[^&]{0,200}?&gt;/i;
const originalLooksLikeHtml = (text: string) => ORIGINAL_HTML_TAG.test(text) || ENCODED_TAG.test(text);

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'blockquote', 'pre', 'table', 'tr', 'ul', 'ol', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'form', 'button', 'input', 'select', 'textarea', 'nav', 'img', 'video', 'audio']);

function originalHtmlToText(html: string, depth = 0): string {
  const source = ENCODED_TAG.test(html) ? cheerio.load(`<x>${html.replace(/</g, '&lt;')}</x>`, null, false)('x').text() : html;
  const $ = cheerio.load(source, null, false);
  const out: string[] = [];
  const walk = (node: unknown, listDepth: number): void => {
    const element = node as { type: string; data?: string; name?: string; children?: unknown[] };
    const children = element.children ?? [];
    if (element.type === 'text') {
      out.push((element.data ?? '').replace(/\s+/g, ' '));
      return;
    }
    if (element.type !== 'tag' && element.type !== 'root') return;
    const tag = element.name?.toLowerCase();
    if (tag && SKIP_TAGS.has(tag)) return;
    if (tag === 'br') {
      out.push('\n');
      return;
    }
    if (tag === 'li') {
      out.push(`\n${'  '.repeat(Math.max(0, listDepth - 1))}- `);
      for (const child of children) walk(child, listDepth);
      out.push('\n');
      return;
    }
    if (tag === 'td' || tag === 'th') {
      for (const child of children) walk(child, listDepth);
      out.push(' ');
      return;
    }
    const isBlock = tag !== undefined && BLOCK_TAGS.has(tag);
    if (isBlock) out.push('\n\n');
    const nextDepth = tag === 'ul' || tag === 'ol' ? listDepth + 1 : listDepth;
    for (const child of children) walk(child, nextDepth);
    if (isBlock) out.push('\n\n');
  };
  for (const node of $.root().contents().toArray()) walk(node, 0);
  const text = originalTidyText(out.join(''));
  return depth < 2 && originalLooksLikeHtml(text) ? originalHtmlToText(text, depth + 1) : text;
}

const NOISE = [
  'script', 'style', 'noscript', 'template', 'iframe', 'svg', 'nav', 'header', 'footer', 'aside', 'form', 'button', '[role="navigation"]', '[role="banner"]',
  '[role="contentinfo"]', '[role="dialog"]', '[aria-hidden="true"]', '[hidden]', '.cookie', '.cookies', '#cookie', '[id*="cookie" i]', '[class*="cookie" i]',
  '[id*="onetrust" i]', '[class*="consent" i]', '[data-automation-id="skipToMainContent"]', '.nav', '.navbar', '.menu', '.sidebar', '.footer', '.header',
  '.breadcrumb', '.breadcrumbs', '.social', '.share', '.related', '.similar', '.ad', '.ads', '.advert', '.advertisement'
].join(',');
const CONTENT_SELECTORS = [
  '[itemprop="description"]', '[data-automation-id="jobPostingDescription"]', '#job-description', '#jobDescription', '#jobdescription', '#job_description',
  '.job-description', '.jobDescription', '.job_description', '.jobdescription', '.job-details', '.jobDetails', '.job-detail', '.posting-description',
  '.description__text', '.show-more-less-html__markup', '#content .content', '.job-post', '.job__description', '.opening-description', '.ats-description',
  '.iCIMS_JobContent', '.iCIMS_InfoMsg_Job', '.jv-job-detail-description', '.gem-job-description', '[class*="JobDescription"]', '[class*="job-description"]',
  '[class*="jobDescription"]', '[id*="job-description"]', '[id*="jobDescription"]'
];
const JOB_WORDS = /\b(responsibilit|requirement|qualification|experience|skills|you will|you'll|what you|about the role|about the job|the role|benefits|salary|compensation|equal opportunity|we are looking)/gi;

function originalMainContent($: CheerioAPI): string | null {
  const doc = $.root().clone();
  doc.find(NOISE).remove();
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
    const score = (Math.min(jobSignals, 25) * 40 + paragraphs * 5) * (1 - linkDensity) - text.length / 120;
    if (score > bestScore) {
      bestScore = score;
      bestText = htmlToText(node.html() ?? '');
    }
  });
  return bestText;
}

function originalContainers($: CheerioAPI): string | null {
  let best: string | null = null;
  for (const selector of CONTENT_SELECTORS) {
    $(selector).each((_, element) => {
      const clone = $(element).clone();
      clone.find(NOISE).remove();
      const text = htmlToText(clone.html() ?? '');
      if (text.length > (best?.length ?? 0)) best = text;
    });
    if (best && (best as string).length >= 400) return best;
  }
  return best;
}

// ---- Generated pages -----------------------------------------------------------------------

const WORDS = ['You will build', 'requirements', 'Responsibilities:', 'experience', 'skills', 'benefits', 'salary', 'the role', 'about the job', "you'll", 'we are looking', 'equal opportunity', 'team', 'lorem ipsum dolor', 'sit amet', 'Apply now', '•', '· item', '&amp;', '&lt;b&gt;', '&lt;3', 'x &gt; y', 'Remote', 'qualifications', 'compensation'];
const SEPARATORS = [' ', ' ', ' ', '', '\n  ', ' ', '\t', '  '];
const ATTRIBUTES = ['', '', '', ' class="job-description"', ' class="menu"', ' class="cookie-banner"', ' id="jobDescription"', ' aria-hidden="true"', ' hidden', ' class="description__text"', ' itemprop="description"', ' class="content"', ' id="content"', ' class="row"', ' class="JobDescription-body"', ' class="job-details"'];
const TAGS = ['div', 'div', 'div', 'section', 'article', 'main', 'table', 'p', 'p', 'ul', 'ol', 'li', 'a', 'a', 'span', 'b', 'br', 'h2', 'nav', 'header', 'footer', 'aside', 'script', 'style', 'button', 'img', 'blockquote', 'strong', 'pre', 'dl'];

function prose(random: () => number): string {
  const count = 1 + Math.floor(random() * 12);
  let text = '';
  for (let index = 0; index < count; index += 1) text += pick(random, WORDS) + pick(random, SEPARATORS);
  return text;
}

function markup(random: () => number, depth: number): string {
  if (depth > 6 || random() < 0.25) return prose(random);
  const tag = pick(random, TAGS);
  const attributes = pick(random, ATTRIBUTES);
  const children = () => {
    let inner = '';
    const count = Math.floor(random() * 5);
    for (let index = 0; index < count; index += 1) inner += markup(random, depth + 1) + pick(random, ['', '\n', ' ']);
    return inner;
  };
  if (tag === 'br' || tag === 'img') return `<${tag}${attributes}>`;
  if (tag === 'table') return `<table${attributes}><tr><td>${children()}</td><td>${children()}</td></tr><tr><th>${prose(random)}</th></tr></table>`;
  if (tag === 'dl') return `<dl><dt>${prose(random)}</dt><dd>${children()}</dd></dl>`;
  if (tag === 'script' || tag === 'style') return `<${tag}>var x = "${prose(random)}";</${tag}>`;
  return `<${tag}${attributes}>${children()}</${tag}>`;
}

function page(random: () => number): string {
  let body = '';
  const count = 1 + Math.floor(random() * 6);
  for (let index = 0; index < count; index += 1) body += markup(random, 0);
  return `<html><head><title>${prose(random)}</title></head><body>${body}</body></html>`;
}

// ---- Titles --------------------------------------------------------------------------------

describe('title asides', () => {
  const PIECES = ['Remote', 'remote', 'REMOTE', 'US', 'USA', 'us', 'United States', 'united  states', ' ', ',', ', ', ' - ', '-', '/', '&', 'and', 'or', 'Hybrid', 'On-site', 'onsite', 'In office', 'Contract', 'Contractor', 'contract to hire', 'Full-time', 'Part time', 'fulltime', 'm/f/d', 'M / W / D', 'm/f', 'x', 'w', '|', 'New York, NY', 'San Francisco, CA', 'Austin,tx', "O'Fallon, MO", 'St. Louis, MO', 'Winston-Salem, NC', '100%', '50% ', '100% ', 'fully ', 'Fully ', 'Engineer', 'Senior', 'II', 'W2', 'w-2', 'C2C', '1099', 'Urgently Hiring', 'urgent hiring', 'Immediate Start', 'all levels', 'Multiple Locations', 'company name withheld', 'Confidential', 'Nationwide', 'East Coast', 'US remote', 'Remote - US, Canada', 'remote,', 'remote--x', 'remote -us', '.', '\t', ' ', 'ü', 'İ', '(', 'Anywhere', 'Permanent', 'temporary', 'hiring now'];

  it('reads every title exactly as the regular expression did', () => {
    const random = seeded(7);
    for (let round = 0; round < 6000; round += 1) {
      let text = '';
      const count = 1 + Math.floor(random() * 6);
      for (let index = 0; index < count; index += 1) text += pick(random, PIECES);
      const trimmed = text.trim();
      expect(isAside(trimmed), JSON.stringify(trimmed)).toBe(ORIGINAL_ASIDE.test(trimmed));
    }
  });

  it('agrees on the asides people write', () => {
    for (const text of ['Remote - US', '100% Remote', 'Contract', 'Company name withheld', 'New York, NY', 'm/f/d', 'Remote, United States', 'Hybrid / On-site', 'Senior', 'Data Engineer', 'remote first', 'US-Remote', '']) {
      expect(isAside(text), text).toBe(ORIGINAL_ASIDE.test(text));
    }
  });

  it('stays quick however many places a title names', () => {
    // Sixteen "Remote"s took minutes to reject before.
    for (const separator of [' ', ', ', ' - ', ' / ']) {
      const title = `Engineer (${Array(16).fill('Remote').join(separator)}!)`;
      expect(elapsed(() => titleTokens(title)), separator).toBeLessThan(500);
      expect(elapsed(() => titleTokens(`Engineer - ${Array(60).fill('Remote, US').join(separator)} x1`))).toBeLessThan(500);
    }
    expect(titleTokens(`Engineer (${Array(16).fill('Remote').join(', ')})`)).toEqual(['engineer']);
  });
});

// ---- Text cleanup ----------------------------------------------------------------------------

describe('text cleanup', () => {
  const PIECES = [' ', '  ', '\t', '\n', '\n\n\n', '\r', '\r\n', ' ', ' ', '​', '　', '•', '·', '▪', '◦', '‣', '- ', '-', 'a', 'word', 'b c', '  - x', '\n  - y'];

  it('tidies text exactly as before', () => {
    const random = seeded(11);
    for (let round = 0; round < 6000; round += 1) {
      let text = '';
      const count = 1 + Math.floor(random() * 10);
      for (let index = 0; index < count; index += 1) text += pick(random, PIECES);
      expect(tidyText(text), JSON.stringify(text)).toBe(originalTidyText(text));
      expect(bulletsToDashes(text), JSON.stringify(text)).toBe(text.replace(/^\s*[•·▪◦‣]\s*/gm, '- '));
    }
  });

  it('tidies long stretches of spaces and blank lines quickly', () => {
    // Each took seconds at this size before, and grew with the square of it.
    expect(elapsed(() => tidyText(`a${' '.repeat(200_000)}b`))).toBeLessThan(500);
    expect(elapsed(() => tidyText(`• x${'\n'.repeat(200_000)}y`))).toBeLessThan(500);
    expect(elapsed(() => tidyText(`a${' \n'.repeat(100_000)}• b`))).toBeLessThan(500);
    expect(tidyText(`• x${'\n'.repeat(1_000)}• y`)).toBe('- x\n- y');
  });

  it('spots markup in text exactly as before, and quickly', () => {
    const PARTS = ['<p', '<p>', '</div>', '>', '<pre', '<pa>', 'a', ' ', '&lt;b&gt;', '<b class="x">', '<', 'text', '</', '<br/>', '<h7>', '&lt;', '&gt;'];
    const random = seeded(13);
    for (let round = 0; round < 4000; round += 1) {
      let text = '';
      const count = 1 + Math.floor(random() * 6);
      for (let index = 0; index < count; index += 1) text += pick(random, PARTS);
      expect(looksLikeHtml(text), JSON.stringify(text)).toBe(originalLooksLikeHtml(text));
    }
    expect(elapsed(() => looksLikeHtml(`${'<p '.repeat(200_000)}`))).toBeLessThan(500);
  });

  it('treats as spaces exactly what a regular expression does', () => {
    for (let code = 0; code <= 0xffff; code += 1) {
      expect(isSpaceCode(code), code.toString(16)).toBe(/\s/.test(String.fromCharCode(code)));
    }
  });
});

// ---- Markup to text ----------------------------------------------------------------------------

describe('markup to text', () => {
  it('reads generated markup exactly as before', () => {
    const random = seeded(17);
    for (let round = 0; round < 400; round += 1) {
      const html = markup(random, 0) + markup(random, 0);
      expect(htmlToText(html), html).toBe(originalHtmlToText(html));
    }
  });

  it('reads markup nested any depth without overflowing the stack', () => {
    // Inline tags nest without the parser slowing down, so only the reading itself is put to the test.
    const deep = `${'<span>'.repeat(60_000)}Senior Engineer${'</span>'.repeat(60_000)}`;
    expect(() => originalHtmlToText(deep)).toThrow(RangeError);
    expect(htmlToText(deep)).toBe('Senior Engineer');
    expect(htmlToText(`${'<div>'.repeat(200_000)}Senior Engineer`)).toBe('Senior Engineer');
  });
});

// ---- The page as parsed --------------------------------------------------------------------------

describe('bounded markup', () => {
  it('leaves ordinary pages exactly as they are', () => {
    const random = seeded(19);
    for (let round = 0; round < 300; round += 1) {
      const html = page(random);
      expect(boundMarkup(html)).toBe(html);
    }
  });

  it('drops tags nested past the limit, keeping their text', () => {
    const html = `<html><body>${'<div>'.repeat(5_000)}<p>Requirements and experience</p>${'</div>'.repeat(5_000)}<p>after</p></body></html>`;
    const bounded = boundMarkup(html);
    expect(bounded.length).toBeLessThan(html.length);
    expect((bounded.match(/<div>/g) ?? []).length).toBe(MAX_NESTING);
    const $ = cheerio.load(bounded);
    expect($('body').text()).toBe('Requirements and experienceafter');
    expect($('body > p').text()).toBe('after');
  });

  it('reads a very large page only so far, but keeps its structured data, title and metadata', () => {
    const jsonLd = '<script type="application/ld+json">{"@type":"JobPosting","title":"Data Engineer"}</script>';
    const filler = `<div class="row"><p>${'lorem ipsum '.repeat(20)}</p></div>`.repeat(30_000);
    const html = `<html><head><title>Data Engineer at Acme</title><meta property="og:site_name" content="Acme"><style>${'.x{}'.repeat(50_000)}</style><script>${'var a=1;'.repeat(50_000)}</script></head><body><h1>Data Engineer</h1>${filler}<meta name="description" content="late"><svg>${'<path d="M0"/>'.repeat(1000)}</svg>${jsonLd}<!-- ${'x'.repeat(1000)} --></body></html>`;
    expect(html.length).toBeGreaterThan(5 * MAX_MARKUP_CHARS);
    const bounded = boundMarkup(html);
    expect(bounded.length).toBeLessThan(MAX_MARKUP_CHARS + 2_000);
    expect(bounded).toContain(jsonLd);
    expect(bounded).toContain('<meta name="description" content="late">');
    expect(bounded).not.toContain('<style>');
    expect(bounded).not.toContain('var a=1;');
    expect(bounded).not.toContain('<svg>');
    const $ = cheerio.load(bounded);
    expect($('title').text()).toBe('Data Engineer at Acme');
    expect($('h1').text()).toBe('Data Engineer');
    expect(extractJsonLd($)?.title).toBe('Data Engineer');
  });

  it('chooses the same main content and the same container as before on generated pages', { timeout: 90_000 }, () => {
    let mainFound = 0;
    let containerFound = 0;
    for (const seed of [23, 29, 31]) {
      const random = seeded(seed);
      for (let round = 0; round < 250; round += 1) {
        const html = page(random);
        const $ = cheerio.load(html);
        const main = originalMainContent($);
        const container = originalContainers($);
        expect(extractMainContent($), html).toBe(main);
        expect(extractKnownContainers($), html).toBe(container);
        if (main) mainFound += 1;
        if (container) containerFound += 1;
      }
    }
    // The pages are varied enough that many do have something to find.
    expect(mainFound).toBeGreaterThan(30);
    expect(containerFound).toBeGreaterThan(100);
  });

  it('still reads a container that sits inside noise inside another container', () => {
    const inner = `<header itemprop="description"><p>${'Requirements: five years of experience with SQL. '.repeat(12)}</p></header>`;
    const $ = cheerio.load(`<html><body><h2 itemprop="description">Data Engineer<aside>${inner}</aside></h2></body></html>`);
    expect(extractKnownContainers($)).toBe(originalContainers($));
    expect(extractKnownContainers($)).toContain('Requirements: five years');
  });

  it('reads a page nested tens of thousands deep, where it overflowed the stack before', async () => {
    const posting = '<p>You will build services. Requirements: five years of experience with skills in TypeScript. Benefits and salary are listed below for the role.</p>'.repeat(4);
    for (const depth of [3_000, 30_000, 300_000]) {
      const html = `<html><head><title>Data Engineer at Acme</title></head><body>${'<div>'.repeat(depth)}${posting}${'</div>'.repeat(depth)}</body></html>`;
      if (depth === 3_000) expect(() => originalMainContent(cheerio.load(html))).toThrow(RangeError);
      const http = new FakeHttp().serve('https://jobs.example.com/1', html);
      const started = performance.now();
      const result = await extractJob('https://jobs.example.com/1', { http, renderer: null });
      expect(performance.now() - started, `depth ${depth}`).toBeLessThan(5_000);
      expect(result.ok, `depth ${depth}`).toBe(true);
      if (result.ok) {
        expect(result.title).toBe('Data Engineer');
        expect(result.description).toContain('Requirements: five years of experience');
      }
    }
  });

  it('reads a 7 MB page in a fraction of the time it took', async () => {
    const block = '<div class="row"><div class="cell"><p>You will build services. Requirements: five years of experience with skills in TypeScript.</p><p>Benefits and salary are listed below for the role.</p><a href="/jobs/1">Related job</a></div></div>';
    const html = `<html><head><title>Data Engineer at Acme</title></head><body><main>${block.repeat(Math.ceil((7 * 1024 * 1024) / block.length))}</main></body></html>`;
    const http = new FakeHttp().serve('https://jobs.example.com/1', html);
    const started = performance.now();
    const result = await extractJob('https://jobs.example.com/1', { http, renderer: null });
    // About 11 seconds before, about half a second now.
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(result.ok).toBe(true);
  });

  it('loads a deep page with its depth bounded for every step after', () => {
    const $ = loadPage(`<html><body>${'<section><div><table><tr><td>'.repeat(2_000)}Engineer</body></html>`);
    let deepest = 0;
    const stack: Array<{ node: { children?: unknown[] }; depth: number }> = [{ node: $.root()[0] as never, depth: 0 }];
    while (stack.length > 0) {
      const { node, depth } = stack.pop() as (typeof stack)[number];
      deepest = Math.max(deepest, depth);
      for (const child of node.children ?? []) stack.push({ node: child as never, depth: depth + 1 });
    }
    expect(deepest).toBeLessThanOrEqual(502);
    expect($('body').text()).toContain('Engineer');
  });
});

// ---- Structured data ---------------------------------------------------------------------------

describe('structured data with odd values', () => {
  const description = `<p>${'You will build data pipelines. Requirements: five years of experience with SQL. '.repeat(8)}</p>`;
  const posting = (fields: Record<string, unknown>) =>
    `<html><head><title>Job</title><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', description, ...fields })}</script></head><body></body></html>`;

  it('reads a posting whose fields are lists, numbers or objects, where it failed with an error before', async () => {
    const html = posting({
      title: ['Data Engineer'],
      hiringOrganization: { name: ['Acme Corp'] },
      jobLocationType: ['TELECOMMUTE'],
      workplaceType: { toString: 'x' },
      employmentType: [{ toString: 'x' }, 'FULL_TIME'],
      datePosted: { toString: 'boom' },
      baseSalary: { currency: ['USD'], value: { minValue: '120000', maxValue: 150000, unitText: ['YEAR'] } },
      identifier: [{ value: 42 }],
      jobLocation: [{ address: { addressLocality: { toString: 'boom' }, addressRegion: ['TX'], addressCountry: 7 } }, [[['deep']]]],
      applicantLocationRequirements: { name: { '@value': 'USA' } }
    });
    const http = new FakeHttp().serve('https://jobs.example.com/1', html);
    const result = await extractJob('https://jobs.example.com/1', { http, renderer: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.title).toBe('Data Engineer');
    expect(result.company).toBe('Acme Corp');
    expect(result.location).toBe('Remote; TX, 7');
    expect(result.requisitionId).toBe('42');
    expect(result.facts).toMatchObject({ workArrangement: 'remote', employmentType: 'permanent', salaryMin: 120000, salaryMax: 150000, salaryCurrency: 'USD', salaryPeriod: 'year', postedAt: null });
  });

  it('never fails on any field holding any kind of value', async () => {
    const values: unknown[] = [null, true, 0, -1, 1e21, '', 'text', [], [null], [[]], {}, { toString: 'x' }, { valueOf: 1, toString: 2 }, { name: { name: { name: 'x' } } }, [{ '@value': 5 }], ['a', { b: 1 }]];
    const fields = ['title', 'name', 'hiringOrganization', 'description', 'jobLocation', 'jobLocationType', 'workplaceType', 'employmentType', 'datePosted', 'baseSalary', 'salaryCurrency', 'identifier', 'applicantLocationRequirements'];
    for (const field of fields) {
      for (const value of values) {
        const $ = cheerio.load(posting({ title: 'Data Engineer', hiringOrganization: 'Acme', [field]: value }));
        expect(() => extractJsonLd($), `${field}: ${JSON.stringify(value)}`).not.toThrow();
        const http = new FakeHttp().serve('https://jobs.example.com/1', posting({ title: 'Data Engineer', hiringOrganization: 'Acme', [field]: value }));
        await expect(extractJob('https://jobs.example.com/1', { http, renderer: null }), `${field}: ${JSON.stringify(value)}`).resolves.toBeTruthy();
      }
    }
  });

  it('saves such a posting through the API instead of answering with a server error', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler');
    http.serve('https://jobs.example.com/odd', posting({ title: { '@value': 'Data Engineer' }, hiringOrganization: [{ name: 'Acme' }], jobLocationType: ['TELECOMMUTE'], employmentType: [{ code: 1 }] }));
    const response = await users.tyler.post('/api/applications', { url: 'https://jobs.example.com/odd', profileId: await users.tyler.defaultProfileId() });
    expect(response.status).toBe(200);
    expect(response.json.outcome).toBe('created');
    expect(ctx.db.$client.prepare('SELECT title, company_name FROM jobs WHERE id = ?').get(response.json.jobId)).toEqual({ title: 'Data Engineer', company_name: 'Acme' });
  });
});
