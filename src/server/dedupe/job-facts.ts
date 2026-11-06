import type { EmploymentType, JobFacts, SalaryPeriod, WorkArrangement } from '../../shared/api';

/**
 * Facts about a posting that stay the same wherever it is listed. Sites publish some of them as
 * data, which is read as a hint, and the rest is found in the posting's text. A fact that cannot
 * be established stays unknown: a missing tag is better than a wrong one, and so is a missing
 * salary when two postings are being compared.
 */

export interface SalaryHint {
  min: number | null;
  max: number | null;
  currency?: string | null;
  period?: string | null;
}

/** What a site says about a posting as data rather than prose. */
export interface JobHints {
  postedAt?: unknown;
  salary?: SalaryHint | null;
  /** Free text such as "$100K/yr - $150K/yr". */
  salaryText?: string | null;
  employmentType?: string | null;
  workArrangement?: string | null;
}

export const EMPTY_FACTS: JobFacts = {
  workArrangement: null,
  employmentType: null,
  clearance: null,
  isFederal: false,
  postedAt: null,
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryPeriod: null
};

// ---- Work arrangement ----------------------------------------------------------------------

export function parseWorkArrangement(raw: string | null | undefined): WorkArrangement | null {
  if (!raw) return null;
  const text = raw.toLowerCase();
  if (/\bhybrid\b|\bflexible\b/.test(text)) return 'hybrid';
  if (/\b(remote|telecommute|work from home|wfh|virtual)\b/.test(text)) return 'remote';
  if (/\b(on[- ]?site|in[- ]office|in[- ]person|office[- ]based)\b/.test(text)) return 'onsite';
  return null;
}

const HYBRID_PHRASES =
  /\bhybrid\s+(?:work|role|position|schedule|model|environment|opportunity|arrangement|setup|job|policy)\b|\b(?:is|as)\s+an?\s+hybrid\b|\bhybrid\b[^.\n]{0,40}\b(?:days?|weeks?|office|on[- ]?site)\b|\b\d\s*(?:-\s*\d\s*)?days?\s*(?:a|per|each)\s*week\b[^.\n]{0,30}\b(?:office|on[- ]?site)\b/i;
const REMOTE_PHRASES =
  /\b(?:fully|100%|completely|entirely|permanently)\s+remote\b|\bremote\s+(?:position|role|job|opportunity|first|only|work\s+(?:is|available)|employee)\b|\b(?:is|as)\s+an?\s+(?:fully\s+)?remote\b|\bwork(?:ing)?\s+(?:from\s+home|remotely)\b|\blocation\s*:\s*remote\b/i;
const ONSITE_PHRASES =
  /\b(?:100%|fully|entirely)\s+(?:on[- ]?site|in[- ]office)\b|\b(?:on[- ]?site|in[- ]office|in[- ]person)\s+(?:position|role|job|only|requirement|work)\b|\b(?:is|as)\s+an?\s+(?:on[- ]?site|in[- ]office)\b|\bnot\s+(?:a\s+)?remote\b|\bno\s+remote\b/i;

function arrangementFromProse(description: string): WorkArrangement | null {
  // Said outright, and read in this order because "not remote" must not count as remote.
  if (ONSITE_PHRASES.test(description)) return 'onsite';
  if (HYBRID_PHRASES.test(description)) return 'hybrid';
  if (REMOTE_PHRASES.test(description)) return 'remote';
  return null;
}

// ---- Employment type -----------------------------------------------------------------------

/** Sites' own labels: FULL_TIME, CONTRACTOR, "Contract to hire", "Regular", SALARIED_FT... */
export function parseEmploymentType(raw: string | null | undefined): EmploymentType | null {
  if (!raw) return null;
  const text = raw.toLowerCase().replace(/[_-]+/g, ' ');
  if (/\b(contract|contractor|contingent|temporary|temp|fixed term|freelance|c2c|1099|consultant|hourly ft contractor)\b/.test(text)) return 'contract';
  if (/\b(full time|fulltime|permanent|regular|direct hire|salaried ft|fte|full)\b/.test(text)) return 'permanent';
  return null;
}

