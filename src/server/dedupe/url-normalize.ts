/**
 * Layer A of duplicate detection: reduce a URL to a stable comparison key without
 * losing the identifiers that make it point at one specific job.
 *
 * The key is for comparison only, it is not guaranteed to be a fetchable URL
 * (it always uses https and drops "www."). The user's original URL is stored separately.
 */

const TRACKING_EXACT = new Set(
  [
    'ref',
    'referer',
    'referrer',
    'ref_src',
    'refid',
    'source',
    'src',
    'sourceid',
    'source_id',
    'fbclid',
    'gclid',
    'gclsrc',
    'gbraid',
    'wbraid',
    'dclid',
    'msclkid',
    'yclid',
    'twclid',
    'ttclid',
    'li_fat_id',
    'mc_cid',
    'mc_eid',
    'igshid',
    'trk',
    'trkinfo',
    'jr_id',
    'gh_src',
    'lever-source',
    'lever-origin',
    'iis',
    'iisn',
    'mobile',
    'width',
    'height',
    'bga',
    'needsredirect',
    'jan1offset',
    'jun1offset',
    '_ccid',
    'indeed-apply-token',
    'extcmp',
    'microsite',
    'hsctaattrib',
    'dcr_ci',
    'step',
    'stepname',
    'jobboardslug',
    'hsctatracking',
    '_hsenc',
    '_hsmi',
    '_ga',
    '_gl',
    'campaign',
    'medium',
    'publisher',
    'sessionid',
    'jsessionid',
    '_s.crb'
  ].map((name) => name.toLowerCase())
);

const TRACKING_PREFIXES = ['utm_', 'rx_', 'tm_', 'hsa_', 'pk_', 'mtm_', 'vero_', 'oly_', 'ga_'];

interface HostRule {
  host: RegExp;
  /** Query parameters that identify the job. Everything else is dropped on this host. */
  keepParams?: string[];
  /** Path suffixes that are application-form views of the same job page. */
  stripPathSuffix?: RegExp;
  /** Fragment routes carry the job id on this host. */
  keepFragment?: boolean;
  rewritePath?: (path: string) => string;
}

const NO_PARAMS: string[] = [];

