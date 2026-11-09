import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  ActivityQuery,
  ActivityResponse,
  AdminUser,
  ApplicationDetail,
  AvatarSubject,
  BackupInfo,
  CreateApplicationRequest,
  CreateApplicationResponse,
  CurrentUser,
  DashboardResponse,
  DuplicatesResponse,
  InterviewListItem,
  InterviewQuery,
  JobDetail,
  JobListQuery,
  JobListResponse,
  MyProfilesResponse,
  StepInput,
  StepSaved,
  TeamApplicationsQuery,
  TeamApplicationsResponse,
  TeamMember,
  UpdateApplicationRequest
} from '@shared/api';
import type { BridgeState } from '@shared/bridge';

const bridge = window.jobTracker;

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export async function call<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const result = await bridge.api<T>(method, path, body);
  if (result.ok) return result.data as T;
  throw new ApiRequestError(result.status, result.error?.code ?? 'error', result.error?.message ?? 'Something went wrong.');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function useBridgeState(): BridgeState | null {
  const [state, setState] = useState<BridgeState | null>(null);
  useEffect(() => {
    let active = true;
    void bridge.getState().then((initial) => {
      if (active) setState(initial);
    });
    const unsubscribe = bridge.onStateChange(setState);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return state;
}

/**
 * Other people's changes arrive as events from the host, and refresh whatever is on screen.
 * A burst of changes is answered once, and only data that is on screen is fetched again.
 */
export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = bridge.onServerEvent(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries();
      }, 200);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [queryClient]);
}

