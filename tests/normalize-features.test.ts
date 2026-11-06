import { describe, expect, it } from 'vitest';
import type { CreateApplicationResponse } from '../src/shared/api';
import { compareJobs } from '../src/server/dedupe/scoring';
import { FEATURES_VERSION, phraseSimilarity, textFeatures, vocabularySimilarity } from '../src/server/dedupe/text-features';
import { descriptionSimilarity, hashDescription, levelsConflict, normalizeCompany, normalizeTitle, titleSimilarity, vocabularyOverlap } from '../src/server/dedupe/text-normalize';
import { stripPersonalParams } from '../src/server/dedupe/url-normalize';
import { cleanSavedLinks, reindexJobs } from '../src/server/services/job-facts-store';
import { createTestServer, createUsers, jobPage, LONG_DESCRIPTION } from './helpers';

describe('company names', () => {
  it.each([
    ['001 Stride, Inc.', 'Stride'],
    ['880 Cigna Management Company, LLC', 'Cigna Management'],
    ['08H Federal Reserve Bank of St. Louis', 'Federal Reserve Bank of St Louis'],
    ['ARKANCE USA LLC (USA)', 'Arkance'],
    ['C.H. Robinson', 'C.H.Robinson'],
    ['W.L Gore & Associates, Inc', 'W. L. Gore and Associates, Inc.'],
    ['AppFolio. Inc', 'AppFolio'],
    ['Castellum. AI', 'Castellum.AI'],
    ['The Home Depot', 'Home Depot'],
    ['Smith Holdings dba Acme Pay', 'Acme Pay'],
    ['Siemens USA', 'Siemens'],
    ['Acme Group', 'ACME']
  ])('treats "%s" and "%s" as one company', (a, b) => {
    expect(normalizeCompany(a)).toBe(normalizeCompany(b));
  });

  it.each([
    ['Unite Us', 'UnitedHealth Group'],
    ['3M', 'M'],
    ['3Core Systems', 'Core Systems'],
    ['Acme Technologies', 'Acme Health']
  ])('keeps "%s" and "%s" apart', (a, b) => {
    expect(normalizeCompany(a)).not.toBe(normalizeCompany(b));
  });
});

describe('job titles', () => {
  it.each([
    ['Sr. Software Engineer (Remote)', 'Senior Software Engineer - Remote, US'],
    ['Full-Stack Developer', 'Fullstack Developer'],
    ['Full Stack Developer (Contract)', 'Full-Stack Developer'],
    ['SWE II', 'Software Engineer 2'],
    ['Backend Engineer (Node.js)', 'Back-End Engineer, Node'],
    ['Sr. GCP Data Engineer (Job-ID 3301)', 'Senior GCP Data Engineer'],
    ['Data Engineer | New York, NY', 'Data Engineer'],
    ['Senior Data Engineer (Company name withheld)', 'Senior Data Engineer'],
    ['ML Engineer', 'Machine Learning Engineer'],
    ['Software Engineer (Backend)', 'Backend Software Engineer']
  ])('reads "%s" and "%s" as the same title', (a, b) => {
    expect(titleSimilarity(a, b)).toBe(1);
  });

  it('keeps words that name the role, wherever they are', () => {
    expect(normalizeTitle('Contract Manager')).toBe('contract manager');
    expect(normalizeTitle('Engineer - Payments')).toBe('engineer payments');
    expect(titleSimilarity('Senior Engineer, Payments', 'Senior Engineer, Identity')).toBeLessThan(0.85);
  });

  it('knows different seniorities apart', () => {
    expect(levelsConflict('Data Engineer II', 'Data Engineer III')).toBe(true);
    expect(levelsConflict('Senior Data Engineer', 'Staff Data Engineer')).toBe(true);
    expect(levelsConflict('Sr Data Engineer', 'Senior Data Engineer')).toBe(false);
    // Only one says a level: that alone is no conflict, the title comparison handles it.
    expect(levelsConflict('Data Engineer', 'Senior Data Engineer')).toBe(false);
  });

  it('never merges two seniorities, even with the same text', () => {
    const job = (title: string) => ({ company: 'Acme', title, location: 'Remote', description: LONG_DESCRIPTION, identifiers: [] });
    const result = compareJobs(job('Data Engineer II'), job('Data Engineer III'));
    expect(result.decision).not.toBe('auto');
    expect(result.reasons).toContain('Different seniority');
  });
});

