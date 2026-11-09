// Fills a Job Tracker database with a large, realistic data set for speed testing.
// Rows go straight into SQLite: no job site is contacted, and every link is made up.
//
//   node scripts/seed-load.mjs <path-to-job-tracker.sqlite> [--jobs 10000] [--users 10] [--profiles 5]
//
// Users are load-user-01, load-user-02 and so on, all with the password "load-password".
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const LOAD_PASSWORD = 'load-password';

// Each path is an application's timeline: Applied, then a step at each stage after it.
const STAGE_PATHS = [
  { weight: 45, path: ['Applied'] },
  { weight: 15, path: ['Applied', 'Rejected'] },
  { weight: 14, path: ['Applied', 'Recruiter Screen'] },
  { weight: 8, path: ['Applied', 'Recruiter Screen', 'Rejected'] },
  { weight: 7, path: ['Applied', 'Recruiter Screen', 'Technical Interview'] },
  { weight: 5, path: ['Applied', 'Recruiter Screen', 'Technical Interview', 'Rejected'] },
  { weight: 3, path: ['Applied', 'Technical Interview', 'Final Interview'] },
  { weight: 1, path: ['Applied', 'Recruiter Screen', 'Technical Interview', 'Final Interview', 'Rejected'] },
  { weight: 2, path: ['Applied', 'Recruiter Screen', 'Technical Interview', 'Final Interview', 'Offer'] }
];
const INTERVIEW_STAGES = new Set(['Recruiter Screen', 'Technical Interview', 'Final Interview']);

const WORDS =
  'data platform pipeline warehouse snowflake python spark kafka airflow dbt aws azure kubernetes terraform reliability analytics streaming governance modeling lakehouse batch orchestration observability engineers stakeholders customers roadmap architecture design review mentoring production quality security compliance healthcare finance retail logistics growth distributed systems latency throughput scale'.split(' ');
const PREFIXES = 'Acme Northwind Globex Initech Umbrella Vertex Summit Harbor Cedar Quantum Atlas Beacon Crescent Delta Evergreen Falcon Granite Horizon Ironwood Juniper Keystone Lumen Meridian Nimbus Orchard Pinnacle Redwood Sable Tidal Union'.split(' ');
const SUFFIXES = 'Health Systems Labs Financial Analytics Software Robotics Energy Logistics Media Insurance Retail Bio Networks Capital Technologies'.split(' ');
const ROLES = 'Data Engineer,Analytics Engineer,Data Platform Engineer,Data Architect,ML Engineer,Backend Engineer,Software Engineer,Site Reliability Engineer,Data Scientist,Business Intelligence Engineer'.split(',');
const LEVELS = ['', 'Senior ', 'Staff ', 'Principal ', 'Lead ', 'Sr. '];
const PROFILE_NAMES = ['Data Engineer', 'Backend', 'Analytics', 'Platform', 'Machine Learning', 'Architect', 'Consulting', 'Remote Only'];
const MEMOS = ['Applied through LinkedIn.', 'Recruiter contacted me.', 'Referred by a former colleague.', 'Followed up by email.', 'Salary range looks good.', 'Hiring manager replied quickly.', 'Sent portfolio and cover letter.'];

/** A small seeded generator, so that every run produces the same data and timings compare fairly. */
function makeRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (max) => Math.floor(next() * max), pick: (list) => list[Math.floor(next() * list.length)] };
}

function postingUrl(index, slug, random) {
  const id = 1_000_000_000 + index;
  const uuid = createHash('md5').update(String(index)).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  switch (index % 6) {
    case 0:
      return { url: `https://job-boards.greenhouse.io/${slug}/jobs/${id}`, provider: 'greenhouse', externalId: String(id) };
    case 1:
      return { url: `https://jobs.lever.co/${slug}/${uuid}`, provider: 'lever', externalId: uuid };
    case 2:
      return { url: `https://jobs.ashbyhq.com/${slug}/${uuid}`, provider: 'ashby', externalId: uuid };
    case 3:
      return { url: `https://${slug}.wd${1 + random.int(12)}.myworkdayjobs.com/careers/job/Remote/Data-Engineer_R${id}`, provider: 'workday', externalId: `${slug}/R${id}` };
    case 4:
      return { url: `https://careers-${slug}.icims.com/jobs/${id}/data-engineer/job`, provider: 'icims', externalId: `${slug}/${id}` };
    default:
      return { url: `https://careers.${slug}.example.com/jobs/${id}`, provider: null, externalId: null };
  }
}