function toSearchParams(query: JobListQuery | TeamApplicationsQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function useCurrentUser(enabled: boolean): UseQueryResult<CurrentUser> {
  return useQuery({ queryKey: ['me'], queryFn: () => call<CurrentUser>('GET', '/api/auth/me'), enabled });
}

export const PAGE_SIZES = [50, 100, 200] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/**
 * One page of the job list. Search, filters and sorting all run on the host over every job, so a
 * page is always the right slice of the full result. While the next page loads, the current one
 * stays on screen instead of flashing empty.
 */
export function useJobPage(query: JobListQuery, page: number, size: PageSize): UseQueryResult<JobListResponse> {
  return useQuery({
    queryKey: ['jobs', query, page, size],
    queryFn: () => call<JobListResponse>('GET', `/api/jobs${toSearchParams({ ...query, limit: size, offset: page * size })}`),
    placeholderData: keepPreviousData
  });
}

export function useCompanies(): UseQueryResult<string[]> {
  return useQuery({ queryKey: ['companies'], queryFn: () => call<string[]>('GET', '/api/jobs/companies'), staleTime: 30_000 });
}

export function useJob(id: number | null): UseQueryResult<JobDetail> {
  return useQuery({ queryKey: ['job', id], queryFn: () => call<JobDetail>('GET', `/api/jobs/${id}`), enabled: id !== null });
}

export function useActivity(query: ActivityQuery): UseQueryResult<ActivityResponse> {
  return useQuery({
    queryKey: ['activity', query],
    queryFn: () =>
      call<ActivityResponse>('GET', `/api/activity?${new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string')).toString()}`),
    placeholderData: keepPreviousData
  });
}

export function useDashboard(): UseQueryResult<DashboardResponse> {
  return useQuery({ queryKey: ['dashboard'], queryFn: () => call<DashboardResponse>('GET', '/api/dashboard') });
}

export function useInterviews(filter: InterviewQuery): UseQueryResult<InterviewListItem[]> {
  const params = new URLSearchParams();
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (filter.stage) params.set('stage', filter.stage);
  if (filter.person) params.set('person', String(filter.person));
  if (filter.profileId) params.set('profileId', String(filter.profileId));
  if (filter.limit) params.set('limit', String(filter.limit));
  if (filter.order) params.set('order', filter.order);
  const text = params.toString();
  return useQuery({
    queryKey: ['interviews', filter],
    queryFn: () => call<InterviewListItem[]>('GET', `/api/interviews${text ? `?${text}` : ''}`),
    placeholderData: keepPreviousData
  });
}

export function useProfiles(): UseQueryResult<MyProfilesResponse> {
  return useQuery({ queryKey: ['profiles'], queryFn: () => call<MyProfilesResponse>('GET', '/api/profiles') });
}

export function useTeam(): UseQueryResult<TeamMember[]> {
  return useQuery({ queryKey: ['team'], queryFn: () => call<TeamMember[]>('GET', '/api/team') });
}

/** Everyone's applications, a page at a time, with the board of where each person's stand. */
export function useTeamApplications(query: TeamApplicationsQuery): UseQueryResult<TeamApplicationsResponse> {
  return useQuery({
    queryKey: ['team-applications', query],
    queryFn: () => call<TeamApplicationsResponse>('GET', `/api/team/applications${toSearchParams(query)}`),
    placeholderData: keepPreviousData
  });
}

/**
 * Images are kept here rather than in the query cache, which refreshes everything on screen
 * after every change anyone makes. An image only has to load again when its version changes.
 */
const avatarImages = new Map<string, Promise<string | null>>();

export function clearAvatarImages(): void {
  avatarImages.clear();
}

function loadAvatarImage(subject: AvatarSubject): Promise<string | null> {
  const key = `${subject.kind}:${subject.id}:${subject.avatarVersion}`;
  let pending = avatarImages.get(key);
  if (!pending) {
    pending = call<{ image: string }>('GET', `/api/avatars/${subject.kind === 'user' ? 'users' : 'profiles'}/${subject.id}`)
      .then((result) => result.image)
      .catch(() => {
        // Not kept: a passing network problem should not hide the picture for good.
        avatarImages.delete(key);
        return null;
      });
    avatarImages.set(key, pending);
  }
  return pending;
}

export function useAvatarImage(subject: AvatarSubject): string | null {
  const [image, setImage] = useState<string | null>(null);
  const { kind, id, avatarVersion } = subject;
  useEffect(() => {
    if (!avatarVersion) {
      setImage(null);
      return;
    }
    let active = true;
    void loadAvatarImage({ ...subject, kind, id, avatarVersion }).then((loaded) => {
      if (active) setImage(loaded);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id, avatarVersion]);
  return image;
}

export function useUsers(): UseQueryResult<AdminUser[]> {
  return useQuery({ queryKey: ['users'], queryFn: () => call<AdminUser[]>('GET', '/api/admin/users') });
}

export function useBackups(enabled: boolean): UseQueryResult<BackupInfo[]> {
  return useQuery({ queryKey: ['backups'], queryFn: () => call<BackupInfo[]>('GET', '/api/admin/backups'), enabled });
}

/** A mutation that refreshes everything on screen afterwards. */
function useRefreshingMutation<Input, Output>(run: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => queryClient.invalidateQueries()
  });
}

export const useCreateApplication = () =>
  useRefreshingMutation((body: CreateApplicationRequest) => call<CreateApplicationResponse>('POST', '/api/applications', body));

export const useApplyToJob = () =>
  useRefreshingMutation(({ jobId, profileId, memo }: { jobId: number; profileId: number; memo?: string }) => call<CreateApplicationResponse>('POST', `/api/jobs/${jobId}/apply`, { profileId, memo }));

export const useUpdateApplication = () =>
  useRefreshingMutation(({ id, body }: { id: number; body: UpdateApplicationRequest }) => call<ApplicationDetail>('PATCH', `/api/applications/${id}`, body));

export const useDeleteApplication = () => useRefreshingMutation((id: number) => call('DELETE', `/api/applications/${id}`));

export const useDeleteJob = () => useRefreshingMutation((id: number) => call('DELETE', `/api/jobs/${id}`));

export const useSetHighlight = () =>
  useRefreshingMutation(({ jobId, highlighted }: { jobId: number; highlighted: boolean }) => call('POST', `/api/jobs/${jobId}/highlight`, { highlighted }));

/** Adds a step to an application's timeline, or changes one: an interview, an offer, a rejection. */
export const useSaveStep = () =>
  useRefreshingMutation(({ applicationId, stepId, input }: { applicationId: number; stepId?: number; input: StepInput }) =>
    stepId ? call<StepSaved>('PATCH', `/api/steps/${stepId}`, input) : call<StepSaved>('POST', `/api/applications/${applicationId}/steps`, input)
  );

export const useDeleteStep = () => useRefreshingMutation((id: number) => call('DELETE', `/api/steps/${id}`));

export function useDuplicates(): UseQueryResult<DuplicatesResponse> {
  return useQuery({ queryKey: ['duplicates'], queryFn: () => call<DuplicatesResponse>('GET', '/api/duplicates') });
}

export function useDuplicateCount(): UseQueryResult<{ total: number }> {
  return useQuery({ queryKey: ['duplicates-count'], queryFn: () => call<{ total: number }>('GET', '/api/duplicates/count') });
}

export const useMergeDuplicate = () => useRefreshingMutation((body: { jobIdA: number; jobIdB: number }) => call('POST', '/api/duplicates/merge', body));

export const useDismissDuplicate = () => useRefreshingMutation((body: { jobIdA: number; jobIdB: number }) => call('POST', '/api/duplicates/dismiss', body));
