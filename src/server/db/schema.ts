import { sql } from 'drizzle-orm';
import { blob, check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { EmploymentType, SalaryPeriod, WorkArrangement } from '../../shared/api';
import type { ApplicationStatus, InterviewStage, UserRole } from '../../shared/constants';

/** All instants are stored as ISO-8601 UTC strings so that they sort lexicographically. */
const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    displayName: text('display_name'),
    passwordHash: text('password_hash').notNull(),
    role: text('role').$type<UserRole>().notNull().default('user'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(nowIso),
    updatedAt: text('updated_at').notNull().default(nowIso)
  },
  (t) => [
    uniqueIndex('users_username_nocase_unique').on(sql`lower(${t.username})`),
    check('users_role_check', sql`${t.role} in ('admin', 'user')`)
  ]
);

/** A persona a user applies under. Archived profiles keep their history but take no new applications. */
export const profiles = sqliteTable(
  'profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(nowIso),
    updatedAt: text('updated_at').notNull().default(nowIso)
  },
  (t) => [uniqueIndex('profiles_user_name_nocase_unique').on(t.userId, sql`lower(${t.name})`), index('profiles_user_idx').on(t.userId)]
);

/** Images live apart from their owners, so that ordinary queries never load them by accident. */
export const userAvatars = sqliteTable('user_avatars', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  mime: text('mime').notNull(),
  data: blob('data', { mode: 'buffer' }).notNull(),
  updatedAt: text('updated_at').notNull().default(nowIso)
});

export const profileAvatars = sqliteTable('profile_avatars', {
  profileId: integer('profile_id')
    .primaryKey()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  mime: text('mime').notNull(),
  data: blob('data', { mode: 'buffer' }).notNull(),
  updatedAt: text('updated_at').notNull().default(nowIso)
});

export const sessions = sqliteTable(
  'sessions',
  {
    /** SHA-256 of the bearer token. The token itself is never stored. */
    tokenHash: text('token_hash').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull().default(nowIso),
    lastSeenAt: text('last_seen_at').notNull().default(nowIso),
    expiresAt: text('expires_at').notNull()
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expiry_idx').on(t.expiresAt)]
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyName: text('company_name').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    location: text('location'),
    descriptionHash: text('description_hash'),
    canonicalUrl: text('canonical_url'),
    isHighlighted: integer('is_highlighted', { mode: 'boolean' }).notNull().default(false),
    highlightedBy: integer('highlighted_by').references(() => users.id, { onDelete: 'set null' }),
    highlightedAt: text('highlighted_at'),
    /** Normalized values used by duplicate detection. */
    companyKey: text('company_key').notNull(),
    titleKey: text('title_key').notNull(),
    extractionMethod: text('extraction_method'),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(nowIso),
    updatedAt: text('updated_at').notNull().default(nowIso),
    lastExtractedAt: text('last_extracted_at'),
    /** Kept up to date by triggers, so that sorting by them never has to count or scan. */
    applicationCount: integer('application_count').notNull().default(0),
    lastActivityAt: text('last_activity_at')
  },
  (t) => [
    index('jobs_company_key_idx').on(t.companyKey),
    index('jobs_title_key_idx').on(t.titleKey),
    index('jobs_description_hash_idx').on(t.descriptionHash),
    index('jobs_created_at_idx').on(t.createdAt),
    index('jobs_updated_at_idx').on(t.updatedAt),
    index('jobs_company_name_idx').on(sql`${t.companyName} collate nocase`),
    index('jobs_highlighted_idx').on(t.isHighlighted),
    index('jobs_application_count_idx').on(t.applicationCount, t.id),
    index('jobs_last_activity_idx').on(t.lastActivityAt, t.id)
  ]
);

/** Every URL known to point at a job: originals, canonical links, redirect targets, discovered aliases. */
export const jobUrls = sqliteTable(
  'job_urls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    originalUrl: text('original_url').notNull(),
    normalizedUrl: text('normalized_url').notNull(),
    sourcePlatform: text('source_platform'),
    externalJobId: text('external_job_id'),
    kind: text('kind').$type<'original' | 'canonical' | 'redirect' | 'discovered'>().notNull().default('original'),
    createdAt: text('created_at').notNull().default(nowIso)
  },
  (t) => [
    // A normalized URL can only ever belong to one job: this enforces URL-level dedupe in the DB.
    uniqueIndex('job_urls_normalized_unique').on(t.normalizedUrl),
    index('job_urls_job_idx').on(t.jobId)
  ]
);

/**
 * Provider-scoped stable identifiers (e.g. greenhouse:5213453007). The unique index makes
 * identifier-level dedupe safe against concurrent inserts, even when many URLs share one id.
 */
export const jobIdentifiers = sqliteTable(
  'job_identifiers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    /** True when found as a link inside another page rather than from the job's own URL. */
    isDiscovered: integer('is_discovered', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(nowIso)
  },
  (t) => [
    uniqueIndex('job_identifiers_unique').on(t.provider, t.externalId),
    index('job_identifiers_job_idx').on(t.jobId)
  ]
);

