/**
 * Layer C of duplicate detection: recognize applicant-tracking systems and aggregator
 * sites from a URL and pull out the stable id of the posting.
 *
 * An identifier from a URL is strong evidence: two URLs with the same provider and id
 * are the same posting, whatever their tracking parameters or wrapper pages look like.
 */

export interface AtsIdentity {
  /** Provider family, e.g. "greenhouse". Also used as job_urls.source_platform. */
  provider: string;
  /** Unique within the provider. Tenant-scoped providers use "tenant/id". */
  externalId: string;
  /** Provider's name for the employer, when the URL contains one. */
  board?: string;
}

type Rule = {
  provider: string;
  host: RegExp;
  match: (url: URL, hostMatch: RegExpMatchArray) => { id: string; board?: string } | null;
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function pathRule(
  provider: string,
  host: RegExp,
  path: RegExp,
  build: (pathMatch: RegExpMatchArray, hostMatch: RegExpMatchArray) => { id: string; board?: string }
): Rule {
  return {
    provider,
    host,
    match: (url, hostMatch) => {
      const pathMatch = url.pathname.match(path);
      return pathMatch ? build(pathMatch, hostMatch) : null;
    }
  };
}

const RULES: Rule[] = [
  {
    provider: 'greenhouse',
    host: /(^|\.)greenhouse\.io$/,
    match: (url) => {
      const token = url.searchParams.get('token');
      if (token && /^\d+$/.test(token)) {
        return { id: token, board: url.searchParams.get('for') ?? undefined };
      }
      const path = url.pathname.match(/^\/(?:embed\/)?([^/]+)\/jobs\/(\d+)/);
      return path ? { id: path[2], board: path[1] } : null;
    }
  },
  pathRule('lever', /^jobs\.(eu\.)?lever\.co$/, new RegExp(`^/([^/]+)/(${UUID})`, 'i'), (m) => ({
    id: m[2].toLowerCase(),
    board: decode(m[1])
  })),
  pathRule('ashby', /^jobs\.ashbyhq\.com$/, new RegExp(`^/([^/]+)/(${UUID})`, 'i'), (m) => ({
    id: m[2].toLowerCase(),
    board: decode(m[1])
  })),
  {
    provider: 'workday',
    host: /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i,
    match: (url, host) => {
      const path = url.pathname.match(/\/(?:job|details)\/(?:.*\/)?([^/]+?)(?:\/apply(?:\/.*)?)?\/?$/i);
      if (!path) return null;
      const slug = path[1] === 'apply' ? null : path[1];
      const req = slug?.match(/_([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)$/);
      if (!req) return null;
      return { id: `${host[1].toLowerCase()}/${req[1].toUpperCase()}`, board: host[1] };
    }
  },
  pathRule('smartrecruiters', /^(jobs|careers)\.smartrecruiters\.com$/i, /^\/oneclick-ui\/company\/([^/]+)\/publication\/([^/]+)/i, (m) => ({
    id: `publication/${m[2].toLowerCase()}`,
    board: m[1]
  })),
  pathRule('smartrecruiters', /^(jobs|careers)\.smartrecruiters\.com$/i, /^\/([^/]+)\/(\d{6,})/, (m) => ({
    id: m[2],
    board: m[1]
  })),
  pathRule('workable', /^apply\.workable\.com$/, /^\/([^/]+)\/j\/([A-Za-z0-9]+)/, (m) => ({
    id: `${m[1].toLowerCase()}/${m[2].toUpperCase()}`,
    board: m[1]
  })),
  pathRule('icims', /^(?:careers-)?([a-z0-9-]+)\.icims\.com$/i, /^\/jobs\/(\d+)/, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  {
    provider: 'jobdiva',
    host: /(^|\.)jobdiva\.com$/,
    match: (url) => {
      const fragment = url.hash.match(/jobs\/(\d+)/);
      return fragment ? { id: fragment[1] } : null;
    }
  },
  pathRule('rippling', /^ats\.rippling\.com$/, new RegExp(`^/([^/]+)/jobs/(${UUID})`, 'i'), (m) => ({
    id: m[2].toLowerCase(),
    board: m[1]
  })),
  pathRule('rippling', /^([a-z0-9-]+)\.rippling-ats\.com$/i, /^\/job\/(\d+)/, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  pathRule('recruitee', /^([a-z0-9-]+)\.recruitee\.com$/i, /^\/o\/([^/]+)/, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1].toLowerCase()}`,
    board: h[1]
  })),
  pathRule('comeet', /^(www\.)?comeet\.com$/, /^\/jobs\/([^/]+)\/([^/]+)\/[^/]*\/([^/]+)/, (m) => ({
    id: `${m[2]}/${m[3]}`.toUpperCase(),
    board: m[1]
  })),
  pathRule('gem', /^jobs\.gem\.com$/, /^\/([^/]+)\/([^/]+)/, (m) => ({ id: m[2], board: m[1] })),
  pathRule('paylocity', /^recruiting\.paylocity\.com$/, /\/Recruiting\/Jobs\/(?:Apply|Details)\/(\d+)/i, (m) => ({ id: m[1] })),
  pathRule('jobvite', /^jobs\.jobvite\.com$/, /^\/([^/]+)\/job\/([^/]+)/, (m) => ({
    id: `${m[1].toLowerCase()}/${m[2]}`,
    board: m[1]
  })),
  pathRule('bamboohr', /^([a-z0-9-]+)\.bamboohr\.com$/i, /^\/(?:careers|jobs)\/(?:view\.php\?id=)?(\d+)/, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  pathRule('jazzhr', /^([a-z0-9-]+)\.applytojob\.com$/i, /^\/apply\/([A-Za-z0-9]+)/, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  pathRule('breezy', /^([a-z0-9-]+)\.breezy\.hr$/i, /^\/p\/([0-9a-f]+)/i, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1].toLowerCase()}`,
    board: h[1]
  })),
  pathRule('zoho', /^([a-z0-9-]+)\.zohorecruit\.[a-z.]+$/i, /^\/jobs\/[^/]+\/(\d+)/i, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  pathRule('catsone', /^([a-z0-9-]+)\.catsone\.com$/i, /^\/careers\/[^/]+\/jobs\/(\d+)/i, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  pathRule('careerplug', /^([a-z0-9-]+)\.careerplug\.com$/i, /^\/jobs\/(\d+)/, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  {
    provider: 'adp',
    host: /^workforcenow\.adp\.com$/,
    match: (url) => {
      const cid = url.searchParams.get('cid');
      const jobId = url.searchParams.get('jobId');
      return cid && jobId ? { id: `${cid.toLowerCase()}/${jobId}` } : null;
    }
  },
  {
    provider: 'adp',
    host: /^myjobs\.adp\.com$/,
    match: (url) => {
      const tenant = url.pathname.match(/^\/([^/]+)/)?.[1];
      const req = url.searchParams.get('reqId');
      return tenant && req ? { id: `myjobs/${tenant.toLowerCase()}/${req}`, board: tenant } : null;
    }
  },
  pathRule('oracle', /^([a-z0-9-]+)\.fa\.[a-z0-9-.]*oraclecloud\.com$/i, /\/sites\/([^/]+)\/(?:my-profile\/)?job\/(\d+)/i, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[2]}`
  })),
  pathRule('paycom', /(^|\.)paycomonline\.net$/, /\/portal\/([^/]+)\/jobs\/(\d+)/, (m) => ({
    id: `${m[1].toLowerCase()}/${m[2]}`
  })),
  {
    provider: 'ukg',
    host: /^recruiting\d*\.ultipro\.com$/,
    match: (url) => {
      const id = url.searchParams.get('opportunityId');
      return id ? { id: id.toLowerCase() } : null;
    }
  },
  {
    provider: 'paycor',
    host: /^recruitingbypaycor\.com$/,
    match: (url) => {
      const id = url.searchParams.get('id');
      return id ? { id: id.toLowerCase() } : null;
    }
  },
  {
    provider: 'brassring',
    host: /\.brassring\.com$/,
    match: (url) => {
      const partner = url.searchParams.get('partnerid');
      const site = url.searchParams.get('siteid');
      const job = url.searchParams.get('jobid') ?? url.hash.match(/jobDetails=(\d+)/)?.[1];
      return partner && site && job ? { id: `${partner}/${site}/${job}` } : null;
    }
  },
  {
    provider: 'hirebridge',
    host: /^(www\.)?hirebridge\.com$/,
    match: (url) => {
      const id = url.searchParams.get('joblistid');
      return id ? { id } : null;
    }
  },
  pathRule('personio', /^([a-z0-9-]+)\.jobs\.personio\.(?:com|de)$/i, /^\/job\/(\d+)/, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  pathRule('pinpoint', /^([a-z0-9-]+)\.pinpointhq\.com$/i, new RegExp(`/postings/(${UUID})`, 'i'), (m) => ({
    id: m[1].toLowerCase()
  })),
  pathRule('avature', /^([a-z0-9-]+)\.avature\.net$/i, /\/JobDetail\/(?:[^/]*\/)?(\d+)/i, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  pathRule('dover', /^app\.dover\.com$/, new RegExp(`/apply/([^/]+)/(${UUID})`, 'i'), (m) => ({
    id: m[2].toLowerCase(),
    board: decode(m[1])
  })),
  pathRule('hiringthing', /^([a-z0-9-]+)\.hiringthing\.com$/i, /^\/job\/(\d+)/, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  pathRule('applicantpro', /^([a-z0-9-]+)\.applicantpro\.com$/i, /^\/jobs\/(\d+)/, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  pathRule('gusto', /^jobs\.gusto\.com$/, new RegExp(`/postings/.*?(${UUID})`, 'i'), (m) => ({
    id: m[1].toLowerCase()
  })),
  pathRule('meta', /^(www\.)?metacareers\.com$/, /\/job_details\/(\d+)/, (m) => ({ id: m[1] })),
  pathRule('phenom', /^(.+)$/, /\/job\/([A-Z0-9]{10,}EN[A-Z]{2,}[A-Z0-9]*)(?:\/|$)/, (m, h) => ({
    id: `${h[1].toLowerCase().replace(/^www\./, '')}/${m[1]}`
  })),
  // Job boards and aggregators: their ids identify a listing on that site.
  pathRule('linkedin', /(^|\.)linkedin\.com$/, /\/jobs\/view\/(?:[^/]*-)?(\d+)/, (m) => ({ id: m[1] })),
  {
    provider: 'linkedin',
    host: /(^|\.)linkedin\.com$/,
    match: (url) => {
      const id = url.searchParams.get('currentJobId');
      return id && /^\d+$/.test(id) ? { id } : null;
    }
  },
  {
    provider: 'indeed',
    host: /(^|\.)indeed\.[a-z.]+$/,
    match: (url) => {
      const id = url.searchParams.get('jk') ?? url.searchParams.get('vjk');
      return id ? { id: id.toLowerCase() } : null;
    }
  },
  pathRule('builtin', /^(www\.)?builtin[a-z]*\.com$/, /\/job\/(?:[^/]+\/)*(\d+)\/?$/, (m) => ({ id: m[1] })),
  pathRule('jobright', /^(www\.)?jobright\.ai$/, /\/jobs\/info\/([^/?#]+)/, (m) => ({ id: m[1] })),
  pathRule('jobright', /^(www\.)?jobright\.ai$/, /\/jobs\/([0-9a-f]{16,})/i, (m) => ({ id: m[1] })),
  {
    provider: 'glassdoor',
    host: /(^|\.)glassdoor\.[a-z.]+$/,
    match: (url) => {
      const id = url.searchParams.get('jobListingId') ?? url.searchParams.get('jl');
      if (id && /^\d+$/.test(id)) return { id };
      const path = url.pathname.match(/_JV_.*?KO\d+,\d+.*?(\d{6,})\.htm/) ?? url.pathname.match(/JL(\d{6,})/);
      return path ? { id: path[1] } : null;
    }
  },
  pathRule('workable-board', /^jobs\.workable\.com$/, /^\/view\/([A-Za-z0-9]+)/, (m) => ({ id: m[1] })),
  pathRule('careers-page', /^(www\.)?careers-page\.com$/, /^\/([^/]+)\/job\/([A-Za-z0-9]+)/, (m) => ({
    id: `${m[1].toLowerCase()}/${m[2]}`,
    board: m[1]
  })),
  pathRule('recruiterflow', /(^|\.)recruiterflow\.com$/, /\/jobs\/(\d+)/, (m) => ({ id: m[1] }))
];

/** Identifiers that survive being wrapped in a company's own careers page. */
function fromEmbedParams(url: URL): AtsIdentity | null {
  const greenhouse = url.searchParams.get('gh_jid');
  if (greenhouse && /^\d+$/.test(greenhouse)) {
    return { provider: 'greenhouse', externalId: greenhouse };
  }
  const ashby = url.searchParams.get('ashby_jid');
  if (ashby && new RegExp(`^${UUID}$`, 'i').test(ashby)) {
    return { provider: 'ashby', externalId: ashby.toLowerCase() };
  }
  const lever = url.searchParams.get('lever_jid') ?? url.searchParams.get('lever-job-id');
  if (lever && new RegExp(`^${UUID}$`, 'i').test(lever)) {
    return { provider: 'lever', externalId: lever.toLowerCase() };
  }
  return null;
}

export function identifyAts(input: string | URL): AtsIdentity | null {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  // Embed parameters are checked first: a wrapper page on a company domain with
  // gh_jid=123 is the same posting as the Greenhouse URL for job 123.
  const embedded = fromEmbedParams(url);
  if (embedded) return embedded;

  for (const rule of RULES) {
    const hostMatch = host.match(rule.host);
    if (!hostMatch) continue;
    const result = rule.match(url, hostMatch);
    if (result) {
      return { provider: rule.provider, externalId: result.id, board: result.board };
    }
  }
  return null;
}

const PLATFORM_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)greenhouse\.io$/, 'greenhouse'],
  [/(^|\.)lever\.co$/, 'lever'],
  [/(^|\.)ashbyhq\.com$/, 'ashby'],
  [/\.myworkdayjobs\.com$/, 'workday'],
  [/(^|\.)smartrecruiters\.com$/, 'smartrecruiters'],
  [/(^|\.)workable\.com$/, 'workable'],
  [/\.icims\.com$/, 'icims'],
  [/(^|\.)jobdiva\.com$/, 'jobdiva'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)indeed\.[a-z.]+$/, 'indeed'],
  [/(^|\.)glassdoor\.[a-z.]+$/, 'glassdoor'],
  [/(^|\.)ziprecruiter\.com$/, 'ziprecruiter'],
  [/^(www\.)?builtin[a-z]*\.com$/, 'builtin'],
  [/(^|\.)jobright\.ai$/, 'jobright']
];

/** Short name for where a URL came from, used for display and job_urls.source_platform. */
export function sourcePlatform(input: string | URL): string {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    return 'other';
  }
  const identity = identifyAts(url);
  if (identity) return identity.provider;
  const host = url.hostname.toLowerCase();
  for (const [pattern, name] of PLATFORM_HOSTS) {
    if (pattern.test(host)) return name;
  }
  return 'company';
}

/** Aggregators only list a job: an ATS id found on their page is the job's real identity. */
const AGGREGATOR_PROVIDERS = new Set([
  'linkedin',
  'indeed',
  'builtin',
  'jobright',
  'glassdoor',
  'ziprecruiter',
  'workable-board'
]);

export function isAggregator(provider: string | null | undefined): boolean {
  return !!provider && AGGREGATOR_PROVIDERS.has(provider);
}

/**
 * Finds ATS links embedded in a page's HTML or JSON blobs. Only reported when the page
 * points at exactly one posting: several matches usually mean a "similar jobs" widget.
 */
export function discoverAtsLinks(html: string, ownIdentity: AtsIdentity | null): Array<{ url: string; identity: AtsIdentity }> {
  const found = new Map<string, { url: string; identity: AtsIdentity }>();
  const unescaped = html.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const pattern = /https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>\\)]*/gi;
  for (const match of unescaped.matchAll(pattern)) {
    const raw = match[0];
    if (!/greenhouse|lever\.co|ashbyhq|myworkdayjobs|smartrecruiters|workable|icims|gh_jid|ashby_jid|jobvite|rippling/i.test(raw)) {
      continue;
    }
    const identity = identifyAts(raw);
    if (!identity || isAggregator(identity.provider)) continue;
    if (ownIdentity && identity.provider === ownIdentity.provider && identity.externalId === ownIdentity.externalId) continue;
    found.set(`${identity.provider}:${identity.externalId}`, { url: raw, identity });
    if (found.size > 1) return [];
  }
  return [...found.values()];
}
