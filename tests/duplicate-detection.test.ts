import { beforeEach, describe, expect, it } from 'vitest';
import type { DuplicatesResponse, JobDetail, JobFacts, JobListResponse } from '../src/shared/api';
import { closeDatabase } from '../src/server/db/client';
import { EMPTY_FACTS } from '../src/server/dedupe/job-facts';
import { findContentMatches } from '../src/server/dedupe/matcher';
import { compareJobs, compareSalaries, type ComparableJob } from '../src/server/dedupe/scoring';
import { hashDescription, normalizeCompany, normalizeTitle, textSketch } from '../src/server/dedupe/text-normalize';
import { listBackups } from '../src/server/services/backups';
import { markDistinct, sweepDuplicates } from '../src/server/services/duplicates';
import { backfillJobFacts, saveNewJobFacts } from '../src/server/services/job-facts-store';
import { mergeJobs, reconcileJobIdentities } from '../src/server/services/job-merge';
import { createTestServer, createUsers, jobPage, tempDir, type ApiClient, type TestServer } from './helpers';

const PLATFORM_TEXT = [
  'Build reliable batch and streaming data pipelines on Snowflake and Airflow for our payments ledger.',
  'Partner with analytics engineers on dbt models, write Python services for reconciliation, and own observability with Datadog across the settlement platform.',
  'Mentor engineers and lead design reviews.',
  'Design Kafka topics for merchant payouts, tune warehouse costs, and automate chargeback reporting for the finance organization.',
  'Work with compliance on audit trails, data retention and access controls, and keep Terraform modules for the data stack current.',
  'Five years building production data systems, strong SQL, and experience operating pipelines on call.'
].join(' ');
/** One job as a listing site words it: mostly the same terms, in other sentences. */
const PLATFORM_REWRITE = [
  'You will own observability with Datadog, write reconciliation services in Python, and build streaming pipelines using Airflow and Snowflake for a payments ledger across the settlement platform.',
  'Lead design reviews, mentor engineers, partner on dbt models with analytics engineers, and keep batch data reliable.',
  'Responsibilities include Kafka topic design for merchant payouts, warehouse cost tuning, and automated chargeback reporting for finance.',
  'Maintain Terraform modules for the data stack, and support compliance with audit trails, retention and access controls.',
  'Requires five years with production data systems, strong SQL, and on call experience operating pipelines.'
].join(' ');
const MOBILE_TEXT = [
  'Ship delightful iOS features in Swift and SwiftUI for our consumer banking application.',
  'Work with designers on animation, improve launch time with Instruments, maintain the Combine networking layer, write XCTest suites, and release through TestFlight every week alongside the Android team.',
  'Own accessibility for VoiceOver and Dynamic Type, profile memory with Xcode, and keep crash rates low using Crashlytics.',
  'Collaborate with product on experiments, feature flags and onboarding flows, and review code from other mobile engineers.',
  'Four years of native iOS development and apps published on the App Store.'
].join(' ');

const job = (extra: Omit<Partial<ComparableJob>, 'facts'> & { facts?: Partial<JobFacts> } = {}): ComparableJob => ({
  company: 'Acme',
  title: 'Senior Data Engineer',
  location: null,
  description: PLATFORM_TEXT,
  identifiers: [],
  ...extra,
  facts: { ...EMPTY_FACTS, ...extra.facts }
});

const SALARY = { salaryMin: 150_000, salaryMax: 180_000, salaryCurrency: 'USD', salaryPeriod: 'year' as const };
/** Facts both listings of one remote job agree on. */
const REMOTE = { location: 'Remote, US', facts: { workArrangement: 'remote' as const } };

