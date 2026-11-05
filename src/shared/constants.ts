export const APPLICATION_STATUSES = [
  'Applied',
  'Recruiter Screen',
  'Technical Interview',
  'Final Interview',
  'Offer',
  'Rejected'
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const DEFAULT_STATUS: ApplicationStatus = 'Applied';

/** Statuses that no longer count as an "active" application on the dashboard. */
export const CLOSED_STATUSES: readonly ApplicationStatus[] = ['Rejected'];

export const INTERVIEW_STAGES = [
  'Recruiter Screen',
  'Technical Interview',
  'Hiring Manager',
  'Final Interview',
  'Other'
] as const;
export type InterviewStage = (typeof INTERVIEW_STAGES)[number];

export const USER_ROLES = ['admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const JOB_SORTS = ['recent', 'updated', 'company', 'interview', 'status', 'applicants'] as const;
export type JobSort = (typeof JOB_SORTS)[number];

export const JOB_SCOPES = ['all', 'mine', 'others'] as const;
export type JobScope = (typeof JOB_SCOPES)[number];

export const PROFILE_NAME_MAX = 64;

/** Avatars are shrunk to this square in the app before upload. */
export const AVATAR_SIZE_PX = 256;
export const AVATAR_MAX_BYTES = 512 * 1024;

export const DEFAULT_PORT = 3847;

export const PASSWORD_MIN_LENGTH = 8;
export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;

export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
