import { describe, expect, it } from 'vitest';
import { annualSalary, combineFacts, deriveJobFacts, EMPTY_FACTS, parseEmploymentType, parsePostedAt, parseSalaryText, parseWorkArrangement } from '../src/server/dedupe/job-facts';

const facts = (description: string, extra: Partial<Parameters<typeof deriveJobFacts>[0]> = {}) => deriveJobFacts({ title: 'Data Engineer', company: 'Acme', description, ...extra });

describe('work arrangement', () => {
  it('reads what sites publish as data', () => {
    expect(parseWorkArrangement('TELECOMMUTE')).toBe('remote');
    expect(parseWorkArrangement('Hybrid')).toBe('hybrid');
    expect(parseWorkArrangement('On-site')).toBe('onsite');
    expect(parseWorkArrangement('')).toBeNull();
  });

  it('prefers data, then the location and title, then the text', () => {
    expect(facts('Work remotely.', { hints: { workArrangement: 'onsite' } }).workArrangement).toBe('onsite');
    expect(facts('This is an on-site role.', { location: 'Remote, US' }).workArrangement).toBe('remote');
    expect(facts('', { title: 'Data Engineer (Hybrid)' }).workArrangement).toBe('hybrid');
    expect(facts('This is a fully remote position.').workArrangement).toBe('remote');
    expect(facts('We use a hybrid model, 3 days a week in the office.').workArrangement).toBe('hybrid');
  });

  it('is not fooled by a negation', () => {
    expect(facts('This is not a remote role.').workArrangement).toBe('onsite');
  });

  it('stays unknown when nothing says', () => {
    expect(facts('Build data pipelines with Python and SQL.').workArrangement).toBeNull();
    // Passing mentions of remote teams say nothing about this job.
    expect(facts('You will collaborate with remote teammates and hybrid cloud systems.').workArrangement).toBeNull();
  });
});

describe('employment type', () => {
  it('reads sites’ own labels', () => {
    expect(parseEmploymentType('FULL_TIME')).toBe('permanent');
    expect(parseEmploymentType('CONTRACTOR')).toBe('contract');
    expect(parseEmploymentType('Contract to hire')).toBe('contract');
    expect(parseEmploymentType('Regular')).toBe('permanent');
    expect(parseEmploymentType('Part-time')).toBeNull();
  });

  it('finds a contract in the title or the text', () => {
    expect(facts('', { title: 'Data Engineer - Contract' }).employmentType).toBe('contract');
    expect(facts('', { title: 'Data Engineer (W2)' }).employmentType).toBe('contract');
    expect(facts('This is a 6 month contract.').employmentType).toBe('contract');
  });

  it('does not take a job about contracts for a contract job', () => {
    expect(facts('', { title: 'Contract Manager' }).employmentType).toBeNull();
    expect(facts('You will negotiate vendor contracts and contract renewals.').employmentType).toBeNull();
  });

  it('lets the text overrule a site’s default label', () => {
    // Many sites label everything as full time, while the posting itself says contract.
    expect(facts('This is a contract position for 12 months.', { hints: { employmentType: 'FULL_TIME' } }).employmentType).toBe('contract');
  });

  it('finds a permanent role', () => {
    expect(facts('This is a permanent position.').employmentType).toBe('permanent');
    expect(facts('Job type: Full-time').employmentType).toBe('permanent');
  });
});

