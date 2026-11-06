import { writeFileSync } from 'node:fs';
import { test } from 'vitest';
// @ts-expect-error A plain script, shared with the command line and the desktop-app speed test.
import { LOAD_PASSWORD, seedLoadData } from '../../scripts/seed-load.mjs';
import { addDays, monthStart } from '../../src/shared/calendar';
import { ApiClient, createTestServer, signInAdmin } from '../helpers';

/**
 * Speed of the numbers pages with about 55,000 applications: the Dashboard and Team page answers,
 * worked out from nothing after a change, and ten people opening them together after one. Opt-in,
 * run under Electron's Node like the other live tests:
 *
 *   ELECTRON_RUN_AS_NODE=1 JOB_TRACKER_SURVEY=1 SURVEY_ARGS="--jobs 25000 --out report.json" \
 *     electron node_modules/vitest/vitest.mjs run --config vitest.survey.config.ts tests/live/analytics-load.test.ts
 */

const TZ = 'America/New_York';
const percentile = (sorted: number[], fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
const round = (value: number) => Math.round(value * 10) / 10;

test('analytics speed with about 55,000 applications', async () => {
  const server = await createTestServer();
  await signInAdmin(server.app);
  const jobs = Number(process.env.SURVEY_ARGS?.match(/--jobs (\d+)/)?.[1] ?? 25_000);
  const counts = seedLoadData(server.ctx.handle.sqlite, { passwordHash: await server.ctx.hasher.hash(LOAD_PASSWORD), jobs });
  server.ctx.handle.sqlite.pragma('wal_checkpoint(TRUNCATE)');
  const users: ApiClient[] = [];
  for (let u = 1; u <= 10; u += 1) {
    const client = new ApiClient(server.app);
    await client.login(`load-user-${String(u).padStart(2, '0')}`, LOAD_PASSWORD);
    users.push(client);
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const activity = (scope: 'me' | 'team', from: string, to: string, group?: string) =>
    `/api/activity?tz=${encodeURIComponent(TZ)}&today=${today}&from=${from}&to=${to}&scope=${scope}${group ? `&group=${group}` : ''}`;
  const ranges = {
    'last 30 days': [addDays(today, -29), today],
    'this month': [monthStart(today), addDays(monthStart(addDays(monthStart(today), 32)), -1)],
    'this year': [`${today.slice(0, 4)}-01-01`, `${today.slice(0, 4)}-12-31`],
    today: [today, today]
  } as const;

  const rows: Array<{ name: string; p50: number; p95: number; max: number; kb: number }> = [];
  // Worked out from nothing every time: as right after anyone changes anything.
  const cold = async (name: string, client: ApiClient, url: string, runs = 7) => {
    const times: number[] = [];
    let bytes = 0;
    for (let run = 0; run < runs; run += 1) {
      server.ctx.readCache.invalidate();
      const started = performance.now();
      const response = await client.get(url);
      times.push(performance.now() - started);
      if (response.status !== 200) throw new Error(`${name}: ${response.status} ${JSON.stringify(response.json).slice(0, 300)}`);
      bytes = JSON.stringify(response.json).length;
    }
    times.sort((a, b) => a - b);
    rows.push({ name, p50: round(percentile(times, 0.5)), p95: round(percentile(times, 0.95)), max: round(times[times.length - 1]), kb: round(bytes / 1024) });
  };

  for (const [label, [from, to]] of Object.entries(ranges)) {
    await cold(`activity me: ${label}`, users[0], activity('me', from, to));
    await cold(`activity team: ${label}`, users[0], activity('team', from, to));
  }
  await cold('team applications: first page', users[0], '/api/team/applications?limit=50');
  await cold('team applications: by stage', users[0], '/api/team/applications?limit=50&sort=stage');
  await cold('team applications: by company', users[0], '/api/team/applications?limit=50&sort=company');
  await cold('team applications: last 30 days', users[0], `/api/team/applications?limit=50&tz=${encodeURIComponent(TZ)}&from=${ranges['last 30 days'][0]}&to=${today}`);
  await cold('team applications: deep page', users[0], '/api/team/applications?limit=50&offset=20000');
  await cold('interviews: past, mine', users[0], `/api/interviews?to=${encodeURIComponent(new Date().toISOString())}&limit=200&order=desc`);

  // One change, then everyone's open Team page and Dashboard ask again at once.
  const together = async (name: string, each: (client: ApiClient) => Promise<unknown>) => {
    const times: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      server.ctx.readCache.invalidate();
      const started = performance.now();
      await Promise.all(users.map(each));
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    rows.push({ name, p50: round(percentile(times, 0.5)), p95: round(percentile(times, 0.95)), max: round(times[times.length - 1]), kb: 0 });
  };
  const [from30, to30] = ranges['last 30 days'];
  await together('10 people: Team page after a change', (client) => client.get(activity('team', from30, to30)));
  await together('10 people: Dashboard after a change', (client) => client.get(activity('me', from30, to30)));
  await together('10 people: both after a change', (client) => Promise.all([client.get(activity('team', from30, to30)), client.get(activity('me', from30, to30)), client.get('/api/team/applications?limit=50')]));

  const width = Math.max(...rows.map((row) => row.name.length));
  console.log(
    [
      `Data: ${JSON.stringify(counts)}`,
      '',
      `${'request'.padEnd(width)}    p50 ms    p95 ms    max ms   size KB`,
      ...rows.map((row) => `${row.name.padEnd(width)}  ${String(row.p50).padStart(8)}  ${String(row.p95).padStart(8)}  ${String(row.max).padStart(8)}  ${String(row.kb).padStart(8)}`)
    ].join('\n')
  );
  const out = process.env.SURVEY_ARGS?.match(/--out (\S+)/)?.[1];
  if (out) writeFileSync(out, JSON.stringify({ counts, rows }, null, 2));
}, 1_800_000);