describe('comparing two postings', () => {
  it('merges a listing site’s rewrite of a posting when the facts line up', () => {
    const result = compareJobs(job({ description: PLATFORM_REWRITE, facts: { ...SALARY, workArrangement: 'remote' } }), job({ facts: { ...SALARY, workArrangement: 'remote' } }));
    expect(result.decision).toBe('auto');
    expect(result.reasons).toContain('Same salary');
  });

  it('asks, rather than merges, when only the title and the subject matter agree', () => {
    // One company's openings share its standard text, so something else has to agree as well.
    expect(compareJobs(job({ description: PLATFORM_REWRITE }), job()).decision).toBe('possible');
  });

  it('accepts a far posting date when everything else agrees, as real sites date one job a year apart', () => {
    const result = compareJobs(job({ description: PLATFORM_REWRITE, facts: { ...SALARY, postedAt: '2025-01-01T00:00:00.000Z' } }), job({ facts: { ...SALARY, postedAt: '2026-01-20T00:00:00.000Z' } }));
    expect(result.decision).toBe('auto');
  });

  it.each([
    ['location', job({ location: 'Austin, TX' }), job({ location: 'Berlin, Germany' })],
    ['salary', job({ facts: { salaryMin: 90_000, salaryMax: 110_000, salaryPeriod: 'year' } }), job({ facts: { salaryMin: 200_000, salaryMax: 240_000, salaryPeriod: 'year' } })],
    ['work arrangement', job({ facts: { workArrangement: 'remote' } }), job({ facts: { workArrangement: 'onsite' } })],
    ['employment type', job({ facts: { employmentType: 'contract' } }), job({ facts: { employmentType: 'permanent' } })],
    ['id on one system', job({ identifiers: [{ provider: 'greenhouse', externalId: '1' }] }), job({ identifiers: [{ provider: 'greenhouse', externalId: '2' }] })]
  ])('never merges by itself when the %s differs, even with identical text', (_name, a, b) => {
    expect(compareJobs(a, b).decision).not.toBe('auto');
  });

  it('asks rather than merges when the only doubt is the requisition number', () => {
    const a = job({ description: `${PLATFORM_TEXT} Req ID: R-10001` });
    const b = job({ description: `${PLATFORM_TEXT} Req ID: R-20002` });
    expect(compareJobs(a, b).decision).not.toBe('auto');
  });

  it('merges one requisition number at one company whatever else the text says', () => {
    const a = job({ description: `${PLATFORM_TEXT} Req ID: R-10001`, title: 'Data Engineer III' });
    const b = job({ description: `${MOBILE_TEXT} Requisition ID: R-10001`, title: 'Data Engineer' });
    expect(compareJobs(a, b).decision).toBe('auto');
  });

  it('keeps apart different levels and teams at one company', () => {
    expect(compareJobs(job({ title: 'Data Engineer' }), job({ title: 'Senior Data Engineer' })).decision).not.toBe('auto');
    expect(compareJobs(job({ title: 'Software Engineer, Data Warehouse' }), job({ title: 'Software Engineer, Data Catalog' })).decision).not.toBe('auto');
  });

  it('keeps apart one title about different work', () => {
    expect(compareJobs(job({ title: 'Senior Engineer', description: MOBILE_TEXT }), job({ title: 'Senior Engineer' })).decision).toBe('possible');
  });

  it('keeps apart one title at different companies', () => {
    expect(compareJobs(job({ company: 'Globex', description: MOBILE_TEXT }), job()).decision).toBe('none');
    expect(compareJobs(job({ company: 'Globex', description: PLATFORM_REWRITE }), job()).decision).not.toBe('auto');
  });

  it('asks about the same posting under a staffing company’s name', () => {
    const facts = { ...SALARY, workArrangement: 'remote' as const, employmentType: 'permanent' as const, postedAt: '2026-01-01T00:00:00.000Z' };
    const result = compareJobs(job({ company: 'Payroll Partner LLC', description: PLATFORM_REWRITE, location: 'Remote, US', facts }), job({ location: 'Remote, US', facts }));
    expect(result.decision).toBe('possible');
  });

  it('merges a shortened company name only when everything else agrees', () => {
    const facts = { ...SALARY, workArrangement: 'remote' as const, employmentType: 'permanent' as const };
    expect(compareJobs(job({ company: 'Sola', description: PLATFORM_REWRITE, facts }), job({ company: 'Sola Payments', facts })).decision).toBe('auto');
    expect(compareJobs(job({ company: 'Sola', description: PLATFORM_REWRITE }), job({ company: 'Sola Payments' })).decision).toBe('possible');
  });

  it('compares pay across hourly and yearly quotes', () => {
    expect(compareSalaries({ ...EMPTY_FACTS, salaryMin: 50, salaryMax: 60, salaryPeriod: 'hour' }, { ...EMPTY_FACTS, salaryMin: 104_000, salaryMax: 124_800, salaryPeriod: 'year' })).toBe('same');
    expect(compareSalaries({ ...EMPTY_FACTS, salaryMin: 100_000, salaryMax: 150_000, salaryPeriod: 'year' }, { ...EMPTY_FACTS, salaryMin: 120_000, salaryMax: 160_000, salaryPeriod: 'year' })).toBe('overlap');
    expect(compareSalaries({ ...EMPTY_FACTS, salaryMin: 100_000, salaryMax: 110_000, salaryPeriod: 'year' }, { ...EMPTY_FACTS, salaryMin: 150_000, salaryMax: 170_000, salaryPeriod: 'year' })).toBe('conflict');
    expect(compareSalaries(EMPTY_FACTS, { ...EMPTY_FACTS, salaryMin: 150_000, salaryMax: 170_000, salaryPeriod: 'year' })).toBe('unknown');
  });
});

