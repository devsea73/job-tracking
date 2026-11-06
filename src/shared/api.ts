import type { ApplicationStatus, InterviewStage, JobScope, JobSort, UserRole } from './constants';
import type { ActivityGroup } from './calendar';
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

export type WorkArrangement = 'remote' | 'hybrid' | 'onsite';
export type EmploymentType = 'permanent' | 'contract';
export type SalaryPeriod = 'year' | 'hour';

/** What is known about a posting wherever it is listed. Unknown stays null rather than guessed. */
export interface JobFacts {
  workArrangement: WorkArrangement | null;
  employmentType: EmploymentType | null;
  /** "TS/SCI", "Top Secret", "Secret", "Public Trust", or "Required" when no level is named. */
  clearance: string | null;
  isFederal: boolean;
  postedAt: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: SalaryPeriod | null;
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
  /** The link this application was added with, when it was added with one. */
  link: ApplicationLink | null;
}

export interface ApplicationLink {
  /** The job link's id, one of JobDetail.urls. */
  id: number;
  url: string;
}

export interface JobListItem {
  id: number;
  title: string;
  company: string;
  location: string | null;
  isHighlighted: boolean;
  createdAt: string;
  updatedAt: string;
  facts: JobFacts;
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
  facts: JobFacts;
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
  facts: JobFacts;
  applications: ApplicationSummary[];
}

/** One side of a pair of jobs that may be one, as shown on the review screen. */
export interface DuplicateJobSummary {
  id: number;
  title: string;
  company: string;
  location: string | null;
  descriptionPreview: string;
  applicationCount: number;
  createdAt: string;
  urls: string[];
  facts: JobFacts;
}

export interface DuplicatePair {
  jobA: DuplicateJobSummary;
  jobB: DuplicateJobSummary;
  score: number;
  reasons: string[];
}

