import { describe, expect, it } from 'vitest';
import { identifiersConflict, identifyAts, isAggregator } from '../src/server/dedupe/ats';
import { normalizeUrl, parseUserUrl, stripPersonalParams } from '../src/server/dedupe/url-normalize';

describe('URL normalization (layer A)', () => {
  const same = (...urls: string[]) => {
    const keys = new Set(urls.map((url) => normalizeUrl(url)));
    expect(keys.size, [...keys].join('\n')).toBe(1);
  };
  const different = (a: string, b: string) => expect(normalizeUrl(a)).not.toBe(normalizeUrl(b));

  it('treats tracking parameters, fragments, case and trailing slashes as noise', () => {
    same(
      'https://company.com/jobs/12345',
      'https://company.com/jobs/12345?utm_source=linkedin',
      'https://company.com/jobs/12345?ref=jobright',
      'https://COMPANY.com/jobs/12345/',
      'http://www.company.com/jobs/12345#apply',
      'https://company.com/jobs/12345?fbclid=abc&gclid=def&utm_campaign=x&jr_id=6a91',
      '  company.com/jobs/12345  '
    );
  });

  it('keeps parameters that identify the job and sorts them', () => {
    same('https://company.com/careers?jobId=7&dept=eng', 'https://company.com/careers?dept=eng&jobId=7&utm_source=x');
    different('https://company.com/careers?jobId=7', 'https://company.com/careers?jobId=8');
    different('https://company.com/job?id=1', 'https://company.com/job?id=2');
  });

  it('keeps fragment routes that name a job and drops ones that do not', () => {
    different('https://company.com/careers#/jobs/1', 'https://company.com/careers#/jobs/2');
    same('https://company.com/careers', 'https://company.com/careers#top');
  });

  it('removes application-form suffixes on known systems', () => {
    same('https://jobs.lever.co/acme/a037c79a-6664-4fbb-842c-800c34cb1b68', 'https://jobs.lever.co/acme/a037c79a-6664-4fbb-842c-800c34cb1b68/apply?lever-source=x');
    same('https://jobs.ashbyhq.com/acme/1de5b39f-0000-4000-8000-000000000001', 'https://jobs.ashbyhq.com/acme/1de5b39f-0000-4000-8000-000000000001/application?utm_source=jobright');
    same('https://acme.wd1.myworkdayjobs.com/en-US/Ext/job/Remote/Engineer_R123/apply', 'https://acme.wd1.myworkdayjobs.com/Ext/job/Remote/Engineer_R123');
    same('https://recruiting.paylocity.com/Recruiting/Jobs/Apply/4436875', 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/4436875?jr_id=1');
  });

  it('keeps Greenhouse job tokens and JobDiva job fragments', () => {
    different('https://job-boards.greenhouse.io/embed/job_app?for=a&token=1', 'https://job-boards.greenhouse.io/embed/job_app?for=a&token=2');
    different('https://www1.jobdiva.com/portal/?a=abc#/jobs/1', 'https://www1.jobdiva.com/portal/?a=abc#/jobs/2');
    same('https://www1.jobdiva.com/portal/?a=abc&jr_id=1#/jobs/1', 'https://www1.jobdiva.com/portal/?a=abc&jr_id=2#/jobs/1');
  });

  it('refuses things that are not web links', () => {
    for (const bad of ['', 'not a url', 'Glassdoor easy apply', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/x', 'https://user:pw@example.com/x']) {
      expect(() => parseUserUrl(bad), bad).toThrow();
    }
  });

  it('keeps what names the job on sites that put it in a parameter or an anchor', () => {
    // BambooHR's older links: the id is the only thing that differs.
    different('https://acme.bamboohr.com/jobs/view.php?id=42', 'https://acme.bamboohr.com/jobs/view.php?id=57');
    same('https://acme.bamboohr.com/jobs/view.php?id=42', 'https://acme.bamboohr.com/jobs/view.php?id=42&source=indeed');
    // Indeed's sponsored listings name their job only in "ad".
    different('https://www.indeed.com/pagead/clk?mo=r&ad=-6NYlbfkN0AAA&p=1', 'https://www.indeed.com/pagead/clk?mo=r&ad=-6NYlbfkN0BBB&p=1');
    // A careers page listing every job: the anchor is which one.
    different('https://smallco.com/careers#backend-engineer', 'https://smallco.com/careers#office-manager');
    different('https://smallco.com/#backend-engineer', 'https://smallco.com/#office-manager');
    // Its own sections are not jobs.
    same('https://smallco.com/careers', 'https://smallco.com/careers#open-roles', 'https://smallco.com/careers#benefits');
    // On a job's own page, an anchor is still just a place on the page.
    same('https://smallco.com/careers/backend-engineer', 'https://smallco.com/careers/backend-engineer#apply-now');
  });

  it('strips personal tokens from what gets stored and compared', () => {
    const link = 'https://careers-x.icims.com/jobs/6849/job/candidate?from=login&eem=SECRET1&code=SECRET2';
    expect(stripPersonalParams(link)).not.toMatch(/SECRET/);
    expect(stripPersonalParams(link)).toContain('from=login');
    expect(normalizeUrl('https://company.com/job/1?rx_viewer=SECRET3&code=SECRET4')).toBe('https://company.com/job/1');
  });
});

describe('ATS identifiers (layer C)', () => {
  const identity = (url: string) => {
    const found = identifyAts(url);
    return found ? `${found.provider}:${found.externalId}` : null;
  };

  it.each([
    ['https://job-boards.greenhouse.io/embed/job_app?for=acme&token=4116095009&jr_id=1', 'greenhouse:4116095009'],
    ['https://boards.greenhouse.io/embed/job_app?token=4116095009', 'greenhouse:4116095009'],
    ['https://job-boards.greenhouse.io/acme/jobs/4116095009', 'greenhouse:4116095009'],
    ['https://acme.com/careers?gh_jid=4116095009', 'greenhouse:4116095009'],
    ['https://jobs.lever.co/acme/A037C79A-6664-4FBB-842C-800C34CB1B68/apply', 'lever:a037c79a-6664-4fbb-842c-800c34cb1b68'],
    ['https://jobs.ashbyhq.com/acme/bd41cc28-25b3-4a6b-8d1b-bf7120ded5b4/application', 'ashby:bd41cc28-25b3-4a6b-8d1b-bf7120ded5b4'],
    ['https://www.mdcalc.com/careers?ashby_jid=bd41cc28-25b3-4a6b-8d1b-bf7120ded5b4', 'ashby:bd41cc28-25b3-4a6b-8d1b-bf7120ded5b4'],
    ['https://acme.wd1.myworkdayjobs.com/Ext/job/Remote-USA/Principal-Engineer_R3798', 'workday:acme/R3798'],
    ['https://acme.wd1.myworkdayjobs.com/en-US/ext/job/remote-usa/principal-engineer_r3798/apply', 'workday:acme/R3798'],
    ['https://acme.wd1.myworkdayjobs.com/External/job/Data-Engineer_43865/apply?utm_source=zip', 'workday:acme/43865'],
    ['https://wd1.myworkdaysite.com/recruiting/acme/Ext/job/Remote/Engineer_R46427', 'workday:acme/R46427'],
    ['https://careers-acme.icims.com/jobs/8044/sr.-data-engineer/job?in_iframe=1', 'icims:acme/8044'],
    ['https://apply.workable.com/acme/j/5B349C9322/', 'workable:acme/5B349C9322'],
    ['https://www1.jobdiva.com/portal/?a=abc#/jobs/29382464', 'jobdiva:29382464'],
    ['https://recruiting.ultipro.com/x/JobBoard/y/OpportunityDetail?opportunityId=FF4F5956', 'ukg:ff4f5956'],
    ['https://findorff.rec.pro.ukg.net/J/JobBoard/y/OpportunityDetail?opportunityId=5B591A44', 'ukg:5b591a44'],
    ['https://www.linkedin.com/jobs/view/senior-engineer-at-acme-3812345678/', 'linkedin:3812345678'],
    ['https://builtin.com/job/senior-software-engineer/123456', 'builtin:123456'],
    ['https://jobright.ai/jobs/info/abc123', 'jobright:abc123']
  ])('%s', (url, expected) => {
    expect(identity(url)).toBe(expected);
  });

  it('sees posting variants of one Workday requisition as the same job', () => {
    expect(identity('https://acme.wd503.myworkdayjobs.com/a/job/Remote/Engineer_JR100704-1')).toBe('workday:acme/JR100704');
    expect(identity('https://acme.wd503.myworkdayjobs.com/b/job/Remote/Engineer_JR100704')).toBe('workday:acme/JR100704');
  });

  it('does not shorten a Workday id into something another job could share', () => {
    expect(identity('https://a.wd1.myworkdayjobs.com/x/job/y/Engineer_2026-12')).toBe('workday:a/2026-12');
    expect(identity('https://a.wd1.myworkdayjobs.com/x/job/y/Engineer_REQ-12')).toBe('workday:a/REQ-12');
    expect(identity('https://a.wd1.myworkdayjobs.com/x/job/y/Engineer_JR-000431')).toBe('workday:a/JR-000431');
  });

  it('scopes per-tenant ids so that different employers never collide', () => {
    expect(identity('https://recruiterflow.com/HR/jobs/716')).not.toBe(identity('https://recruiterflow.com/releady/jobs/716'));
    expect(identity('https://a.wd1.myworkdayjobs.com/x/job/y/E_R1')).not.toBe(identity('https://b.wd1.myworkdayjobs.com/x/job/y/E_R1'));
    expect(identity('https://careers-a.icims.com/jobs/1/job')).not.toBe(identity('https://careers-b.icims.com/jobs/1/job'));
  });

  it('finds nothing on ordinary pages', () => {
    expect(identity('https://company.com/careers/backend-engineer')).toBeNull();
  });

  it('reads BambooHR ids from both shapes of its links, as one posting', () => {
    expect(identity('https://acme.bamboohr.com/careers/42')).toBe('bamboohr:acme/42');
    expect(identity('https://acme.bamboohr.com/jobs/view.php?id=42')).toBe('bamboohr:acme/42');
    expect(identity('https://acme.bamboohr.com/jobs/view.php?id=57')).toBe('bamboohr:acme/57');
  });

  it('treats ZipRecruiter ids as a listing site’s, never as the employer’s', () => {
    const found = identifyAts('https://www.ziprecruiter.com/c/Acme/Job/Data-Engineer/-in-Austin,TX?jid=a1b2c3d4e5');
    expect(found).toMatchObject({ provider: 'ziprecruiter', externalId: 'a1b2c3d4e5' });
    expect(isAggregator(found?.provider)).toBe(true);
  });

  it('only sees a conflict between ids from one page of one site', () => {
    const a = identifyAts('https://acme.com/careers/job?jobId=101');
    const b = identifyAts('https://acme.com/careers/job?jobId=202');
    const elsewhere = identifyAts('https://staffing-partner.com/jobs/view?jobId=909');
    if (!a || !b || !elsewhere) throw new Error('expected ids');
    expect(identifiersConflict(a, b)).toBe(true);
    // Two sites number their jobs separately: the same posting copied elsewhere is not "another job".
    expect(identifiersConflict(a, elsewhere)).toBe(false);
    expect(identifiersConflict({ provider: 'greenhouse', externalId: '1' }, { provider: 'greenhouse', externalId: '2' })).toBe(true);
    expect(identifiersConflict({ provider: 'greenhouse', externalId: '1' }, { provider: 'lever', externalId: '2' })).toBe(false);
  });
});
