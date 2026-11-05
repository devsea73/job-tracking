import type { CheerioAPI } from 'cheerio';
import type { AtsIdentity } from '../dedupe/ats';
import type { HttpClient } from './safe-fetch';
import { FetchError } from './safe-fetch';
import { cleanInline, htmlToText } from './text';
import type { PartialJob } from './types';

/**
 * Pipeline step 3: site-specific knowledge. Where a job system publishes the posting as
 * data, that is read instead of scraping its page: it is faster, and it cannot pick up
 * navigation or advertisements.
 */

export interface AdapterContext {
  url: URL;
  identity: AtsIdentity | null;
  http: HttpClient;
  /** Set when the job system's own data endpoint says this posting does not exist. */
  gone?: boolean;
}

export interface SiteAdapter {
  name: string;
  /**
   * The system's pages are an application around the posting, which can show consent notices
   * and other long text. Only its data and known markup count, never a guess at the content.
   */
  structuredOnly?: boolean;
  matches(ctx: Pick<AdapterContext, 'url' | 'identity'>): boolean;
  /** Reads the posting from a public data endpoint. */
  api?(ctx: AdapterContext): Promise<PartialJob | null>;
  /** The page to fetch when it is not the link itself, e.g. the application form's job view. */
  pageUrl?(ctx: AdapterContext): string | null;
  /** Reads posting data embedded in the page's HTML. */
  embedded?($: CheerioAPI, html: string, ctx: AdapterContext): PartialJob | null;
}

type Json = Record<string, any>;

/** Failed data calls are not fatal: the pipeline goes on to read the page. Unsafe URLs still abort. */
async function getJson(ctx: Pick<AdapterContext, 'http' | 'gone'>, url: string): Promise<Json | null> {
  try {
    const response = await ctx.http.fetch(url, { accept: 'json' });
    if (response.status === 404 || response.status === 410) ctx.gone = true;
    if (response.status >= 400) return null;
    return JSON.parse(response.body) as Json;
  } catch (error) {
    if (error instanceof FetchError && error.reason === 'unsafe_url') throw error;
    return null;
  }
}

/** Joins the sections a posting is split into, under their headings. */
function sections(parts: Array<[heading: string | null, html: unknown]>): string | null {
  const blocks = parts
    .map(([heading, html]) => {
      const text = typeof html === 'string' ? htmlToText(html) : '';
      if (!text) return null;
      return heading ? `${heading}\n\n${text}` : text;
    })
    .filter((block): block is string => !!block);
  return blocks.length ? blocks.join('\n\n') : null;
}

