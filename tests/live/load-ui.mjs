// Speed of the real desktop app with 10,000 jobs, 10 users and 5 profiles each: one host and
// one client, over real HTTPS. Times run from the action until the result is on screen.
//
//   npm run build && node tests/live/load-ui.mjs [--label after] [--keep folder]
//
// With --keep, the host's data stays in that folder afterwards, so you can open it yourself:
//   $env:JOB_TRACKER_USER_DATA = "<folder>"; npm run dev
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOAD_PASSWORD, seedLoadData } from '../../scripts/seed-load.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'package.json'));
const { _electron: electron } = require('playwright-core');
const electronPath = require('electron');
const Database = require('better-sqlite3');
const argon2 = require('argon2');

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const label = option('--label');
const keep = option('--keep');
const work = mkdtempSync(join(tmpdir(), 'job-tracker-load-'));
const hostFolder = keep ?? join(work, 'host');
const PORT = 3900 + Math.floor(Math.random() * 90);
const shots = join(work, 'shots');
const results = [];
const running = new Set();

async function launch(folder) {
  const env = { ...process.env, JOB_TRACKER_USER_DATA: folder };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const app = await electron.launch({ executablePath: electronPath, args: [root], env, colorScheme: 'no-override' });
  running.add(app);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function close(instance) {
  running.delete(instance.app);
  await instance.app.close().catch(() => undefined);
}

/** Runs an action and times it until the condition holds, measured inside the page's own clock. */
async function timed(name, page, action, until) {
  const started = Date.now();
  await action();
  await until();
  // Two animation frames: the result has really been painted, not only added to the page.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const ms = Date.now() - started;
  results.push({ name, ms });
  console.log(`  ${String(ms).padStart(7)} ms  ${name}`);
  return ms;
}

const rows = (page) => page.locator('[data-job-row]');
const nav = (page, name) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();
const firstRowText = (page) => rows(page).first().innerText();
const pageStats = (page) =>
  page.evaluate(() => ({
    domNodes: document.querySelectorAll('*').length,
    heapMb: Math.round(performance.memory.usedJSHeapSize / 1_048_576),
    tableRows: document.querySelectorAll('[data-job-row]').length
  }));

/** Measures how smooth scrolling is: the longest gap between painted frames, in milliseconds. */
const scrollProbe = (page) =>
  page.evaluate(async () => {
    const scroller = document.querySelector('[data-scroller]') ?? document.querySelector('tbody').closest('.overflow-auto');
    const gaps = [];
    let last = performance.now();
    const distance = scroller.scrollHeight - scroller.clientHeight;
    const duration = 1500;
    const started = performance.now();
    await new Promise((resolve) => {
      const step = (now) => {
        gaps.push(now - last);
        last = now;
        const progress = Math.min(1, (now - started) / duration);
        scroller.scrollTop = distance * progress;
        if (progress < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    gaps.sort((a, b) => a - b);
    return { frames: gaps.length, worstFrameMs: Math.round(gaps[gaps.length - 1]), p95FrameMs: Math.round(gaps[Math.floor(gaps.length * 0.95)]), scrollHeight: scroller.scrollHeight };
  });

try {
  console.log('Preparing the host');
  let host = await launch(hostFolder);
  await host.page.getByRole('heading', { name: 'How will this computer be used?' }).waitFor();
  await host.page.evaluate((port) => window.jobTracker.startHost(port), PORT);
  await host.page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 30_000 });
  await host.page.getByLabel('Username').fill('admin');
  await host.page.getByLabel('Password').fill('admin');
  await host.page.getByRole('button', { name: 'Sign in' }).click();
  await host.page.getByLabel('Current password').fill('admin');
  await host.page.getByLabel('New password', { exact: true }).fill('load-admin-password');
  await host.page.getByLabel('New password again').fill('load-admin-password');
  await host.page.getByRole('button', { name: 'Save and continue' }).click();
  await host.page.getByRole('heading', { name: 'All Jobs' }).waitFor();
  await close(host);

  const databasePath = join(hostFolder, 'host-data', 'job-tracker.sqlite');
  const started = Date.now();
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  const counts = seedLoadData(database, { passwordHash: await argon2.hash(LOAD_PASSWORD) });
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.close();
  console.log(`Seeded ${JSON.stringify(counts)} in ${((Date.now() - started) / 1000).toFixed(1)}s, database ${(statSync(databasePath).size / 1_048_576).toFixed(0)} MB\n`);

  console.log('Host, signed in, with 10,000 jobs');
  const launchStarted = Date.now();
  host = await launch(hostFolder);
  await rows(host.page).first().waitFor({ timeout: 120_000 });
  results.push({ name: 'start the app until jobs are on screen', ms: Date.now() - launchStarted });
  console.log(`  ${String(Date.now() - launchStarted).padStart(7)} ms  start the app until jobs are on screen`);
  const page = host.page;

  await timed('open Dashboard', page, () => nav(page, 'Dashboard'), () => page.getByRole('heading', { name: /Upcoming interviews/ }).waitFor());
  await timed('open All Jobs', page, () => nav(page, 'All Jobs'), () => rows(page).first().waitFor());
  const initial = await firstRowText(page);

  const chooseSort = async (name) => {
    await page.getByRole('combobox', { name: 'Sort by' }).click();
    await page.getByRole('option', { name }).click();
  };
  const changed = async (before) => page.waitForFunction((text) => document.querySelector('[data-job-row]')?.innerText !== text, before, { timeout: 60_000 });
  await timed('sort by Most applied', page, () => chooseSort('Most applied'), () => changed(initial));
  const sorted = await firstRowText(page);
  await timed('sort by Company', page, () => chooseSort('Company'), () => changed(sorted));
  const byCompany = await firstRowText(page);
  await timed('back to Recently added', page, () => chooseSort('Recently added'), () => changed(byCompany));

  const recent = await firstRowText(page);
  await timed('search: type and see results', page, () => page.getByLabel('Search').fill('robotics principal'), () => changed(recent));
  const found = await firstRowText(page);
  await timed('clear search', page, () => page.getByLabel('Search').fill(''), () => changed(found));

  await timed('open a job', page, () => rows(page).first().click(), () => page.getByRole('heading', { level: 2 }).first().waitFor());
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' }).catch(() => undefined);

  console.log(`  first page: ${JSON.stringify(await pageStats(page))}`);
  console.log(`  scrolling : ${JSON.stringify(await scrollProbe(page))}`);

  // Reaches deep into the list, the way someone scrolling through it would.
  const showMore = page.getByRole('button', { name: /Show more/ });
  if ((await showMore.count()) > 0) {
    for (let pageNumber = 2; pageNumber <= 10; pageNumber += 1) {
      const before = await rows(page).count();
      await timed(`load page ${pageNumber} of 100 rows`, page, () => showMore.click(), () => page.waitForFunction((count) => document.querySelectorAll('tbody tr').length > count, before, { timeout: 60_000 }));
    }
  } else {
    const jumpTo = (fraction, name, minIndex) =>
      timed(name, page, () => page.waitForTimeout(0), () =>
        page.waitForFunction(
          ([position, wanted]) => {
            const scroller = document.querySelector('[data-scroller]');
            scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * position;
            return [...document.querySelectorAll('tbody[data-index]')].some((body) => Number(body.dataset.index) >= wanted && body.querySelector('[data-job-row]'));
          },
          [fraction, minIndex],
          { timeout: 60_000, polling: 'raf' }
        )
      );
    await jumpTo(0.5, 'jump to the middle of 10,000 jobs', 4000);
    await jumpTo(1, 'jump to the end of 10,000 jobs', 9900);
  }
  console.log(`  deep in the list: ${JSON.stringify(await pageStats(page))}`);
  const deep = await scrollProbe(page);
  console.log(`  scrolling: ${JSON.stringify(deep)}`);
  results.push({ name: 'worst frame while scrolling deep list', ms: deep.worstFrameMs });

  await timed('open Team', page, () => nav(page, 'Team'), () => page.getByText(/Load User 10/).first().waitFor());
  await timed('open Interviews', page, () => nav(page, 'Interviews'), () => page.getByRole('heading', { name: 'Interviews' }).waitFor());
  await page.getByText(/Video call|Recruiter Screen|Technical Interview/).first().waitFor({ timeout: 30_000 });
  await timed('open Settings', page, () => nav(page, 'Settings'), () => page.getByRole('heading', { name: 'Settings' }).waitFor());

  console.log('\nA second person over HTTPS');
  const state = await page.evaluate(() => window.jobTracker.getState());
  const client = await launch(join(work, 'client'));
  await client.page.getByRole('button', { name: /Client: connect to a host/ }).click();
  await client.page.getByLabel('Server address').fill(`127.0.0.1:${PORT}`);
  await client.page.getByRole('button', { name: 'Find host' }).click();
  await client.page.getByRole('button', { name: /It matches/ }).click();
  await client.page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 15_000 });
  await client.page.getByLabel('Username').fill('load-user-01');
  await client.page.getByLabel('Password').fill(LOAD_PASSWORD);
  await timed('sign in until jobs are on screen', client.page, () => client.page.getByRole('button', { name: 'Sign in' }).click(), () => rows(client.page).first().waitFor({ timeout: 60_000 }));
  const clientFirst = await firstRowText(client.page);
  await nav(page, 'All Jobs');
  await rows(page).first().waitFor();

  // A change by one person, seen by the other with no refresh.
  const jobToStar = await client.page.evaluate(async () => (await window.jobTracker.api('GET', '/api/jobs?limit=1')).data.items[0]);
  const liveStarted = Date.now();
  await client.page.evaluate((id) => window.jobTracker.api('POST', `/api/jobs/${id}/highlight`, { highlighted: !window.__toggled }), jobToStar.id);
  await page.waitForFunction(
    (id) => window.jobTracker.api('GET', `/api/jobs/${id}`).then((result) => result.data.isHighlighted),
    jobToStar.id,
    { timeout: 30_000 }
  );
  results.push({ name: 'a change reaches the other person', ms: Date.now() - liveStarted });
  console.log(`  ${String(Date.now() - liveStarted).padStart(7)} ms  a change reaches the other person`);
  void clientFirst;
  void state;
  void shots;

  await close(client);
  await close(host);
  writeFileSync(join(root, `load-report-ui${label ? `.${label}` : ''}.json`), JSON.stringify(results, null, 2));
  console.log(keep ? `\nThe seeded data stays in ${keep}` : '');
} catch (error) {
  console.error('Stopped early:', error);
  process.exitCode = 1;
} finally {
  for (const app of running) await app.close().catch(() => undefined);
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A lingering process can hold files for a moment. It's a temp folder.
  }
}
