import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  AdminUser,
  BackupInfo,
  CreateApplicationRequest,
  CreateApplicationResponse,
  CurrentUser,
  DashboardResponse,
  Interview,
  InterviewInput,
  InterviewListItem,
  JobDetail,
  JobListQuery,
  JobListResponse,
  MyApplicationDetail,
  UpdateApplicationRequest
} from '@shared/api';
import type { BridgeState } from '@shared/bridge';
import type { InterviewStage } from '@shared/constants';

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

/** Other people's changes arrive as events from the host, and refresh whatever is on screen. */
export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  useEffect(() => bridge.onServerEvent(() => void queryClient.invalidateQueries()), [queryClient]);
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

export function useJobs(query: JobListQuery): UseQueryResult<JobListResponse> {
  return useQuery({
    queryKey: ['jobs', query],
    queryFn: () => call<JobListResponse>('GET', `/api/jobs${toSearchParams(query)}`),
    placeholderData: keepPreviousData
  });
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

export function useInterviews(filter: { from?: string; to?: string; stage?: InterviewStage }): UseQueryResult<InterviewListItem[]> {
  const params = new URLSearchParams();
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (filter.stage) params.set('stage', filter.stage);
  const text = params.toString();
  return useQuery({
    queryKey: ['interviews', filter],
    queryFn: () => call<InterviewListItem[]>('GET', `/api/interviews${text ? `?${text}` : ''}`),
    placeholderData: keepPreviousData
  });
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
  useRefreshingMutation(({ jobId, memo }: { jobId: number; memo?: string }) => call<CreateApplicationResponse>('POST', `/api/jobs/${jobId}/apply`, { memo }));

export const useUpdateApplication = () =>
  useRefreshingMutation(({ id, body }: { id: number; body: UpdateApplicationRequest }) => call<MyApplicationDetail>('PATCH', `/api/applications/${id}`, body));

export const useDeleteApplication = () => useRefreshingMutation((id: number) => call('DELETE', `/api/applications/${id}`));

export const useSetHighlight = () =>
  useRefreshingMutation(({ jobId, highlighted }: { jobId: number; highlighted: boolean }) => call('POST', `/api/jobs/${jobId}/highlight`, { highlighted }));

export const useSaveInterview = () =>
  useRefreshingMutation(({ applicationId, interviewId, input }: { applicationId: number; interviewId?: number; input: InterviewInput }) =>
    interviewId
      ? call<Interview>('PATCH', `/api/interviews/${interviewId}`, input)
      : call<Interview>('POST', `/api/applications/${applicationId}/interviews`, input)
  );

export const useDeleteInterview = () => useRefreshingMutation((id: number) => call('DELETE', `/api/interviews/${id}`));
