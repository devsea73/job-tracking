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
  'pte',
  'pllc',
  'pc',
  'srl',
  'sarl',
  'spa',
  'nv',
  'oy',
  'ab',
  'kk',
  'bhd',
  'sdn',
  'holdings',
  'holding',
  'group',
  // A country after the name is the local office of one employer: "Siemens USA". Not "Us":
  // "Unite Us" is a name of its own.
  'usa',
  'america'
]);

/**
 * "Stripe, Inc.", "STRIPE" and "The Stripe Company" all become "stripe"; "C.H. Robinson" and
 * "C.H.Robinson" become one. Workday prefixes names with cost-center codes ("880 Cigna"),
 * which say nothing about the company and are dropped.
 */
export function normalizeCompany(name: string): string {
  let text = stripDiacritics(name).toLowerCase();
  // "Acme Corp (formerly Widgets)", "ARKANCE USA LLC (USA)": the brackets are about the name, not it.
  text = text.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  // "Smith Holdings dba Acme": the name people know is the one after "doing business as".
  text = text.replace(/^.*\b(?:dba|d\/b\/a|doing business as)\b/, ' ');
  text = text.replace(/^\s*\d{2,}[a-z]?\s+(?=[a-z])/, ' ');
  const words = text
    .replace(/&|\+/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length > 1 && COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop();
  if (words.length > 1 && words[0] === 'the') words.shift();
  return words.join('');
}

const TITLE_ABBREVIATIONS: Record<string, string[]> = {
  sr: ['senior'],
  snr: ['senior'],
  jr: ['junior'],
  engr: ['engineer'],
  eng: ['engineer'],
  dev: ['developer'],
  devs: ['developers'],
  mgr: ['manager'],
  mgmt: ['management'],
  swe: ['software', 'engineer'],
  sde: ['software', 'development', 'engineer'],
  sre: ['site', 'reliability', 'engineer'],
  ml: ['machine', 'learning'],
  ii: ['2'],
  iii: ['3'],
  iv: ['4']
};

/** Words written as one or two: "Full-Stack", "Full Stack" and "Fullstack" are one word. */
const COMPOUNDS: Array<[string, string, string]> = [
  ['back', 'end', 'backend'],
  ['front', 'end', 'frontend'],
  ['full', 'stack', 'fullstack'],
  ['dev', 'ops', 'devops'],
  ['data', 'base', 'database'],
  ['node', 'js', 'node'],
  ['react', 'js', 'react'],
  ['vue', 'js', 'vue'],
  ['next', 'js', 'next']
];

/** Words that describe where or how, not which role. */
const TITLE_NOISE = new Set(['remote', 'hybrid', 'onsite', 'usa', 'us', 'united', 'states', 'the', 'a', 'an']);

/**
 * Words that only say where, on what terms, or for which listing, each on its own as a piece of an
 * aside. Lowercase, as the text is compared lowercased.
 */
const ASIDE_WORDS = [
  'remote', 'hybrid', 'onsite', 'on-site', 'inoffice', 'in-office', 'us', 'usa', 'united states', 'north america', 'anywhere', 'nationwide', 'worldwide',
  'east coast', 'west coast', 'contract', 'contractor', 'contract to hire', 'c2c', 'w2', 'w-2', '1099', 'fulltime', 'full-time', 'full time', 'parttime',
  'part-time', 'part time', 'permanent', 'temporary', 'all levels', 'multiple levels', 'multiple locations', 'company name withheld', 'confidential',
  'urgent hiring', 'urgently hiring', 'hiring now', 'immediate start', 'immediate hire', 'and', 'or'
];

const isLetter = (code: number) => code >= 97 && code <= 122;
const isGenderLetter = (char: string) => char.length === 1 && 'mfwdx|'.includes(char);
const BLANK = /\s/;
/** The same characters as \s in a regular expression. */
const isBlank = (char: string) => char.length === 1 && BLANK.test(char);

/**
 * A part of a title in brackets or after a dash that only says where, on what terms, or for which
 * listing: "(Remote - US)", "- 100% Remote", "(Contract)", "(Company name withheld)", "| New York, NY".
 * Inside the title proper the same words can matter: a "Contract Manager" is a role.
 *
 * True when the whole text is a run of such pieces: the words above, "m/f/d", "City, ST",
 * "US Remote", "Remote - anything", single separators, after an optional "50%" and "fully".
 * It reads the text once, keeping every place a piece can end, so it stays quick however a title
 * is put together. A regular expression for the same thing backtracks: a title with sixteen
 * "Remote"s in it would take minutes.
 */
export function isAside(raw: string): boolean {
  // Only ASCII letters change case, as with a regular expression's i flag; the length stays the same.
  const text = raw.replace(/[A-Z]/g, (char) => char.toLowerCase());
  const n = text.length;
  if (n === 0) return false;
  const code = (index: number) => (index < n ? text.charCodeAt(index) : -1);
  const blankRun = (from: number) => {
    let index = from;
    while (index < n && isBlank(text[index])) index += 1;
    return index;
  };

  // Where the pieces may begin: after "50%" and any spaces, then after "fully " or "100% ".
  const starts = new Set<number>([0]);
  const percent = /^\d+%/.exec(text);
  if (percent) for (let index = percent[0].length, end = blankRun(index); index <= end; index += 1) starts.add(index);
  for (const start of [...starts]) {
    for (const lead of ['fully', '100%']) {
      if (!text.startsWith(lead, start)) continue;
      const after = start + lead.length;
      const end = blankRun(after);
      for (let index = after + 1; index <= end; index += 1) starts.add(index);
    }
  }

  const reached = new Uint8Array(n + 1);
  const reach = (index: number) => {
    reached[index] = 1;
  };
  for (let at = 0; at < n; at += 1) {
    if (!reached[at] && !starts.has(at)) continue;
    for (const word of ASIDE_WORDS) if (text.startsWith(word, at)) reach(at + word.length);
    const char = text[at];
    // A separator on its own.
    if (isBlank(char) || ',/&-'.includes(char)) reach(at + 1);
    // "m/f/d", "m / w / x".
    if (isGenderLetter(char)) {
      let index = at + 1;
      for (let repeat = 0; repeat < 2; repeat += 1) {
        let next = blankRun(index);
        if (text[next] !== '/') break;
        next = blankRun(next + 1);
        if (next >= n || !isGenderLetter(text[next])) break;
        index = next + 1;
        reach(index);
      }
    }
    // "New York, NY": letters, spaces, dots, apostrophes and dashes up to a comma, then two letters.
    let run = at;
    while (run < n && (isLetter(code(run)) || " .'-".includes(text[run]))) run += 1;
    if (run > at && text[run] === ',') {
      const letters = blankRun(run + 1);
      if (isLetter(code(letters)) && isLetter(code(letters + 1))) reach(letters + 2);
    }
    // "US remote": one word, then " remote".
    let word = at;
    while (word < n && isLetter(code(word))) word += 1;
    if (word > at && text.startsWith(' remote', word)) reach(word + 7);
    // "Remote - US, Canada": separators, then letters, spaces and commas; dashes only before any letter.
    if (text.startsWith('remote', at)) {
      const from = at + 6;
      if (from < n && ' ,-'.includes(text[from])) {
        let sawLetter = false;
        for (let end = from + 1; end <= n; end += 1) {
          const last = text[end - 1];
          if (last === '-') {
            if (sawLetter) break;
          } else if (isLetter(code(end - 1))) sawLetter = true;
          else if (last !== ' ' && last !== ',') break;
          if (end - from >= 2 && last !== '-') reach(end);
        }
      }
    }
  }
  return reached[n] === 1;
}

function withoutAsides(title: string): string {
  let text = title.replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (_whole: string, round: string | undefined, square: string | undefined) => (isAside((round ?? square ?? '').trim()) ? ' ' : ` ${round ?? square} `));
  // Trailing segments after a dash or bar, one at a time, from the end.
  for (;;) {
    const match = /^(.*\S)\s+[-–—|:]\s+([^-–—|:]+)$/.exec(text.trim());
    if (!match || !isAside(match[2].trim())) break;
    text = match[1];
  }
  // Requisition codes: "Job-ID 3301", "Req #12345", "R-102938", "(2024-1135)".
  return text
    .replace(/\b(?:job|req(?:uisition)?|posting|position)[\s-]*(?:id|no\.?|number|code)?[\s#:-]*[a-z]*\d[\w-]*/gi, ' ')
    .replace(/(?:^|\s)#?[a-z]{0,3}-?\d{4,}[\w-]*/gi, ' ');
}

export function titleTokens(title: string): string[] {
  const cleaned = stripDiacritics(withoutAsides(title))
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\.net\b/g, ' dotnet ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter(Boolean);
  const expanded: string[] = [];
  words.forEach((word, index) => {
    // "Engineer I" and "Engineer V": the last word is a level, not a letter.
    if ((word === 'i' || word === 'v') && index === words.length - 1 && index > 0) expanded.push(word === 'i' ? '1' : '5');
    else expanded.push(...(TITLE_ABBREVIATIONS[word] ?? [word]));
  });
  const joined: string[] = [];
  for (let i = 0; i < expanded.length; i += 1) {
    const pair = COMPOUNDS.find(([first, second]) => expanded[i] === first && expanded[i + 1] === second);
    if (pair) {
      joined.push(pair[2]);
      i += 1;
    } else joined.push(expanded[i]);
  }
  return joined.filter((word) => !TITLE_NOISE.has(word));
}

const LEVEL_WORDS: Record<string, number> = { intern: 0, internship: 0, junior: 1, associate: 1, entry: 1, mid: 2, intermediate: 2, senior: 3, staff: 4, principal: 5, distinguished: 6, fellow: 6 };

/**
 * The seniority a title names, if any: a word ("Senior") and a number ("II") are separate, as
 * titles use either or both. Different seniorities are different openings, however alike.
 */
export function titleLevel(title: string): { word: number | null; number: number | null } {
  let word: number | null = null;
  let number: number | null = null;
  for (const token of titleTokens(title)) {
    if (token in LEVEL_WORDS) word = Math.max(word ?? 0, LEVEL_WORDS[token]);
    else if (/^[1-5]$/.test(token)) number = Number(token);
  }
  return { word, number };
}

export function levelsConflict(a: string, b: string): boolean {
  const left = titleLevel(a);
  const right = titleLevel(b);
  return (left.word !== null && right.word !== null && left.word !== right.word) || (left.number !== null && right.number !== null && left.number !== right.number);
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

/** Words every posting uses, which say nothing about which job this is. */
const COMMON_WORDS = new Set(
  (
    'the and for with you your our are will that this have from all can has not but they their them who what when where how why was were been being its any more most other some such only own same than too very just into over under about after before between during out off down also each both few may might must shall should would could able across along among around because while within without work working works worked team teams role roles job jobs position positions company experience experienced years year skills skill ability strong knowledge including include includes required requirements preferred qualifications responsibilities responsible opportunity opportunities candidate candidates employee employees benefits benefit equal employment apply application applicants please join help make use using used need needs new one two three etc per well like based ensure provide providing support supporting develop developing development build building design designing maintain maintaining manage managing lead leading collaborate collaborating business technical technology technologies solutions systems system services service environment understanding excellent good great best high level time part full looking seeking ideal success successful'
  ).split(' ')
);

/** The words that make a posting about this job and not any other. */
export function distinctiveWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const word of descriptionWords(text)) {
    if (word.length >= 3 && !COMMON_WORDS.has(word) && !/^\d+$/.test(word)) words.add(word);
  }
  return words;
}

/**
 * How much of the shorter text's vocabulary appears in the longer one. A listing site rewrites a
 * posting's sentences, which defeats phrase comparison, but it keeps talking about the same things.
 */
export function vocabularyOverlap(a: string, b: string): number {
  const left = distinctiveWords(a);
  const right = distinctiveWords(b);
  if (left.size < 15 || right.size < 15) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const word of small) if (large.has(word)) shared += 1;
  return shared / small.size;
}

/**
 * A small sample of a text's phrases: always the same ones for the same text, and two texts share
 * samples in proportion to how much of their wording they share. Comparing these in an index finds
 * reposted text among thousands of postings without comparing against each one.
 */
export function textSketch(text: string, size = 8): string[] {
  const words = descriptionWords(text);
  if (words.length < 20) return [];
  const hashes = new Set<number>();
  for (let i = 0; i <= words.length - 4; i += 1) {
    let hash = 0x811c9dc5;
    for (let w = i; w < i + 4; w += 1) {
      const word = words[w];
      for (let c = 0; c < word.length; c += 1) hash = Math.imul(hash ^ word.charCodeAt(c), 0x01000193);
      hash = Math.imul(hash ^ 32, 0x01000193);
    }
    hashes.add(hash >>> 0);
  }
  return [...hashes]
    .sort((a, b) => a - b)
    .slice(0, size)
    .map((hash) => hash.toString(16));
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
