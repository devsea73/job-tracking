import type { ApplicationStatus, InterviewStage, JobScope, JobSort, UserRole } from './constants';

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
}

/** Public information about a user who applied. Never contains personal application data. */
export interface Applicant {
  id: number;
  username: string;
  displayName: string | null;
  initials: string;
  color: string;
}

export interface MyApplicationSummary {
  id: number;
  status: ApplicationStatus;
  memoPreview: string;
  nextInterviewAt: string | null;
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
  applicants: Applicant[];
  myApplication: MyApplicationSummary | null;
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

export interface MyApplicationDetail {
  id: number;
  status: ApplicationStatus;
  memo: string;
  appliedAt: string;
  updatedAt: string;
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
  applicants: Applicant[];
  myApplication: MyApplicationDetail | null;
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
  applicants: Applicant[];
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
  | { outcome: 'already_applied'; applicationId: number; jobId: number; title: string; company: string }
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