describe('text features', () => {
  const rewritten = LONG_DESCRIPTION.split('\n\n').reverse().join('\n\n');

  it('compare exactly as the posting text did', () => {
    const a = textFeatures(LONG_DESCRIPTION);
    const b = textFeatures(rewritten);
    const before = descriptionSimilarity(LONG_DESCRIPTION, rewritten);
    const after = phraseSimilarity(a, b);
    expect(after.jaccard).toBeCloseTo(before.jaccard, 2);
    expect(after.containment).toBeCloseTo(before.containment, 2);
    expect(vocabularySimilarity(a, b)).toBeCloseTo(vocabularyOverlap(LONG_DESCRIPTION, rewritten), 5);
    expect(a.hash).toBe(hashDescription(LONG_DESCRIPTION));
  });

  it('cannot be read back as text', () => {
    const features = textFeatures(LONG_DESCRIPTION);
    const stored = Buffer.concat([Buffer.from(features.shingles.buffer), Buffer.from(features.words.buffer)]).toString('latin1');
    for (const word of ['payments', 'infrastructure', 'distributed', 'engineer']) expect(stored).not.toContain(word);
  });

  it('are what saved jobs are compared on, with no text in the index', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'andy');
    server.http.serve('https://careers.example.com/jobs/1', jobPage({ title: 'Platform Engineer', company: 'Acme' }));
    const added = (await users.andy.addJob('https://careers.example.com/jobs/1')) as Extract<CreateApplicationResponse, { outcome: 'created' }>;
    const sqlite = server.ctx.handle.sqlite;
    const columns = (sqlite.prepare('PRAGMA table_info(job_text_features)').all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(['job_id', 'version', 'hash', 'length', 'shingles', 'words', 'requisitions']);
    const row = sqlite.prepare('SELECT version, shingles, words FROM job_text_features WHERE job_id = ?').get(added.jobId) as { version: number; shingles: Buffer; words: Buffer };
    expect(row.version).toBe(FEATURES_VERSION);
    expect(row.shingles.length).toBeGreaterThan(100);
    expect(Buffer.concat([row.shingles, row.words]).toString('latin1')).not.toContain('payments');
  });

  it('are made again for every saved job when the rules change, and every job is compared again', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'andy');
    server.http.serve('https://careers.example.com/jobs/2', jobPage({ title: 'Sr. Data Engineer (Remote)', company: '001 Acme, Inc.' }));
    const added = (await users.andy.addJob('https://careers.example.com/jobs/2')) as Extract<CreateApplicationResponse, { outcome: 'created' }>;
    const sqlite = server.ctx.handle.sqlite;
    // As an older version would have left it.
    sqlite.prepare(`UPDATE jobs SET company_key = '001acme', title_key = 'sr data engineer remote' WHERE id = ?`).run(added.jobId);
    sqlite.prepare('UPDATE job_text_features SET version = 1').run();
    expect(reindexJobs(sqlite)).toBe(1);
    expect(sqlite.prepare('SELECT company_key, title_key FROM jobs WHERE id = ?').get(added.jobId)).toEqual({ company_key: 'acme', title_key: 'senior data engineer' });
    expect(sqlite.prepare('SELECT checked_at FROM job_facts WHERE job_id = ?').get(added.jobId)).toEqual({ checked_at: null });
    expect(reindexJobs(sqlite)).toBe(0);
  });
});