const CONTRACT_TITLE = /(?:^|[(\-–—|,:/\s])contract(?:or)?(?:[- ]to[- ](?:hire|perm))?\s*(?:$|[)\-–—|,:/]|role\b|position\b)|\bc2c\b|\bw-?2\b|\b1099\b|\bcorp[- ]to[- ]corp\b|\btemporary\b|\bcontract[- ]to[- ](?:hire|perm)\b/i;
const CONTRACT_PHRASES =
  /\b\d+\+?\s*-?\s*(?:months?|years?)\s+(?:\w+\s+)?(?:contract|engagement)\b|\bcontract\s+(?:position|role|opportunity|assignment|job|duration|length|term)\b|\b(?:employment|job|position)\s*type\s*:?\s*(?:contract|c2c|w-?2|temporary)\b|\bc2c\b|\bcorp[- ]to[- ]corp\b|\bcontract[- ]to[- ](?:hire|perm)\b|\bw-?2\s+(?:contract|only|candidates?|employment)\b|\b(?:this|is)\s+(?:is\s+)?an?\s+contract\b/i;
const PERMANENT_PHRASES =
  /\bpermanent\s+(?:position|role|opportunity|employment|hire|full[- ]time)\b|\bfull[- ]time\s+(?:permanent|position|role|employee|opportunity|job)\b|\bdirect[- ]hire\b|\b(?:employment|job|position)\s*type\s*:?\s*(?:full[- ]time|permanent)\b/i;

// ---- Clearance and federal work ------------------------------------------------------------

/**
 * Equal-opportunity and compliance text mentions federal law, contractors and veterans on
 * postings that have nothing to do with government work, so those sentences are left out.
 */
const BOILERPLATE =
  /equal\s+(?:employment\s+)?opportunity|affirmative\s+action|\beeo\b|e-verify|form\s+i-9|social\s+security\s+administration|registered\s+trademark|disabilit|veteran\s+status|protected\s+(?:class|veteran)|office\s+of\s+federal|federal\s+contract\s+compliance|federal\s+(?:government\s+)?(?:law|contractor|holiday|tax|regulation|minimum|health\s*care|employment|income)|federal,?\s+(?:and\s+|or\s+)?state|state,?\s+(?:and\s+|or\s+)?(?:local,?\s+(?:and\s+|or\s+)?)?federal|applicable\s+(?:law|federal)/i;

function withoutBoilerplate(description: string): string {
  return description
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => !BOILERPLATE.test(sentence))
    .join('\n');
}

const CLEARANCE_LEVELS: Array<[RegExp, string]> = [
  [/\bts\s*\/\s*sci\b|\btop[- ]secret\s*\/\s*sci\b/i, 'TS/SCI'],
  [/\btop[- ]secret\b/i, 'Top Secret'],
  [/\bsecret\b[^.\n]{0,20}\bclearance\b|\b(?:active|current|dod|dow|interim)\s+secret\b|\bclearance\b[^:\n]{0,40}:\s*secret\b/i, 'Secret'],
  [/\bpublic[- ]trust\b/i, 'Public Trust'],
  [/\bsecurity\s+clearance\b|\b(?:active|government|federal|dod|dow|current)\s+clearance\b|\bclearance\s+(?:is\s+)?required\b|\bclearable\b|\bpolygraph\b/i, 'Required']
];

