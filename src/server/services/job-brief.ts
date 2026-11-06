import type { ApplicationDetail, ApplicationLink, JobBrief, JobDetail } from '../../shared/api';
import type { UserRole } from '../../shared/constants';
import { isUnreadableNote } from '../../shared/unreadable';
import type { AppContext } from '../context';
import { getJobDetail } from './job-queries';

/**
 * What someone deciding whether to apply wants at a glance, for the notification another
 * person's new application raises: the stack, the industry, and the tags.
 */

const TECH: Array<[string, RegExp]> = [
  ['Python', /\bpython\b/i],
  ['Java', /\bjava\b(?!\s*script)/i],
  ['Go', /\bgolang\b|(?:^|[\s(,/])Go(?=[\s,/)]|$)(?!\s+(?:to|ahead|live|beyond|deeper|further|above)\b)/],
  ['TypeScript', /\btypescript\b/i],
  ['JavaScript', /\bjavascript\b/i],
  ['Node.js', /\bnode(?:\.js|js)?\b(?!\s+(?:pool|group|label|count|affinit))/i],
  ['React', /\breact(?:\.js|js)?\b(?!\s+(?:to|quickly|fast))/i],
  ['Angular', /\bangular\b/i],
  ['Vue', /\bvue(?:\.js)?\b/i],
  ['C#', /(?:^|[^a-z0-9])c#(?![a-z0-9])/i],
  ['.NET', /(?:^|\s)\.net\b|\basp\.net\b|\bdotnet\b/i],
  ['C++', /\bc\+\+/i],
  ['Ruby', /\bruby\b/i],
  ['Rails', /\brails\b/i],
  ['PHP', /\bphp\b/i],
  ['Laravel', /\blaravel\b/i],
  ['Kotlin', /\bkotlin\b/i],
  ['Swift', /\bswift\b(?!ly)/i],
  ['Scala', /\bscala\b/i],
  ['Rust', /\brust\b(?!ic)/i],
  ['Elixir', /\belixir\b/i],
  ['Django', /\bdjango\b/i],
  ['FastAPI', /\bfastapi\b/i],
  ['Spring', /\bspring\s*boot\b|\bspring\b(?=\s*(?:framework|mvc|cloud))/i],
  ['Snowflake', /\bsnowflake\b/i],
  ['Databricks', /\bdatabricks\b/i],
  ['Spark', /\b(?:py)?spark\b/i],
  ['Kafka', /\bkafka\b/i],
  ['Airflow', /\bairflow\b/i],
  ['dbt', /\bdbt\b/i],
  ['Redshift', /\bredshift\b/i],
  ['BigQuery', /\bbigquery\b/i],
  ['AWS', /\baws\b|\bamazon web services\b/i],
  ['Azure', /\bazure\b/i],
  ['GCP', /\bgcp\b|\bgoogle cloud\b/i],
  ['Kubernetes', /\bkubernetes\b|\bk8s\b/i],
  ['Docker', /\bdocker\b/i],
  ['Terraform', /\bterraform\b/i],
  ['PostgreSQL', /\bpostgres(?:ql)?\b/i],
  ['MongoDB', /\bmongo(?:db)?\b/i],
  ['GraphQL', /\bgraphql\b/i],
  ['Salesforce', /\bsalesforce\b/i],
  ['Tableau', /\btableau\b/i],
  ['Power BI', /\bpower\s?bi\b/i]
];

/** The technologies a posting leans on most, those in its title first. */
export function deriveStack(title: string, description: string, limit = 5): string[] {
  const scored: Array<{ name: string; score: number }> = [];
  for (const [name, pattern] of TECH) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    const inText = description.match(global)?.length ?? 0;
    const inTitle = pattern.test(title) ? 10 : 0;
    if (inText + inTitle > 0) scored.push({ name, score: inText + inTitle });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.name);
}

