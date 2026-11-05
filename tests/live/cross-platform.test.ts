import { resolve } from 'node:path';
import { afterAll, test } from 'vitest';
import { buildApp } from '../../src/server/app';
import { createPasswordHasher } from '../../src/server/auth/passwords';
import { createContext } from '../../src/server/create-context';
import { closeDatabase } from '../../src/server/db/client';
import { descriptionSimilarity } from '../../src/server/dedupe/text-normalize';
import { PlaywrightRenderer } from '../../src/server/extraction/browser';
import { SafeHttpClient } from '../../src/server/extraction/safe-fetch';
import { createSilentLogger } from '../../src/server/logger';
import { ApiClient, tempDir } from '../helpers';

/**
 * Adds the same real openings from different sites and prints how each one was matched.
 * Live and opt-in, like the survey: the outcome depends on what the sites serve today.
 *
 *   npm run survey -- --cross-platform
 */
const GROUPS: string[][] = [
  // Each line is one real opening, reached through different sites.
  ['https://job-boards.greenhouse.io/embed/job_app?for=machinifyinc&token=4116095009', 'https://job-boards.greenhouse.io/machinifyinc/jobs/4116095009', 'https://jobright.ai/jobs/info/6a90b8778ffa38557e6ce94e'],
  ['https://builtin.com/job/principal-data-engineer/12088047', 'https://careers-appliedsystems.icims.com/jobs/7841/principal-data-engineer/job', 'https://jobright.ai/jobs/info/6a99b276138838706058fac2'],
  ['https://devoted.wd1.myworkdayjobs.com/devoted/job/Remote-USA/Principal-Data-Engineer_R3798', 'https://devoted.wd1.myworkdayjobs.com/Devoted/job/Remote-USA/Principal-Data-Engineer_R3798?utm_source=x', 'https://jobright.ai/jobs/info/6ae11cc21f9d9308370a7c4b'],
  ['https://jobs.ashbyhq.com/gravie/ae035962-5696-43fe-9eb9-fa891860c8a3', 'https://jobs.ashbyhq.com/gravie/ae035962-5696-43fe-9eb9-fa891860c8a3/application?utm_source=x', 'https://jobright.ai/jobs/info/6a9888ca83fc633357632091']
];

const http = new SafeHttpClient();
const renderer = new PlaywrightRenderer();
afterAll(async () => {
  await renderer.close();
  await http.close();
});

test('real openings across sites', async () => {
  const ctx = await createContext({
    dataDir: tempDir(),
    migrationsDir: resolve(__dirname, '..', '..', 'drizzle'),
    version: 'survey',
    http,
    renderer,
    logger: createSilentLogger(),
    hasher: createPasswordHasher({ memoryCost: 1024, timeCost: 2 })
  });
  const app = buildApp(ctx);
  await app.ready();
  const admin = new ApiClient(app);
  await admin.login('admin', 'admin');
  await admin.post('/api/auth/change-password', { currentPassword: 'admin', newPassword: 'survey-password' });

  let userNumber = 0;
  for (const group of GROUPS) {
    process.stderr.write(`\n=== opening\n`);
    for (const url of group) {
      userNumber += 1;
      const name = `user${userNumber}`;
      await admin.post('/api/admin/users', { username: name, password: 'survey-password' });
      const client = new ApiClient(app);
      await client.login(name, 'survey-password');
      const result: any = await client.addJob(url);
      if (result.outcome === 'possible_duplicate') {
        const existing = (await client.get(`/api/jobs/${result.candidates[0].jobId}`)).json;
        const overlap = descriptionSimilarity(result.extracted.description ?? '', existing.description);
        process.stderr.write(`   overlap with #${existing.id}: jaccard=${overlap.jaccard.toFixed(2)} containment=${overlap.containment.toFixed(2)} lengths=${result.extracted.description?.length}/${existing.description.length} loc="${result.extracted.location}"/"${existing.location}"\n`);
      }
      const summary =
        result.outcome === 'created'
          ? `created job ${result.jobId}, new=${result.jobWasNew}, matchedBy=${result.matchedBy}`
          : result.outcome === 'possible_duplicate'
            ? `ASKS: "${result.extracted.title}" @ ${result.extracted.company} vs ${result.candidates.map((c: any) => `#${c.jobId} (${c.score}: ${c.reasons.join(', ')})`).join('; ')}`
            : result.outcome === 'needs_manual'
              ? `needs manual: ${result.reason}: ${result.message}`
              : result.outcome;
      process.stderr.write(`${url.slice(0, 70).padEnd(72)} ${summary}\n`);
    }
  }
  const jobs = (await admin.get('/api/jobs?limit=50')).json;
  process.stderr.write(`\nResult: ${jobs.total} jobs from ${GROUPS.flat().length} links, across ${GROUPS.length} real openings\n`);
  for (const job of jobs.items) process.stderr.write(`  #${job.id} ${job.title} @ ${job.company}: ${job.applicants.length} applicant(s)\n`);
  await app.close();
  closeDatabase(ctx.handle);
});
