// Drives the real desktop app through the whole scenario: one host and two clients, each in
// its own Electron process and profile, talking over HTTPS as separate computers would.
// Uses live job sites, so it is opt-in:
//
//   npm run build && node tests/live/e2e-app.mjs [folder-for-screenshots]
//
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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

/** Types a link into the add bar and waits for its check: what the alert says, and its tone. */
async function checkViaBar(page, url, memo = '') {
  const bar = page.locator('[data-add-bar]');
  await bar.getByRole('textbox', { name: 'Job URL' }).fill(url);
  await page.waitForFunction(() => {
    const alert = document.querySelector('[data-add-bar] [data-add-check]');
    return !!alert && alert.getAttribute('data-add-check') !== 'checking';
  }, null, { timeout: 150_000 });
  if (memo) await bar.getByRole('textbox', { name: 'Memo' }).fill(memo);
  return { bar, text: (await bar.locator('[data-add-check]').innerText()).replace(/\s+/g, ' ') };
}

/** ✓, then waits for the bar to clear, which is what a save looks like. */
async function saveViaBar(page) {
  await page.locator('[data-add-bar]').getByRole('button', { name: 'Save job' }).click();
  await page.waitForFunction(() => document.querySelector('[data-add-bar] input[aria-label="Job URL"]')?.value === '', null, { timeout: 60_000 });
}

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
  await host.page.getByRole('heading', { name: 'All Jobs' }).waitFor();
  check('admin lands on All Jobs', true);

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
  await tyler.page.getByRole('heading', { name: 'All Jobs' }).waitFor();
  check('Tyler signed in from "computer B"', true);
  check('regular user has no Users page', (await tyler.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Users' }).count()) === 0);

  const john = await launch('computer-c');
  await pairClient(john.page, address, state.host.fingerprint);
  await john.page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 15_000 });
  await signIn(john.page, 'john', 'john-password');
  await john.page.getByRole('heading', { name: 'All Jobs' }).waitFor();
  check('John signed in from "computer C"', true);

  console.log('\nTyler adds a Built In link');
  check('the job link box has the cursor after signing in', (await tyler.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Job URL');
  const builtIn = await checkViaBar(tyler.page, BUILT_IN_URL, MEMO);
  await shot(tyler.page, '06-add-job');
  console.log(`  check: ${builtIn.text}`);
  check('a link is checked as soon as it is entered', /Fresh job|Duplicate|read the page/.test(builtIn.text), builtIn.text);
  await saveViaBar(tyler.page);
  await tyler.page.locator('[data-job-row]').first().click();
  await tyler.page.getByRole('heading', { level: 2 }).filter({ hasText: /Engineer/ }).waitFor({ timeout: 120_000 });
  const title = await tyler.page.getByRole('heading', { level: 2 }).filter({ hasText: /Engineer/ }).innerText();
  await tyler.page.getByText(/About|Responsibilities|experience/i).first().waitFor();
  await shot(tyler.page, '07-job-detail');
  console.log(`  extracted: ${title}`);
  check('title, company and description were extracted automatically', !!title);
  check('memo was saved', (await tyler.page.locator('textarea[aria-label="Memo"]').inputValue()) === MEMO);
  await tyler.page.getByRole('button', { name: 'Close', exact: true }).click();

  console.log('\nJohn adds the equivalent Jobright link');
  const jobright = await checkViaBar(john.page, JOBRIGHT_URL);
  console.log(`  check: ${jobright.text}`);
  if (/Maybe a duplicate/.test(jobright.text)) {
    await shot(john.page, '08-possible-duplicate');
    await jobright.bar.getByRole('button', { name: 'Same job' }).click();
  }
  check('the Jobright link is recognized as the job already saved', /Duplicate|Maybe a duplicate/.test(jobright.text), jobright.text);
  await saveViaBar(john.page);
  await john.page.locator('[data-job-row]').first().click();
  await john.page.getByRole('heading', { level: 2 }).filter({ hasText: /Engineer/ }).waitFor({ timeout: 30_000 });
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
  await tyler.page.getByRole('combobox', { name: 'Application status' }).first().getByRole('img', { name: 'Technical Interview' }).waitFor();
  await john.page.getByRole('combobox', { name: 'Application status' }).first().click();
  await john.page.getByRole('option', { name: 'Recruiter Screen' }).click();
  await john.page.getByRole('combobox', { name: 'Application status' }).first().getByRole('img', { name: 'Recruiter Screen' }).waitFor();

  const statusOf = (instance) => instance.page.evaluate(async () => (await window.jobTracker.api('GET', '/api/jobs')).data.items[0].applications.find((application) => application.isMine).status);
  check('Tyler is at Technical Interview', (await statusOf(tyler)) === 'Technical Interview');
  check('John is at Recruiter Screen, independently', (await statusOf(john)) === 'Recruiter Screen');

  console.log('\nTyler schedules an interview');
  await tyler.page.getByRole('row').nth(1).click();
  await tyler.page.getByRole('button', { name: 'Schedule' }).click();
  const scheduleForm = tyler.page.getByRole('dialog', { name: 'Schedule interview' });
  await scheduleForm.getByLabel('Date').fill('2030-11-13');
  await scheduleForm.getByLabel('Time').fill('14:00');
  await scheduleForm.getByLabel('Note (optional)').fill('Video call with the hiring team');
  await tyler.page.getByRole('dialog', { name: 'Schedule interview' }).getByRole('button', { name: 'Save' }).click();
  await tyler.page.getByText('Video call with the hiring team').waitFor();
  await shot(tyler.page, '10-interview-history');
  await tyler.page.getByRole('button', { name: 'Close', exact: true }).click();
  const shared = await john.page.evaluate(async () => JSON.stringify((await window.jobTracker.api('GET', '/api/jobs')).data) + JSON.stringify((await window.jobTracker.api('GET', '/api/interviews?person=all')).data));
  check("Tyler's memo and interview are visible to John", shared.includes('Recruiter contacted') && shared.includes('Video call'));

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
  const company = (await tyler.page.getByRole('row').nth(1).getByRole('cell').nth(1).innerText()).trim();
  const results = () => tyler.page.locator('[data-job-row]').count();
  await tyler.page.getByRole('button', { name: 'Filters' }).click();
  const settle = () => tyler.page.waitForTimeout(500);
  await tyler.page.locator('input[aria-label="Company"]').fill(company.slice(0, 6));
  await settle();
  check('company filter finds it', (await results()) === 1);
  await tyler.page.getByLabel('Search').fill('recruiter');
  await settle();
  check('memo search finds it', (await results()) === 1);
  await tyler.page.getByRole('combobox', { name: 'Status filter' }).click();
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

  console.log('\nProfiles, photos and the shared process view');
  // A one-pixel PNG: the app decodes, crops and re-encodes it, as it would a real photo.
  const PIXEL = { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') };
  await nav(tyler.page, 'Settings');
  await tyler.page.getByRole('heading', { name: 'My profiles' }).waitFor();
  await tyler.page.getByLabel('Upload photo for Tyler Morgan (tyler)').setInputFiles(PIXEL);
  await tyler.page.getByText('Photo updated.').first().waitFor();
  const avatarVersion = await tyler.page.evaluate(async () => (await window.jobTracker.api('GET', '/api/auth/me')).data.avatarVersion);
  check('Tyler uploaded his own photo', !!avatarVersion);
  await tyler.page.getByRole('button', { name: 'New profile' }).click();
  await tyler.page.getByLabel('Profile name').fill('Backend');
  await tyler.page.getByRole('dialog').getByRole('button', { name: 'Create profile' }).click();
  await tyler.page.getByRole('button', { name: 'Rename Backend' }).waitFor();
  await tyler.page.getByLabel('Upload photo for Backend').setInputFiles(PIXEL);
  await tyler.page.waitForFunction(async () => (await window.jobTracker.api('GET', '/api/profiles')).data.profiles.some((profile) => profile.name === 'Backend' && profile.avatarVersion));
  check('...and a second profile with its own photo', true);
  await shot(tyler.page, '21-profiles');

  await nav(tyler.page, 'All Jobs');
  await tyler.page.locator('[data-job-row]').first().click();
  await tyler.page.getByRole('button', { name: 'I applied with this profile' }).click();
  await tyler.page.getByRole('img', { name: /Backend \(Tyler Morgan\)/ }).first().waitFor({ timeout: 10_000 });
  check('one person can apply to a job under a second profile', true);
  await tyler.page.getByRole('button', { name: 'Close', exact: true }).click();

  await john.page.getByRole('img', { name: /Backend \(Tyler Morgan\)/ }).first().waitFor({ timeout: 10_000 });
  check("the new profile's avatar reached John's screen live", true);
  await john.page.locator('img[src^="data:image/"]').first().waitFor({ timeout: 10_000 });
  check("John's screen shows the uploaded photo, not initials", true);
  await john.page.getByRole('button', { name: /Show interview process/ }).first().click();
  await john.page.getByLabel('Current stage: Technical Interview').first().waitFor();
  await john.page.getByLabel('Next interview').first().waitFor();
  check("All Jobs shows each profile's interview process to everyone", true);
  await shot(john.page, '22-all-jobs-process');

  await john.page.getByRole('combobox', { name: 'Sort by' }).click();
  await john.page.getByRole('option', { name: 'Most applied' }).click();
  await john.page.waitForTimeout(400);
  check('Most applied sort is offered and leaves the list intact', (await john.page.locator('[data-job-row]').getByRole('img', { name: /Backend/ }).count()) > 0);

  await john.page.locator('[data-job-row]').first().click();
  await john.page.getByText('Recruiter contacted me.').first().waitFor();
  await john.page.getByText('Video call with the hiring team').first().waitFor();
  check("John can read Tyler's memo and interview in the job details", true);
  await shot(john.page, '23-job-detail-shared');
  const johnCanEdit = await john.page.evaluate(async () => {
    const list = (await window.jobTracker.api('GET', '/api/jobs')).data;
    const theirs = list.items[0].applications.find((application) => !application.isMine);
    return (await window.jobTracker.api('PATCH', `/api/applications/${theirs.id}`, { status: 'Rejected' })).status;
  });
  check("John still cannot change Tyler's application", johnCanEdit === 404, String(johnCanEdit));
  await john.page.getByRole('button', { name: 'Close', exact: true }).click();

  await nav(tyler.page, 'Team');
  await tyler.page.getByRole('heading', { name: 'Team', exact: true }).waitFor();
  await tyler.page.getByLabel('Technical pass').first().waitFor();
  await tyler.page.evaluate(() => window.jobTracker.setTheme('light'));
  await tyler.page.waitForTimeout(400);
  await shot(tyler.page, '24-team');
  const team = await tyler.page.evaluate(async () => (await window.jobTracker.api('GET', '/api/team')).data);
  const tylerStats = team.find((member) => member.user.username === 'tyler').stats;
  check(
    'Team reports the right numbers for Tyler',
    tylerStats.applications === 2 && tylerStats.interviews === 1 && tylerStats.technical === 1 && tylerStats.offers === 0 && tylerStats.screenPass.percent === 50 && tylerStats.technicalPass.percent === 100,
    JSON.stringify(tylerStats)
  );
  await tyler.page.evaluate(() => window.jobTracker.setTheme('dark'));
  await tyler.page.waitForTimeout(300);
  await shot(tyler.page, '25-team-dark');
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

  // What an older version could have left: the same posting saved again under a staffing
  // company's name, before saved jobs were checked for duplicates. Written while the host is
  // stopped, with Electron's own Node, which is what the database driver is built for.
  const planter = join(work, 'plant-duplicate.cjs');
  writeFileSync(
    planter,
    `const Database = require(${JSON.stringify(join(root, 'node_modules', 'better-sqlite3'))});
const db = new Database(process.argv[2]);
const job = db.prepare('SELECT * FROM jobs ORDER BY id LIMIT 1').get();
db.prepare("INSERT INTO jobs (company_name, company_key, title, title_key, description, description_hash, location, created_by, extraction_method) VALUES ('Talent Bridge Staffing', 'talent bridge staffing', ?, ?, ?, ?, ?, ?, 'manual')").run(job.title, job.title_key, job.description, job.description_hash, job.location, job.created_by);
db.close();`
  );
  const planted = spawnSync(electronPath, [planter, join(work, 'computer-a', hostDatabases[0])], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  check('a duplicate from an older version was planted', planted.status === 0, planted.stderr);

  console.log('\nEverything comes back after restarting');
  await close(tyler);
  await close(john);
  const hostAgain = await launch('computer-a');
  await hostAgain.page.getByRole('heading', { name: 'All Jobs' }).waitFor({ timeout: 30_000 });
  check('host restarted by itself and remembered the session', true);
  const tylerAgain = await launch('computer-b');
  await tylerAgain.page.getByRole('heading', { name: 'All Jobs' }).waitFor({ timeout: 20_000 });
  check('client reconnected by itself and remembered the session', true);
  const persisted = () =>
    tylerAgain.page.evaluate(async () => {
      const list = (await window.jobTracker.api('GET', '/api/jobs')).data;
      const applied = list.items.find((item) => item.applications.length > 0);
      const detail = (await window.jobTracker.api('GET', `/api/jobs/${applied.id}`)).data;
      const first = detail.applications.find((application) => application.isMine);
      return { total: list.total, applications: detail.applications.length, highlighted: detail.isHighlighted, status: first.status, memo: first.memo, interviews: first.interviews.length, urls: detail.urls.length };
    });
  const after = await persisted();
  console.log(`  after restart: ${JSON.stringify(after)}`);
  check('job, applications, highlight, status, memo and interview all persisted', after.applications === 3 && after.highlighted && after.status === 'Technical Interview' && after.memo === MEMO && after.interviews === 1 && after.urls >= 2);

  console.log('\nA saved duplicate waits for review');
  const badge = tylerAgain.page.locator('[data-duplicate-count]');
  await badge.waitFor({ timeout: 30_000 });
  check('the rail counts the pair waiting for review', (await badge.innerText()) === '1', await badge.innerText());
  await nav(tylerAgain.page, 'Possible duplicates');
  const pair = tylerAgain.page.locator('[data-duplicate-pair]');
  await pair.waitFor();
  await pair.getByText('Talent Bridge Staffing').waitFor();
  await shot(tylerAgain.page, '17-review-duplicates');
  check('the review page shows both jobs and why they look alike', (await pair.getByText('Identical description').count()) === 1);
  await pair.getByRole('button', { name: 'Same job' }).click();
  await tylerAgain.page.getByText('No duplicates to check').waitFor({ timeout: 15_000 });
  const merged = await persisted();
  check('merging leaves one job that kept every application', merged.total === 1 && merged.applications === 3 && merged.memo === MEMO, JSON.stringify(merged));
  check('...and the count is gone from the rail', (await badge.count()) === 0);

  console.log('\nThe other ways adding a job can go');
  const closeDetail = () => tylerAgain.page.getByRole('button', { name: 'Close', exact: true }).click();
  const clearBar = () => tylerAgain.page.locator('[data-add-bar]').getByRole('textbox', { name: 'Job URL' }).fill('');

  const again = await checkViaBar(tylerAgain.page, BUILT_IN_URL);
  await shot(tylerAgain.page, '18-already-applied');
  check('a job this profile applied to already says so before saving', /Already applied as/.test(again.text), again.text);
  check('...and ✓ is off for that profile', await again.bar.getByRole('button', { name: 'Save job' }).isDisabled());
  await clearBar();

  const JOBDIVA_URL = 'https://www1.jobdiva.com/portal/?a=9xjdnw687b7a7nvvdyut936kpjlgy0023blrozaecads0pdnwppcswnaaku8ji2g#/jobs/29382464';
  const diva = await checkViaBar(tylerAgain.page, JOBDIVA_URL);
  await shot(tylerAgain.page, '19-manual-entry');
  check('an unreadable page says why and asks for a title and company in the bar', /Can't read the page/.test(diva.text), diva.text);
  await diva.bar.getByRole('textbox', { name: 'Job title' }).fill('Data Engineer');
  await diva.bar.getByRole('textbox', { name: 'Company' }).fill('Typed By Hand Inc');
  await saveViaBar(tylerAgain.page);
  await nav(tylerAgain.page, 'All Jobs');
  await tylerAgain.page.getByLabel('Search').fill('Typed');
  await tylerAgain.page.locator('[data-job-row]', { hasText: 'Typed By Hand' }).first().click();
  await tylerAgain.page.getByRole('heading', { level: 2, name: 'Data Engineer' }).waitFor({ timeout: 30_000 });
  await tylerAgain.page.getByLabel('Details entered by hand.').waitFor();
  check('...and saves what was typed', true);
  await closeDetail();
  await tylerAgain.page.getByLabel('Search').fill('');

  const ashby = await checkViaBar(tylerAgain.page, 'https://jobs.ashbyhq.com/gravie/ae035962-5696-43fe-9eb9-fa891860c8a3');
  console.log(`  Ashby: ${ashby.text}`);
  await saveViaBar(tylerAgain.page);
  const listing = await checkViaBar(tylerAgain.page, 'https://jobright.ai/jobs/info/6a9888ca83fc633357632091');
  // Jobright rewrites the posting. With the same title, salary and terms it is recognized; a
  // posting that has changed since is offered as a possible duplicate instead.
  console.log(`  the Jobright copy of the Ashby posting: ${listing.text}`);
  if (/Maybe a duplicate/.test(listing.text)) await shot(tylerAgain.page, '20-possible-duplicate');
  check('a listing site rewrite of a saved posting is caught before saving', /Already applied|Duplicate|Maybe a duplicate/.test(listing.text), listing.text);
  await clearBar();
  const gravie = await tylerAgain.page.evaluate(async () => (await window.jobTracker.api('GET', '/api/jobs?q=gravie')).data.total);
  check('one job remains', gravie === 1, String(gravie));

  await nav(tylerAgain.page, 'All Jobs');
  await tylerAgain.page.getByLabel('Search').fill('gravie');
  const gravieRow = tylerAgain.page.locator('[data-job-row]', { hasText: 'Senior Data Engineer' }).first();
  await gravieRow.waitFor();
  const tags = await gravieRow.locator('[data-job-tags] > span').allInnerTexts();
  console.log(`  tags above the title: ${JSON.stringify(tags)}`);
  await shot(tylerAgain.page, '21-tags');
  check('tags show above the job title', tags.some((tag) => /Remote|Hybrid|On-site/.test(tag)), JSON.stringify(tags));
  await tylerAgain.page.getByLabel('Search').fill('');

  console.log('\nDeleting a job');
  const typed = await tylerAgain.page.evaluate(async () => (await window.jobTracker.api('GET', '/api/jobs?q=Typed')).data.items[0]);
  await nav(tylerAgain.page, 'All Jobs');
  await tylerAgain.page.getByLabel('Search').fill('Typed');
  const typedRow = tylerAgain.page.locator('[data-job-row]', { hasText: 'Typed By Hand' });
  await typedRow.waitFor();
  await typedRow.hover();
  await typedRow.getByRole('button', { name: /^Delete / }).click();
  await tylerAgain.page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await tylerAgain.page.getByText('Nothing matches these filters').waitFor();
  const afterDelete = await tylerAgain.page.evaluate(async (id) => (await window.jobTracker.api('GET', `/api/jobs/${id}`)).status, typed.id);
  check('someone can delete a job only they applied to', afterDelete === 404, String(afterDelete));
  await tylerAgain.page.getByLabel('Search').fill('');
  const sharedJob = await tylerAgain.page.evaluate(async () => (await window.jobTracker.api('GET', '/api/jobs?sort=applicants&limit=1')).data.items[0]);
  check('...and is not offered it on a job someone else applied to', (await tylerAgain.page.locator('[data-job-row]', { hasText: sharedJob.title }).first().getByRole('button', { name: /^Delete / }).count()) === 0);
  const refusedDelete = await tylerAgain.page.evaluate(async (id) => (await window.jobTracker.api('DELETE', `/api/jobs/${id}`)).status, sharedJob.id);
  check('...and the server refuses it too', refusedDelete === 403, String(refusedDelete));

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