export interface DuplicatesResponse {
  pairs: DuplicatePair[];
  total: number;
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
  /**
   * "None of these": `seen` lists the candidates the person was shown. Only those are recorded as
   * different jobs; any other wait on the Duplicates page, and a likelier one found since is asked about.
   */
  | { action: 'new'; seen?: number[] };

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

/** What a pasted link turns out to be, read and compared but not saved. */
export interface CheckedJobSummary {
  title: string | null;
  company: string | null;
  location: string | null;
  facts: JobFacts | null;
}

export interface KnownJobSummary {
  id: number;
  title: string;
  company: string;
  location: string | null;
  facts: JobFacts;
  applicationCount: number;
  /** The checking person's own profiles that applied already. */
  myProfileIds: number[];
}

export type CheckLinkResponse =
  /** Not in the list yet. */
  | { status: 'fresh'; draftId: string; job: CheckedJobSummary }
  /** Already in the list: saving adds the profile to it. */
  | { status: 'known'; draftId: string | null; matchedBy: MatchedBy; job: KnownJobSummary }
  /** Looks like jobs in the list, without being certain. */
  | { status: 'possible'; draftId: string; job: CheckedJobSummary; candidates: DuplicateCandidate[] }
  /** The page could not be read. Saving needs a title and company; the description says why. */
  | { status: 'unreadable'; draftId: string; reason: ExtractionFailureReason; message: string; description: string; job: CheckedJobSummary };

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
  facts: JobFacts;
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
  /** Soonest first, the default, or latest first: past interviews are read from the latest. */
  order?: 'asc' | 'desc';
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

/**
 * Asked in the viewer's own calendar: their time zone, the day it is for them, and the range's
 * first and last days (both included). The host works out where each of those days begins.
 */
export interface ActivityQuery {
  tz: string;
  today: string;
  from: string;
  to: string;
  /** Left out: hours for one day, days up to two months, weeks up to half a year, months beyond. */
  group?: ActivityGroup;
  /** "me" for the viewer alone (the dashboard), "team" for everyone (the Team page). Left out: team. */
  scope?: ActivityScope;
}

export type ActivityScope = 'me' | 'team';

/** Days, both included, written 2026-11-05. */
export interface DaySpan {
  first: string;
  last: string;
}

export interface ActivityBucket extends DaySpan {
  /** 2026-11-05T14 for an hour, 2026-11-05 for a day, the Monday for a week, 2026-11 for a month. Its days are cut to the range. */
  key: string;
}

/** How far the applications made in the range have got so far, each counted at its furthest stage and every stage before it. */
export interface ActivityReached {
  screen: number;
  technical: number;
  final: number;
  offer: number;
  /** Turned down, at whatever stage. */
  rejected: number;
}

export interface ActivityCounts {
  today: number;
  yesterday: number;
  week: number;
  month: number;
  inRange: number;
  /** Applications made in the range that got an interview so far: Recruiter Screen or later, or one scheduled. */
  interviews: number;
  /** Percent, one decimal. Null when nothing was applied in the range: no rate, rather than 0%. */
  interviewRate: number | null;
  reached: ActivityReached;
  /** Interviews whose date falls in the range, whenever their application was made. */
  scheduled: number;
  /** Interviews whose date is today. */
  scheduledToday: number;
}

/** The trend charts' measures, in the order an application goes: sent, an interview, technical, final, an offer; then the share that ended in an offer. */
export const TREND_METRICS = ['bids', 'interviews', 'technical', 'final', 'offers', 'success'] as const;
export type TrendMetric = (typeof TREND_METRICS)[number];

/**
 * Each measure per bucket. The counts are of what happened in that bucket: applications sent, and
 * applications getting an interview (Recruiter Screen or later, or one booked) or reaching
 * Technical, Final or Offer, on the day that happened. Success is a percentage as it stood at the
 * end of each bucket: offers out of every application up to then, all time; null before the first.
 */
export type TrendSeries = Record<TrendMetric, Array<number | null>>;

/** A measure over the part of the range that has begun, and over as long a stretch from the start of the period before. Null when the range has not begun. */
export interface TrendTotal {
  current: number | null;
  previous: number | null;
}

export type TrendTotals = Record<TrendMetric, TrendTotal>;

export interface ActivityProfile {
  id: number;
  name: string;
  isArchived: boolean;
  today: number;
  inRange: number;
  interviews: number;
  interviewRate: number | null;
  allTime: number;
  allTimeInterviews: number;
  allTimeInterviewRate: number | null;
  /** Applications in each of the response's buckets. */
  series: number[];
  trends: TrendSeries;
  trendTotals: TrendTotals;
}

export interface ActivityPerson extends ActivityCounts {
  user: UserRef;
  isMe: boolean;
  isActive: boolean;
  allTime: number;
  allTimeInterviews: number;
  allTimeInterviewRate: number | null;
  /** Applications in each of the response's buckets. */
  series: number[];
  /** The person's profiles in use or with history: most applications in the range first. */
  profiles: ActivityProfile[];
  /** By applications in the range, then today's, this week's, this month's, then name; 1 is the leader. */
  rank: number;
  behindLeader: number;
  trends: TrendSeries;
  /** The same over the period before, bucket for bucket (see ActivityResponse.previous). */
  previousTrends: TrendSeries;
  trendTotals: TrendTotals;
}

export interface ActivityResponse {
  tz: string;
  group: ActivityGroup;
  /** The days each number covers, in the viewer's calendar. */
  periods: { today: DaySpan; yesterday: DaySpan; week: DaySpan; month: DaySpan; range: DaySpan };
  buckets: ActivityBucket[];
  /**
   * What the trends are compared with: the month or year before a whole month or year, otherwise
   * as many days just before the range. Its buckets line up with the range's, one for one: weeks,
   * and months against as many days before, are the range's own moved back to the same place, and
   * are named by their first day. The totals compare the range as far as today with as many days
   * from the start of this period.
   */
  previous: { range: DaySpan; buckets: ActivityBucket[]; compared: { current: DaySpan; previous: DaySpan } | null };
  /** The viewer first, then everyone else by rank. */
  people: ActivityPerson[];
  /** Everyone listed, added together. */
  team: ActivityCounts;
  teamTrends: TrendSeries;
  teamTrendTotals: TrendTotals;
}

export const TEAM_APPLICATION_SORTS = ['applied', 'stage', 'updated', 'company'] as const;
export type TeamApplicationSort = (typeof TEAM_APPLICATION_SORTS)[number];

/** Everyone's applications, one row each. Days are in the viewer's calendar; without them, all time. */
export interface TeamApplicationsQuery {
  tz?: string;
  from?: string;
  to?: string;
  /** One member's user id. Left out: everyone. */
  person?: number;
  status?: ApplicationStatus;
  q?: string;
  sort?: TeamApplicationSort;
  limit?: number;
  offset?: number;
}

export interface TeamApplication extends ApplicationSummary {
  job: { id: number; title: string; company: string; location: string | null; facts: JobFacts };
}

/** One member's applications in the range, by where each one is now. */
export interface TeamBoardRow {
  user: UserRef;
  isMe: boolean;
  isActive: boolean;
  total: number;
  statuses: Record<ApplicationStatus, number>;
  /** Got an interview: Recruiter Screen or later, or one booked. */
  interviews: number;
  interviewRate: number | null;
}

export interface TeamApplicationsResponse {
  /** The days covered, or null for all time. */
  range: DaySpan | null;
  /** Every member, the viewer first, then by applications. Counts the range only, not the other filters. */
  board: TeamBoardRow[];
  /** Applications matching every filter, and the page of them asked for. */
  total: number;
  items: TeamApplication[];
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
  /** `resync` never comes from the host: the app sends it to its own window once the live stream is back after a break. */
  type: 'jobs_changed' | 'applications_changed' | 'users_changed' | 'database_restored' | 'application_added' | 'resync';
  jobId?: number;
  /** application_added: who applied, and the new application. */
  userId?: number;
  applicationId?: number;
  at: string;
}

/** A job at a glance, for the notification another person's new application raises. */
export interface JobBrief {
  jobId: number;
  title: string;
  company: string;
  location: string | null;
  /** The link the person in the notice applied with. Without one: the first link anyone applied with, then the job's first link. */
  url: string | null;
  /** That link's id, sent back when applying from the notice so the new application keeps it too. */
  urlId: number | null;
  /** Administrators look after accounts and data; they are not offered jobs. */
  viewerIsAdmin: boolean;
  /** Who applied, and under which of their profiles. */
  owner: string | null;
  profile: string | null;
  addedByMe: boolean;
  /** One of the viewer's own profiles has applied already. */
  alreadyApplied: boolean;
  facts: JobFacts;
  /** The technologies the posting leans on most. */
  stack: string[];
  /** What the company does, when the posting says so clearly. */
  industry: string | null;
}
