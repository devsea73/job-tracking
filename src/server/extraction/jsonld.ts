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

function formatPlace(place: unknown): string | null {
  if (!place) return null;
  if (typeof place === 'string') return cleanInline(place);
  if (Array.isArray(place)) {
    const parts = [...new Set(place.map(formatPlace).filter((part): part is string => !!part))];
    return parts.length ? parts.slice(0, 4).join('; ') : null;
  }
  const object = place as Json;
  const address = (object.address ?? object) as Json | string;
  if (typeof address === 'string') return cleanInline(address);
  const fields = ['addressLocality', 'addressRegion', 'addressCountry'].map((key) => {
    const value = address[key];
    if (value && typeof value === 'object') return cleanInline((value as Json).name as string);
    return cleanInline(value as string);
  });
  const parts = fields.filter((part): part is string => !!part);
  return parts.length ? parts.join(', ') : cleanInline(object.name as string);
}

function organizationName(org: unknown): string | null {
  if (!org) return null;
  if (typeof org === 'string') return cleanInline(org);
  if (Array.isArray(org)) return organizationName(org[0]);
  return cleanInline((org as Json).name as string);
}

function postingLocation(posting: Json): string | null {
  const location = formatPlace(posting.jobLocation);
  const remote = String(posting.jobLocationType ?? '').toUpperCase() === 'TELECOMMUTE';
  if (remote) {
    const region = formatPlace(posting.applicantLocationRequirements);
    return location ? `Remote; ${location}` : region ? `Remote; ${region}` : 'Remote';
  }
  return location;
}

/** schema.org's baseSalary, in the several shapes sites use for it. */
function salaryHint(posting: Json): JobHints['salary'] {
  const base = (Array.isArray(posting.baseSalary) ? posting.baseSalary[0] : posting.baseSalary) as Json | number | string | undefined;
  if (base === undefined || base === null) return null;
  if (typeof base !== 'object') return { min: Number(base) || null, max: Number(base) || null, currency: posting.salaryCurrency as string };
  const value = base.value as Json | number | string | undefined;
  const nested = value && typeof value === 'object' ? value : null;
  const single = nested ? (nested.value as unknown) : value;
  const number = (raw: unknown) => {
    const parsed = typeof raw === 'string' ? Number(raw.replace(/[^\d.]/g, '')) : (raw as number);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  return {
    min: number(nested?.minValue ?? base.minValue ?? single),
    max: number(nested?.maxValue ?? base.maxValue ?? single),
    currency: (base.currency ?? posting.salaryCurrency) as string | null,
    period: (nested?.unitText ?? base.unitText) as string | null
  };
}

function toPartial(posting: Json): PartialJob {
  const description = typeof posting.description === 'string' ? htmlToText(posting.description) : null;
  const identifier = posting.identifier;
  let requisition: string | null = null;
  if (typeof identifier === 'string') requisition = identifier;
  else if (identifier && typeof identifier === 'object') {
    const value = (identifier as Json).value;
    if (typeof value === 'string' || typeof value === 'number') requisition = String(value);
  }
  return {
    title: cleanInline((posting.title ?? posting.name) as string),
    company: organizationName(posting.hiringOrganization),
    description: description || null,
    location: postingLocation(posting),
    requisitionId: requisition,
    hints: {
      postedAt: posting.datePosted,
      salary: salaryHint(posting),
      employmentType: (Array.isArray(posting.employmentType) ? posting.employmentType.join(' ') : posting.employmentType) as string | null,
      workArrangement: (posting.jobLocationType ?? posting.workplaceType) as string | null
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
  const best = postings
    .map(toPartial)
    .sort((a, b) => (b.description?.length ?? 0) - (a.description?.length ?? 0))[0];
  return postings.length > 3 ? null : best;
}