describe('security clearance', () => {
  it('names the level', () => {
    expect(facts('Must hold an active TS/SCI.').clearance).toBe('TS/SCI');
    expect(facts('Top Secret clearance required.').clearance).toBe('Top Secret');
    expect(facts('Clearance Required: Secret Clearance').clearance).toBe('Secret');
    expect(facts('Candidates must hold an active DoW Secret (or higher) clearance').clearance).toBe('Secret');
    expect(facts('Clearance Level Must Currently Possess:\n\nSecret').clearance).toBe('Secret');
    expect(facts('Public Trust/Other Required:\n\nNACI (T1)').clearance).toBe('Public Trust');
    expect(facts('Requires the ability to obtain a security clearance.').clearance).toBe('Required');
  });

  it('notices when it is ruled out', () => {
    expect(facts('No security clearance is needed for this role.').clearance).toBeNull();
    expect(facts('A security clearance is not required.').clearance).toBeNull();
    expect(facts('Public Trust/Other Required:\n\nNone').clearance).toBeNull();
    expect(facts('Clearance Level Must Currently Possess:\n\nNone').clearance).toBeNull();
  });

  it('only counts what the job requires', () => {
    expect(facts('Security clearance preferred.').clearance).toBeNull();
    expect(facts('An active Secret clearance is a plus.').clearance).toBeNull();
    expect(facts('Nice to have:\n\n- Power BI or Tableau\n\n- An active Secret clearance or higher').clearance).toBeNull();
    expect(facts('Preferred Qualifications:\n- Top Secret clearance').clearance).toBeNull();
    // A later "preferred" elsewhere does not cancel a real requirement.
    expect(facts('Requires a DoD clearance.\nSecurity clearance preferred for the team lead.').clearance).toBe('Required');
    expect(facts('Must hold a Secret clearance. Python is preferred, and many other things are too.').clearance).toBe('Secret');
  });

  it('ignores other uses of the words', () => {
    expect(facts('Keep customer secrets safe. Clearance sale analytics.').clearance).toBeNull();
    expect(facts('Protect trade secrets and maintain trust with the public.').clearance).toBeNull();
  });
});

describe('federal position', () => {
  it('recognizes government work', () => {
    expect(facts('Support DoD customers on a new program.').isFederal).toBe(true);
    expect(facts('Support a mission-critical federal health data modernization initiative.').isFederal).toBe(true);
    expect(facts('Experience working in the U.S. Federal Government space.').isFederal).toBe(true);
    expect(facts('Candidates must pass a clearance through the U.S. Federal Government.').isFederal).toBe(true);
    expect(facts('Delivering to every major agency across the U.S. government.').isFederal).toBe(true);
    expect(facts('', { title: 'Federal Data Engineer' }).isFederal).toBe(true);
    expect(facts('', { company: 'Acme Federal Services' }).isFederal).toBe(true);
    expect(facts('', { urls: ['https://www.usajobs.gov/job/123'] }).isFederal).toBe(true);
    expect(facts('', { urls: ['https://www.army.mil/careers/5'] }).isFederal).toBe(true);
  });

  it('is not fooled by legal text every employer carries', () => {
    expect(facts('As a federal contractor, Acme is an affirmative action employer.').isFederal).toBe(false);
    expect(facts('You may file complaints with the Office of Federal Contract Compliance Programs.').isFederal).toBe(false);
    expect(facts('Acme participates in the federal government’s E-Verify program.').isFederal).toBe(false);
    expect(facts('We will provide the federal government with your Form I-9 information.').isFederal).toBe(false);
    expect(facts('Contact the Department of Homeland Security (DHS) or Social Security Administration (SSA).').isFederal).toBe(false);
    expect(facts('We comply with all federal, state and local laws.').isFederal).toBe(false);
    expect(facts('Benefits include federal holidays off.').isFederal).toBe(false);
  });

  it('is not fooled by passing mentions', () => {
    expect(facts('Used by small schools, government agencies and Global 100 enterprises.').isFederal).toBe(false);
    expect(facts('Community organizations, government agencies and hospitals are all connected.').isFederal).toBe(false);
    expect(facts('Experience with data from the Census Bureau and other federal agencies.').isFederal).toBe(false);
    expect(facts('Each story needs a clear DoD and acceptance criteria.').isFederal).toBe(false);
  });

  it('knows a bank is not the government', () => {
    expect(facts('', { company: 'Navy Federal Credit Union' }).isFederal).toBe(false);
    expect(facts('', { company: 'Federal Home Loan Bank' }).isFederal).toBe(false);
  });
});