const CLEARANCE_DENIED_BEFORE = /\b(?:no|not|without|doesn'?t|does\s+not|don'?t|do\s+not|isn'?t|is\s+not)\b[^.\n]{0,50}$/i;
// Includes forms that answer "Public Trust/Other Required: None".
const CLEARANCE_DENIED_AFTER = /^[^.\n]{0,30}\b(?:not\s+(?:be\s+)?required|not\s+needed|is\s+not)\b|^[^\n]{0,30}:\s*none\b/i;
const OPTIONAL_WORDING = /\b(?:nice[- ]to[- ]have|preferred|desired|a\s+plus|bonus|optional|ideally)\b/i;

/** "Secret clearance preferred", or an item in a list under a heading like "Nice to have:". */
function isOptional(text: string, start: number, end: number): boolean {
  const lineStart = text.lastIndexOf('\n', start) + 1;
  const nextLine = text.indexOf('\n', end);
  const lineEnd = nextLine === -1 ? text.length : nextLine;
  if (OPTIONAL_WORDING.test(text.slice(Math.max(lineStart, start - 40), Math.min(lineEnd, end + 40)))) return true;
  const headings = text.slice(Math.max(0, lineStart - 500), lineStart).match(/^[^\n]{2,60}:\s*$/gm);
  return !!headings && OPTIONAL_WORDING.test(headings[headings.length - 1]);
}

/** Only what a job requires. What it merely prefers does not make it a clearance job. */
function detectClearance(title: string, prose: string): string | null {
  const text = `${title}\n${prose}`;
  for (const [pattern, level] of CLEARANCE_LEVELS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const before = text.slice(Math.max(0, start - 60), start);
      const after = text.slice(end, end + 40);
      if (!CLEARANCE_DENIED_BEFORE.test(before) && !CLEARANCE_DENIED_AFTER.test(after) && !isOptional(text, start, end)) return level;
    }
  }
  return null;
}

const FEDERAL_TITLE = /\bfederal\b|\bu\.?s\.?\s+government\b|\bgovcon\b/i;
const FEDERAL_COMPANY = /\bfederal\s+(?:services|solutions|systems|government|technology)\b|\bgovernment\s+(?:services|solutions|systems)\b|\bu\.?s\.?\s+department\s+of\b/i;
const NOT_FEDERAL_COMPANY = /navy\s+federal|federal\s+express|federal\s+home\s+loan|federal\s+credit\s+union/i;
/**
 * Says who the work is for. Merely naming the government does not count: real postings mention
 * "government agencies" among a product's customers, and data from "federal agencies".
 */
const FEDERAL_PROSE = new RegExp(
  [
    String.raw`\b(?:federal|u\.?s\.?\s+government)\s+(?:clients?|customers?|missions?|projects?|civilian|sector|space|program\s+office|contracts?(?!or)|workforce|problems?|partners?|systems?)\b`,
    String.raw`\bfederal\s+(?:[\w-]+\s+){1,3}initiatives?\b`,
    String.raw`\b(?:the\s+|u\.?s\.?\s+)federal\s+government\b`,
    String.raw`\bacross\s+the\s+u\.?s\.?\s+government\b`,
    String.raw`\bgovernment\s+contract(?:s|ing)\b`,
    String.raw`\bdepartment\s+of\s+(?:defense|war|homeland\s+security|veterans\s+affairs|energy|justice|the\s+treasury|state|health\s+and\s+human\s+services)\b`,
    String.raw`\bdefense\s+(?:health\s+)?agenc(?:y|ies)\b`,
    String.raw`\bintelligence\s+community\b`,
    // Spelled out, because "DoD" also means "definition of done".
    String.raw`\bdo[dw]\s+(?:customers?|clients?|programs?|contracts?|clearance|secret|reference|missions?|agenc\w+|components?|systems?|environments?|il\d|impact\s+level|directive|\d{4})\b`,
    String.raw`\bfor\s+(?:the\s+)?do[dw]\b`,
    String.raw`\b(?:serv(?:e|es|ing)|support(?:s|ing)?|for|with)\s+(?:\w+\s+){0,2}federal\s+agenc(?:y|ies)\b`,
    String.raw`\bsupport(?:s|ing)?\b[^.\n]{0,60}\b(?:federal|u\.?s\.?\s+government)\s+(?:[\w-]+\s+){0,3}(?:agenc\w*|clients?|customers?|missions?|programs?|initiatives?|projects?)\b`
  ].join('|'),
  'i'
);