const INDUSTRIES: Array<[string, RegExp]> = [
  ['Healthcare', /\bhealth ?care\b|\bpatients?\b|\bclinical\b|\bhospitals?\b|\bmedical\b|\bclinicians?\b|\bmedicaid\b|\bmedicare\b|\bpharmac(?:y|ies)\b/gi],
  ['Fintech', /\bfintech\b|\bpayments?\b|\bbanking\b|\bbanks?\b|\blending\b|\bloans?\b|\bcredit cards?\b|\btrading\b|\binvestments?\b|\bwealth\b|\bfinancial services\b/gi],
  ['Insurance', /\binsurance\b|\binsurers?\b|\bclaims\b|\bunderwriting\b|\bpolicyholders?\b/gi],
  ['Government', /\bfederal\b|\bgovernment\b|\bpublic sector\b|\bdefen[cs]e\b|\bdod\b|\bagenc(?:y|ies)\b|\bmilitary\b/gi],
  ['Cybersecurity', /\bcyber ?security\b|\bthreats?\b|\bsecurity operations\b|\bmalware\b|\bvulnerabilit(?:y|ies)\b|\bsoc\b/gi],
  ['E-commerce', /\be-?commerce\b|\bretail(?:ers?)?\b|\bshoppers?\b|\bmarketplace\b|\bmerchants?\b|\bcheckout\b/gi],
  ['Education', /\bedtech\b|\beducation(?:al)?\b|\bstudents?\b|\blearners?\b|\bteachers?\b|\buniversit(?:y|ies)\b|\bschools?\b/gi],
  ['Energy', /\benergy\b|\bsolar\b|\butilit(?:y|ies)\b|\boil and gas\b|\brenewables?\b|\bgrid\b|\bclean ?tech\b/gi],
  ['Logistics', /\blogistics\b|\bsupply chain\b|\bshipping\b|\bfreight\b|\bwarehous(?:e|ing)\b|\bfleet\b|\bdelivery\b/gi],
  ['Real estate', /\breal estate\b|\bproperty\b|\bproperties\b|\bmortgages?\b|\brentals?\b|\bhomebuyers?\b|\bproptech\b/gi],
  ['Media & gaming', /\bmedia\b|\bstreaming\b|\bgam(?:e|es|ing)\b|\bentertainment\b|\bmusic\b|\bcontent creators?\b/gi],
  ['Travel', /\btravel\b|\bhospitality\b|\bhotels?\b|\bairlines?\b|\bbookings?\b/gi],
  ['HR tech', /\bhr tech\b|\bhuman resources\b|\bpayroll\b|\brecruiting\b|\bworkforce\b|\bhiring platform\b/gi],
  ['Biotech', /\bbiotech\b|\bpharma(?:ceutical)?s?\b|\blife sciences\b|\bgenomics?\b|\bdrug discovery\b/gi],
  ['Automotive', /\bautomotive\b|\bvehicles?\b|\bcars?\b|\bdealerships?\b|\bev\b/gi],
  ['Telecom', /\btelecom(?:munications)?\b|\bwireless\b|\bcarriers?\b|\b5g\b/gi],
  ['Legal', /\blegal\b|\blaw firms?\b|\battorneys?\b|\blitigation\b/gi],
  ['Marketing', /\bmarketing\b|\badvertis(?:ing|ers)\b|\bad tech\b|\badtech\b|\bcampaigns?\b/gi]
];

/** The industry a posting is about, when its text says so clearly enough. */
export function deriveIndustry(company: string, description: string): string | null {
  const text = `${company}\n${description}`;
  let best: { name: string; hits: number } | null = null;
  for (const [name, pattern] of INDUSTRIES) {
    const hits = text.match(pattern)?.length ?? 0;
    if (hits > (best?.hits ?? 0)) best = { name, hits };
  }
  // A passing mention is not what a company does.
  return best && best.hits >= 3 ? best.name : null;
}

/**
 * The link to offer: the one the person in the notice applied with, since it is the posting they
 * mean. Someone who joined without a link: the first link anyone applied with, then the first saved.
 */
function linkToOffer(job: JobDetail, source: ApplicationDetail | null): ApplicationLink | null {
  if (source?.link) return source.link;
  const used = job.applications.find((application) => application.link)?.link;
  if (used) return used;
  const saved = job.urls.find((url) => url.kind === 'original') ?? job.urls[0];
  return saved ? { id: saved.id, url: saved.originalUrl } : null;
}

export function getJobBrief(ctx: AppContext, viewer: { id: number; role: UserRole }, jobId: number, applicationId?: number): JobBrief {
  const job = getJobDetail(ctx, viewer.id, jobId);
  const source = job.applications.find((application) => application.id === applicationId) ?? job.applications[job.applications.length - 1] ?? null;
  // Whoever applied first found the job; everyone after them only joined it.
  const first = [...job.applications].sort((a, b) => a.appliedAt.localeCompare(b.appliedAt) || a.id - b.id)[0];
  const description = isUnreadableNote(job.description) ? '' : job.description;
  const link = linkToOffer(job, source);
  return {
    jobId: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    url: link?.url ?? null,
    urlId: link?.id ?? null,
    viewerIsAdmin: viewer.role === 'admin',
    owner: source ? (source.owner.displayName ?? source.owner.username) : null,
    profile: source?.profile.name ?? null,
    addedByMe: source?.isMine ?? false,
    foundIt: !!source && source.id === first?.id,
    alreadyApplied: job.applications.some((application) => application.isMine),
    facts: job.facts,
    stack: deriveStack(job.title, description),
    industry: description ? deriveIndustry(job.company, description) : null
  };
}