export const applications = sqliteTable(
  'applications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileId: integer('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    status: text('status').$type<ApplicationStatus>().notNull().default('Applied'),
    memo: text('memo').notNull().default(''),
    /** The highest pipeline stage ever reached, as an index into PIPELINE_STAGES. Kept up to date by a trigger. */
    furthestRank: integer('furthest_rank').notNull().default(0),
    /** The link this application was added with. Empty when someone joined the job without one. */
    jobUrlId: integer('job_url_id').references(() => jobUrls.id, { onDelete: 'set null' }),
    appliedAt: text('applied_at').notNull().default(nowIso),
    updatedAt: text('updated_at').notNull().default(nowIso)
  },
  (t) => [
    // A profile applies to a shared job at most once. One person can apply under several profiles.
    uniqueIndex('applications_profile_job_unique').on(t.profileId, t.jobId),
    index('applications_job_idx').on(t.jobId),
    index('applications_user_job_idx').on(t.userId, t.jobId),
    index('applications_status_idx').on(t.status),
    index('applications_user_status_idx').on(t.userId, t.status),
    index('applications_job_url_idx').on(t.jobUrlId),
    // The numbers pages read a range of days; count each profile's that got somewhere; and find the
    // offers, which success counts from the start.
    index('applications_applied_idx').on(t.appliedAt),
    index('applications_furthest_idx').on(t.furthestRank, t.profileId),
    check(
      'applications_status_check',
      sql`${t.status} in ('Applied', 'Recruiter Screen', 'Technical Interview', 'Final Interview', 'Rejected', 'Offer')`
    )
  ]
);

export const interviews = sqliteTable(
  'interviews',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    stage: text('stage').$type<InterviewStage>().notNull(),
    scheduledAt: text('scheduled_at').notNull(),
    timezone: text('timezone').notNull(),
    note: text('note'),
    createdAt: text('created_at').notNull().default(nowIso),
    updatedAt: text('updated_at').notNull().default(nowIso)
  },
  (t) => [
    index('interviews_application_idx').on(t.applicationId, t.scheduledAt),
    index('interviews_scheduled_idx').on(t.scheduledAt),
    // Which applications got an interview booked in a range of days.
    index('interviews_created_idx').on(t.createdAt, t.applicationId)
  ]
);

export const applicationStatusHistory = sqliteTable(
  'application_status_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    applicationId: integer('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    oldStatus: text('old_status').$type<ApplicationStatus>(),
    newStatus: text('new_status').$type<ApplicationStatus>().notNull(),
    changedAt: text('changed_at').notNull().default(nowIso)
  },
  // By application; and which applications reached a stage in a range of days.
  (t) => [index('status_history_application_idx').on(t.applicationId, t.changedAt), index('status_history_reached_idx').on(t.newStatus, t.changedAt, t.applicationId)]
);

/** What is known about a job wherever it is listed: the tags on it, and what duplicates are judged by. */
export const jobFacts = sqliteTable(
  'job_facts',
  {
    jobId: integer('job_id')
      .primaryKey()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    workArrangement: text('work_arrangement').$type<WorkArrangement>(),
    employmentType: text('employment_type').$type<EmploymentType>(),
    clearance: text('clearance'),
    isFederal: integer('is_federal', { mode: 'boolean' }).notNull().default(false),
    postedAt: text('posted_at'),
    salaryMin: real('salary_min'),
    salaryMax: real('salary_max'),
    salaryCurrency: text('salary_currency'),
    salaryPeriod: text('salary_period').$type<SalaryPeriod>(),
    /** When this job was last compared with the others. Null means it still needs to be. */
    checkedAt: text('checked_at'),
    updatedAt: text('updated_at').notNull().default(nowIso)
  },
  (t) => [index('job_facts_checked_idx').on(t.checkedAt)]
);

/**
 * Fingerprints for finding postings that may be one job, however their links or company names are
 * written: a sample of each description's phrases (kind "text"). Shared values mark a candidate.
 */
export const jobSignatures = sqliteTable(
  'job_signatures',
  {
    kind: text('kind').notNull(),
    value: text('value').notNull(),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' })
  },
  (t) => [primaryKey({ columns: [t.kind, t.value, t.jobId] }), index('job_signatures_job_idx').on(t.jobId)]
);

/**
 * What duplicate detection compares a job's text on: hashes of its phrases and distinctive words,
 * its length and requisition numbers. Nothing here can be turned back into the posting's text.
 */
export const jobTextFeatures = sqliteTable(
  'job_text_features',
  {
    jobId: integer('job_id')
      .primaryKey()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    hash: text('hash'),
    length: integer('length').notNull().default(0),
    shingles: blob('shingles').notNull(),
    words: blob('words').notNull(),
    requisitions: text('requisitions').notNull().default('[]')
  },
  (t) => [index('job_text_features_hash_idx').on(t.hash)]
);

/** Pairs of jobs that look alike. Pending ones wait for someone to decide; distinct ones stay apart. */
export const duplicateCandidates = sqliteTable(
  'duplicate_candidates',
  {
    jobIdLow: integer('job_id_low')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    jobIdHigh: integer('job_id_high')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    status: text('status').$type<'pending' | 'distinct'>().notNull().default('pending'),
    score: real('score').notNull().default(0),
    reasons: text('reasons').notNull().default('[]'),
    createdAt: text('created_at').notNull().default(nowIso)
  },
  (t) => [primaryKey({ columns: [t.jobIdLow, t.jobIdHigh] }), index('duplicate_candidates_status_idx').on(t.status, t.score), index('duplicate_candidates_high_idx').on(t.jobIdHigh)]
);

export const schema = {
  users,
  profiles,
  userAvatars,
  profileAvatars,
  sessions,
  jobs,
  jobUrls,
  jobIdentifiers,
  applications,
  interviews,
  applicationStatusHistory,
  jobFacts,
  jobSignatures,
  jobTextFeatures,
  duplicateCandidates
};
