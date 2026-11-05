import type { ApplicationStatus, InterviewStage, JobScope, JobSort, UserRole } from './constants';
import type { PipelineStage, ProcessStats } from './pipeline';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface CurrentUser {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
  mustChangePassword: boolean;
  initials: string;
  color: string;
  avatarVersion: string | null;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: CurrentUser;
}

export interface AdminUser {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
  isActive: boolean;
  mustChangePassword: boolean;
  applicationCount: number;
  createdAt: string;
  updatedAt: string;
  initials: string;
  color: string;
  avatarVersion: string | null;
}

/** Enough to draw an avatar. The version changes when the image does, so it doubles as a cache key. */
export interface AvatarSubject {
  kind: 'user' | 'profile';
  id: number;
  initials: string;
  color: string;
  avatarVersion: string | null;
}

export interface UserRef extends AvatarSubject {
  kind: 'user';
  username: string;
  displayName: string | null;
}

export interface ProfileRef extends AvatarSubject {
  kind: 'profile';
  name: string;
  isArchived: boolean;
}

/** One profile's application to a job. Everyone on the host can read all of this. */
export interface ApplicationSummary {
  id: number;
  owner: UserRef;
  profile: ProfileRef;
  /** Whether the person asking owns it. Only the owner can change it. */
  isMine: boolean;
  status: ApplicationStatus;
  /** The highest stage it ever reached, which stays put after a rejection. */
  furthestStage: PipelineStage;
  memoPreview: string;
  nextInterviewAt: string | null;
  interviewCount: number;
  appliedAt: string;
  updatedAt: string;
}

export interface JobListItem {
  id: number;
  title: string;
  company: string;
  location: string | null;
  isHighlighted: boolean;
  createdAt: string;
  updatedAt: string;
  applications: ApplicationSummary[];
}

export interface JobListQuery {
  q?: string;
  company?: string;
  status?: ApplicationStatus;
  stage?: InterviewStage;
  interviewFrom?: string;
  interviewTo?: string;
  highlighted?: boolean;
  scope?: JobScope;
  personId?: number;
  profileId?: number;
  sort?: JobSort;
  highlightFirst?: boolean;
  limit?: number;
  offset?: number;
}

export interface JobListResponse {
  items: JobListItem[];
  total: number;
}

export interface JobUrl {
  id: number;
  originalUrl: string;
  normalizedUrl: string;
  sourcePlatform: string | null;
  externalJobId: string | null;
  kind: 'original' | 'canonical' | 'redirect' | 'discovered';
  createdAt: string;
}

export interface Interview {
  id: number;
  applicationId: number;
  stage: InterviewStage;
  /** UTC instant, ISO 8601. */
  scheduledAt: string;
  /** IANA zone in which the user scheduled the event. */
  timezone: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StatusHistoryEntry {
  id: number;
  oldStatus: ApplicationStatus | null;
  newStatus: ApplicationStatus;
  changedAt: string;
}

export interface ApplicationDetail extends ApplicationSummary {
  memo: string;
  interviews: Interview[];
  history: StatusHistoryEntry[];
}

export interface JobDetail {
  id: number;
  title: string;
  company: string;
  location: string | null;
  description: string;
  canonicalUrl: string | null;
  isHighlighted: boolean;
  highlightedBy: string | null;
  highlightedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastExtractedAt: string | null;
  extractionMethod: string | null;
  urls: JobUrl[];
  applications: ApplicationDetail[];
}

export interface DuplicateCandidate {
  jobId: number;
  title: string;
  company: string;
  location: string | null;
  score: number;
  reasons: string[];
  descriptionPreview: string;
  urls: string[];
  applications: ApplicationSummary[];
}

export interface ExtractedJobFields {
  title: string | null;
  company: string | null;
  description: string | null;
  location: string | null;
}

export interface ManualJobFields {
  title: string;
  company: string;
  description: string;
  location?: string | null;
}

export type DuplicateResolution =
  | { action: 'merge'; jobId: number }
  | { action: 'new' };

export interface CreateApplicationRequest {
  url: string;
  /** The profile applying. Must be one of the signed-in user's active profiles. */
  profileId: number;
  memo?: string;
  /** Sent when the user confirms a possible-duplicate dialog. */
  resolution?: DuplicateResolution;
  /** Sent when extraction failed and the user typed the fields themselves. */
  manual?: ManualJobFields;
  /** Returned by an earlier call, lets the server skip re-fetching the page. */
  draftId?: string;
}

export type MatchedBy =
  | 'new'
  | 'url'
  | 'canonical'
  | 'identifier'
  | 'content'
  | 'user_confirmed';

export type CreateApplicationResponse =
  | {
      outcome: 'created';
      applicationId: number;
      jobId: number;
      jobWasNew: boolean;
      matchedBy: MatchedBy;
    }
  | { outcome: 'already_applied'; applicationId: number; jobId: number; title: string; company: string; profileName: string }
  | {
      outcome: 'possible_duplicate';
      draftId: string;
      extracted: ExtractedJobFields;
      candidates: DuplicateCandidate[];
    }
  | {
      outcome: 'needs_manual';
      draftId: string;
      reason: ExtractionFailureReason;
      message: string;
      extracted: ExtractedJobFields;
      missing: Array<keyof ManualJobFields>;
    };

export type ExtractionFailureReason =
  | 'unsafe_url'
  | 'timeout'
  | 'network'
  | 'http_error'
  | 'not_found'
  | 'blocked'
  | 'not_html'
  | 'too_large'
  | 'incomplete';

export interface UpdateApplicationRequest {
  status?: ApplicationStatus;
  memo?: string;
}

export interface InterviewInput {
  stage: InterviewStage;
  scheduledAt: string;
  timezone: string;
  note?: string | null;
}

export interface InterviewListItem extends Interview {
  jobId: number;
  title: string;
  company: string;
  owner: UserRef;
  profile: ProfileRef;
  isMine: boolean;
}

export interface InterviewQuery {
  from?: string;
  to?: string;
  stage?: InterviewStage;
  /** A user id, or "all" for everyone. Without it, the signed-in user's own interviews. */
  person?: number | 'all';
  profileId?: number;
  limit?: number;
}

export interface MyProfile extends ProfileRef {
  applicationCount: number;
  createdAt: string;
}

export interface MyProfilesResponse {
  profiles: MyProfile[];
  /** Offered first when adding a job. */
  lastUsedProfileId: number | null;
}

export interface TeamProfile {
  profile: ProfileRef;
  stats: ProcessStats;
}

export interface TeamMember {
  user: UserRef;
  isActive: boolean;
  /** All of this person's profiles added together. */
  stats: ProcessStats;
  profiles: TeamProfile[];
}

export interface DashboardResponse {
  totalApplications: number;
  activeApplications: number;
  upcomingInterviews: number;
  rejectedApplications: number;
  recentApplications: JobListItem[];
  highlightedJobs: JobListItem[];
  nextInterviews: InterviewListItem[];
}

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ServerInfo {
  app: 'job-tracker';
  version: string;
  initialized: boolean;
}

export interface ServerEvent {
  type: 'jobs_changed' | 'applications_changed' | 'users_changed' | 'database_restored';
  jobId?: number;
  at: string;
}