const HOST_RULES: HostRule[] = [
  { host: /(^|\.)greenhouse\.io$/, keepParams: ['for', 'token', 'gh_jid'] },
  { host: /^jobs\.lever\.co$/, keepParams: NO_PARAMS, stripPathSuffix: /\/apply$/ },
  { host: /^jobs\.ashbyhq\.com$/, keepParams: NO_PARAMS, stripPathSuffix: /\/application$/ },
  {
    host: /\.myworkdayjobs\.com$/,
    keepParams: NO_PARAMS,
    stripPathSuffix: /\/apply(\/.*)?$/,
    rewritePath: (path) => path.replace(/^\/[a-z]{2}-[A-Z]{2}(?=\/)/, '')
  },
  { host: /(^|\.)workable\.com$/, keepParams: NO_PARAMS, stripPathSuffix: /\/apply$/ },
  { host: /\.icims\.com$/, keepParams: NO_PARAMS },
  { host: /\.applytojob\.com$/, keepParams: NO_PARAMS },
  { host: /(^|\.)rippling\.com$/, keepParams: NO_PARAMS, stripPathSuffix: /\/apply$/ },
  { host: /\.rippling-ats\.com$/, keepParams: NO_PARAMS },
  { host: /\.smartrecruiters\.com$/, keepParams: NO_PARAMS },
  { host: /\.catsone\.com$/, keepParams: NO_PARAMS, stripPathSuffix: /\/apply$/ },
  { host: /\.careerplug\.com$/, keepParams: NO_PARAMS, stripPathSuffix: /\/apps\/new$/ },
  // "/jobs/view.php?id=42": the id is the job.
  { host: /\.bamboohr\.com$/, keepParams: ['id'] },
  { host: /\.zohorecruit\.com$/, keepParams: NO_PARAMS },
  { host: /\.breezy\.hr$/, keepParams: NO_PARAMS },
  { host: /^jobs\.gem\.com$/, keepParams: NO_PARAMS },
  { host: /\.recruitee\.com$/, keepParams: NO_PARAMS },
  { host: /(^|\.)comeet\.com$/, keepParams: NO_PARAMS },
  { host: /^jobs\.jobvite\.com$/, keepParams: NO_PARAMS, stripPathSuffix: /\/apply$/ },
  {
    host: /^recruiting\.paylocity\.com$/,
    keepParams: NO_PARAMS,
    rewritePath: (path) => path.replace(/\/Recruiting\/Jobs\/(Apply|Details)\//i, '/Recruiting/Jobs/Details/')
  },
  { host: /^workforcenow\.adp\.com$/, keepParams: ['cid', 'jobId', 'ccId'] },
  { host: /^myjobs\.adp\.com$/, keepParams: ['reqId'] },
  { host: /\.jobdiva\.com$/, keepParams: ['a'], keepFragment: true },
  { host: /\.brassring\.com$/, keepParams: ['partnerid', 'siteid', 'jobid'] },
  { host: /\.oraclecloud\.com$/, keepParams: NO_PARAMS },
  { host: /\.paycomonline\.net$/, keepParams: NO_PARAMS },
  { host: /\.ultipro\.com$/, keepParams: ['opportunityId'] },
  { host: /\.rec\.pro\.ukg\.net$/, keepParams: ['opportunityId'] },
  { host: /\.ripplehire\.com$/, keepParams: NO_PARAMS, keepFragment: true },
  { host: /\.myworkdaysite\.com$/, keepParams: NO_PARAMS, stripPathSuffix: /\/apply(\/.*)?$/ },
  { host: /\.teamtailor\.com$/, keepParams: NO_PARAMS },
  { host: /^careers\.kula\.ai$/, keepParams: NO_PARAMS },
  { host: /^app\.careerpuck\.com$/, keepParams: NO_PARAMS },
  { host: /^recruitingbypaycor\.com$/, keepParams: ['clientId', 'id'] },
  { host: /^hirebridge\.com$/, keepParams: ['joblistid', 'cid'] },
  { host: /\.personio\.(com|de)$/, keepParams: NO_PARAMS },
  { host: /\.pinpointhq\.com$/, keepParams: NO_PARAMS },
  { host: /\.hiringthing\.com$/, keepParams: NO_PARAMS },
  { host: /^jobs\.gusto\.com$/, keepParams: NO_PARAMS },
  { host: /\.applicantpro\.com$/, keepParams: NO_PARAMS },
  { host: /^app\.dover\.com$/, keepParams: NO_PARAMS },
  { host: /^metacareers\.com$/, keepParams: NO_PARAMS },
  {
    host: /(^|\.)linkedin\.com$/,
    keepParams: ['currentJobId'],
    rewritePath: (path) => path.replace(/\/jobs\/view\/(?:[^/]*-)?(\d+)\/?$/, '/jobs/view/$1')
  },
  // A sponsored listing's link ("/pagead/clk?ad=…") names its job only in "ad".
  { host: /(^|\.)indeed\.[a-z.]+$/, keepParams: ['jk', 'vjk', 'ad'] },
  { host: /^jobright\.ai$/, keepParams: NO_PARAMS },
  { host: /^builtin[a-z]*\.com$/, keepParams: NO_PARAMS },
  { host: /(^|\.)glassdoor\.[a-z.]+$/, keepParams: ['jl', 'jobListingId'] },
  { host: /(^|\.)ziprecruiter\.com$/, keepParams: ['jid', 'lvk'] }
];

function findHostRule(host: string): HostRule | undefined {
  return HOST_RULES.find((rule) => rule.host.test(host));
}

export class InvalidUrlError extends Error {
  constructor(message = 'That does not look like a valid job URL.') {
    super(message);
    this.name = 'InvalidUrlError';
  }
}

/** Accepts what a person pastes: surrounding spaces and missing "https://". */
export function parseUserUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) throw new InvalidUrlError();
  // A scheme other than http(s) must be refused rather than treated as a hostname.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(\/\/|(?!\d))/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new InvalidUrlError();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidUrlError('Only http and https links are supported.');
  }
  if (url.username || url.password) {
    throw new InvalidUrlError('Links that contain a username or password are not allowed.');
  }
  if (!url.hostname.includes('.') && !url.hostname.includes(':')) {
    throw new InvalidUrlError();
  }
  return url;
}

/**
 * Query parameters that act as a person's credentials rather than describe a job: login
 * codes from emailed links, one-click apply tokens, per-viewer tracking ids. People paste
 * these links straight from their browser, and saved URLs are visible to everyone on the
 * LAN, so they never reach the database, the logs or a fetch.
 */
const PERSONAL_PARAMS = new Set([
  'code',
  'eem',
  'indeed-apply-token',
  'rx_viewer',
  'rx_p',
  'access_token',
  'id_token',
  'auth',
  'authtoken',
  'auth_token',
  'password',
  'sessionid',
  'jsessionid',
  'userid',
  'user_id'
]);

/**
 * Marketing and visitor tracking: who clicked, from which campaign or email. None of it says which
 * job, and some of it identifies the person who clicked ("ccuid", "p_uid", "mc_eid"), so it is
 * not kept in saved links either. Parameters that name the job ("jr_id", "gh_jid", "token") stay.
 */
