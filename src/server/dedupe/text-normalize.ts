import { createHash } from 'node:crypto';

function stripDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '');
}

const COMPANY_SUFFIXES = new Set([
  'inc',
  'incorporated',
  'llc',
  'llp',
  'lp',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'plc',
  'gmbh',
  'ag',
  'sa',
  'bv',
  'pty',
  'pvt',
  'holdings',
  'holding'
]);

/** "Stripe, Inc." and "STRIPE" both become "stripe". */
export function normalizeCompany(name: string): string {
  const words = stripDiacritics(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b([a-z])\.(?=[a-z]\.)/g, '$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop();
  if (words.length > 1 && words[0] === 'the') words.shift();
  return words.join('');
}

const TITLE_ABBREVIATIONS: Record<string, string> = {
  sr: 'senior',
  snr: 'senior',
  jr: 'junior',
  engr: 'engineer',
  eng: 'engineer',
  dev: 'developer',
  mgr: 'manager',
  mgmt: 'management',
  ii: '2',
  iii: '3',
  iv: '4'
};

/** Words that describe where or how, not which role. */
const TITLE_NOISE = new Set(['remote', 'hybrid', 'onsite', 'usa', 'us', 'united', 'states', 'the', 'a', 'an']);

export function titleTokens(title: string): string[] {
  const cleaned = stripDiacritics(title)
    .toLowerCase()
    .replace(/\((?:[^)]*\b(?:remote|hybrid|onsite|on-site|usa?|united states)\b[^)]*)\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();
  return cleaned
    .split(' ')
    .filter(Boolean)
    .map((word) => TITLE_ABBREVIATIONS[word] ?? word)
    .filter((word) => !TITLE_NOISE.has(word));
}

export function normalizeTitle(title: string): string {
  return titleTokens(title).join(' ');
}

/** Jaccard similarity of title words, 1 for equal titles. */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

export function descriptionWords(description: string): string[] {
  return stripDiacritics(description)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Fingerprint that ignores formatting, so the same text copied between sites hashes equally. */
export function hashDescription(description: string): string | null {
  const words = descriptionWords(description);
  if (words.length < 20) return null;
  return createHash('sha256').update(words.join(' ')).digest('hex');
}

function shingles(words: string[], size = 3): Set<string> {
  const result = new Set<string>();
  if (words.length < size) {
    if (words.length) result.add(words.join(' '));
    return result;
  }
  for (let i = 0; i <= words.length - size; i += 1) {
    result.add(words.slice(i, i + size).join(' '));
  }
  return result;
}

export interface DescriptionSimilarity {
  /** Share of all phrases that both texts contain. */
  jaccard: number;
  /** Share of the shorter text's phrases found in the longer text. Catches excerpts. */
  containment: number;
}

export function descriptionSimilarity(a: string, b: string): DescriptionSimilarity {
  const sa = shingles(descriptionWords(a));
  const sb = shingles(descriptionWords(b));
  if (sa.size === 0 || sb.size === 0) return { jaccard: 0, containment: 0 };
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  let shared = 0;
  for (const shingle of small) if (large.has(shingle)) shared += 1;
  return {
    jaccard: shared / (sa.size + sb.size - shared),
    containment: shared / small.size
  };
}

const REQ_ID_PATTERN =
  /\b(?:req(?:uisition)?(?:\s*(?:id|no\.?|number|#))?|job\s*(?:id|no\.?|number|#|code)|posting\s*(?:id|number)|position\s*(?:id|number|#))\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{2,20})\b/gi;

/** Requisition numbers quoted in the posting text. Different numbers mean different openings. */
export function extractRequisitionIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(REQ_ID_PATTERN)) {
    const id = match[1].toUpperCase();
    if (/\d/.test(id)) ids.add(id);
  }
  return ids;
}

export type LocationComparison = 'match' | 'unknown' | 'conflict';

const LOCATION_STOPWORDS = new Set(['united', 'states', 'usa', 'us', 'of', 'america', 'the', 'in', 'and', 'or']);

function locationTokens(location: string): Set<string> {
  return new Set(
    stripDiacritics(location)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter((token) => token && !LOCATION_STOPWORDS.has(token))
  );
}

export function compareLocations(a: string | null | undefined, b: string | null | undefined): LocationComparison {
  if (!a?.trim() || !b?.trim()) return 'unknown';
  const ta = locationTokens(a);
  const tb = locationTokens(b);
  if (ta.size === 0 || tb.size === 0) return 'unknown';
  for (const token of ta) if (tb.has(token)) return 'match';
  // Multi-location or remote postings are often listed under just one place per site.
  if (ta.has('remote') || tb.has('remote') || ta.has('multiple') || tb.has('multiple')) return 'unknown';
  return 'conflict';
}
