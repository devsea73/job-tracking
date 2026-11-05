import { z } from 'zod';
import {
  APPLICATION_STATUSES,
  INTERVIEW_STAGES,
  JOB_SCOPES,
  JOB_SORTS,
  PASSWORD_MIN_LENGTH,
  USERNAME_PATTERN
} from '../shared/constants';
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

export const createApplicationBody = z.object({
  url: z.string().trim().min(1, 'Job URL is required.').max(4_000, 'That link is too long.'),
  memo: memo.optional(),
  resolution: z
    .discriminatedUnion('action', [
      z.object({ action: z.literal('merge'), jobId: z.number().int().positive() }),
      z.object({ action: z.literal('new') })
    ])
    .optional(),
  manual: manualJobFields.optional(),
  draftId: z.string().uuid().optional()
});

export const applyToJobBody = z.object({ memo: memo.optional() });

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

export const interviewQuery = z.object({
  from: instant.optional(),
  to: instant.optional(),
  stage: z.enum(INTERVIEW_STAGES).optional()
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
  sort: z.enum(JOB_SORTS).optional(),
  highlightFirst: queryBoolean.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

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
