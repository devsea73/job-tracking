import { describe, expect, it } from 'vitest';
import { parseTitleCompany } from '../src/server/extraction/html';
import { extractJob } from '../src/server/extraction/pipeline';
import { FetchError } from '../src/server/extraction/safe-fetch';
import { htmlToText } from '../src/server/extraction/text';
import { FakeHttp, FakeRenderer, jobPage, LONG_DESCRIPTION } from './helpers';

function deps(renderer: FakeRenderer | null = null) {
  return { http: new FakeHttp(), renderer };
}

const URL_A = 'https://careers.acme.com/jobs/1';

describe('structured data', () => {
  it('reads schema.org/JobPosting', async () => {
    const d = deps();
    d.http.serve(URL_A, jobPage({ title: 'Staff Engineer', company: 'Acme', location: 'Austin' }));
    const result = await extractJob(URL_A, d);
    expect(result).toMatchObject({ ok: true, title: 'Staff Engineer', company: 'Acme', location: 'Austin', method: 'json-ld' });
    if (result.ok) {
      expect(result.description).toContain('Design, build and operate');
      expect(result.description).not.toContain('Copyright');
    }
  });

  it('finds postings nested in @graph and tolerates sloppy JSON', async () => {
    const d = deps();
    const graph = { '@graph': [{ '@type': 'WebSite' }, { '@type': ['JobPosting'], title: 'Nested Role', description: LONG_DESCRIPTION, hiringOrganization: 'Acme' }] };
    d.http.serve(URL_A, `<html><head><script type="application/ld+json">${JSON.stringify(graph, null, 1).replace(/\\n/g, '\n')};</script></head><body></body></html>`);
    expect(await extractJob(URL_A, d)).toMatchObject({ ok: true, title: 'Nested Role', company: 'Acme' });
  });

  it('ignores a listing page full of postings', async () => {
    const d = deps();
    const many = Array.from({ length: 6 }, (_, i) => ({ '@type': 'JobPosting', title: `Role ${i}`, description: LONG_DESCRIPTION, hiringOrganization: 'Acme' }));
    d.http.serve(URL_A, `<html><head><title>Careers</title><script type="application/ld+json">${JSON.stringify(many)}</script></head><body><h1>Careers</h1></body></html>`);
    expect((await extractJob(URL_A, d)).ok).toBe(false);
  });

  it('marks remote postings', async () => {
    const d = deps();
    const posting = { '@type': 'JobPosting', title: 'Remote Role', description: LONG_DESCRIPTION, hiringOrganization: { name: 'Acme' }, jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { name: 'USA' } };
    d.http.serve(URL_A, `<html><head><script type="application/ld+json">${JSON.stringify(posting)}</script></head></html>`);
    expect(await extractJob(URL_A, d)).toMatchObject({ ok: true, location: 'Remote; USA' });
  });
});

