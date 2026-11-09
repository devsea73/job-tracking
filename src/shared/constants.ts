/**
 * Where an application is. One idea, used everywhere: each step on an application's timeline is at
 * a stage, and the application is at the stage of its latest step, or Applied before it has any.
 */
export const STAGES = ['Applied', 'Recruiter Screen', 'Technical Interview', 'Final Interview', 'Offer', 'Rejected'] as const;
export type Stage = (typeof STAGES)[number];

/** What a step on the timeline can be: Applied is the application itself, with its own date. */
export const STEP_STAGES = ['Recruiter Screen', 'Technical Interview', 'Final Interview', 'Offer', 'Rejected'] as const;
export type StepStage = (typeof STEP_STAGES)[number];

/** Steps that are meetings, booked for a time: what the calendars show. Three technical rounds are three steps. */
export const INTERVIEW_STAGES = ['Recruiter Screen', 'Technical Interview', 'Final Interview'] as const;
export type InterviewStage = (typeof INTERVIEW_STAGES)[number];

/** Steps that end the process. Interviews after one will not happen, so saving one removes them. */
export const OUTCOME_STAGES = ['Offer', 'Rejected'] as const;

export const isInterviewStage = (stage: string): stage is InterviewStage => (INTERVIEW_STAGES as readonly string[]).includes(stage);
export const isOutcomeStage = (stage: string): boolean => (OUTCOME_STAGES as readonly string[]).includes(stage);

export const USER_ROLES = ['admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const JOB_SORTS = ['recent', 'applied', 'updated', 'company', 'interview', 'stage', 'applicants'] as const;
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