function description(random, company, title) {
  const paragraphs = [`About ${company}\n\nWe are hiring a ${title} to join our team.`];
  for (let p = 0; p < 7; p += 1) {
    const words = [];
    for (let w = 0; w < 45 + random.int(30); w += 1) words.push(random.pick(WORDS));
    paragraphs.push(`${words.join(' ')}.`);
  }
  return paragraphs.join('\n\n');
}

/** Everything goes in one transaction, which is what keeps tens of thousands of inserts quick. */
export function seedLoadData(sqlite, { passwordHash, jobs = 10_000, users = 10, profilesPerUser = 5, seed = 42 } = {}) {
  if (!passwordHash) throw new Error('seedLoadData needs a passwordHash');
  const random = makeRandom(seed);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const DAY = 86_400_000;
  const weightTotal = STAGE_PATHS.reduce((sum, item) => sum + item.weight, 0);
  const pickPath = () => {
    let roll = random.int(weightTotal);
    for (const item of STAGE_PATHS) {
      roll -= item.weight;
      if (roll < 0) return item.path;
    }
    return STAGE_PATHS[0].path;
  };

  const insertUser = sqlite.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)');
  const insertProfile = sqlite.prepare('INSERT INTO profiles (user_id, name) VALUES (?, ?)');
  const insertJob = sqlite.prepare(
    `INSERT INTO jobs (company_name, title, description, location, description_hash, canonical_url, is_highlighted, company_key, title_key, extraction_method, created_by, created_at, updated_at, last_extracted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'json-ld', ?, ?, ?, ?)`
  );
  const insertUrl = sqlite.prepare('INSERT INTO job_urls (job_id, original_url, normalized_url, source_platform, external_job_id, kind) VALUES (?, ?, ?, ?, ?, ?)');
  const insertIdentifier = sqlite.prepare('INSERT INTO job_identifiers (job_id, provider, external_id) VALUES (?, ?, ?)');
  // The stage and furthest stage are worked out from the steps by the database's own triggers.
  const insertApplication = sqlite.prepare('INSERT INTO applications (user_id, profile_id, job_id, memo, applied_at, created_at, updated_at, job_url_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertStep = sqlite.prepare('INSERT INTO application_steps (application_id, stage, at, timezone, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

  const counts = { users: 0, profiles: 0, jobs: 0, urls: 0, applications: 0, interviews: 0, steps: 0 };

  sqlite.transaction(() => {
    const people = [];
    for (let u = 1; u <= users; u += 1) {
      const number = String(u).padStart(2, '0');
      const userId = Number(insertUser.run(`load-user-${number}`, `Load User ${number}`, passwordHash).lastInsertRowid);
      counts.users += 1;
      const profiles = [];
      for (let p = 0; p < profilesPerUser; p += 1) {
        profiles.push(Number(insertProfile.run(userId, PROFILE_NAMES[p % PROFILE_NAMES.length]).lastInsertRowid));
        counts.profiles += 1;
      }
      people.push({ userId, profiles });
    }
    const allProfiles = people.flatMap((person) => person.profiles.map((profileId) => ({ profileId, userId: person.userId })));

    for (let index = 0; index < jobs; index += 1) {
      const company = `${random.pick(PREFIXES)} ${random.pick(SUFFIXES)}`;
      const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '');
      const title = `${random.pick(LEVELS)}${random.pick(ROLES)}`;
      const text = description(random, company, title);
      const added = now - random.int(180) * DAY - random.int(DAY);
      const posting = postingUrl(index, slug, random);
      const jobId = Number(
        insertJob.run(
          company,
          title,
          text,
          random.pick(['Remote', 'Remote; USA', 'New York, NY', 'Austin, TX', 'Chicago, IL', 'San Francisco, CA', 'Seattle, WA']),
          createHash('sha256').update(text).digest('hex'),
          posting.url,
          random.next() < 0.03 ? 1 : 0,
          slug,
          title.toLowerCase().replace(/^sr\. /, 'senior ').replace(/[^a-z0-9+#]+/g, ' ').trim(),
          people[random.int(people.length)].userId,
          iso(added),
          iso(added),
          iso(added)
        ).lastInsertRowid
      );
      counts.jobs += 1;
      const normalized = posting.url.replace(/^https:\/\//, 'https://');
      const links = [Number(insertUrl.run(jobId, posting.url, normalized, posting.provider ?? 'company', posting.externalId, 'original').lastInsertRowid)];
      counts.urls += 1;
      if (posting.provider) insertIdentifier.run(jobId, posting.provider, posting.externalId);
      if (index % 5 === 0) {
        const alias = `https://builtin.com/job/data-engineer/${2_000_000 + index}`;
        links.push(Number(insertUrl.run(jobId, alias, alias, 'builtin', String(2_000_000 + index), 'original').lastInsertRowid));
        counts.urls += 1;
      }

      // Most jobs get a few applications, and a few popular ones get many.
      const roll = random.next();
      const applicants = index % 400 === 0 ? 15 + random.int(25) : roll < 0.1 ? 0 : roll < 0.45 ? 1 : roll < 0.7 ? 2 : roll < 0.85 ? 3 : 4 + random.int(5);
      const start = random.int(allProfiles.length);
      for (let a = 0; a < Math.min(applicants, allProfiles.length); a += 1) {
        const { profileId, userId } = allProfiles[(start + a * 7) % allProfiles.length];
        const path = pickPath();
        const applied = added + random.int(5 * DAY);
        const steps = path.map((_, step) => applied + step * (2 + random.int(9)) * DAY);
        // Each came with one of the job's links, taking turns; now and then someone joined without one.
        const link = (index + a) % 10 === 9 ? null : links[a % links.length];
        const applicationId = Number(
          insertApplication.run(userId, profileId, jobId, random.next() < 0.6 ? random.pick(MEMOS) : '', iso(applied), iso(Math.min(applied, now)), iso(Math.min(steps[steps.length - 1], now)), link).lastInsertRowid
        );
        counts.applications += 1;
        path.forEach((stage, step) => {
          if (step === 0) return;
          // Saved around when the application got there, as people do: bookkeeping only.
          const saved = iso(Math.min(steps[step], now));
          if (INTERVIEW_STAGES.has(stage)) {
            // The latest interview of one still going is often still to come.
            const last = step === path.length - 1;
            const first = last && random.next() < 0.33 ? now + random.int(45) * DAY : steps[step] + DAY;
            // A technical stage is often more than one round.
            const rounds = stage === 'Technical Interview' && random.next() < 0.4 ? 2 + random.int(2) : 1;
            for (let round = 0; round < rounds; round += 1) {
              insertStep.run(applicationId, stage, iso(first + round * 2 * 3_600_000), 'America/New_York', random.next() < 0.3 ? 'Video call with the team' : null, saved, saved);
              counts.interviews += 1;
              counts.steps += 1;
            }
          } else {
            // An offer or a rejection, on the day it came.
            insertStep.run(applicationId, stage, iso(steps[step] + 2 * DAY), 'America/New_York', null, saved, saved);
            counts.steps += 1;
          }
        });
      }
    }
  })();
  // Gives the query planner real numbers about the new data.
  sqlite.exec('ANALYZE');
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, ...rest] = process.argv.slice(2);
  if (!path) {
    console.error('Usage: node scripts/seed-load.mjs <path-to-job-tracker.sqlite> [--jobs 10000] [--users 10] [--profiles 5]');
    process.exit(1);
  }
  const option = (name, fallback) => {
    const index = rest.indexOf(name);
    return index >= 0 ? Number(rest[index + 1]) : fallback;
  };
  const { default: Database } = await import('better-sqlite3');
  const { default: argon2 } = await import('argon2');
  const sqlite = new Database(path);
  sqlite.pragma('foreign_keys = ON');
  const started = Date.now();
  const counts = seedLoadData(sqlite, {
    passwordHash: await argon2.hash(LOAD_PASSWORD),
    jobs: option('--jobs', 10_000),
    users: option('--users', 10),
    profilesPerUser: option('--profiles', 5)
  });
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
  sqlite.close();
  console.log(`Seeded in ${((Date.now() - started) / 1000).toFixed(1)}s: ${JSON.stringify(counts)}`);
}