function isFederalPosition(title: string, company: string, prose: string, urls: string[]): boolean {
  if (urls.some((url) => /(^|\/\/|\.)usajobs\.gov\b|\.mil(\/|$)/i.test(url))) return true;
  if (FEDERAL_TITLE.test(title)) return true;
  if (NOT_FEDERAL_COMPANY.test(company)) return false;
  return FEDERAL_COMPANY.test(company) || FEDERAL_PROSE.test(prose);
}

// ---- Salary --------------------------------------------------------------------------------

const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|K)?`;
const SALARY_RANGE = new RegExp(String.raw`(\$|USD\s?|£|€|CAD\s?\$?)\s?${AMOUNT}\s*(?:\/\s*(?:hr|hour|yr|year))?\s*(?:-|–|—|to|and)\s*(?:\$|USD\s?|£|€|CAD\s?\$?)?\s?${AMOUNT}\s*(?:USD|CAD|EUR|GBP)?\s*(?:(?:\/|per|an?)\s*(hour|hr|year|yr|annum|annually))?`, 'i');
const SALARY_SINGLE = new RegExp(String.raw`(\$|USD\s?|£|€)\s?${AMOUNT}\s*(?:\/|per|an?)\s*(hour|hr)\b`, 'i');
const NOT_PAY_AFTER = /^\s*(?:million|billion|trillion|m\b|b\b|bn\b)/i;

function toNumber(digits: string, kilo: string | undefined): number {
  const value = Number(digits.replace(/,/g, ''));
  return kilo ? value * 1000 : value;
}

function currencyOf(symbol: string): string {
  const text = symbol.trim().toUpperCase();
  if (text.startsWith('CAD')) return 'CAD';
  if (text === '£') return 'GBP';
  if (text === '€') return 'EUR';
  return 'USD';
}

function normalizePeriod(raw: string | null | undefined, min: number | null): SalaryPeriod | null {
  const text = (raw ?? '').toLowerCase();
  if (/hour|\bhr\b/.test(text)) return 'hour';
  if (/year|yr|annual|annum|salary/.test(text)) return 'year';
  if (min === null) return null;
  return min < 500 ? 'hour' : 'year';
}

function plausible(min: number, max: number, period: SalaryPeriod): boolean {
  if (min <= 0 || max < min) return false;
  return period === 'hour' ? min >= 10 && max <= 1000 : min >= 15_000 && max <= 2_000_000 && max <= min * 5;
}

function salaryFromHint(hint: SalaryHint | null | undefined): Pick<JobFacts, 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryPeriod'> | null {
  const min = hint?.min ?? hint?.max ?? null;
  const max = hint?.max ?? hint?.min ?? null;
  if (min === null || max === null) return null;
  const period = normalizePeriod(hint?.period, min);
  if (!period || !plausible(min, max, period)) return null;
  return { salaryMin: min, salaryMax: max, salaryCurrency: (hint?.currency ?? 'USD').toUpperCase(), salaryPeriod: period };
}

/** Finds a pay range in text, leaving out amounts such as "$250M in revenue". */
export function parseSalaryText(text: string | null | undefined): Pick<JobFacts, 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryPeriod'> | null {
  if (!text) return null;
  const scan = new RegExp(SALARY_RANGE.source, 'gi');
  for (const match of text.matchAll(scan)) {
    const end = (match.index ?? 0) + match[0].length;
    if (NOT_PAY_AFTER.test(text.slice(end, end + 12))) continue;
    // A "k" on either end applies to both: "$100-150K".
    const hasKilo = match[3] || match[5];
    let min = toNumber(match[2], match[3] ?? (hasKilo && Number(match[2]) < 1000 ? 'k' : undefined));
    const max = toNumber(match[4], match[5] ?? (hasKilo && Number(match[4]) < 1000 ? 'k' : undefined));
    if (min > max && min < 1000) min *= 1000;
    const period = normalizePeriod(match[6], min);
    if (period && plausible(min, max, period)) return { salaryMin: min, salaryMax: max, salaryCurrency: currencyOf(match[1]), salaryPeriod: period };
  }
  const single = text.match(SALARY_SINGLE);
  if (single) {
    const value = toNumber(single[2], single[3]);
    if (plausible(value, value, 'hour')) return { salaryMin: value, salaryMax: value, salaryCurrency: currencyOf(single[1]), salaryPeriod: 'hour' };
  }
  return null;
}

/** Comparable numbers, whichever way each site quotes pay. */
export function annualSalary(facts: Pick<JobFacts, 'salaryMin' | 'salaryMax' | 'salaryPeriod'>): { min: number; max: number } | null {
  if (facts.salaryMin === null || facts.salaryMax === null) return null;
  const factor = facts.salaryPeriod === 'hour' ? 2080 : 1;
  return { min: facts.salaryMin * factor, max: facts.salaryMax * factor };
}

// ---- Dates ---------------------------------------------------------------------------------

export function parsePostedAt(raw: unknown, now = Date.now()): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  let time: number;
  if (typeof raw === 'number') time = raw < 1e11 ? raw * 1000 : raw;
  else if (/^\d{11,13}$/.test(String(raw))) time = Number(raw);
  else time = Date.parse(String(raw).replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/, '$1T$2Z'));
  // Job sites sometimes publish a placeholder, or a date when a posting will expire.
  if (!Number.isFinite(time) || time < Date.UTC(2000, 0, 1) || time > now + 2 * 86_400_000) return null;
  return new Date(time).toISOString();
}

// ---- All together --------------------------------------------------------------------------

export interface FactSources {
  title: string;
  company: string;
  location?: string | null;
  description: string;
  urls?: string[];
  hints?: JobHints | null;
}

export function deriveJobFacts({ title, company, location, description, urls = [], hints }: FactSources): JobFacts {
  const prose = withoutBoilerplate(description);
  const salary = salaryFromHint(hints?.salary) ?? parseSalaryText(hints?.salaryText) ?? parseSalaryText(description);

  const contractSaid = CONTRACT_TITLE.test(title) || CONTRACT_PHRASES.test(prose);
  const structured = parseEmploymentType(hints?.employmentType);
  let employmentType: EmploymentType | null;
  if (structured === 'contract' || contractSaid) employmentType = 'contract';
  else if (structured === 'permanent' || PERMANENT_PHRASES.test(prose)) employmentType = 'permanent';
  else employmentType = null;

  return {
    workArrangement:
      parseWorkArrangement(hints?.workArrangement) ?? parseWorkArrangement(location) ?? parseWorkArrangement(title) ?? arrangementFromProse(prose),
    employmentType,
    clearance: detectClearance(title, prose),
    isFederal: isFederalPosition(title, company, prose, urls),
    postedAt: parsePostedAt(hints?.postedAt),
    salaryMin: salary?.salaryMin ?? null,
    salaryMax: salary?.salaryMax ?? null,
    salaryCurrency: salary?.salaryCurrency ?? null,
    salaryPeriod: salary?.salaryPeriod ?? null
  };
}

/** What one listing knows fills in what the other does not. The first one's own values win. */
export function combineFacts(first: JobFacts, second: JobFacts): JobFacts {
  const hasSalary = first.salaryMin !== null;
  return {
    workArrangement: first.workArrangement ?? second.workArrangement,
    employmentType: first.employmentType ?? second.employmentType,
    clearance: first.clearance ?? second.clearance,
    isFederal: first.isFederal || second.isFederal,
    // The first day a job was seen anywhere is the closest to when it really opened.
    postedAt: first.postedAt && second.postedAt ? (first.postedAt < second.postedAt ? first.postedAt : second.postedAt) : (first.postedAt ?? second.postedAt),
    salaryMin: hasSalary ? first.salaryMin : second.salaryMin,
    salaryMax: hasSalary ? first.salaryMax : second.salaryMax,
    salaryCurrency: hasSalary ? first.salaryCurrency : second.salaryCurrency,
    salaryPeriod: hasSalary ? first.salaryPeriod : second.salaryPeriod
  };
}