describe('salary', () => {
  it('reads the usual ways of writing it', () => {
    expect(parseSalaryText('The base salary is $120,000 - $150,000 per year.')).toMatchObject({ salaryMin: 120_000, salaryMax: 150_000, salaryCurrency: 'USD', salaryPeriod: 'year' });
    expect(parseSalaryText('$100K/yr - $150K/yr')).toMatchObject({ salaryMin: 100_000, salaryMax: 150_000, salaryPeriod: 'year' });
    expect(parseSalaryText('Range: $100-150K')).toMatchObject({ salaryMin: 100_000, salaryMax: 150_000 });
    expect(parseSalaryText('$60/hr - $80/hr')).toMatchObject({ salaryMin: 60, salaryMax: 80, salaryPeriod: 'hour' });
    expect(parseSalaryText('Pay is $75 per hour')).toMatchObject({ salaryMin: 75, salaryMax: 75, salaryPeriod: 'hour' });
    expect(parseSalaryText('£60,000 to £80,000 a year')).toMatchObject({ salaryCurrency: 'GBP', salaryMin: 60_000 });
  });

  it('does not take other amounts for pay', () => {
    expect(parseSalaryText('We raised $250M in funding.')).toBeNull();
    expect(parseSalaryText('Backed by $10 - $20 million in revenue.')).toBeNull();
    expect(parseSalaryText('A 401(k) match and a $500 home office budget.')).toBeNull();
    expect(parseSalaryText('Processes $1,000,000 - $9,000,000 a day in payments.')).toBeNull();
  });

  it('compares hourly and yearly pay on one scale', () => {
    expect(annualSalary({ salaryMin: 50, salaryMax: 60, salaryPeriod: 'hour' })).toEqual({ min: 104_000, max: 124_800 });
    expect(annualSalary({ salaryMin: 100_000, salaryMax: 120_000, salaryPeriod: 'year' })).toEqual({ min: 100_000, max: 120_000 });
    expect(annualSalary({ salaryMin: null, salaryMax: null, salaryPeriod: null })).toBeNull();
  });
});

describe('posting date', () => {
  it('reads dates, timestamps and a site’s own format', () => {
    expect(parsePostedAt('2026-03-01')).toBe('2026-03-01T00:00:00.000Z');
    expect(parsePostedAt('2026-03-01 10:00:00')).toBe('2026-03-01T10:00:00.000Z');
    expect(parsePostedAt(Date.UTC(2026, 2, 1))).toBe('2026-03-01T00:00:00.000Z');
    expect(parsePostedAt(Date.UTC(2026, 2, 1) / 1000)).toBe('2026-03-01T00:00:00.000Z');
  });

  it('ignores placeholders and dates ahead', () => {
    expect(parsePostedAt('1970-01-01')).toBeNull();
    expect(parsePostedAt('2099-12-31')).toBeNull();
    expect(parsePostedAt('soon')).toBeNull();
    expect(parsePostedAt(null)).toBeNull();
  });
});

describe('combining what two listings know', () => {
  it('fills in what one does not say', () => {
    const combined = combineFacts({ ...EMPTY_FACTS, workArrangement: 'remote' }, { ...EMPTY_FACTS, workArrangement: 'hybrid', employmentType: 'contract', clearance: 'Secret', isFederal: true, salaryMin: 100_000, salaryMax: 120_000, salaryCurrency: 'USD', salaryPeriod: 'year' });
    expect(combined).toMatchObject({ workArrangement: 'remote', employmentType: 'contract', clearance: 'Secret', isFederal: true, salaryMin: 100_000 });
  });

  it('keeps the earliest date, when the job really opened', () => {
    expect(combineFacts({ ...EMPTY_FACTS, postedAt: '2026-05-01T00:00:00.000Z' }, { ...EMPTY_FACTS, postedAt: '2026-03-01T00:00:00.000Z' }).postedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('does not mix the ends of two salary ranges', () => {
    const combined = combineFacts({ ...EMPTY_FACTS, salaryMin: 100, salaryMax: 110, salaryCurrency: 'USD', salaryPeriod: 'hour' }, { ...EMPTY_FACTS, salaryMin: 150_000, salaryMax: 170_000, salaryCurrency: 'USD', salaryPeriod: 'year' });
    expect(combined).toMatchObject({ salaryMin: 100, salaryMax: 110, salaryPeriod: 'hour' });
  });
});