describe('saved links', () => {
  it('lose tracking that can identify who clicked, and keep what names the job', () => {
    const humana = 'https://careers.humana.com/us/en/job/HUMHUMUSR427075EXTERNALENUS/Senior-AI-Full-Stack-Engineer?utm_medium=phenom-feeds&utm_source=appcast_indeed&ccuid=74831460592&_ccid=1787670574116c41nrrx14';
    expect(stripPersonalParams(humana)).toBe('https://careers.humana.com/us/en/job/HUMHUMUSR427075EXTERNALENUS/Senior-AI-Full-Stack-Engineer');
    const mckesson = 'https://careers.mckesson.com/en/job/-/-/733/99821368704?p_sid=kh3EeKb&p_uid=h4hZ83slH6&source=rd_indeed_pj&utm_campaign=x';
    expect(stripPersonalParams(mckesson)).toBe('https://careers.mckesson.com/en/job/-/-/733/99821368704');
    const greenhouse = 'https://job-boards.greenhouse.io/embed/job_app?for=crexi&jr_id=6a7e5a3819ce4e6e9d932a1a&token=4724138005&utm_source=jobright';
    expect(stripPersonalParams(greenhouse)).toBe('https://job-boards.greenhouse.io/embed/job_app?for=crexi&jr_id=6a7e5a3819ce4e6e9d932a1a&token=4724138005');
    // An account activation link holds a personal token: only the job page it leads to is kept.
    const activation = 'https://capitalone.wd12.myworkdayjobs.com/Capital_One/activate/4f1jkdait8y7qkp4bqa3bvvgyvto8shxii/?redirect=%2Fen-US%2FCapital_One%2Fjob%2FMcLean-VA%2FLead-Software-Engineer_R123';
    expect(stripPersonalParams(activation)).toBe('https://capitalone.wd12.myworkdayjobs.com/en-US/Capital_One/job/McLean-VA/Lead-Software-Engineer_R123');
    expect(stripPersonalParams('https://linktr.ee/renous?lt_utm_source=lt_share_link#402475494')).toBe('https://linktr.ee/renous#402475494');
    // A site that needs its own parameter to show the job keeps it.
    const sap = 'https://career41.sapsf.com/portalcareer?_s.crb=%252bEE0iIPlE0uqvlwEpDfaW3x063NsgPnKOGG';
    expect(stripPersonalParams(sap)).toBe(sap);
  });

  it('are cleaned when saved, and links saved before are cleaned once', async () => {
    const server = await createTestServer();
    const { users } = await createUsers(server.app, 'andy');
    server.http.serve('https://careers.example.com/jobs/3?gh_jid=123', jobPage({ title: 'Engineer', company: 'Acme' }));
    const added = (await users.andy.addJob('https://careers.example.com/jobs/3?gh_jid=123&utm_source=linkedin&mc_eid=abc')) as Extract<CreateApplicationResponse, { outcome: 'created' }>;
    const sqlite = server.ctx.handle.sqlite;
    const saved = sqlite.prepare(`SELECT original_url AS url FROM job_urls WHERE job_id = ? AND kind = 'original'`).get(added.jobId) as { url: string };
    expect(saved.url).toBe('https://careers.example.com/jobs/3?gh_jid=123');
    sqlite.prepare(`UPDATE job_urls SET original_url = ? WHERE job_id = ? AND kind = 'original'`).run('https://careers.example.com/jobs/3?gh_jid=123&ccuid=555', added.jobId);
    expect(cleanSavedLinks(sqlite)).toBe(1);
    expect((sqlite.prepare(`SELECT original_url AS url FROM job_urls WHERE job_id = ? AND kind = 'original'`).get(added.jobId) as { url: string }).url).toBe('https://careers.example.com/jobs/3?gh_jid=123');
    expect(cleanSavedLinks(sqlite)).toBe(0);
  });
});