/** "About Avalon Healthcare Solutions" as a posting's opening heading. */
function employerFromIntroduction(description: string | null): string | null {
  const name = description?.match(/^\s*About\s+([A-Z][\w&.,' -]{1,48})\s*(?:\n|:)/)?.[1]?.trim();
  if (!name || /^(the|this|us|our|you|we)\b/i.test(name)) return null;
  return name;
}

export function humanizeSlug(slug: string | undefined | null): string | null {
  if (!slug) return null;
  const words = decodeSafe(slug)
    .replace(/^\d+-/, '')
    .replace(/[-_.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || /^[0-9a-f]{16,}$/i.test(slug)) return null;
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function pageTitleCompany(html: string): string | null {
  const title = cleanInline(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]);
  return title?.split(/\s+[-|–—]\s+/)[0]?.trim() || null;
}

const greenhouse: SiteAdapter = {
  name: 'greenhouse',
  matches: ({ identity }) => identity?.provider === 'greenhouse',
  async api(ctx) {
    const { identity, url, http } = ctx;
    if (!identity) return null;
    const endpoint = (board: string) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${identity.externalId}`;
    // A wrapper page on a company's own site: the board may be in the link, and is usually
    // the company's domain name ("block.xyz" is board "block"). A wrong guess proves nothing.
    const board = identity.board ?? url.searchParams.get('gh_board');
    const job = board ? await getJson(ctx, endpoint(board)) : await getJson({ http }, endpoint(url.hostname.split('.').slice(-2)[0]));
    if (!job?.title) return null;
    return {
      title: cleanInline(job.title),
      company: cleanInline(job.company_name),
      description: job.content ? htmlToText(job.content) : null,
      location: cleanInline(job.location?.name),
      requisitionId: job.requisition_id ?? null,
      canonicalUrl: typeof job.absolute_url === 'string' ? job.absolute_url : null
    };
  },
  // Without a board name the link itself is the only address known to work, and on a
  // company's own site it is the wrapper page, which names its board.
  pageUrl: ({ identity }) => (identity?.board ? `https://job-boards.greenhouse.io/embed/job_app?token=${identity.externalId}&for=${encodeURIComponent(identity.board)}` : null),
  embedded(_$, html) {
    const raw = html.match(/window\.__remixContext\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/)?.[1];
    if (!raw) return null;
    try {
      const routes = Object.values((JSON.parse(raw) as Json).state?.loaderData ?? {}) as Json[];
      const post = routes.find((route) => route?.jobPost)?.jobPost;
      if (!post?.title) return null;
      return {
        title: cleanInline(post.title),
        company: cleanInline(post.company_name),
        description: sections([
          [null, post.introduction],
          [null, post.content],
          [null, post.conclusion]
        ]),
        location: cleanInline(post.job_post_location),
        canonicalUrl: typeof post.public_url === 'string' ? post.public_url : null
      };
    } catch {
      return null;
    }
  }
};

const lever: SiteAdapter = {
  name: 'lever',
  matches: ({ identity }) => identity?.provider === 'lever',
  async api(ctx) {
    const { url, identity, http } = ctx;
    if (!identity?.board) return null;
    const host = url.hostname.includes('.eu.') ? 'api.eu.lever.co' : 'api.lever.co';
    const job = await getJson(ctx, `https://${host}/v0/postings/${encodeURIComponent(identity.board)}/${identity.externalId}`);
    if (!job?.text) return null;
    // The data endpoint does not name the employer; the page title does ("PadSplit - Sr. Data Engineer").
    let company: string | null = null;
    try {
      const page = await http.fetch(`https://${url.hostname}/${encodeURIComponent(identity.board)}/${identity.externalId}`);
      if (page.status < 400) company = pageTitleCompany(page.body);
    } catch {
      // A missing page only costs the display name, which falls back to the board name.
    }
    return {
      title: cleanInline(job.text),
      company: company ?? humanizeSlug(identity.board),
      description: sections([
        [null, job.description ?? job.descriptionBody],
        ...((job.lists ?? []) as Json[]).map((list): [string | null, unknown] => [cleanInline(list.text), `<ul>${list.content ?? ''}</ul>`]),
        [null, job.additional]
      ]),
      location: cleanInline(job.categories?.allLocations?.join('; ') ?? job.categories?.location),
      canonicalUrl: typeof job.hostedUrl === 'string' ? job.hostedUrl : null
    };
  },
  pageUrl: ({ url }) => url.toString().replace(/\/apply(?=$|[?#])/, '')
};

const ashby: SiteAdapter = {
  name: 'ashby',
  matches: ({ identity }) => identity?.provider === 'ashby',
  // The job page carries a complete schema.org/JobPosting, which step 1 reads.
  pageUrl: ({ identity }) => (identity?.board ? `https://jobs.ashbyhq.com/${encodeURIComponent(identity.board)}/${identity.externalId}` : null),
  embedded($, html) {
    const raw = html.match(/window\.__appData\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/)?.[1];
    if (!raw) return null;
    try {
      const data = JSON.parse(raw) as Json;
      if (!data.posting?.title) return null;
      return {
        title: cleanInline(data.posting.title),
        company: cleanInline(data.organization?.name) ?? cleanInline($('meta[property="og:site_name"]').attr('content')),
        description: data.posting.descriptionHtml ? htmlToText(data.posting.descriptionHtml) : null,
        location: cleanInline(data.posting.locationName)
      };
    } catch {
      return null;
    }
  }
};

function workdayApiUrl(url: URL): string | null {
  const shared = url.pathname.match(/^\/(?:[a-z]{2}-[A-Z]{2}\/)?recruiting\/([^/]+)\/([^/]+)\/(?:job|details)\/(.+?)(?:\/apply(?:\/.*)?)?\/?$/i);
  if (shared) return `https://${url.hostname}/wday/cxs/${shared[1]}/${shared[2]}/job/${shared[3]}`;
  const tenant = url.hostname.split('.')[0];
  const own = url.pathname.match(/^\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)\/(?:job|details)\/(.+?)(?:\/apply(?:\/.*)?)?\/?$/i);
  return own ? `https://${url.hostname}/wday/cxs/${tenant}/${own[1]}/job/${own[2]}` : null;
}

const workday: SiteAdapter = {
  name: 'workday',
  structuredOnly: true,
  matches: ({ url }) => /\.(myworkdayjobs|myworkdaysite)\.com$/i.test(url.hostname),
  // A link to the application form leads to a sign-in page, the posting is one level up.
  pageUrl: ({ url }) => `https://${url.hostname}${url.pathname.replace(/\/apply(\/.*)?$/i, '')}`,
  embedded($, _html, ctx) {
    if ($('[data-automation-id="errorMessage"]').length > 0) ctx.gone = true;
    const title = cleanInline($('[data-automation-id="jobPostingHeader"]').first().text());
    const description = $('[data-automation-id="jobPostingDescription"]').first().html();
    if (!title && !description) return null;
    return {
      title,
      company: null,
      description: description ? htmlToText(description) : null,
      location: cleanInline($('[data-automation-id="locations"] dd').first().text())
    };
  },
  async api(ctx) {
    const { url, identity } = ctx;
    const endpoint = workdayApiUrl(url);
    if (!endpoint) return null;
    // A miss here proves nothing: links that leave out the location segment miss even when
    // the job is live. Whether it is closed is left for the page itself to say.
    const data = await getJson({ http: ctx.http }, endpoint);
    const info = data?.jobPostingInfo as Json | undefined;
    if (!info?.title) return null;
    return {
      title: cleanInline(info.title),
      company: cleanInline(data?.hiringOrganization?.name) ?? humanizeSlug(identity?.board),
      description: info.jobDescription ? htmlToText(info.jobDescription) : null,
      location: cleanInline(info.location),
      requisitionId: info.jobReqId ?? null,
      canonicalUrl: typeof info.externalUrl === 'string' ? info.externalUrl : null
    };
  }
};

const smartRecruiters: SiteAdapter = {
  name: 'smartrecruiters',
  matches: ({ identity }) => identity?.provider === 'smartrecruiters',
  async api(ctx) {
    const { identity } = ctx;
    if (!identity?.board) return null;
    const id = identity.externalId.replace(/^publication\//, '');
    const job = await getJson(ctx, `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(identity.board)}/postings/${id}`);
    if (!job?.name) return null;
    const ad = (job.jobAd?.sections ?? {}) as Json;
    const place = job.location ?? {};
    const where = cleanInline(place.fullLocation?.replace(/^[,\s]+$/, '')) ?? ([place.city, place.region, place.country].filter(Boolean).join(', ') || null);
    return {
      title: cleanInline(job.name),
      company: cleanInline(job.company?.name) ?? humanizeSlug(identity.board),
      description: sections([
        [ad.companyDescription?.title ?? null, ad.companyDescription?.text],
        [ad.jobDescription?.title ?? null, ad.jobDescription?.text],
        [ad.qualifications?.title ?? null, ad.qualifications?.text],
        [ad.additionalInformation?.title ?? null, ad.additionalInformation?.text]
      ]),
      location: place.remote ? (where ? `Remote; ${where}` : 'Remote') : where,
      requisitionId: job.refNumber ?? null,
      canonicalUrl: typeof job.postingUrl === 'string' ? job.postingUrl : null
    };
  }
};

const workable: SiteAdapter = {
  name: 'workable',
  matches: ({ identity }) => identity?.provider === 'workable',
  async api(ctx) {
    const { identity, http } = ctx;
    if (!identity?.board) return null;
    const code = identity.externalId.split('/')[1];
    const account = encodeURIComponent(identity.board);
    const job = await getJson(ctx, `https://apply.workable.com/api/v2/accounts/${account}/jobs/${code}`);
    if (!job?.title) return null;
    const about = await getJson({ http }, `https://apply.workable.com/api/v1/accounts/${account}`);
    const place = (job.location ?? {}) as Json;
    const where = [place.city, place.region, place.country].filter(Boolean).join(', ') || null;
    return {
      title: cleanInline(job.title),
      company: cleanInline(about?.name) ?? humanizeSlug(identity.board),
      description: sections([
        [null, job.description],
        ['Requirements', job.requirements],
        ['Benefits', job.benefits]
      ]),
      location: job.remote ? (where ? `Remote; ${where}` : 'Remote') : where,
      requisitionId: job.code || null,
      canonicalUrl: `https://apply.workable.com/${account}/j/${code}/`
    };
  }
};

const rippling: SiteAdapter = {
  name: 'rippling',
  matches: ({ url, identity }) => identity?.provider === 'rippling' && url.hostname === 'ats.rippling.com',
  async api(ctx) {
    const { identity } = ctx;
    if (!identity?.board) return null;
    const job = await getJson(ctx, `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(identity.board)}/jobs/${identity.externalId}`);
    if (!job?.name) return null;
    return {
      title: cleanInline(job.name),
      company: cleanInline(job.board?.companyName) ?? humanizeSlug(identity.board),
      description: sections([
        [null, job.description?.company],
        [null, job.description?.role]
      ]),
      location: Array.isArray(job.workLocations) ? cleanInline(job.workLocations.join('; ')) : null,
      canonicalUrl: typeof job.url === 'string' ? job.url : null
    };
  }
};

const recruitee: SiteAdapter = {
  name: 'recruitee',
  matches: ({ identity }) => identity?.provider === 'recruitee',
  async api(ctx) {
    const slug = ctx.url.pathname.match(/^\/o\/([^/]+)/)?.[1];
    if (!slug) return null;
    const { url } = ctx;
    const data = await getJson(ctx, `https://${url.hostname}/api/offers/${slug}`);
    const offer = data?.offer as Json | undefined;
    if (!offer?.title) return null;
    return {
      title: cleanInline(offer.title),
      company: cleanInline(offer.company_name),
      description: sections([
        [null, offer.description],
        ['Requirements', offer.requirements]
      ]),
      location: cleanInline(offer.location)
    };
  }
};

const oracle: SiteAdapter = {
  name: 'oracle',
  matches: ({ identity }) => identity?.provider === 'oracle',
  async api(ctx) {
    const { url } = ctx;
    const path = url.pathname.match(/\/sites\/([^/]+)\/(?:my-profile\/)?job\/(\d+)/i);
    if (!path) return null;
    const finder = `ById;Id=%22${path[2]}%22,siteNumber=${path[1]}`;
    const data = await getJson(ctx, `https://${url.hostname}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=${finder}`);
    const item = (data?.items as Json[] | undefined)?.[0];
    if (!item?.Title) return null;
    return {
      title: cleanInline(item.Title),
      company: cleanInline(item.LegalEmployer) ?? cleanInline(item.BusinessUnit) ?? cleanInline(item.Organization),
      description: sections([
        [null, item.CorporateDescriptionStr],
        [null, item.ExternalDescriptionStr],
        ['Responsibilities', item.ExternalResponsibilitiesStr],
        ['Qualifications', item.ExternalQualificationsStr],
        [null, item.OrganizationDescriptionStr]
      ]),
      location: cleanInline(item.PrimaryLocation),
      requisitionId: item.RequisitionId ? String(item.RequisitionId) : null
    };
  }
};

const bambooHr: SiteAdapter = {
  name: 'bamboohr',
  matches: ({ identity }) => identity?.provider === 'bamboohr',
  async api(ctx) {
    const { url, identity, http } = ctx;
    const id = url.pathname.match(/\/(?:careers|jobs)\/(?:view\.php\?id=)?(\d+)/)?.[1];
    if (!id) return null;
    const data = await getJson(ctx, `https://${url.hostname}/careers/${id}/detail`);
    const opening = data?.result?.jobOpening as Json | undefined;
    if (!opening?.jobOpeningName) return null;
    const about = await getJson({ http }, `https://${url.hostname}/careers/company-info`);
    const place = (opening.location ?? {}) as Json;
    return {
      title: cleanInline(opening.jobOpeningName),
      company: cleanInline(about?.result?.name) ?? humanizeSlug(identity?.board),
      description: opening.description ? htmlToText(opening.description) : null,
      location: [place.city, place.state].filter(Boolean).join(', ') || (opening.isRemote ? 'Remote' : null),
      canonicalUrl: typeof opening.jobOpeningShareUrl === 'string' ? opening.jobOpeningShareUrl : null
    };
  }
};

const icims: SiteAdapter = {
  name: 'icims',
  matches: ({ identity }) => identity?.provider === 'icims',
  // The plain view is a wrapper around an iframe. Rebuilding the link also leaves behind
  // any login code that came with a link copied from an email.
  pageUrl: ({ url }) => {
    const id = url.pathname.match(/^\/jobs\/(\d+)/)?.[1];
    return id ? `https://${url.hostname}/jobs/${id}/job?in_iframe=1` : null;
  }
};

const adp: SiteAdapter = {
  name: 'adp',
  matches: ({ url }) => url.hostname === 'workforcenow.adp.com' && url.searchParams.has('cid') && url.searchParams.has('jobId'),
  async api(ctx) {
    const { url } = ctx;
    const params = new URLSearchParams({
      cid: url.searchParams.get('cid') ?? '',
      timeStamp: String(Date.now()),
      lang: 'en_US',
      ccId: url.searchParams.get('ccId') ?? '19000101_000001',
      locale: 'en_US'
    });
    const jobId = encodeURIComponent(url.searchParams.get('jobId') ?? '');
    const job = await getJson(ctx, `https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions/${jobId}?${params}`);
    if (!job?.requisitionTitle) return null;
    const places = ((job.requisitionLocations ?? []) as Json[])
      .map((place) => cleanInline(place.nameCode?.shortName ?? place.address?.cityName))
      .filter(Boolean);
    const description = job.requisitionDescription ? htmlToText(job.requisitionDescription) : null;
    return {
      title: cleanInline(job.requisitionTitle),
      // ADP's data does not name the employer, but postings usually open by doing so.
      company: cleanInline(job.organizationalUnits?.[0]?.nameCode?.shortName) ?? employerFromIntroduction(description),
      description,
      location: places.length ? places.join('; ') : null,
      requisitionId: job.clientRequisitionID ?? null
    };
  }
};

const paylocity: SiteAdapter = {
  name: 'paylocity',
  matches: ({ identity }) => identity?.provider === 'paylocity',
  pageUrl: ({ identity }) => (identity ? `https://recruiting.paylocity.com/Recruiting/Jobs/Details/${identity.externalId}` : null),
  embedded(_$, html) {
    const raw = html.match(/window\.pageData\s*=\s*(\{[\s\S]*?\});?\s*(?:<\/script>|window\.)/)?.[1];
    if (!raw) return null;
    try {
      const data = JSON.parse(raw) as Json;
      const job = (data.Job ?? {}) as Json;
      if (!job.JobTitle) return null;
      return {
        title: cleanInline(job.JobTitle),
        company: cleanInline(data.CompanyName ?? job.CompanyName),
        description: sections([
          [null, job.Description],
          ['Requirements', job.Requirements]
        ]),
        location: cleanInline(job.LocationName ?? job.Location)
      };
    } catch {
      return null;
    }
  }
};

const jobright: SiteAdapter = {
  name: 'jobright',
  matches: ({ url }) => /(^|\.)jobright\.ai$/i.test(url.hostname),
  embedded($) {
    const raw = $('script#__NEXT_DATA__').first().text();
    if (!raw) return null;
    try {
      const props = (JSON.parse(raw) as Json).props?.pageProps as Json;
      const job = props?.dataSource?.jobResult as Json | undefined;
      if (!job?.jobTitle) return null;
      const list = (items: unknown) =>
        Array.isArray(items) && items.length
          ? `<ul>${items
              .filter((item): item is string => typeof item === 'string')
              .map((item) => `<li>${item.replace(/</g, '&lt;')}</li>`)
              .join('')}</ul>`
          : null;
      return {
        title: cleanInline(job.jobTitle),
        company: cleanInline(props.dataSource?.companyResult?.companyName),
        description: sections([
          [null, job.jobSummary],
          ['Responsibilities', list(job.coreResponsibilities)],
          ['Qualifications', list(job.qualifications?.mustHave ?? job.detailQualifications)]
        ]),
        location: cleanInline(job.jobLocation)
      };
    } catch {
      return null;
    }
  }
};

const linkedIn: SiteAdapter = {
  name: 'linkedin',
  matches: ({ identity }) => identity?.provider === 'linkedin',
  // LinkedIn's public guest view of a posting, the one served to people who are not signed in.
  pageUrl: ({ identity }) => (identity ? `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${identity.externalId}` : null),
  embedded($) {
    const title = cleanInline($('.top-card-layout__title, .topcard__title').first().text());
    if (!title) return null;
    const description = $('.show-more-less-html__markup, .description__text').first().html();
    return {
      title,
      company: cleanInline($('.topcard__org-name-link, .topcard__flavor a').first().text()),
      description: description ? htmlToText(description) : null,
      location: cleanInline($('.topcard__flavor--bullet').first().text())
    };
  }
};

const comeet: SiteAdapter = {
  name: 'comeet',
  matches: ({ identity }) => identity?.provider === 'comeet',
  // The page is an unrendered template; the data behind it is embedded alongside.
  embedded(_$, html, ctx) {
    const raw = html.match(/COMPANY_POSITIONS_DATA\s*=\s*(\[[\s\S]*?\]);\s*\n/)?.[1];
    if (!raw) return null;
    try {
      const uid = ctx.url.pathname.split('/').filter(Boolean).pop()?.toUpperCase() ?? '';
      const position = (JSON.parse(raw) as Json[]).find((item) => typeof item.uid === 'string' && uid.startsWith(item.uid.toUpperCase()));
      // The list holds every open position: one that is missing has been closed.
      if (!position) ctx.gone = true;
      if (!position?.name) return null;
      const details = (position.custom_fields?.details ?? []) as Json[];
      const place = (position.location ?? {}) as Json;
      return {
        title: cleanInline(position.name),
        company: cleanInline(position.company_name),
        description: sections(details.map((detail): [string | null, unknown] => [cleanInline(detail.name), detail.value])),
        location: cleanInline(place.name) ?? ([place.city, place.state, place.country].filter(Boolean).join(', ') || null)
      };
    } catch {
      return null;
    }
  }
};

const rippleHire: SiteAdapter = {
  name: 'ripplehire',
  matches: ({ identity }) => identity?.provider === 'ripplehire',
  async api(ctx) {
    const token = ctx.url.searchParams.get('token');
    const id = ctx.url.hash.match(/detail\/job\/(\d+)/)?.[1];
    if (!token || !id) return null;
    const data = await getJson(ctx, `https://${ctx.url.hostname}/candidate/candidatejobdetail?token=${encodeURIComponent(token)}&jobSeq=${id}&lang=en`);
    const job = data?.jobVO as Json | undefined;
    if (!job?.jobTitle) return null;
    return {
      title: cleanInline(job.jobTitle),
      company: cleanInline(data?.companyVO?.companyName),
      description: sections([
        [null, job.jobDesc],
        ['Skills', job.jobSkills],
        [null, job.compensationRange]
      ]),
      location: cleanInline(job.locations ?? job.jobLocation),
      requisitionId: job.jobCode ?? null
    };
  }
};

const careerPuck: SiteAdapter = {
  name: 'careerpuck',
  matches: ({ identity }) => identity?.provider === 'careerpuck',
  async api(ctx) {
    const { identity, url } = ctx;
    if (!identity?.board) return null;
    const data = await getJson(ctx, `https://api.careerpuck.com/v1/public/job-boards/${encodeURIComponent(identity.board)}`);
    const id = url.pathname.split('/').filter(Boolean).pop();
    const job = (data?.jobs as Json[] | undefined)?.find((item) => item.atsSourceId === id || item.permalink === id);
    // The board lists every open job: one missing from the list has been closed.
    if (data && !job) ctx.gone = true;
    if (!job?.title) return null;
    return {
      title: cleanInline(job.title),
      company: cleanInline(data?.employerProfile?.name) ?? humanizeSlug(identity.board),
      description: job.content ? htmlToText(job.content) : null,
      location: cleanInline(job.location)
    };
  }
};

const dover: SiteAdapter = {
  name: 'dover',
  matches: ({ identity }) => identity?.provider === 'dover',
  async api(ctx) {
    if (!ctx.identity) return null;
    const job = await getJson(ctx, `https://app.dover.com/api/v1/inbound/application-portal-job/${ctx.identity.externalId}`);
    if (!job?.title) return null;
    return {
      title: cleanInline(job.title),
      company: cleanInline(job.client_name),
      description: job.user_provided_description ? htmlToText(job.user_provided_description) : null,
      location: Array.isArray(job.locations) ? cleanInline(job.locations.map((place: Json) => place?.name).filter(Boolean).join('; ')) : null
    };
  }
};

const hireBridge: SiteAdapter = {
  name: 'hirebridge',
  matches: ({ identity }) => identity?.provider === 'hirebridge',
  embedded($) {
    const heading = $('h3')
      .filter((_, element) => /^\s*job description\s*$/i.test($(element).text()))
      .first();
    const html = heading.parent().clone();
    html.find('h3').first().remove();
    const description = html.html();
    if (!description) return null;
    // "Senior Data Engineer  Product Management  Jobs in  US-Remote  Fusion Risk Management"
    const parts = $('title')
      .first()
      .text()
      .split(/ \s*|\s{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);
    return {
      title: cleanInline(parts[0]),
      company: cleanInline(parts[parts.length - 1]),
      description: htmlToText(description),
      location: null
    };
  }
};

const pinpoint: SiteAdapter = {
  name: 'pinpoint',
  matches: ({ identity }) => identity?.provider === 'pinpoint',
  // Links often point at the application form rather than the posting.
  pageUrl: ({ url }) => `https://${url.hostname}${url.pathname.replace(/\/applications\/new\/?$/, '')}`
};

const phenomApply: SiteAdapter = {
  name: 'phenom',
  matches: ({ url }) => /\/apply$/.test(url.pathname) && url.searchParams.has('jobSeqNo'),
  // ".../us/en/apply?jobSeqNo=X" is the application form for ".../us/en/job/X".
  pageUrl: ({ url }) => `https://${url.hostname}${url.pathname.replace(/\/apply$/, '')}/job/${url.searchParams.get('jobSeqNo')}`
};

const ukg: SiteAdapter = {
  name: 'ukg',
  matches: ({ identity }) => identity?.provider === 'ukg',
  // The description comes from the general content steps; this page's title and employer are not in its metadata.
  embedded($) {
    const title = cleanInline($('[data-automation="opportunity-title"]').first().text());
    if (!title) return null;
    return {
      title,
      company: cleanInline($('[data-automation="navbar-large-logo"] img, img[data-automation="navbar-large-logo"]').first().attr('alt')),
      description: null,
      location: cleanInline($('[data-automation="physical-location-item"], [data-automation="physical-location"]').first().text())
    };
  }
};

const ADAPTERS: SiteAdapter[] = [
  ukg,
  comeet,
  rippleHire,
  careerPuck,
  dover,
  hireBridge,
  pinpoint,
  phenomApply,
  greenhouse,
  lever,
  ashby,
  workday,
  smartRecruiters,
  workable,
  rippling,
  recruitee,
  oracle,
  bambooHr,
  icims,
  adp,
  paylocity,
  jobright,
  linkedIn
];

export function findAdapter(ctx: Pick<AdapterContext, 'url' | 'identity'>): SiteAdapter | null {
  return ADAPTERS.find((adapter) => adapter.matches(ctx)) ?? null;
}

/**
 * Company sites embed their ATS with a script tag. The tag names the board that the
 * wrapper page's own URL leaves out ("?gh_jid=123" on the company's domain).
 */
export function findEmbeddedBoard(html: string, identity: AtsIdentity): string | null {
  if (identity.provider === 'greenhouse') {
    return html.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=|embed\/job_app\?for=)([A-Za-z0-9_-]+)/)?.[1] ?? null;
  }
  if (identity.provider === 'ashby') {
    return html.match(/jobs\.ashbyhq\.com\/([^/"'?\s]+)(?:\/embed|\/[0-9a-f]{8}-)/i)?.[1] ?? null;
  }
  return null;
}
