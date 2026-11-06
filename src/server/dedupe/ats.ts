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

/**
 * Workday slugs end in "_{requisition}", optionally with a posting suffix: "_JR100704-1"
 * is the same requisition as "_JR100704", published to a second career site or location.
 * The suffix only goes when what remains still has letters and digits, so that ids which
 * are mostly numeric ("_2026-12", "_REQ-12") keep every part that distinguishes them.
 */
function workdayIdentity(pathname: string, tenant: string): { id: string; board: string } | null {
  const path = pathname.replace(/\/apply(\/.*)?$/i, '').replace(/\/+$/, '');
  const slug = path.match(/\/(?:job|details)\/(?:.*\/)?([^/]+)$/i)?.[1];
  const req = slug?.match(/_([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)$/)?.[1];
  if (!req) return null;
  const upper = req.toUpperCase();
  const base = upper.replace(/-\d{1,2}$/, '');
  const id = /[A-Z]/.test(base) && /\d/.test(base) ? base : upper;
  return { id: `${tenant.toLowerCase()}/${id}`, board: tenant };
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
    match: (url, host) => workdayIdentity(url.pathname, host[1])
  },
  {
    // The same Workday posting, served from the shared host: /recruiting/{tenant}/{site}/job/...
    provider: 'workday',
    host: /^wd\d+\.myworkdaysite\.com$/i,
    match: (url) => {
      const tenant = url.pathname.match(/^\/(?:[a-z]{2}-[A-Z]{2}\/)?recruiting\/([^/]+)\//i)?.[1];
      return tenant ? workdayIdentity(url.pathname, tenant) : null;
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
  pathRule('bamboohr', /^([a-z0-9-]+)\.bamboohr\.com$/i, /^\/(?:careers|jobs)\/(\d+)/, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  {
    // The older shape of the same link: /jobs/view.php?id=42 is /careers/42.
    provider: 'bamboohr',
    host: /^([a-z0-9-]+)\.bamboohr\.com$/i,
    match: (url, h) => {
      const id = url.searchParams.get('id');
      return /\/view\.php$/i.test(url.pathname) && id && /^\d+$/.test(id) ? { id: `${h[1].toLowerCase()}/${id}`, board: h[1] } : null;
    }
  },
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
    host: /^(?:recruiting\d*\.ultipro\.com|[a-z0-9-]+\.rec\.pro\.ukg\.net)$/,
    match: (url) => {
      const id = url.searchParams.get('opportunityId');
      return id ? { id: id.toLowerCase() } : null;
    }
  },
  {
    provider: 'ripplehire',
    host: /^([a-z0-9-]+)\.ripplehire\.com$/i,
    match: (url, host) => {
      const id = url.hash.match(/detail\/job\/(\d+)/)?.[1];
      return id ? { id: `${host[1].toLowerCase()}/${id}`, board: host[1] } : null;
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
      const tenant = url.searchParams.get('cid');
      return id ? { id: tenant ? `${tenant}/${id}` : id } : null;
    }
  },
  pathRule('teamtailor', /^([a-z0-9-]+)(?:\.[a-z]{2})?\.teamtailor\.com$/i, /^\/jobs\/(\d+)/, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  pathRule('kula', /^careers\.kula\.ai$/, /^\/([^/]+)\/(\d+)/, (m) => ({
    id: `${m[1].toLowerCase()}/${m[2]}`,
    board: m[1]
  })),
  pathRule('careerpuck', /^app\.careerpuck\.com$/, /^\/job-board\/([^/]+)\/job\/([^/]+)/, (m) => ({
    id: `${m[1].toLowerCase()}/${m[2]}`,
    board: m[1]
  })),
  pathRule('darwinbox', /^([a-z0-9-]+)\.darwinbox\.[a-z.]+$/i, /\/jobDetails\/([a-z0-9]+)/i, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  pathRule('isolved', /^([a-z0-9-]+)\.isolvedhire\.com$/i, /^\/jobs\/(\d+)/, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  pathRule('trakstar', /^([a-z0-9-]+)\.hire\.trakstar\.com$/i, /^\/jobs\/([a-z0-9]+)/i, (m, h) => ({
    id: `${h[1].toLowerCase()}/${m[1]}`,
    board: h[1]
  })),
  pathRule('trinet', /^app\.trinethire\.com$/, /^\/companies\/([^/]+)\/jobs\/(\d+)/, (m) => ({
    id: `${m[1].toLowerCase()}/${m[2]}`,
    board: m[1].replace(/^\d+-/, '')
  })),
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
  pathRule('linkedin', /(^|\.)linkedin\.com$/, /\/jobs\/view\/(?:externalApply\/)?(?:[^/]*-)?(\d+)/i, (m) => ({ id: m[1] })),
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
  pathRule('jobright', /^(www\.)?jobright\.ai$/, /\/jobs\/info\/([^/?#]+)/, (m) => ({ id: m[1].toLowerCase() })),
  pathRule('jobright', /^(www\.)?jobright\.ai$/, /\/jobs\/([0-9a-f]{16,})/i, (m) => ({ id: m[1].toLowerCase() })),
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
  {
    // A listing site's ids, so they never show two jobs differ: it lists one job under several.
    provider: 'ziprecruiter',
    host: /(^|\.)ziprecruiter\.com$/,
    match: (url) => {
      const id = url.searchParams.get('jid') ?? url.searchParams.get('lvk');
      return id && /^[A-Za-z0-9_-]{4,}$/.test(id) ? { id } : null;
    }
  },
  pathRule('workable-board', /^jobs\.workable\.com$/, /^\/view\/([A-Za-z0-9]+)/, (m) => ({ id: m[1] })),
  pathRule('careers-page', /^(www\.)?careers-page\.com$/, /^\/([^/]+)\/job\/([A-Za-z0-9]+)/, (m) => ({
    id: `${m[1].toLowerCase()}/${m[2]}`,
    board: m[1]
  })),
  // Numbered per tenant: /HR/jobs/716 and /releady/jobs/716 are not the same posting.
  pathRule('recruiterflow', /(^|\.)recruiterflow\.com$/, /^\/([^/]+)\/jobs\/(\d+)/, (m) => ({
    id: `${m[1].toLowerCase()}/${m[2]}`,
    board: m[1]
  }))
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
  return fromJobParams(url);
}

/** Names that say "this value is the job", on sites with no rule of their own. */
const JOB_ID_PARAMS = new Set([
  'jobid',
  'job_id',
  'job-id',
  'jobreq',
  'reqid',
  'req_id',
  'requisitionid',
  'requisition_id',
  'postingid',
  'posting_id',
  'jobpostingid',
  'opportunityid',
  'positionid',
  'position_id',
  'jobseqno',
  'jobnumber',
  'job_number',
  'jid'
]);

/** On one system these separate customers, so the same job number can mean different jobs. */
const TENANT_PARAMS = new Set(['a', 'c', 'cid', 'client', 'clientid', 'company', 'companyid', 'org', 'orgid', 'tenant', 'account', 'partnerid', 'siteid', 'board', 'for', 'token', 'domain']);

/**
 * An id in a parameter, on a site without its own rule. It only counts within one page of one
 * site and one customer, because a wrong merge is worse than asking: "?jobId=5" on two
 * different paths or for two different customers can be two different jobs.
 */
function fromJobParams(url: URL): AtsIdentity | null {
  let jobId: string | null = null;
  const tenant: string[] = [];
  for (const [name, value] of url.searchParams) {
    const lower = name.toLowerCase();
    if (!jobId && JOB_ID_PARAMS.has(lower) && value.length >= 3 && /\d/.test(value)) jobId = value;
    else if (TENANT_PARAMS.has(lower)) tenant.push(`${lower}=${value}`);
  }
  if (!jobId) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const page = url.pathname.replace(/\/+$/, '').replace(/\/(apply|application|details?|jobdetails?|view)$/i, '');
  return { provider: 'site', externalId: [`${host}${page}`, ...tenant.sort(), jobId].join('|') };
}

const JOBRIGHT_ID = /^[0-9a-f]{16,40}$/i;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Other listings a link names in its parameters, on top of what it points at. Jobright adds
 * jr_id=<its own id> to every link it sends people to, so a Greenhouse link carrying one is the
 * same job as that Jobright page. Links can also wrap the real one, like LinkedIn's externalApply.
 */
export function referencedIdentities(input: string | URL, depth = 0): AtsIdentity[] {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    return [];
  }
  const found: AtsIdentity[] = [];
  const jobright = url.searchParams.get('jr_id');
  if (jobright && JOBRIGHT_ID.test(jobright)) found.push({ provider: 'jobright', externalId: jobright.toLowerCase() });
  if (depth < 2) {
    for (const value of url.searchParams.values()) {
      const nested = /^https?%3A/i.test(value) ? safeDecode(value) : value;
      if (!/^https?:\/\//i.test(nested)) continue;
      const identity = identifyAts(nested);
      if (identity && identity.provider !== 'site') found.push(identity);
      found.push(...referencedIdentities(nested, depth + 1));
    }
  }
  const own = identifyAts(url);
  const seen = new Set(own ? [`${own.provider}\n${own.externalId}`] : []);
  return found.filter((identity) => {
    const key = `${identity.provider}\n${identity.externalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const TITLE_PARAMS = new Set(['jobtitle', 'job_title', 'job-title', 'businesstitle', 'positiontitle', 'position_title', 'jobname', 'job_name', 'title']);

/** A job title some links carry in a parameter, useful when the page itself cannot be read. */
export function titleFromUrl(input: string | URL): string | null {
  try {
    const url = typeof input === 'string' ? new URL(input) : input;
    for (const [name, value] of url.searchParams) {
      const text = value.replace(/\s+/g, ' ').trim();
      // Letters, a sensible length, and not a link or an id.
      if (TITLE_PARAMS.has(name.toLowerCase()) && text.length >= 3 && text.length <= 200 && /[a-z]{2}/i.test(text) && !/^https?:/i.test(text)) return text;
    }
  } catch {
    // Not a link, so no title in it.
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
  if (identity && identity.provider !== 'site') return identity.provider;
  const host = url.hostname.toLowerCase();
  for (const [pattern, name] of PLATFORM_HOSTS) {
    if (pattern.test(host)) return name;
  }
  return 'company';
}

/** Aggregators only list a job: an ATS id found on their page is the job's real identity. */
export const AGGREGATOR_PROVIDERS = ['linkedin', 'indeed', 'builtin', 'jobright', 'glassdoor', 'ziprecruiter', 'workable-board'];

export function isAggregator(provider: string | null | undefined): boolean {
  return !!provider && AGGREGATOR_PROVIDERS.includes(provider);
}

/** The page and customer a site's own id belongs to: "host/path|tenant…" without the id itself. */
function siteSystem(externalId: string): string {
  return externalId.slice(0, externalId.lastIndexOf('|'));
}

/**
 * Two ids from one system that differ: by that system's own word, two postings. An id a site
 * puts in a "?jobId=" parameter only says that about another id from the same page of the same
 * site, since two sites number their jobs separately.
 */
export function identifiersConflict(a: { provider: string; externalId: string }, b: { provider: string; externalId: string }): boolean {
  if (a.provider !== b.provider || a.externalId === b.externalId) return false;
  return a.provider !== 'site' || siteSystem(a.externalId) === siteSystem(b.externalId);
}

/**
 * Finds ATS links embedded in a page's HTML or JSON blobs. Only reported when the page
 * points at exactly one posting: several matches usually mean a "similar jobs" widget.
 */
export function discoverAtsLinks(html: string, ownIdentity: AtsIdentity | null): Array<{ url: string; identity: AtsIdentity }> {
  const found = new Map<string, { url: string; identity: AtsIdentity }>();
  const unescaped = html
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    // A link wrapped inside another one, like a "url=https%3A%2F%2F..." on an apply button.
    .replace(/https?%3A%2F%2F[^\s"'<>&]+/gi, (encoded) => ` ${safeDecode(encoded)} `);
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
