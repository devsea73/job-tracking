import { statSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
// @ts-expect-error A plain script, shared with the command line and the desktop-app speed test.
import { LOAD_PASSWORD, seedLoadData } from '../../scripts/seed-load.mjs';
import { sweepDuplicates } from '../../src/server/services/duplicates';
import { backfillJobFacts } from '../../src/server/services/job-facts-store';
import { ApiClient, createTestServer, jobPage, signInAdmin, type TestServer } from '../helpers';

/**
 * Speed of the server with 10,000 jobs, 10 users and 5 profiles each. Opt-in, not part of
 * `npm test`. Timings are of the whole request through Fastify, without the network.
 *
 *   npm run loadtest                    prints a table and writes load-report.json
 *   npm run loadtest -- --label before  names that report load-report.before.json
 */

interface Row {
  name: string;
  p50: number;
  p95: number;
  max: number;
  kb: number;
  count?: number;
}

const percentile = (sorted: number[], fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
const round = (value: number) => Math.round(value * 10) / 10;

async function measure(rows: Row[], name: string, call: (run: number) => Promise<{ status: number; json: unknown; body?: string }>, runs = 15): Promise<void> {
  const times: number[] = [];
  let bytes = 0;
  let count: number | undefined;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    const response = await call(run);
    times.push(performance.now() - started);
    if (response.status >= 400) throw new Error(`${name}: HTTP ${response.status} ${JSON.stringify(response.json).slice(0, 200)}`);
    bytes = JSON.stringify(response.json).length;
    const json = response.json as { total?: number } | unknown[];
    count = Array.isArray(json) ? json.length : json?.total;
  }
  times.sort((a, b) => a - b);
  rows.push({ name, p50: round(percentile(times, 0.5)), p95: round(percentile(times, 0.95)), max: round(times[times.length - 1]), kb: round(bytes / 1024), count });
}

async function seeded(): Promise<{ server: TestServer; admin: ApiClient; users: ApiClient[]; seedMs: number; counts: Record<string, number>; dbMb: number }> {
  const server = await createTestServer();
  const admin = await signInAdmin(server.app);
  const started = performance.now();
  const passwordHash = await server.ctx.hasher.hash(LOAD_PASSWORD);
  const counts = seedLoadData(server.ctx.handle.sqlite, { passwordHash });
  const seedMs = performance.now() - started;
  server.ctx.handle.sqlite.pragma('wal_checkpoint(TRUNCATE)');
  const users: ApiClient[] = [];
  for (let u = 1; u <= 10; u += 1) {
    const client = new ApiClient(server.app);
    await client.login(`load-user-${String(u).padStart(2, '0')}`, LOAD_PASSWORD);
    users.push(client);
  }
  return { server, admin, users, seedMs, counts, dbMb: statSync(server.databasePath).size / 1_048_576 };
}

test('speed with 10,000 jobs', async () => {
  const { server, admin, users, seedMs, counts, dbMb } = await seeded();
  const user = users[0];
  const rows: Row[] = [];
  const me = (await user.get('/api/auth/me')).json;
  const profileId = await user.defaultProfileId();

  // What the first start after an upgrade does: give every saved job its tags and fingerprints.
  let started = performance.now();
  const backfilled = backfillJobFacts(server.ctx.handle.sqlite);
  const backfillMs = performance.now() - started;

  const jobId = (await user.get('/api/jobs?limit=1')).json.items[0].id;
  const list = (query: string) => () => user.get(`/api/jobs${query}`);

  await measure(rows, 'list: default (first page)', list('?limit=100'));
  await measure(rows, 'list: all shared, recent', list('?scope=all&sort=recent&limit=100'));
  await measure(rows, 'list: mine, recent', list('?scope=mine&sort=recent&limit=100'));
  await measure(rows, 'list: sort updated', list('?sort=updated&limit=100'));
  await measure(rows, 'list: sort company', list('?sort=company&limit=100'));
  await measure(rows, 'list: sort interview', list('?sort=interview&limit=100'));
  await measure(rows, 'list: sort status', list('?sort=status&limit=100'));
  await measure(rows, 'list: sort most applied', list('?sort=applicants&limit=100'));
  await measure(rows, 'list: starred first', list('?highlightFirst=true&limit=100'));
  await measure(rows, 'list: highlighted only', list('?highlighted=true&limit=100'));
  await measure(rows, 'list: search common word', list('?q=snowflake&limit=100'));
  await measure(rows, 'list: search rare word', list('?q=principal%20robotics&limit=100'));
  await measure(rows, 'list: search memo text', list('?q=referred&limit=100'));
  await measure(rows, 'list: company filter', list('?company=acme&limit=100'));
  await measure(rows, 'list: status filter', list('?status=Offer&limit=100'));
  await measure(rows, 'list: person filter', list(`?personId=${me.id}&limit=100`));
  await measure(rows, 'list: profile filter', list(`?profileId=${profileId}&limit=100`));
  await measure(rows, 'list: interview date range', list(`?interviewFrom=${encodeURIComponent(new Date().toISOString())}&limit=100`));
  await measure(rows, 'list: everything combined', list(`?q=data&status=Applied&personId=${me.id}&sort=applicants&limit=100`));
  await measure(rows, 'list: deep page (offset 9900)', list('?offset=9900&limit=100'));
  await measure(rows, 'list: 1,000 rows at once', list('?limit=1000'), 5);
  await measure(rows, 'list: 5,000 rows at once', list('?limit=5000'), 3);

  await measure(rows, 'job details', (run) => user.get(`/api/jobs/${jobId + run}`));
  await measure(rows, 'dashboard', () => user.get('/api/dashboard'));
  await measure(rows, 'team page data', () => user.get('/api/team'));
  await measure(rows, 'interviews: mine', () => user.get('/api/interviews'));
  await measure(rows, 'interviews: everyone', () => user.get('/api/interviews?person=all'));
  await measure(rows, 'companies list', () => user.get('/api/jobs/companies'));
  await measure(rows, 'my profiles', () => user.get('/api/profiles'));
  await measure(rows, 'admin: users list', () => admin.get('/api/admin/users'));

  // Writes, including duplicate detection against everything already there.
  const applications = (await user.get('/api/jobs?scope=mine&limit=20')).json.items.flatMap((job: any) => job.applications.filter((item: any) => item.isMine).map((item: any) => item.id));
  await measure(rows, 'change a status', (run) => user.patch(`/api/applications/${applications[run % applications.length]}`, { status: run % 2 ? 'Applied' : 'Recruiter Screen' }));
  await measure(rows, 'add a job: link already known', async (run) => {
    const url = (await user.get(`/api/jobs/${jobId + 100 + run}`)).json.urls[0].originalUrl;
    return user.post('/api/applications', { url, profileId });
  });
  for (let run = 0; run < 15; run += 1) {
    server.http.serve(
      `https://new-${run}.example.org/jobs/1`,
      jobPage({ title: 'Senior Data Engineer', company: 'Acme Health', description: `${'A brand new opening with text of its own for this particular team '.repeat(8)} ${run}` })
    );
  }
  await measure(rows, 'add a job: brand new link', (run) => user.post('/api/applications', { url: `https://new-${run}.example.org/jobs/1`, profileId, resolution: { action: 'new' } }));
  for (let run = 0; run < 15; run += 1) {
    server.http.serve(
      `https://check-${run}.example.org/jobs/1`,
      jobPage({ title: 'Senior Data Engineer', company: 'Acme Health', description: `${'Another opening whose text needs comparing with similar ones at this company '.repeat(8)} ${run}` })
    );
  }
  await measure(rows, 'add a job: content comparison', (run) => user.post('/api/applications', { url: `https://check-${run}.example.org/jobs/1`, profileId }));

  // Everyone at once: the slow request decides how long the others wait.
  const concurrent = async (name: string, each: (client: ApiClient, index: number) => Promise<unknown>) => {
    const started = performance.now();
    await Promise.all(users.map(each));
    const total = performance.now() - started;
    rows.push({ name, p50: round(total), p95: round(total), max: round(total), kb: 0 });
  };
  await concurrent('10 users open All Jobs together', (client) => client.get('/api/jobs?limit=100'));
  await concurrent('10 users open Team together', (client) => client.get('/api/team'));
  await concurrent('10 users refresh everything', async (client) => {
    await Promise.all([client.get('/api/jobs?limit=100'), client.get('/api/dashboard'), client.get('/api/team'), client.get('/api/jobs/companies'), client.get('/api/profiles')]);
  });

  // Last, because it merges whatever the generated data happens to repeat.
  // Then every job is compared with the rest in the background, while people keep working.
  const during: number[] = [];
  let sweeping = true;
  started = performance.now();
  const sweep = sweepDuplicates(server.ctx).finally(() => {
    sweeping = false;
  });
  for (let run = 0; sweeping; run += 1) {
    const requested = performance.now();
    // A different page each time, so that no answer comes from the cache.
    await user.get(`/api/jobs?offset=${(run * 100) % 9900}&limit=100`);
    during.push(performance.now() - requested);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const swept = await sweep;
  const sweepMs = performance.now() - started;
  during.sort((a, b) => a - b);
  rows.push({ name: 'list while duplicates are checked', p50: round(percentile(during, 0.5)), p95: round(percentile(during, 0.95)), max: round(during[during.length - 1]), kb: 0, count: during.length });
  await measure(rows, 'duplicates to review', () => user.get('/api/duplicates'));
  await measure(rows, 'duplicates count', () => user.get('/api/duplicates/count'));

  const width = Math.max(...rows.map((row) => row.name.length));
  const lines = [
    `Data: ${JSON.stringify(counts)}`,
    `Seeded in ${(seedMs / 1000).toFixed(1)}s. Database: ${dbMb.toFixed(0)} MB.`,
    `Tags and fingerprints for ${backfilled} saved jobs: ${(backfillMs / 1000).toFixed(1)}s, once, on the first start after upgrading.`,
    `Background duplicate check of ${swept.checked} jobs: ${(sweepMs / 1000).toFixed(1)}s; merged ${swept.merged}, waiting for review ${swept.pending}.`,
    '',
    `${'request'.padEnd(width)}    p50 ms    p95 ms    max ms   size KB   results`,
    ...rows.map((row) => `${row.name.padEnd(width)}  ${String(row.p50).padStart(8)}  ${String(row.p95).padStart(8)}  ${String(row.max).padStart(8)}  ${String(row.kb).padStart(8)}  ${String(row.count ?? '').padStart(8)}`)
  ];
  console.log(lines.join('\n'));
  const label = process.env.SURVEY_ARGS?.match(/--label (\S+)/)?.[1];
  writeFileSync(`load-report${label ? `.${label}` : ''}.json`, JSON.stringify({ counts, seedMs, dbMb, backfilled, backfillMs, swept, sweepMs, rows }, null, 2));
}, 600_000);
