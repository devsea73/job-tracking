import type { CheerioAPI } from 'cheerio';
import type { JobHints } from '../dedupe/job-facts';
import { cleanInline, htmlToText } from './text';
import type { PartialJob } from './types';

type Json = Record<string, unknown>;

function isJobPosting(node: Json): boolean {
  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  return types.some((value) => typeof value === 'string' && /(^|[/#:])JobPosting$/i.test(value));
}

function collectJobPostings(node: unknown, found: Json[], depth = 0): void {
  if (depth > 8 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectJobPostings(item, found, depth + 1);
    return;
  }
  const object = node as Json;
  if (isJobPosting(object)) found.push(object);
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    if (key in object) collectJobPostings(object[key], found, depth + 1);
  }
}

/** Sites often emit almost-JSON: raw newlines in strings, or trailing semicolons. */
function parseLenient(raw: string): unknown {
  const text = raw
    .trim()
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .replace(/;\s*$/, '');
  try {
    return JSON.parse(text);
  } catch {
    try {
      // eslint-disable-next-line no-control-regex
      return JSON.parse(text.replace(/[\u0000-\u001f]+/g, ' '));
    } catch {
      return null;
    }
  }
}

/*
 * Structured data is written by the site, and any field can hold any JSON: a list where one value
 * is expected, a number, an object, or an object whose "toString" is a string, which makes String()
 * itself throw. Every field is read through the helpers below, which only ever return a string, a
 * number or nothing, so an odd field is left out and the rest of the posting is still read.
 */

const isObject = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A value as text: a string, or a number written out, or the first one found in a list or in an object's "@value" or "name". */
function textOf(value: unknown, depth = 0): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = textOf(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (isObject(value)) return textOf(value['@value'], depth + 1) ?? textOf(value.name, depth + 1);
  return null;
}

/** Every text in a value that may be a list: "FULL_TIME", or ["FULL_TIME", "CONTRACTOR"]. */
function textsOf(value: unknown): string[] {
  return (Array.isArray(value) ? value.slice(0, 20) : [value]).map((item) => textOf(item)).filter((item): item is string => !!item);
}

const inline = (value: unknown) => cleanInline(textOf(value));

function formatPlace(place: unknown, depth = 0): string | null {
  if (!place || depth > 3) return null;
  if (typeof place === 'string') return cleanInline(place);
  if (Array.isArray(place)) {
    const parts = [...new Set(place.slice(0, 20).map((item) => formatPlace(item, depth + 1)).filter((part): part is string => !!part))];
    return parts.length ? parts.slice(0, 4).join('; ') : null;
  }
  if (!isObject(place)) return null;
  const address = place.address ?? place;
  if (typeof address === 'string') return cleanInline(address);
  if (!isObject(address)) return inline(place.name);
  const fields = ['addressLocality', 'addressRegion', 'addressCountry'].map((key) => inline(address[key]));
  const parts = fields.filter((part): part is string => !!part);
  return parts.length ? parts.join(', ') : inline(place.name);
}

function organizationName(org: unknown): string | null {
  if (!org) return null;
  if (typeof org === 'string') return cleanInline(org);
  if (Array.isArray(org)) return organizationName(org[0]);
  return isObject(org) ? inline(org.name) : null;
}

function postingLocation(posting: Json): string | null {
  const location = formatPlace(posting.jobLocation);
  const remote = textsOf(posting.jobLocationType).some((type) => type.trim().toUpperCase() === 'TELECOMMUTE');
  if (remote) {
    const region = formatPlace(posting.applicantLocationRequirements);
    return location ? `Remote; ${location}` : region ? `Remote; ${region}` : 'Remote';
  }
  return location;
}

/** An amount: a number, or the digits in a text such as "$120,000". */
function amount(raw: unknown): number | null {
  const parsed = typeof raw === 'string' ? Number(raw.replace(/[^\d.]/g, '')) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** schema.org's baseSalary, in the several shapes sites use for it. */
function salaryHint(posting: Json): JobHints['salary'] {
  const base = Array.isArray(posting.baseSalary) ? posting.baseSalary[0] : posting.baseSalary;
  if (base === undefined || base === null) return null;
  if (!isObject(base)) {
    if (typeof base !== 'string' && typeof base !== 'number') return null;
    const value = typeof base === 'number' ? base : Number(base) || null;
    return { min: amount(value), max: amount(value), currency: textOf(posting.salaryCurrency) };
  }
  const value = base.value;
  const nested = isObject(value) ? value : null;
  const single = nested ? nested.value : value;
  return {
    min: amount(nested?.minValue ?? base.minValue ?? single),
    max: amount(nested?.maxValue ?? base.maxValue ?? single),
    currency: textOf(base.currency ?? posting.salaryCurrency),
    period: textOf(nested?.unitText ?? base.unitText)
  };
}

function requisitionOf(identifier: unknown): string | null {
  if (typeof identifier === 'string') return identifier;
  const first = Array.isArray(identifier) ? identifier.find(isObject) : identifier;
  if (!isObject(first)) return null;
  const value = first.value;
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : null;
}

function toPartial(posting: Json): PartialJob {
  const description = textOf(posting.description);
  const datePosted = posting.datePosted;
  const employment = textsOf(posting.employmentType);
  const arrangement = textsOf(posting.jobLocationType ?? posting.workplaceType);
  return {
    title: inline(posting.title) ?? inline(posting.name),
    company: organizationName(posting.hiringOrganization),
    description: (description && htmlToText(description)) || null,
    location: postingLocation(posting),
    requisitionId: requisitionOf(posting.identifier),
    hints: {
      // A number is a time stamp, read as one.
      postedAt: typeof datePosted === 'number' ? datePosted : textOf(datePosted),
      salary: salaryHint(posting),
      employmentType: employment.length ? employment.join(' ') : null,
      workArrangement: arrangement.length ? arrangement.join(' ') : null
    }
  };
}

/** Pipeline step 1: schema.org/JobPosting structured data. */
export function extractJsonLd($: CheerioAPI): PartialJob | null {
  const postings: Json[] = [];
  $('script[type="application/ld+json"]').each((_, element) => {
    const parsed = parseLenient($(element).text());
    if (parsed) collectJobPostings(parsed, postings);
  });
  if (postings.length === 0) return null;
  // Listing pages hold many postings; only a page with one posting describes one job.
  if (postings.length > 3) return null;
  const partials = postings
    .map((posting) => {
      try {
        return toPartial(posting);
      } catch {
        // Whatever else is odd about it, one posting's data never stops the page from being read.
        return null;
      }
    })
    .filter((partial): partial is PartialJob => partial !== null);
  return partials.sort((a, b) => (b.description?.length ?? 0) - (a.description?.length ?? 0))[0] ?? null;
}
