import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  AdminUser,
  ApplicationDetail,
  AvatarSubject,
  BackupInfo,
  CreateApplicationRequest,
  CreateApplicationResponse,
  CurrentUser,
  DashboardResponse,
  Interview,
  InterviewInput,
  InterviewListItem,
  InterviewQuery,
  JobDetail,
  JobListItem,
  JobListQuery,
  JobListResponse,
  MyProfilesResponse,
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

function toSearchParams(query: JobListQuery): string {
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

export const JOB_PAGE_SIZE = 50;

export interface JobWindow {
  /** The job at a position in the whole list, or null until its page arrives. */
  rowAt: (index: number) => JobListItem | null;
  total: number | undefined;
  error: unknown;
}

/**
 * The part of a long list around what is on screen. Pages load as they scroll into view and are
 * forgotten soon after, and a refresh only asks again for the pages being looked at, so the cost
 * stays the same however many of the 10,000 jobs someone has scrolled past.
 */
export function useJobWindow(query: JobListQuery, firstPage: number, lastPage: number): JobWindow {
  const pages: number[] = [];
  for (let page = firstPage; page <= lastPage; page += 1) pages.push(page);
  const results = useQueries({
    queries: pages.map((page) => ({
      queryKey: ['jobs', query, page],
      queryFn: () => call<JobListResponse>('GET', `/api/jobs${toSearchParams({ ...query, limit: JOB_PAGE_SIZE, offset: page * JOB_PAGE_SIZE })}`),
      gcTime: 60_000,
      // While new filters load, the same page keeps showing what it had. Another page never does.
      placeholderData: (previous: JobListResponse | undefined, previousQuery: { queryKey: readonly unknown[] } | undefined) => (previousQuery?.queryKey[2] === page ? previous : undefined)
    }))
  });
  const lastTotal = useRef<number | undefined>(undefined);
  const known = results.find((result) => result.data)?.data?.total;
  if (known !== undefined) lastTotal.current = known;
  return {
    rowAt: (index) => {
      const position = pages.indexOf(Math.floor(index / JOB_PAGE_SIZE));
      return position < 0 ? null : (results[position]?.data?.items[index % JOB_PAGE_SIZE] ?? null);
    },
    total: lastTotal.current,
    error: results.find((result) => result.isError && !result.data)?.error ?? null
  };
}

export function useCompanies(): UseQueryResult<string[]> {
  return useQuery({ queryKey: ['companies'], queryFn: () => call<string[]>('GET', '/api/jobs/companies'), staleTime: 30_000 });
}

export function useJob(id: number | null): UseQueryResult<JobDetail> {
  return useQuery({ queryKey: ['job', id], queryFn: () => call<JobDetail>('GET', `/api/jobs/${id}`), enabled: id !== null });
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

export const useSaveInterview = () =>
  useRefreshingMutation(({ applicationId, interviewId, input }: { applicationId: number; interviewId?: number; input: InterviewInput }) =>
    interviewId
      ? call<Interview>('PATCH', `/api/interviews/${interviewId}`, input)
      : call<Interview>('POST', `/api/applications/${applicationId}/interviews`, input)
  );

export const useDeleteInterview = () => useRefreshingMutation((id: number) => call('DELETE', `/api/interviews/${id}`));