describe('text fingerprints', () => {
  it('are the same for the same text, and do not depend on what else is stored', () => {
    expect(textSketch(PLATFORM_TEXT)).toEqual(textSketch(PLATFORM_TEXT));
    expect(textSketch(PLATFORM_TEXT)).toHaveLength(8);
  });

  it('are shared by reposted text and not by unrelated text', () => {
    const sketch = new Set(textSketch(PLATFORM_TEXT));
    const reposted = textSketch(`${PLATFORM_TEXT} Apply today through our careers page.`);
    expect(reposted.filter((value) => sketch.has(value)).length).toBeGreaterThanOrEqual(5);
    expect(textSketch(MOBILE_TEXT).filter((value) => sketch.has(value))).toHaveLength(0);
  });

  it('are left out for text too short to mean anything', () => {
    expect(textSketch('Great job, apply now.')).toEqual([]);
  });
});

describe('with a real database', () => {
  let server: TestServer;
  let admin: ApiClient;
  let alice: ApiClient;
  let bob: ApiClient;

  beforeEach(async () => {
    server = await createTestServer();
    ({ admin, users: { alice, bob } } = await createUsers(server.app, 'alice', 'bob'));
  });

  const sqlite = () => server.ctx.handle.sqlite;

  /** Puts a job directly into the database, the way one saved by an earlier version would be. */
  function insertJob(fields: { company: string; title: string; description: string; location?: string | null; facts?: Partial<JobFacts>; id?: string; provider?: string; checked?: boolean }): number {
    const { lastInsertRowid } = sqlite()
      .prepare(`INSERT INTO jobs (company_name, company_key, title, title_key, description, description_hash, location, created_by, extraction_method) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'manual')`)
      .run(fields.company, normalizeCompany(fields.company), fields.title, normalizeTitle(fields.title), fields.description, hashDescription(fields.description), fields.location ?? null);
    const id = Number(lastInsertRowid);
    saveNewJobFacts(sqlite(), id, { ...EMPTY_FACTS, ...fields.facts }, fields.description);
    if (!fields.checked) sqlite().prepare('UPDATE job_facts SET checked_at = NULL WHERE job_id = ?').run(id);
    if (fields.id) sqlite().prepare('INSERT INTO job_identifiers (job_id, provider, external_id, is_discovered) VALUES (?, ?, ?, 0)').run(id, fields.provider ?? 'greenhouse', fields.id);
    return id;
  }

  const jobIds = () => (sqlite().prepare('SELECT id FROM jobs ORDER BY id').all() as Array<{ id: number }>).map((row) => row.id);
  const pendingCount = () => (sqlite().prepare(`SELECT COUNT(*) AS total FROM duplicate_candidates WHERE status = 'pending'`).get() as { total: number }).total;
  const quietComparable = (extra: Omit<Partial<ComparableJob>, 'facts'> & { facts?: Partial<JobFacts> }): ComparableJob => job({ identifiers: [], ...extra });

  describe('finding candidates', () => {
    it('finds the real match however many unrelated jobs share its title', () => {
      // The old search took the first 300 rows of title or company matches, in no order.
      const real = insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_TEXT, ...REMOTE });
      const insert = sqlite().transaction(() => {
        for (let i = 0; i < 1500; i += 1) insertJob({ company: `Other Company ${i}`, title: 'Senior Data Engineer', description: `${MOBILE_TEXT} Variant ${i}.`, checked: true });
      });
      insert();
      const result = findContentMatches(server.ctx.db, quietComparable({ description: PLATFORM_REWRITE, ...REMOTE }));
      expect(result.auto?.jobId).toBe(real);
    });

    it('finds the real match among many other openings at one big company', () => {
      const insert = sqlite().transaction(() => {
        for (let i = 0; i < 1200; i += 1) insertJob({ company: 'Acme', title: `Unrelated Role ${i}`, description: `${MOBILE_TEXT} Variant ${i}.`, checked: true });
      });
      const real = insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_TEXT, ...REMOTE });
      insert();
      const result = findContentMatches(server.ctx.db, quietComparable({ description: PLATFORM_REWRITE, ...REMOTE }));
      expect(result.auto?.jobId).toBe(real);
    });

    it('finds a variation of the company name in both directions', () => {
      const real = insertJob({ company: 'Devoted Health Services', title: 'Senior Data Engineer', description: PLATFORM_TEXT });
      expect(findContentMatches(server.ctx.db, quietComparable({ company: 'Devoted Health', description: PLATFORM_REWRITE })).possible[0]?.jobId).toBe(real);
      sqlite().prepare('UPDATE jobs SET company_name = ?, company_key = ? WHERE id = ?').run('Devoted', 'devoted', real);
      expect(findContentMatches(server.ctx.db, quietComparable({ company: 'Devoted Health', description: PLATFORM_REWRITE })).possible[0]?.jobId).toBe(real);
    });

    it('finds a repost under another company’s name by its wording', () => {
      const real = insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_TEXT });
      const result = findContentMatches(server.ctx.db, quietComparable({ company: 'Staffing Partner', description: `${PLATFORM_TEXT} Apply through our site.` }));
      expect(result.possible.map((item) => item.jobId)).toContain(real);
      expect(result.auto).toBeNull();
    });

    it('asks when more than one job is a confident match', () => {
      const first = insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_TEXT, ...REMOTE });
      const second = insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: `${PLATFORM_TEXT} Second opening.`, ...REMOTE });
      const result = findContentMatches(server.ctx.db, quietComparable({ description: PLATFORM_REWRITE, ...REMOTE }));
      expect(compareJobs(quietComparable({ description: PLATFORM_REWRITE, ...REMOTE }), quietComparable({ ...REMOTE })).decision).toBe('auto');
      expect(result.auto).toBeNull();
      expect(result.possible.map((item) => item.jobId).sort()).toEqual([first, second].sort());
    });
  });

  describe('checking saved jobs', () => {
    it('merges a saved duplicate, keeping every application and taking a backup first', async () => {
      const employer = await alice.addJob('https://careers.example.com/jobs/1', {
        manual: { title: 'Senior Data Engineer', company: 'Acme', description: PLATFORM_TEXT, location: 'Remote, US' }
      });
      const listing = insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_REWRITE, location: 'Remote, US', facts: { ...SALARY, workArrangement: 'remote' } });
      expect(employer.outcome).toBe('created');
      const backups: string[] = [];
      const result = await sweepDuplicates(server.ctx, { backup: async () => backups.push('done') });
      expect(result.merged).toBe(1);
      expect(backups).toHaveLength(1);
      expect(jobIds()).toHaveLength(1);
      expect(jobIds()).not.toContain(listing);
      const list = (await alice.request('GET', '/api/jobs')).json as JobListResponse;
      expect(list.items[0].applications).toHaveLength(1);
      // What only the listing knew now belongs to the job.
      expect(list.items[0].facts.salaryMin).toBe(150_000);
    });

    it('takes no backup when nothing merges', async () => {
      insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_TEXT });
      insertJob({ company: 'Globex', title: 'iOS Engineer', description: MOBILE_TEXT });
      const backups: string[] = [];
      const result = await sweepDuplicates(server.ctx, { backup: async () => backups.push('done') });
      expect(result).toMatchObject({ checked: 2, merged: 0, pending: 0 });
      expect(backups).toHaveLength(0);
    });

    it('does not merge jobs with different ids on one system, however alike', async () => {
      insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_TEXT, id: '111' });
      insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_TEXT, id: '222' });
      const result = await sweepDuplicates(server.ctx);
      expect(result.merged).toBe(0);
      expect(jobIds()).toHaveLength(2);
    });

    it('merges a listing site’s copy into the employer’s posting, which keeps its wording', async () => {
      const listing = insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_REWRITE, id: 'abc', provider: 'jobright', ...REMOTE });
      const employer = insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_TEXT, id: '111', ...REMOTE });
      await sweepDuplicates(server.ctx);
      expect(jobIds()).toEqual([employer]);
      expect(jobIds()).not.toContain(listing);
      const row = sqlite().prepare('SELECT description FROM jobs WHERE id = ?').get(employer) as { description: string };
      expect(row.description).toBe(PLATFORM_TEXT);
    });

    it('does not merge a listing into two equally good openings, and asks instead', async () => {
      insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_TEXT, id: '111', ...REMOTE });
      insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: `${PLATFORM_TEXT} Second opening.`, id: '222', ...REMOTE });
      insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_REWRITE, ...REMOTE });
      const result = await sweepDuplicates(server.ctx);
      expect(result.merged).toBe(0);
      expect(jobIds()).toHaveLength(3);
      expect(pendingCount()).toBeGreaterThan(0);
    });

    it('does not check a job twice', async () => {
      insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_TEXT });
      expect((await sweepDuplicates(server.ctx)).checked).toBe(1);
      expect((await sweepDuplicates(server.ctx)).checked).toBe(0);
    });

    it('checks a job again after it is corrected', async () => {
      const a = insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_TEXT, ...REMOTE });
      const b = insertJob({ company: 'Globex', title: 'Senior Data Engineer', description: PLATFORM_REWRITE, ...REMOTE });
      await sweepDuplicates(server.ctx);
      expect(jobIds()).toEqual([a, b]);
      const response = await admin.request('PATCH', `/api/jobs/${b}`, { company: 'Acme' });
      expect(response.status).toBe(200);
      expect((await sweepDuplicates(server.ctx)).merged).toBe(1);
      expect(jobIds()).toHaveLength(1);
    });

    it('stops when told to, and finishes the rest later', async () => {
      for (let i = 0; i < 5; i += 1) insertJob({ company: `Company ${i}`, title: `Role ${i}`, description: PLATFORM_TEXT.replace('payments', `product${i}`) });
      let calls = 0;
      const first = await sweepDuplicates(server.ctx, { shouldStop: () => (calls += 1) > 2 });
      expect(first.checked).toBe(2);
      expect((await sweepDuplicates(server.ctx)).checked).toBe(3);
    });
  });

  describe('reviewing', () => {
    async function pendingPair() {
      const a = insertJob({ company: 'Acme', title: 'Senior Data Engineer', description: PLATFORM_TEXT, location: 'Remote, US', facts: { workArrangement: 'remote' } });
      // "Holdings" would be dropped as a legal suffix, making them one company.
      const b = insertJob({ company: 'Acme Robotics', title: 'Senior Data Engineer', description: PLATFORM_REWRITE, location: 'Remote, US' });
      await sweepDuplicates(server.ctx);
      expect(pendingCount()).toBe(1);
      return { a, b };
    }

    it('lists pairs with both jobs, their tags and the reasons, for everyone', async () => {
      const { a, b } = await pendingPair();
      const response = (await bob.request('GET', '/api/duplicates')).json as DuplicatesResponse;
      expect(response.total).toBe(1);
      expect([response.pairs[0].jobA.id, response.pairs[0].jobB.id].sort()).toEqual([a, b].sort());
      expect(response.pairs[0].jobA.facts.workArrangement).toBe('remote');
      expect(response.pairs[0].reasons).toContain('Same job title');
      expect((await bob.request('GET', '/api/duplicates/count')).json).toEqual({ total: 1 });
    });

    it('needs a signed-in person', async () => {
      const anonymous = await server.app.inject({ method: 'GET', url: '/api/duplicates' });
      expect(anonymous.statusCode).toBe(401);
    });

    it('merges a pair when someone says it is one job, copying the database first', async () => {
      const { a, b } = await pendingPair();
      const response = await bob.request('POST', '/api/duplicates/merge', { jobIdA: a, jobIdB: b });
      expect(response.status).toBe(200);
      expect(jobIds()).toEqual([a]);
      expect(pendingCount()).toBe(0);
      expect(listBackups(server.ctx).filter((backup) => backup.name.startsWith('before-merge-'))).toHaveLength(1);
    });

    it('merges only a pair waiting for review: not two unrelated jobs, nor a pair someone called different', async () => {
      const { a, b } = await pendingPair();
      const c = insertJob({ company: 'Initech', title: 'Office Manager', description: MOBILE_TEXT });
      const unrelated = await bob.request('POST', '/api/duplicates/merge', { jobIdA: a, jobIdB: c });
      expect(unrelated.status).toBe(409);
      expect(unrelated.json.error.code).toBe('pair_not_waiting');
      // Someone else settled it a moment ago; this screen had not refreshed yet.
      await alice.request('POST', '/api/duplicates/dismiss', { jobIdA: a, jobIdB: b });
      const settled = await bob.request('POST', '/api/duplicates/merge', { jobIdA: a, jobIdB: b });
      expect(settled.status).toBe(409);
      expect(settled.json.error.code).toBe('pair_settled');
      expect(jobIds()).toEqual([a, b, c]);
    });

    it('never asks again once someone says they differ', async () => {
      const { a, b } = await pendingPair();
      expect((await bob.request('POST', '/api/duplicates/dismiss', { jobIdA: b, jobIdB: a })).status).toBe(200);
      expect(pendingCount()).toBe(0);
      expect(jobIds()).toEqual([a, b]);
      sqlite().prepare('UPDATE job_facts SET checked_at = NULL').run();
      const result = await sweepDuplicates(server.ctx);
      expect(result).toMatchObject({ merged: 0, pending: 0 });
    });

    it('remembers "different" after one of the pair merges into a third job', () => {
      const a = insertJob({ company: 'Acme', title: 'Data Engineer', description: PLATFORM_TEXT });
      const b = insertJob({ company: 'Acme', title: 'Data Engineer', description: PLATFORM_TEXT });
      const c = insertJob({ company: 'Acme', title: 'Data Engineer', description: PLATFORM_TEXT });
      markDistinct(sqlite(), b, c);
      sqlite().transaction(() => mergeJobs(sqlite(), a, b))();
      const rows = sqlite().prepare(`SELECT job_id_low AS low, job_id_high AS high FROM duplicate_candidates WHERE status = 'distinct'`).all();
      expect(rows).toEqual([{ low: a, high: c }]);
    });

    it('refuses nonsense', async () => {
      const { a } = await pendingPair();
      expect((await bob.request('POST', '/api/duplicates/merge', { jobIdA: a, jobIdB: a })).status).toBe(400);
      expect((await bob.request('POST', '/api/duplicates/merge', { jobIdA: a, jobIdB: 99_999 })).status).toBe(404);
      expect((await bob.request('POST', '/api/duplicates/dismiss', { jobIdA: 'x' })).status).toBe(400);
    });

    it('removes a pair when one of its jobs is deleted', async () => {
      const { a, b } = await pendingPair();
      await admin.request('DELETE', `/api/jobs/${b}`);
      expect(pendingCount()).toBe(0);
      expect(jobIds()).toEqual([a]);
    });

    it('remembers "different" when the person adding a job says so', async () => {
      server.http.serve('https://careers.example.com/jobs/10', jobPage({ title: 'Senior Data Engineer', company: 'Acme', description: PLATFORM_TEXT }));
      server.http.serve('https://acme-jobs.example.org/role/20', jobPage({ title: 'Senior Data Engineer', company: 'Acme', description: `${MOBILE_TEXT} ${MOBILE_TEXT}` }));
      const first = await alice.addJob('https://careers.example.com/jobs/10');
      const second = await alice.addJob('https://acme-jobs.example.org/role/20');
      expect(second.outcome).toBe('possible_duplicate');
      if (second.outcome !== 'possible_duplicate' || first.outcome !== 'created') throw new Error('unexpected outcome');
      const third = await alice.addJob('https://acme-jobs.example.org/role/20', { draftId: second.draftId, resolution: { action: 'new', seen: second.candidates.map((candidate) => candidate.jobId) } });
      if (third.outcome !== 'created') throw new Error('unexpected outcome');
      const row = sqlite().prepare('SELECT status FROM duplicate_candidates WHERE job_id_low = ? AND job_id_high = ?').get(first.jobId, third.jobId) as { status: string };
      expect(row.status).toBe('distinct');
    });
  });

  describe('what a job shows', () => {
    it('carries tags from the posting into the job and the list', async () => {
      server.http.serve(
        'https://careers.example.com/jobs/30',
        jobPage({ title: 'Data Engineer - Contract', company: 'Acme', location: 'Remote, US', description: `Support DoD customers. Requires an active Secret clearance. The range is $80/hr - $100/hr.\n\n${PLATFORM_TEXT}\n\n${PLATFORM_REWRITE}` })
      );
      const added = await alice.addJob('https://careers.example.com/jobs/30');
      if (added.outcome !== 'created') throw new Error(`unexpected ${added.outcome}`);
      const detail = (await bob.request('GET', `/api/jobs/${added.jobId}`)).json as JobDetail;
      expect(detail.facts).toMatchObject({ workArrangement: 'remote', employmentType: 'contract', clearance: 'Secret', isFederal: true, salaryMin: 80, salaryMax: 100, salaryPeriod: 'hour' });
      const list = (await bob.request('GET', '/api/jobs')).json as JobListResponse;
      expect(list.items[0].facts.clearance).toBe('Secret');
    });

    it('reads tags again when an admin corrects a job', async () => {
      const id = insertJob({ company: 'Acme', title: 'Data Engineer', description: PLATFORM_TEXT });
      await admin.request('PATCH', `/api/jobs/${id}`, { title: 'Data Engineer (Hybrid)' });
      const detail = (await admin.request('GET', `/api/jobs/${id}`)).json as JobDetail;
      expect(detail.facts.workArrangement).toBe('hybrid');
    });
  });
});

