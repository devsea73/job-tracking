import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
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
    lastExtractedAt: text('last_extracted_at')
  },
  (t) => [
    index('jobs_company_key_idx').on(t.companyKey),
    index('jobs_description_hash_idx').on(t.descriptionHash),
    index('jobs_created_at_idx').on(t.createdAt),
    index('jobs_updated_at_idx').on(t.updatedAt),
    index('jobs_company_name_idx').on(sql`${t.companyName} collate nocase`),
    index('jobs_highlighted_idx').on(t.isHighlighted)
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
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    status: text('status').$type<ApplicationStatus>().notNull().default('Applied'),
    memo: text('memo').notNull().default(''),
    appliedAt: text('applied_at').notNull().default(nowIso),
    updatedAt: text('updated_at').notNull().default(nowIso)
  },
  (t) => [
    // One user has at most one application per shared job.
    uniqueIndex('applications_user_job_unique').on(t.userId, t.jobId),
    index('applications_job_idx').on(t.jobId),
    index('applications_user_status_idx').on(t.userId, t.status),
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
    index('interviews_scheduled_idx').on(t.scheduledAt)
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
  (t) => [index('status_history_application_idx').on(t.applicationId, t.changedAt)]
);

export const schema = {
  users,
  sessions,
  jobs,
  jobUrls,
  jobIdentifiers,
  applications,
  interviews,
  applicationStatusHistory
};
