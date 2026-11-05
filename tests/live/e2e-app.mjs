// Drives the real desktop app through the whole scenario: one host and two clients, each in
// its own Electron process and profile, talking over HTTPS as separate computers would.
// Uses live job sites, so it is opt-in:
//
//   npm run build && node tests/live/e2e-app.mjs [folder-for-screenshots]
//
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'package.json'));
const { _electron: electron } = require('playwright-core');
const electronPath = require('electron');

const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'job-tracker-shots-'));
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'job-tracker-e2e-'));
const PORT = 3847 + Math.floor(Math.random() * 900) + 100;

const BUILT_IN_URL = process.env.E2E_BUILTIN_URL ?? 'https://builtin.com/job/principal-data-engineer/12088047';
const JOBRIGHT_URL = process.env.E2E_JOBRIGHT_URL ?? 'https://jobright.ai/jobs/info/6a99b276138838706058fac2';
const MEMO = 'Applied through LinkedIn. Recruiter contacted me.';

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const running = new Set();
async function launch(name) {
  const env = { ...process.env, JOB_TRACKER_USER_DATA: join(work, name) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  // Without no-override Playwright pins prefers-color-scheme to light, which would hide the theme setting.
  const app = await electron.launch({ executablePath: process.env.E2E_EXECUTABLE ?? electronPath, args: process.env.E2E_EXECUTABLE ? [] : [root], env, colorScheme: 'no-override' });
  running.add(app);
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.waitForLoadState('domcontentloaded');
  return { app, page, errors, name };
}
async function close(instance) {
  running.delete(instance.app);
  await instance.app.close().catch(() => undefined);
}
const shot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) });

async function signIn(page, username, password) {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
const nav = (page, label) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: label }).click();

async function addUser(page, username, password, displayName) {
  await page.getByRole('button', { name: 'Add user' }).first().click();
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Display name (optional)').fill(displayName);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('dialog').getByRole('button', { name: 'Add user' }).click();
  await page.getByRole('button', { name: `Actions for ${username}` }).waitFor();
}

async function pairClient(page, address, fingerprint) {
  await page.getByRole('button', { name: /Client: connect to a host/ }).click();
  await page.getByLabel('Server address').fill(address);
  await page.getByRole('button', { name: 'Find host' }).click();
  await page.getByRole('heading', { name: 'Confirm this is your host' }).waitFor({ timeout: 15_000 });
  const shown = await page.locator('code').first().innerText();
  check(`client shows the host's fingerprint (${page === undefined ? '' : address})`, shown === fingerprint, `${shown} vs ${fingerprint}`);
  await page.getByRole('button', { name: /It matches/ }).click();
}