describe('upgrading a database that has jobs from before', () => {
  it('gives saved jobs their tags and compares them, once', async () => {
    const dataDir = tempDir();
    const first = await createTestServer({ dataDir });
    const { users } = await createUsers(first.app, 'alice');
    expect((await users.alice.addJob('https://careers.example.com/jobs/1', { manual: { title: 'Data Engineer', company: 'Acme', description: `This is a fully remote position. ${PLATFORM_TEXT}` } })).outcome).toBe('created');
    // What an earlier version would have left behind: jobs with no details stored.
    first.ctx.handle.sqlite.prepare('DELETE FROM job_facts').run();
    first.ctx.handle.sqlite.prepare('DELETE FROM job_signatures').run();
    await first.app.close();
    closeDatabase(first.ctx.handle);

    const second = await createTestServer({ dataDir });
    const row = second.ctx.handle.sqlite.prepare('SELECT work_arrangement, checked_at FROM job_facts').get() as { work_arrangement: string; checked_at: string | null };
    expect(row).toEqual({ work_arrangement: 'remote', checked_at: null });
    expect((second.ctx.handle.sqlite.prepare('SELECT COUNT(*) AS total FROM job_signatures').get() as { total: number }).total).toBe(8);
    expect(backfillJobFacts(second.ctx.handle.sqlite)).toBe(0);
    await reconcileJobIdentities(second.ctx);
    expect((await sweepDuplicates(second.ctx)).checked).toBe(1);
  });
});
