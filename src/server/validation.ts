import { z } from 'zod';
import {
  APPLICATION_STATUSES,
  INTERVIEW_STAGES,
  JOB_SCOPES,
  JOB_SORTS,
  PASSWORD_MIN_LENGTH,
  PROFILE_NAME_MAX,
  USERNAME_PATTERN
} from '../shared/constants';
import { ACTIVITY_GROUPS, daysBetween, groupFits, isCalendarDate, MAX_RANGE_DAYS } from '../shared/calendar';
import { TEAM_APPLICATION_SORTS } from '../shared/api';
import { badRequest } from './errors';

/** Validates request data, reporting the first problem in words a person can act on. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue.path.join('.');
  throw badRequest(field ? `${field}: ${issue.message}` : issue.message, result.error.issues);
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

const username = z
  .string()
  .trim()
  .regex(USERNAME_PATTERN, 'Use 2-32 letters, numbers, dots, dashes or underscores, starting with a letter or number.');

const newPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(256, 'Use at most 256 characters.');

export const loginBody = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256)
});

export const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword
});

const displayName = z.string().trim().max(64).nullable().optional();

export const createUserBody = z.object({
  username,
  password: newPassword,
  displayName,
  mustChangePassword: z.boolean().optional()
});

export const updateUserBody = z
  .object({ username: username.optional(), displayName, isActive: z.boolean().optional() })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update.');

export const resetPasswordBody = z.object({ password: newPassword });

const memo = z.string().max(20_000, 'Keep memos under 20,000 characters.');

export const manualJobFields = z.object({
  title: z.string().trim().min(1, 'Job title is required.').max(300),
  company: z.string().trim().min(1, 'Company is required.').max(200),
  description: z.string().trim().min(1, 'Job description is required.').max(200_000),
  location: z.string().trim().max(300).nullable().optional()
});

const profileId = z.number({ message: 'Choose a profile.' }).int().positive('Choose a profile.');

export const createApplicationBody = z.object({
  url: z.string().trim().min(1, 'Job URL is required.').max(4_000, 'That link is too long.'),
  profileId,
  memo: memo.optional(),
  resolution: z
    .discriminatedUnion('action', [
      z.object({ action: z.literal('merge'), jobId: z.number().int().positive() }),
      z.object({ action: z.literal('new'), seen: z.array(z.number().int().positive()).max(50).optional() })
    ])
    .optional(),
  manual: manualJobFields.optional(),
  draftId: z.string().uuid().optional()
});

export const checkLinkBody = z.object({ url: z.string().trim().min(1, 'Job URL is required.').max(4_000, 'That link is too long.') });

export const applyToJobBody = z.object({
  profileId,
  memo: memo.optional(),
  urlId: z.number().int().positive().optional(),
  /** From a notification: only if none of this person's profiles has applied yet. */
  unlessApplied: z.boolean().optional()
});

const profileName = z.string().trim().min(1, 'Give the profile a name.').max(PROFILE_NAME_MAX, `Use at most ${PROFILE_NAME_MAX} characters.`);

export const createProfileBody = z.object({ name: profileName });

export const updateProfileBody = z
  .object({ name: profileName.optional(), isArchived: z.boolean().optional() })
  .refine((body) => body.name !== undefined || body.isArchived !== undefined, 'Nothing to update.');

/** Base64 runs a third longer than the image it holds, so this is a generous outer limit. */
export const avatarBody = z.object({ image: z.string().min(1).max(1_000_000, 'That image is too large.') });

export const updateApplicationBody = z
  .object({ status: z.enum(APPLICATION_STATUSES).optional(), memo: memo.optional() })
  .refine((body) => body.status !== undefined || body.memo !== undefined, 'Nothing to update.');

/** An instant with an explicit offset. Local times without one would be ambiguous. */
const instant = z.string().refine((value) => /(Z|[+-]\d{2}:\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value)), {
  message: 'Use a full date and time with a timezone offset.'
});

const timezone = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Unknown timezone.' }
);

export const interviewBody = z.object({
  stage: z.enum(INTERVIEW_STAGES),
  scheduledAt: instant,
  timezone,
  note: z.string().trim().max(5_000).nullable().optional()
});

const queryId = z.coerce.number().int().positive();

export const interviewQuery = z.object({
  from: instant.optional(),
  to: instant.optional(),
  stage: z.enum(INTERVIEW_STAGES).optional(),
  person: z.union([z.literal('all'), queryId]).optional(),
  profileId: queryId.optional(),
  limit: z.coerce.number().int().min(1).max(5_000).optional(),
  /** Soonest first, or latest first: past interviews are read from the latest. */
  order: z.enum(['asc', 'desc']).optional()
});

const queryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true');

export const jobListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  status: z.enum(APPLICATION_STATUSES).optional(),
  stage: z.enum(INTERVIEW_STAGES).optional(),
  interviewFrom: instant.optional(),
  interviewTo: instant.optional(),
  highlighted: queryBoolean.optional(),
  scope: z.enum(JOB_SCOPES).optional(),
  personId: queryId.optional(),
  profileId: queryId.optional(),
  sort: z.enum(JOB_SORTS).optional(),
  highlightFirst: queryBoolean.optional(),
  limit: z.coerce.number().int().min(1).max(5_000).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

/**
 * A real day, in years the counting can work with: the day after 9999-12-31 has no four-digit
 * year, and Intl writes years before 1000 without their leading zeros.
 */
const calendarDate = z
  .string()
  .refine(isCalendarDate, { message: 'Use a date like 2026-11-05.' })
  .refine((value) => value >= '1970-01-01' && value <= '9998-12-31', { message: 'Use a date between 1970 and 9998.' });
export const activityQuery = z
  .object({ tz: timezone, today: calendarDate, from: calendarDate, to: calendarDate, group: z.enum(ACTIVITY_GROUPS).optional(), scope: z.enum(['me', 'team']).optional() })
  .refine((query) => query.to >= query.from, 'The range ends before it starts.')
  .refine((query) => daysBetween(query.from, query.to) < MAX_RANGE_DAYS, `Choose a range of at most ${MAX_RANGE_DAYS} days.`)
  .refine((query) => !query.group || groupFits(query.group, query.from, query.to), 'Hours can only be shown for a single day.');

/** A range of days needs its time zone, and both ends; without any of them, all time. */
export const teamApplicationsQuery = z
  .object({
    tz: timezone.optional(),
    from: calendarDate.optional(),
    to: calendarDate.optional(),
    person: queryId.optional(),
    status: z.enum(APPLICATION_STATUSES).optional(),
    q: z.string().trim().max(200).optional(),
    sort: z.enum(TEAM_APPLICATION_SORTS).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional()
  })
  .refine((query) => [query.tz, query.from, query.to].every((value) => value === undefined) || [query.tz, query.from, query.to].every((value) => value !== undefined), 'Give the time zone and both days of the range, or none of them.')
  .refine((query) => !query.from || !query.to || query.to >= query.from, 'The range ends before it starts.');

export const briefQuery = z.object({ application: z.coerce.number().int().positive().optional() });

export const duplicatePairBody = z.object({ jobIdA: z.number().int().positive(), jobIdB: z.number().int().positive() });

export const highlightBody = z.object({ highlighted: z.boolean() });

export const updateJobBody = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    company: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(200_000).optional(),
    location: z.string().trim().max(300).nullable().optional()
  })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update.');

export const backupNameParam = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]+\.sqlite$/, 'Unknown backup.')
});