const VISITOR_TRACKING = new Set(
  [
    'ref',
    'referer',
    'referrer',
    'ref_src',
    'refid',
    'source',
    'src',
    'sourceid',
    'source_id',
    'fbclid',
    'gclid',
    'gclsrc',
    'gbraid',
    'wbraid',
    'dclid',
    'msclkid',
    'yclid',
    'twclid',
    'ttclid',
    'li_fat_id',
    'mc_cid',
    'mc_eid',
    'igshid',
    'trk',
    'trkinfo',
    'gh_src',
    'lever-source',
    'lever-origin',
    '_ccid',
    'ccuid',
    'p_uid',
    'p_sid',
    'mssc',
    'extcmp',
    'hsctaattrib',
    'hsctatracking',
    'dcr_ci',
    '_hsenc',
    '_hsmi',
    '_ga',
    '_gl',
    'campaign',
    'medium',
    'publisher',
    'iis',
    'iisn',
    'uid',
    'user',
    'email',
    'e-mail',
    'mail'
  ].map((name) => name.toLowerCase())
);
const VISITOR_TRACKING_PREFIXES = ['utm_', 'lt_utm_', 'hsa_', 'pk_', 'mtm_', 'vero_', 'oly_', 'ga_', 'tm_'];

/** Paths that carry a one-time token for one person: account activation, sign-in, password reset. */
const PERSONAL_PATH = /\/(?:activate|activation|verify|confirm|reset-?password|magic-?link|login|signin|sign-in)\//i;

/** A copy of the link that is safe to store and to show to other users. */
export function stripPersonalParams(input: string | URL): string {
  let url = new URL(input);
  // "…/activate/<token>/?redirect=/job/…": keep the job page it leads to, without the token.
  if (PERSONAL_PATH.test(url.pathname)) {
    const target = url.searchParams.get('redirect') ?? url.searchParams.get('returnUrl') ?? url.searchParams.get('return_to') ?? url.searchParams.get('next');
    if (target?.startsWith('/') && !target.startsWith('//')) url = new URL(target, url.origin);
  }
  for (const name of [...url.searchParams.keys()]) {
    const lower = name.toLowerCase();
    if (PERSONAL_PARAMS.has(lower) || VISITOR_TRACKING.has(lower) || VISITOR_TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix))) url.searchParams.delete(name);
  }
  return url.toString();
}

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return TRACKING_EXACT.has(lower) || PERSONAL_PARAMS.has(lower) || TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Hash routes and fragments that name a job are identifiers; "#apply" or "#top" are not. */
function isMeaningfulFragment(fragment: string): boolean {
  if (!fragment) return false;
  if (/^!?\//.test(fragment)) return /\d|job|position|career/i.test(fragment);
  return /(job|req|position|opening)/i.test(fragment) && /\d/.test(fragment);
}

/** Anchors a careers page uses for its own sections, not for one job. */
const PAGE_ANCHORS = new Set([
  'top',
  'main',
  'content',
  'main-content',
  'skip',
  'skip-to-content',
  'apply',
  'application',
  'jobs',
  'careers',
  'openings',
  'open-roles',
  'open-positions',
  'positions',
  'roles',
  'all-jobs',
  'job-list',
  'listings',
  'join',
  'join-us',
  'about',
  'about-us',
  'team',
  'teams',
  'benefits',
  'perks',
  'values',
  'culture',
  'life',
  'contact',
  'faq',
  'faqs',
  'footer',
  'header',
  'nav',
  'menu',
  'search',
  'filters',
  'results',
  'overview',
  'intro',
  'home'
]);

/** A page that lists every job of a site: its home or its careers page. */
function isListingPath(path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  return segments.length === 0 || (segments.length === 1 && /^(careers?|jobs?|job-board|openings|positions|join-us|work-with-us)$/i.test(segments[0]));
}

/** On such a page, "#backend-engineer" is the only thing that says which job is meant. */
function isJobAnchor(fragment: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{2,80}$/i.test(fragment) && !PAGE_ANCHORS.has(fragment.toLowerCase());
}

export function normalizeUrl(input: string | URL): string {
  const url = typeof input === 'string' ? parseUserUrl(input) : new URL(input);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const rule = findHostRule(host);

  let path = url.pathname.replace(/\/{2,}/g, '/');
  if (rule?.rewritePath) path = rule.rewritePath(path);
  path = path.replace(/\/+$/, '');
  if (rule?.stripPathSuffix) path = path.replace(rule.stripPathSuffix, '');
  path = path.replace(/\/+$/, '');

  const kept: Array<[string, string]> = [];
  const seen = new Set<string>();
  const allow = rule?.keepParams?.map((name) => name.toLowerCase());
  for (const [name, value] of url.searchParams) {
    if (allow ? !allow.includes(name.toLowerCase()) : isTrackingParam(name)) continue;
    if (!name) continue;
    const key = `${name.toLowerCase()}=${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push([name, value]);
  }
  kept.sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));

  const params = new URLSearchParams();
  for (const [name, value] of kept) params.append(name, value);
  const query = params.toString();

  const rawFragment = url.hash.replace(/^#/, '');
  const fragment = rule?.keepFragment || isMeaningfulFragment(rawFragment) || (!rule && !query && isListingPath(path) && isJobAnchor(rawFragment)) ? rawFragment : '';

  const port = url.port && !['80', '443'].includes(url.port) ? `:${url.port}` : '';
  return `https://${host}${port}${path}${query ? `?${query}` : ''}${fragment ? `#${fragment}` : ''}`;
}