describe('plain HTML', () => {
  const page = `<!doctype html><html><head><title>Backend Engineer at Globex</title><meta property="og:title" content="Backend Engineer at Globex"></head>
    <body>
      <header><nav><a href="/">Home</a><a href="/jobs">All jobs</a></nav></header>
      <h1>Backend Engineer</h1>
      <div class="job-description"><h2>Responsibilities</h2><ul><li>Build APIs that serve millions of requests</li><li>Own services end to end, with on-call</li></ul>
        <p>We are looking for an experienced engineer with strong qualifications in distributed systems, databases and cloud infrastructure, who enjoys working closely with other teams.</p>
        <aside class="ads">Buy our sponsored course now!</aside>
      </div>
      <footer>Privacy policy. Terms. Copyright Globex.</footer>
    </body></html>`;

  it('reads known description containers and leaves out page furniture', async () => {
    const d = deps();
    d.http.serve(URL_A, page);
    const result = await extractJob(URL_A, d);
    expect(result).toMatchObject({ ok: true, title: 'Backend Engineer', company: 'Globex', method: 'site-html' });
    if (result.ok) {
      expect(result.description).toContain('- Build APIs');
      expect(result.description).not.toMatch(/Home|All jobs|Privacy policy|sponsored course/);
    }
  });

  it('keeps paragraphs and lists readable', () => {
    const text = htmlToText('<h2>Skills</h2><p>First para.</p><p>Second&nbsp;para.</p><ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul><script>evil()</script>');
    expect(text).toContain('Skills\n\nFirst para.\n\nSecond para.');
    expect(text).toContain('- One');
    expect(text).toContain('  - Nested');
    expect(text).not.toContain('evil');
  });

  it('decodes double-encoded HTML', () => {
    expect(htmlToText('&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;')).toContain('Hello');
  });

  it.each([
    ['Senior Engineer at Stripe', 'Senior Engineer', 'Stripe'],
    ['Job Application for Staff Data Engineer at Webflow', 'Staff Data Engineer', 'Webflow'],
    ['Stripe - Senior Engineer', 'Senior Engineer', 'Stripe'],
    ['Senior Engineer | Stripe', 'Senior Engineer', 'Stripe'],
    ['Everest Technologies - Data Engineer (Snowflake) - Remote Job', 'Data Engineer (Snowflake)', 'Everest Technologies'],
    ['Block - Careers - Software Engineer, Data Platform', 'Software Engineer, Data Platform', 'Block'],
    ['Apply to Data Engineer - Acme', 'Data Engineer', 'Acme']
  ])('parses the page title "%s"', (raw, title, company) => {
    expect(parseTitleCompany(raw)).toEqual({ title, company });
  });
});