try {
  console.log(`Work folder: ${work}\nScreenshots: ${shots}\n`);

  console.log('Host setup');
  const host = await launch('computer-a');
  await host.page.getByRole('heading', { name: 'How will this computer be used?' }).waitFor();
  await shot(host.page, '01-first-launch');
  // Start on a test port, so a real install on this computer is left alone.
  await host.page.evaluate((port) => window.jobTracker.startHost(port), PORT);
  await host.page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 30_000 });
  await shot(host.page, '02-login');

  await signIn(host.page, 'admin', 'wrong-password');
  await host.page.getByText(/Incorrect username or password/).waitFor();
  check('wrong password is refused', true);

  await signIn(host.page, 'admin', 'admin');
  await host.page.getByRole('heading', { name: 'Choose a new password' }).waitFor();
  check('admin/admin must change the password first', true);
  await shot(host.page, '03-required-password-change');
  await host.page.getByLabel('Current password').fill('admin');
  await host.page.getByLabel('New password', { exact: true }).fill('host-admin-password');
  await host.page.getByLabel('New password again').fill('host-admin-password');
  await host.page.getByRole('button', { name: 'Save and continue' }).click();
  await host.page.getByRole('heading', { name: /Welcome back, admin/ }).waitFor();
  check('admin reaches the dashboard', true);

  await nav(host.page, 'Users');
  await addUser(host.page, 'tyler', 'tyler-password', 'Tyler Morgan');
  await addUser(host.page, 'john', 'john-password', 'John Doe');
  await shot(host.page, '04-users');
  check('admin created Tyler and John', true);

  await nav(host.page, 'Settings');
  await host.page.getByRole('heading', { name: 'This computer is the host' }).waitFor();
  await shot(host.page, '05-host-settings');
  const state = await host.page.evaluate(() => window.jobTracker.getState());
  check('host shows a LAN address', state.host.addresses.length > 0, JSON.stringify(state.host));
  const lanIp = Object.values(networkInterfaces()).flat().find((info) => info.family === 'IPv4' && !info.internal)?.address ?? '127.0.0.1';
  const address = `${state.host.addresses[0] ?? lanIp}:${PORT}`;
  console.log(`  host address: ${address}`);

  console.log('\nClients connect over HTTPS');
  const tyler = await launch('computer-b');
  await pairClient(tyler.page, address, state.host.fingerprint);
  await tyler.page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 15_000 });
  await signIn(tyler.page, 'tyler', 'tyler-password');
  await tyler.page.getByRole('heading', { name: /Welcome back, Tyler Morgan/ }).waitFor();
  check('Tyler signed in from "computer B"', true);
  check('regular user has no Users page', (await tyler.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Users' }).count()) === 0);

  const john = await launch('computer-c');
  await pairClient(john.page, address, state.host.fingerprint);
  await john.page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 15_000 });
  await signIn(john.page, 'john', 'john-password');
  await john.page.getByRole('heading', { name: /Welcome back, John Doe/ }).waitFor();
  check('John signed in from "computer C"', true);

  console.log('\nTyler adds a Built In link');
  await tyler.page.getByRole('button', { name: 'Add job' }).first().click();
  await shot(tyler.page, '06-add-job');
  await tyler.page.getByLabel('Job URL').fill(BUILT_IN_URL);
  await tyler.page.getByLabel('Memo (optional)').fill(MEMO);
  await tyler.page.getByRole('button', { name: 'Save Application' }).click();
  await tyler.page.getByRole('heading', { level: 2 }).filter({ hasText: /Engineer/ }).waitFor({ timeout: 120_000 });
  const title = await tyler.page.getByRole('heading', { level: 2 }).filter({ hasText: /Engineer/ }).innerText();
  await tyler.page.getByText(/About|Responsibilities|experience/i).first().waitFor();
  await shot(tyler.page, '07-job-detail');
  console.log(`  extracted: ${title}`);
  check('title, company and description were extracted automatically', !!title);
  check('memo was saved', (await tyler.page.getByLabel('Memo').inputValue()) === MEMO);
  await tyler.page.getByRole('button', { name: 'Close', exact: true }).click();

  console.log('\nJohn adds the equivalent Jobright link');
  await john.page.getByRole('button', { name: 'Add job' }).first().click();
  await john.page.getByLabel('Job URL').fill(JOBRIGHT_URL);
  await john.page.getByRole('button', { name: 'Save Application' }).click();
  const outcome = await Promise.race([
    john.page.getByRole('heading', { name: 'Is this one of these jobs?' }).waitFor({ timeout: 120_000 }).then(() => 'dialog'),
    john.page.getByRole('heading', { level: 2 }).filter({ hasText: /Engineer/ }).waitFor({ timeout: 120_000 }).then(() => 'merged')
  ]);
  console.log(`  outcome: ${outcome}`);
  if (outcome === 'dialog') {
    await shot(john.page, '08-possible-duplicate');
    await john.page.getByRole('button', { name: 'Same job' }).first().click();
    await john.page.getByRole('heading', { level: 2 }).filter({ hasText: /Engineer/ }).waitFor({ timeout: 30_000 });
  }
  await john.page.getByRole('img', { name: /Tyler Morgan/ }).first().waitFor();
  await john.page.getByRole('img', { name: /John Doe/ }).first().waitFor();
  await shot(john.page, '09-two-avatars-on-one-job');
  check('both URLs are one job, with both avatars', true);

  const count = await tyler.page.evaluate(async () => (await window.jobTracker.api('GET', '/api/jobs')).data.total);
  check('the database holds one shared job', count === 1, `found ${count}`);

  console.log('\nLive updates and independent statuses');
  await nav(tyler.page, 'All Jobs');
  await tyler.page.getByRole('img', { name: /John Doe/ }).first().waitFor({ timeout: 10_000 });
  check("John's avatar appeared on Tyler's screen without refreshing", true);

  await nav(tyler.page, 'My Applications');
  await tyler.page.getByRole('combobox', { name: 'Application status' }).first().click();
  await tyler.page.getByRole('option', { name: 'Technical Interview' }).click();
  await tyler.page.getByRole('combobox', { name: 'Application status' }).first().getByText('Technical Interview').waitFor();
  await john.page.getByRole('combobox', { name: 'Application status' }).first().click();
  await john.page.getByRole('option', { name: 'Recruiter Screen' }).click();
  await john.page.getByRole('combobox', { name: 'Application status' }).first().getByText('Recruiter Screen').waitFor();

  const statusOf = (instance) => instance.page.evaluate(async () => (await window.jobTracker.api('GET', '/api/jobs')).data.items[0].myApplication.status);
  check('Tyler is at Technical Interview', (await statusOf(tyler)) === 'Technical Interview');
  check('John is at Recruiter Screen, independently', (await statusOf(john)) === 'Recruiter Screen');

  console.log('\nTyler schedules an interview');
  await tyler.page.getByRole('row').nth(1).click();
  await tyler.page.getByRole('button', { name: 'Schedule' }).click();
  await tyler.page.getByLabel('Date').fill('2030-11-13');
  await tyler.page.getByLabel('Time').fill('14:00');
  await tyler.page.getByLabel('Note (optional)').fill('Video call with the hiring team');
  await tyler.page.getByRole('dialog', { name: 'Schedule interview' }).getByRole('button', { name: 'Save' }).click();
  await tyler.page.getByText('Video call with the hiring team').waitFor();
  await shot(tyler.page, '10-interview-history');
  await tyler.page.getByRole('button', { name: 'Close', exact: true }).click();
  const hidden = await john.page.evaluate(async () => JSON.stringify((await window.jobTracker.api('GET', '/api/jobs')).data) + JSON.stringify((await window.jobTracker.api('GET', '/api/interviews')).data));
  check("Tyler's memo and interview stay hidden from John", !hidden.includes('Recruiter contacted') && !hidden.includes('Video call'));

  console.log('\nJohn highlights the job');
  await john.page.getByRole('button', { name: 'Close', exact: true }).click().catch(() => undefined);
  await nav(john.page, 'All Jobs');
  await john.page.getByRole('button', { name: 'Highlight this job for everyone' }).first().click();
  await tyler.page.getByRole('button', { name: 'Remove highlight' }).first().waitFor({ timeout: 10_000 });
  check("the highlight reached Tyler's screen live", true);
  await nav(host.page, 'Highlighted');
  await host.page.getByRole('button', { name: 'Remove highlight' }).first().waitFor({ timeout: 10_000 });
  await shot(host.page, '11-highlighted');
  check('everyone sees it under Highlighted', true);

  console.log('\nFiltering');
  await nav(tyler.page, 'My Applications');
  const company = (await tyler.page.getByRole('row').nth(1).getByRole('cell').first().innerText()).trim();
  const results = () => tyler.page.locator('tbody tr').count();
  const settle = () => tyler.page.waitForTimeout(500);
  await tyler.page.getByLabel('Company').fill(company.slice(0, 6));
  await settle();
  check('company filter finds it', (await results()) === 1);
  await tyler.page.getByLabel('Search').fill('recruiter');
  await settle();
  check('memo search finds it', (await results()) === 1);
  await tyler.page.getByRole('combobox', { name: 'My status' }).click();
  await tyler.page.getByRole('option', { name: 'Technical Interview' }).click();
  await settle();
  await tyler.page.getByLabel('Interviews from').fill('2030-11-01');
  await tyler.page.getByLabel('Interviews to').fill('2030-11-30');
  await settle();
  await shot(tyler.page, '12-combined-filters');
  check('company + status + memo + interview dates combine', (await results()) === 1);
  await tyler.page.getByLabel('Interviews from').fill('2031-01-01');
  await tyler.page.getByLabel('Interviews to').fill('2031-01-30');
  await tyler.page.getByText('Nothing matches these filters').waitFor();
  check('a date range outside the interview finds nothing', true);

  await nav(tyler.page, 'Dashboard');
  await tyler.page.getByRole('heading', { name: 'Upcoming interviews' }).waitFor();
  await tyler.page.waitForTimeout(400);
  await shot(tyler.page, '13-dashboard');
  await nav(tyler.page, 'Interviews');
  await tyler.page.getByText('Video call with the hiring team').waitFor();
  await shot(tyler.page, '14-interviews');
  await nav(tyler.page, 'All Jobs');
  const background = () => tyler.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await tyler.page.evaluate(() => window.jobTracker.setTheme('dark'));
  await tyler.page.waitForTimeout(300);
  const darkBackground = await background();
  await shot(tyler.page, '15-dark-mode');
  await tyler.page.evaluate(() => window.jobTracker.setTheme('light'));
  await tyler.page.waitForTimeout(300);
  const lightBackground = await background();
  check('the theme setting really changes the app', darkBackground === 'rgb(15, 17, 21)' && lightBackground === 'rgb(247, 247, 248)', `${darkBackground} / ${lightBackground}`);
  await tyler.page.evaluate(() => window.jobTracker.setTheme('system'));

  console.log('\nHost goes away');
  await close(host);
  await tyler.page.getByText('Cannot reach the host.').waitFor({ timeout: 40_000 });
  await shot(tyler.page, '16-host-offline');
  check('a client shows a clear connection error', true);
  const filesMatching = (dir, pattern) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((file) => pattern.test(String(file))).map(String) : []);
  // Chromium keeps a few .db files of its own in every profile (first_party_sets.db and the like).
  console.log(`  every .db/.sqlite file on client B: ${JSON.stringify(filesMatching(join(work, 'computer-b'), /\.(sqlite|db)(-wal|-shm)?$/))}`);
  check('clients created no job databases of their own', filesMatching(join(work, 'computer-b'), /\.sqlite/).length === 0 && filesMatching(join(work, 'computer-c'), /\.sqlite/).length === 0);
  const hostDatabases = filesMatching(join(work, 'computer-a'), /\.sqlite$/);
  check('the host has its database in application data', hostDatabases.length === 1 && hostDatabases[0].startsWith('host-data'), JSON.stringify(hostDatabases));

  console.log('\nEverything comes back after restarting');
  await close(tyler);
  await close(john);
  const hostAgain = await launch('computer-a');
  await hostAgain.page.getByRole('heading', { name: /Welcome back, admin/ }).waitFor({ timeout: 30_000 });
  check('host restarted by itself and remembered the session', true);
  const tylerAgain = await launch('computer-b');
  await tylerAgain.page.getByRole('heading', { name: /Welcome back, Tyler Morgan/ }).waitFor({ timeout: 20_000 });
  check('client reconnected by itself and remembered the session', true);
  const after = await tylerAgain.page.evaluate(async () => {
    const list = (await window.jobTracker.api('GET', '/api/jobs')).data;
    const detail = (await window.jobTracker.api('GET', `/api/jobs/${list.items[0].id}`)).data;
    return { total: list.total, applicants: detail.applicants.length, highlighted: detail.isHighlighted, status: detail.myApplication.status, memo: detail.myApplication.memo, interviews: detail.myApplication.interviews.length, urls: detail.urls.length };
  });
  console.log(`  after restart: ${JSON.stringify(after)}`);
  check('job, applicants, highlight, status, memo and interview all persisted', after.total === 1 && after.applicants === 2 && after.highlighted && after.status === 'Technical Interview' && after.memo === MEMO && after.interviews === 1 && after.urls >= 2);

  console.log('\nThe other ways adding a job can go');
  const addJob = async (url) => {
    await tylerAgain.page.getByRole('button', { name: 'Add job' }).first().click();
    await tylerAgain.page.getByLabel('Job URL').fill(url);
    await tylerAgain.page.getByRole('button', { name: 'Save Application' }).click();
  };
  const closeDetail = () => tylerAgain.page.getByRole('button', { name: 'Close', exact: true }).click();

  await addJob(BUILT_IN_URL);
  await tylerAgain.page.getByRole('heading', { name: 'You already applied to this job' }).waitFor({ timeout: 30_000 });
  await shot(tylerAgain.page, '18-already-applied');
  check('adding a job twice shows the existing application', true);
  await tylerAgain.page.getByRole('button', { name: 'Open my application' }).click();
  await tylerAgain.page.getByLabel('Memo').waitFor();
  check('...and offers to open it', (await tylerAgain.page.getByLabel('Memo').inputValue()) === MEMO);
  await closeDetail();

  const JOBDIVA_URL = 'https://www1.jobdiva.com/portal/?a=9xjdnw687b7a7nvvdyut936kpjlgy0023blrozaecads0pdnwppcswnaaku8ji2g#/jobs/29382464';
  await addJob(JOBDIVA_URL);
  await tylerAgain.page.getByRole('heading', { name: 'Add the job details' }).waitFor({ timeout: 120_000 });
  await tylerAgain.page.getByText(/bot check|could not find|closed or removed/i).first().waitFor();
  await shot(tylerAgain.page, '19-manual-entry');
  check('an unreadable page explains why and asks for the details', true);
  await tylerAgain.page.getByLabel('Job title').fill('Data Engineer');
  await tylerAgain.page.getByLabel('Company', { exact: true }).fill('Typed By Hand Inc');
  await tylerAgain.page.getByLabel('Job description').fill('The description, pasted in by hand because the site showed a bot check.');
  await tylerAgain.page.getByRole('button', { name: 'Save application' }).click();
  await tylerAgain.page.getByRole('heading', { level: 2, name: 'Data Engineer' }).waitFor({ timeout: 30_000 });
  await tylerAgain.page.getByText('Details entered by hand.').waitFor();
  check('...and saves what was typed', true);
  await closeDetail();

  await addJob('https://jobs.ashbyhq.com/gravie/ae035962-5696-43fe-9eb9-fa891860c8a3');
  await tylerAgain.page.getByRole('heading', { level: 2, name: /Senior Data Engineer/ }).waitFor({ timeout: 120_000 });
  await closeDetail();
  await addJob('https://jobright.ai/jobs/info/6a9888ca83fc633357632091');
  await tylerAgain.page.getByRole('heading', { name: 'Is this one of these jobs?' }).waitFor({ timeout: 120_000 });
  await tylerAgain.page.getByText('Same company').first().waitFor();
  await shot(tylerAgain.page, '20-possible-duplicate');
  check('an uncertain match asks, and says why', true);
  await tylerAgain.page.getByRole('button', { name: 'Same job' }).first().click();
  await tylerAgain.page.getByRole('heading', { name: 'You already applied to this job' }).waitFor({ timeout: 30_000 });
  await tylerAgain.page.getByRole('button', { name: 'Close', exact: true }).last().click();
  const gravie = await tylerAgain.page.evaluate(async () => {
    const list = (await window.jobTracker.api('GET', '/api/jobs?q=gravie')).data;
    const detail = (await window.jobTracker.api('GET', `/api/jobs/${list.items[0].id}`)).data;
    return { total: list.total, platforms: detail.urls.map((url) => url.sourcePlatform) };
  });
  check('confirming keeps one job and saves the new link for it', gravie.total === 1 && gravie.platforms.includes('jobright') && gravie.platforms.includes('ashby'), JSON.stringify(gravie));

  console.log('\nBackup');
  await nav(hostAgain.page, 'Settings');
  await hostAgain.page.getByRole('button', { name: 'Back up now' }).click();
  await hostAgain.page.getByText(/Backup saved/).waitFor();
  await shot(hostAgain.page, '17-backup');
  check('backup created from Settings', readdirSync(join(work, 'computer-a', 'host-data', 'backups')).some((file) => statSync(join(work, 'computer-a', 'host-data', 'backups', file)).size > 0));

  const logText = require('node:fs').readFileSync(join(work, 'computer-a', 'host-data', 'logs', 'server.log'), 'utf8');
  check('the log holds no passwords or tokens', !/host-admin-password|tyler-password|argon2id|Bearer /.test(logText));
  const loginAsSeenByPage = await tylerAgain.page.evaluate(() => window.jobTracker.api('POST', '/api/auth/login', { username: 'tyler', password: 'tyler-password' }));
  check('page code never receives the session token', loginAsSeenByPage.ok && loginAsSeenByPage.data.user.username === 'tyler' && !JSON.stringify(loginAsSeenByPage).toLowerCase().includes('token'), JSON.stringify(Object.keys(loginAsSeenByPage.data ?? {})));
  const refused = await tylerAgain.page.evaluate(() => window.jobTracker.api('GET', '/api/admin/users'));
  check('the app enforces roles at the server, not just in the menu', refused.status === 403);
  const outsideApi = await tylerAgain.page.evaluate(() => window.jobTracker.api('GET', '/../../etc/passwd'));
  check('the bridge only reaches the API', !outsideApi.ok && outsideApi.error.code === 'invalid_path');
  const unexpected = [...tylerAgain.errors, ...hostAgain.errors].filter((text) => !/Failed to load resource|net::ERR/.test(text));
  check('no errors in the page consoles', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));

  await close(tylerAgain);
  await close(hostAgain);
} catch (error) {
  failures.push(String(error));
  console.error('\nStopped early:', error);
  for (const app of running) {
    for (const page of app.windows()) await page.screenshot({ path: join(shots, `failure-${Date.now()}.png`) }).catch(() => undefined);
  }
} finally {
  for (const app of running) await app.close().catch(() => undefined);
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A lingering process can hold files for a moment. It's a temp folder.
  }
}

console.log(`\n${passed} checks passed, ${failures.length} failed. Screenshots: ${shots}`);
if (failures.length) {
  console.log(failures.map((name) => `  - ${name}`).join('\n'));
  process.exit(1);
}