describe('never presenting a non-posting as a job', () => {
  const noRenderer = () => deps(null);

  it('does not accept a short metadata teaser as the description', async () => {
    const d = noRenderer();
    d.http.serve(URL_A, `<html><head><title>Engineer at Acme</title><meta property="og:description" content="${'Acme builds things for people who like things. '.repeat(6)}"></head><body><h1>Engineer</h1></body></html>`);
    const result = await extractJob(URL_A, d);
    expect(result).toMatchObject({ ok: false, reason: 'incomplete' });
    if (!result.ok) expect(result.partial).toMatchObject({ title: 'Engineer', company: 'Acme' });
  });

  it('accepts metadata that clearly holds the whole posting', async () => {
    const d = noRenderer();
    d.http.serve(URL_A, `<html><head><title>Engineer at Acme</title><meta name="description" content="${(`${LONG_DESCRIPTION} `.repeat(2)).replace(/\n/g, ' ')}"></head><body><h1>Engineer</h1></body></html>`);
    expect(await extractJob(URL_A, d)).toMatchObject({ ok: true, method: 'open-graph' });
  });

  it.each(['Careers', 'Current openings at Acme', 'Search Jobs', 'Job Seeker Support', '{{company.name}} - Careers', 'Recruitment'])('rejects "%s" as a job title', async (title) => {
    const d = noRenderer();
    d.http.serve(URL_A, `<html><head><title>${title}</title></head><body><h1>${title}</h1><div class="job-description">${LONG_DESCRIPTION}</div></body></html>`);
    const result = await extractJob(URL_A, d);
    expect(result.ok).toBe(false);
  });

  it.each(['1.Introduction', 'mainPage.jobDetailsPage', 'Data Analytics Careers and Open Positions'])('rejects "%s", seen on real pages, as a job title', async (title) => {
    const d = noRenderer();
    d.http.serve(URL_A, `<html><head><title>${title}</title></head><body><h1>${title}</h1><div class="job-description">${LONG_DESCRIPTION}</div></body></html>`);
    expect((await extractJob(URL_A, d)).ok).toBe(false);
  });

  it('does not take a location out of a page title for the employer', async () => {
    const d = noRenderer();
    d.http.serve(URL_A, `<html><head><title>Senior Engineer - Snowflake in Remote, United States</title><meta property="og:site_name" content="CDW Jobs"></head><body><div class="job-description">${LONG_DESCRIPTION}</div></body></html>`);
    expect(await extractJob(URL_A, d)).toMatchObject({ ok: true, company: 'CDW' });
  });

  it('reads a cookie banner as noise, not as a posting', async () => {
    const d = noRenderer();
    d.http.serve(URL_A, `<html><head><title>Jobs</title></head><body><div class="cookie-banner"><p>We use cookies</p><p>on this site with your consent</p><p>to analyze our traffic and optimize your experience.</p></div></body></html>`);
    expect((await extractJob(URL_A, d)).ok).toBe(false);
  });

  it.each([
    ['closed page', 200, '<html><title>Careers</title><body><p>This job is no longer available.</p></body></html>'],
    ['"no longer accepting"', 200, '<html><title>Recruitment</title><body><p>We are no longer accepting applications for this position.</p></body></html>'],
    ['not found title', 200, '<html><title>Job Not Found</title><body><p>Sorry.</p></body></html>'],
    ['SPA 404 text', 200, "<html><title>Careers</title><body><script>var bundle='" + 'x'.repeat(5000) + "'</script><p>The page you are looking for doesn't exist.</p></body></html>"],
    ['HTTP 404', 404, jobPage({ title: 'Old Role', company: 'Acme' })],
    ['HTTP 410', 410, '<html><title>Sr. Data Engineer - Acme</title><body>Gone</body></html>']
  ])('reports a removed posting: %s', async (_name, status, body) => {
    const d = noRenderer();
    d.http.serve(URL_A, { status, body });
    expect(await extractJob(URL_A, d)).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('keeps a real posting that mentions closing further down', async () => {
    const d = noRenderer();
    const description = `${LONG_DESCRIPTION}\n\nPlease note: this position is no longer open once filled, so apply early.`;
    d.http.serve(URL_A, jobPage({ title: 'Engineer', company: 'Acme', description }));
    expect((await extractJob(URL_A, d)).ok).toBe(true);
  });
});

describe('failures', () => {
  it('reports a blocked page without saving its text', async () => {
    const d = deps();
    d.http.serve(URL_A, { status: 403, body: '<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing. <a>Verify you are human</a></body></html>' });
    const result = await extractJob(URL_A, d);
    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
    if (!result.ok) expect(result.partial.description).toBeNull();
  });

  it('recognizes a challenge page even under a large script bundle', async () => {
    const d = deps();
    d.http.serve(URL_A, `<html><head><title>Candidate Portal</title></head><body><script>var bundle="${'x'.repeat(9000)}"</script><h3>Quick security check</h3><p>Please confirm you're human to continue.</p></body></html>`);
    expect(await extractJob(URL_A, d)).toMatchObject({ ok: false, reason: 'blocked' });
  });

  it('offers nothing from the page title when the real page turns out to be a bot check', async () => {
    const r = new FakeRenderer();
    const d = deps(r);
    d.http.serve(URL_A, '<html><head><title>Acme Hiring Hub</title></head><body><div id="app"></div></body></html>');
    r.serve(URL_A, "<html><head><title>Acme Hiring Hub</title></head><body><h3>Quick security check</h3><p>Please confirm you're human to continue.</p></body></html>");
    const result = await extractJob(URL_A, d);
    expect(result).toMatchObject({ ok: false, reason: 'blocked' });
    if (!result.ok) expect(result.partial).toMatchObject({ title: null, company: null, description: null });
  });

  it("does not mistake Cloudflare's everyday script for a bot check", async () => {
    const r = new FakeRenderer();
    const d = deps(r);
    const shell = '<html><head><title>Loading</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body></body></html>';
    d.http.serve(URL_A, shell);
    r.serve(URL_A, shell.replace('<body></body>', `<body>${jobPage({ title: 'Engineer', company: 'Acme' })}</body>`));
    expect(await extractJob(URL_A, d)).toMatchObject({ ok: true, title: 'Engineer' });
  });

  it('does not mistake a captcha on an application form for a bot check', async () => {
    const d = deps();
    d.http.serve(URL_A, jobPage({ title: 'Engineer', company: 'Acme', extraBody: '<div class="g-recaptcha"></div>' }));
    expect((await extractJob(URL_A, d)).ok).toBe(true);
  });

  it('reports a sign-in wall', async () => {
    const r = new FakeRenderer();
    const d = deps(r);
    const login = '<html><head><title>Sign in to continue</title></head><body><form><input type="password"></form></body></html>';
    d.http.serve(URL_A, login);
    r.serve(URL_A, login);
    expect(await extractJob(URL_A, d)).toMatchObject({ ok: false, reason: 'blocked' });
  });

  it.each([
    ['timeout', new FetchError('timeout', 'The job site took too long to respond.'), 'timeout'],
    ['network', new FetchError('network', 'The job site could not be reached.'), 'network'],
    ['too large', new FetchError('too_large', 'This page is too large to process.'), 'too_large'],
    ['not a web page', new FetchError('not_html', 'This link returned application/pdf instead of a web page.'), 'not_html']
  ])('reports %s', async (_name, error, reason) => {
    const d = deps();
    d.http.serve(URL_A, { error });
    expect(await extractJob(URL_A, d)).toMatchObject({ ok: false, reason });
  });

  it('reports server errors', async () => {
    const d = deps();
    d.http.serve(URL_A, { status: 500, body: '<html><body>Oops</body></html>' });
    expect(await extractJob(URL_A, d)).toMatchObject({ ok: false, reason: 'http_error' });
  });

  it('hands over partial details for the manual form when fields are missing', async () => {
    const d = deps();
    d.http.serve(URL_A, '<html><head><title>Data Engineer</title></head><body><h1>Data Engineer</h1></body></html>');
    const result = await extractJob(URL_A, d);
    expect(result).toMatchObject({ ok: false, reason: 'incomplete' });
    if (!result.ok) {
      expect(result.partial.title).toBe('Data Engineer');
      expect(result.message).toMatch(/company.*description/);
    }
  });
});

describe('browser fallback', () => {
  it('renders pages that build themselves with JavaScript', async () => {
    const r = new FakeRenderer();
    const d = deps(r);
    d.http.serve(URL_A, '<html><head><title>Loading</title></head><body><div id="app"></div></body></html>');
    r.serve(URL_A, jobPage({ title: 'Rendered Role', company: 'Acme' }));
    const result = await extractJob(URL_A, d);
    expect(result).toMatchObject({ ok: true, title: 'Rendered Role', usedBrowser: true, method: 'browser' });
  });

  it('is not opened when the plain page already has the posting', async () => {
    const r = new FakeRenderer();
    const d = deps(r);
    d.http.serve(URL_A, jobPage({ title: 'Role', company: 'Acme' }));
    await extractJob(URL_A, d);
    expect(r.rendered).toEqual([]);
  });

  it('reads a posting shown in an ATS iframe on a career site', async () => {
    const r = new FakeRenderer();
    const d = deps(r);
    d.http.serve(URL_A, '<html><head><title>Careers</title></head><body></body></html>');
    const frame = 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=123';
    r.pages.set(URL_A, { html: '<html><body><iframe></iframe></body></html>', finalUrl: URL_A, status: 200, frames: [{ url: frame, html: '<html></html>' }] });
    d.http.serve('https://boards-api.greenhouse.io/v1/boards/acme/jobs/123', JSON.stringify({ title: 'Framed Role', company_name: 'Acme', content: LONG_DESCRIPTION }));
    const result = await extractJob(URL_A, d);
    expect(result).toMatchObject({ ok: true, title: 'Framed Role', discoveredUrls: [frame] });
  });

  it('falls through to a clear failure when no browser can be opened', async () => {
    const r = new FakeRenderer();
    const d = deps(r);
    d.http.serve(URL_A, '<html><head><title>Loading</title></head><body></body></html>');
    const result = await extractJob(URL_A, d);
    expect(result).toMatchObject({ ok: false, reason: 'incomplete' });
  });
});

describe('site adapters', () => {
  const longHtml = `<p>${LONG_DESCRIPTION}</p>`;

  it('Greenhouse: uses the board data endpoint', async () => {
    const d = deps();
    d.http.serve('https://boards-api.greenhouse.io/v1/boards/acme/jobs/42', JSON.stringify({ title: 'SWE', company_name: 'Acme', content: longHtml.replace(/</g, '&lt;').replace(/>/g, '&gt;'), location: { name: 'NYC' }, absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/42' }));
    const result = await extractJob('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=42&jr_id=x', d);
    expect(result).toMatchObject({ ok: true, title: 'SWE', company: 'Acme', location: 'NYC', method: 'api', canonicalUrl: 'https://job-boards.greenhouse.io/acme/jobs/42' });
  });

  it('Greenhouse: a job the API does not know is closed, however its page looks', async () => {
    const d = deps(new FakeRenderer());
    d.http.serve('https://boards-api.greenhouse.io/v1/boards/acme/jobs/42', { status: 404, body: '{"error":"Job not found"}', contentType: 'application/json' });
    d.http.serve('https://job-boards.greenhouse.io/embed/job_app?token=42&for=acme', '<html><head><title>Current openings at Acme</title></head><body><h1>Current openings at Acme</h1></body></html>');
    const result = await extractJob('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=42', d);
    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
    expect((d.renderer as FakeRenderer).rendered).toEqual([]);
  });

  it('Lever: combines the data endpoint with the page title for the employer', async () => {
    const id = 'a037c79a-6664-4fbb-842c-800c34cb1b68';
    const d = deps();
    d.http.serve(`https://api.lever.co/v0/postings/padsplit/${id}`, JSON.stringify({ text: 'Sr. Data Engineer', description: longHtml, lists: [{ text: 'Requirements', content: '<li>SQL</li>' }], additional: '<p>Benefits</p>', categories: { location: 'Atlanta, GA' }, hostedUrl: `https://jobs.lever.co/padsplit/${id}` }));
    d.http.serve(`https://jobs.lever.co/padsplit/${id}`, '<html><title>PadSplit - Sr. Data Engineer</title></html>');
    const result = await extractJob(`https://jobs.lever.co/padsplit/${id}/apply?utm_source=x`, d);
    expect(result).toMatchObject({ ok: true, title: 'Sr. Data Engineer', company: 'PadSplit', location: 'Atlanta, GA', method: 'api' });
    if (result.ok) expect(result.description).toContain('Requirements\n\n- SQL');
  });

  it('Workday: maps the page to its data endpoint, with or without /apply', async () => {
    for (const url of ['https://devoted.wd1.myworkdayjobs.com/Devoted/job/Remote-USA/Principal-Data-Engineer_R3798', 'https://devoted.wd1.myworkdayjobs.com/en-US/Devoted/job/Remote-USA/Principal-Data-Engineer_R3798/apply?source=x']) {
      const d = deps();
      d.http.serve('https://devoted.wd1.myworkdayjobs.com/wday/cxs/devoted/Devoted/job/Remote-USA/Principal-Data-Engineer_R3798', JSON.stringify({ jobPostingInfo: { title: 'Principal Data Engineer', jobDescription: longHtml, location: 'Remote USA', jobReqId: 'R3798' }, hiringOrganization: { name: 'Devoted Health' } }));
      expect(await extractJob(url, d)).toMatchObject({ ok: true, title: 'Principal Data Engineer', company: 'Devoted Health', method: 'api' });
    }
  });

  it('Workday: its own error page means closed, even behind a cookie notice or Cloudflare', async () => {
    const r = new FakeRenderer();
    const d = deps(r);
    const url = 'https://naic.wd115.myworkdayjobs.com/naic/job/Kansas-City/Sr-Data-Engineer_JR101235';
    const api = 'https://naic.wd115.myworkdayjobs.com/wday/cxs/naic/naic/job/Kansas-City/Sr-Data-Engineer_JR101235';
    d.http.serve(api, { status: 403, body: '{"errorCode":"S22"}', contentType: 'application/json' });
    d.http.serve(url, '<html><head><title></title></head><body><div id="root"></div></body></html>');
    const notice = 'Thank you for your interest in employment. '.repeat(30);
    r.serve(url, `<html><head><title>Careers</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body><h1>${notice}</h1><div data-automation-id="errorMessage">This content isn’t available.</div></body></html>`);
    expect(await extractJob(url, d)).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('Greenhouse: tries the board named in a wrapper link, or the company domain', async () => {
    const posting = JSON.stringify({ title: 'SWE', company_name: 'Samsara', content: longHtml });
    const named = deps();
    named.http.serve('https://boards-api.greenhouse.io/v1/boards/samsara/jobs/8039914', posting);
    expect(await extractJob('https://www.samsara.com/company/careers/roles/8039914?gh_jid=8039914&gh_board=samsara', named)).toMatchObject({ ok: true, company: 'Samsara', method: 'api' });

    const guessed = deps();
    guessed.http.serve('https://boards-api.greenhouse.io/v1/boards/block/jobs/5281312008', JSON.stringify({ title: 'SWE', company_name: 'Block', content: longHtml }));
    expect(await extractJob('https://block.xyz/careers/jobs/5281312008?gh_jid=5281312008', guessed)).toMatchObject({ ok: true, company: 'Block', method: 'api' });
  });

  it('Greenhouse: a wrong guess at the board does not mark the job closed', async () => {
    const d = deps();
    d.http.serve('https://thrivemarketjobs.com/job_posting.html?id=1&gh_jid=1', jobPage({ title: 'Engineer', company: 'Thrive Market' }));
    expect(await extractJob('https://thrivemarketjobs.com/job_posting.html?id=1&gh_jid=1', d)).toMatchObject({ ok: true, company: 'Thrive Market' });
  });

  it('Workday: tidies the payroll codes in employer names', async () => {
    const cases = [
      ['6090-Johnson & Johnson Services Inc. Legal Entity', 'Johnson & Johnson Services Inc.'],
      ['8100 United States - Genesys Cloud Services', 'Genesys Cloud Services'],
      ['3Cloud', '3Cloud'],
      ['1Password', '1Password']
    ];
    for (const [raw, expected] of cases) {
      const d = deps();
      d.http.serve('https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Ext/job/Remote/Role_R1', JSON.stringify({ jobPostingInfo: { title: 'Role', jobDescription: longHtml }, hiringOrganization: { name: raw } }));
      expect(await extractJob('https://acme.wd1.myworkdayjobs.com/Ext/job/Remote/Role_R1', d)).toMatchObject({ ok: true, company: expected });
    }
  });

  it('Workday: a consent notice in the rendered app is not the posting', async () => {
    const r = new FakeRenderer();
    const d = deps(r);
    const url = 'https://teladoc.wd503.myworkdayjobs.com/Ext/job/Remote/Principal-Engineer_JR1';
    d.http.serve(url, '<html><head><title>Careers</title></head><body></body></html>');
    const notice = Array.from({ length: 8 }, (_, i) => `<p>Section ${i}: your experience, skills and benefits information may be used as described in this privacy notice for employees.</p>`).join('');
    r.serve(url, `<html><head><title>Careers</title></head><body><h1>1.Introduction</h1><main>${notice}</main></body></html>`);
    expect(await extractJob(url, d)).toMatchObject({ ok: false, reason: 'incomplete' });
  });

  it('Workday: reads the posting from the rendered app when the data endpoint fails', async () => {
    const r = new FakeRenderer();
    const d = deps(r);
    const url = 'https://acme.wd1.myworkdayjobs.com/Ext/job/Remote/Principal-Engineer_JR1';
    d.http.serve(url, '<html><head><title>Careers</title></head><body></body></html>');
    r.serve(url, `<html><head><title>Careers</title></head><body><h2 data-automation-id="jobPostingHeader">Principal Engineer</h2><div data-automation-id="jobPostingDescription">${longHtml}</div></body></html>`);
    expect(await extractJob(`${url}/apply?source=x`, d)).toMatchObject({ ok: true, title: 'Principal Engineer', company: 'Acme' });
  });

  it('Greenhouse: a link without a board name is read as it is', async () => {
    const d = deps();
    const url = 'https://boards.greenhouse.io/embed/job_app?token=7567977';
    const remix = { state: { loaderData: { job: { jobPost: { title: 'Senior Software Engineer', company_name: 'Acme', content: longHtml.replace(/</g, '&lt;').replace(/>/g, '&gt;') } } } } };
    d.http.serve(url, `<html><body><script>window.__remixContext = ${JSON.stringify(remix)};</script></body></html>`);
    expect(await extractJob(`${url}&utm_source=x&jr_id=y`.replace('&utm_source=x&jr_id=y', ''), d)).toMatchObject({ ok: true, title: 'Senior Software Engineer', company: 'Acme', method: 'embedded-data' });
  });

  it('Workday: follows the shared myworkdaysite.com host', async () => {
    const d = deps();
    d.http.serve('https://wd1.myworkdaysite.com/wday/cxs/ssctech/SSCTechnologies/job/Remote/Engineer_R46427', JSON.stringify({ jobPostingInfo: { title: 'Engineer', jobDescription: longHtml }, hiringOrganization: { name: 'SS&C' } }));
    expect(await extractJob('https://wd1.myworkdaysite.com/recruiting/ssctech/SSCTechnologies/job/Remote/Engineer_R46427', d)).toMatchObject({ ok: true, company: 'SS&C' });
  });

  it('SmartRecruiters: joins the sections of the job ad', async () => {
    const d = deps();
    d.http.serve('https://api.smartrecruiters.com/v1/companies/Vericast/postings/744000145288291', JSON.stringify({ name: 'Senior Data Engineer ', company: { name: 'Vericast' }, location: { city: 'San Antonio', region: 'TX', remote: true }, jobAd: { sections: { jobDescription: { title: 'Job Description', text: longHtml }, qualifications: { title: 'Qualifications', text: '<p>SQL</p>' } } } }));
    const result = await extractJob('https://jobs.smartrecruiters.com/Vericast/744000145288291-senior-data-engineer-', d);
    expect(result).toMatchObject({ ok: true, title: 'Senior Data Engineer', company: 'Vericast', location: 'Remote; San Antonio, TX' });
    if (result.ok) expect(result.description).toContain('Qualifications\n\nSQL');
  });

  it('iCIMS: leaves a login code from an emailed link behind', async () => {
    const d = deps();
    d.http.serve('https://careers-acme.icims.com/jobs/6849/job?in_iframe=1', jobPage({ title: 'Engineer', company: 'Acme' }));
    const result = await extractJob('https://careers-acme.icims.com/jobs/6849/engineer/candidate?from=login&eem=SECRET&code=SECRET', d);
    expect(result).toMatchObject({ ok: true, title: 'Engineer' });
    expect(d.http.requests.join(' ')).not.toContain('SECRET');
  });

  it('Jobright: reads its embedded data and the ATS link inside the page', async () => {
    const d = deps();
    const data = { props: { pageProps: { dataSource: { jobResult: { jobTitle: 'Senior Data Engineer', jobSummary: LONG_DESCRIPTION, coreResponsibilities: ['Build things'], jobLocation: 'Remote' }, companyResult: { companyName: 'Machinify' } } } } };
    d.http.serve('https://jobright.ai/jobs/info/abc123', `<html><head><title>Senior Data Engineer @ Machinify | Jobright.ai</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script><a href="https://job-boards.greenhouse.io/machinifyinc/jobs/4116095009">Apply</a></body></html>`);
    const result = await extractJob('https://jobright.ai/jobs/info/abc123', d);
    expect(result).toMatchObject({ ok: true, title: 'Senior Data Engineer', company: 'Machinify', location: 'Remote', method: 'embedded-data' });
    if (result.ok) expect(result.discoveredUrls).toEqual(['https://job-boards.greenhouse.io/machinifyinc/jobs/4116095009']);
  });

  it('LinkedIn: uses the public guest view', async () => {
    const d = deps();
    d.http.serve('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/3812345678', `<html><body><h2 class="top-card-layout__title">Staff Engineer</h2><a class="topcard__org-name-link">Globex</a><span class="topcard__flavor--bullet">Remote</span><div class="show-more-less-html__markup">${longHtml}</div></body></html>`);
    expect(await extractJob('https://www.linkedin.com/jobs/view/staff-engineer-at-globex-3812345678/', d)).toMatchObject({ ok: true, title: 'Staff Engineer', company: 'Globex', location: 'Remote' });
  });

  it('Built In: is read from the JSON-LD it publishes', async () => {
    const d = deps();
    d.http.serve('https://builtin.com/job/principal-data-engineer/12088047', jobPage({ title: 'Principal Data Engineer', company: 'Applied Systems' }));
    expect(await extractJob('https://builtin.com/job/principal-data-engineer/12088047', d)).toMatchObject({ ok: true, company: 'Applied Systems', method: 'json-ld' });
  });
});
