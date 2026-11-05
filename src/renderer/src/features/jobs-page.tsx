import { useEffect, useMemo, useRef, useState } from 'react';
import { Briefcase, Inbox, Plus, Search, SearchX, Star, X } from 'lucide-react';
import type { JobListItem, JobListQuery } from '@shared/api';
import { APPLICATION_STATUSES, INTERVIEW_STAGES, type ApplicationStatus, type InterviewStage, type JobScope, type JobSort } from '@shared/constants';
import { AvatarStack, HighlightButton, StatusSelect } from '@/components/job-bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { EmptyState, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { ANY, Select } from '@/components/ui/select';
import { errorMessage, useCompanies, useJobs } from '@/lib/api';
import { cn, dayBoundary, formatDateTime, formatRelative } from '@/lib/utils';

export type JobsView = 'mine' | 'all' | 'highlighted';

const PAGE_SIZE = 100;

const SORT_OPTIONS: Array<{ value: JobSort; label: string }> = [
  { value: 'recent', label: 'Recently added' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'company', label: 'Company name' },
  { value: 'interview', label: 'Interview date' },
  { value: 'status', label: 'Application status' }
];

const VIEW_COPY: Record<JobsView, { title: string; subtitle: string }> = {
  mine: { title: 'My Applications', subtitle: 'Jobs you have applied to. Status, memos and interviews here are private to you.' },
  all: { title: 'All Jobs', subtitle: 'The list shared by everyone on this host.' },
  highlighted: { title: 'Highlighted', subtitle: 'Jobs anyone has starred for the whole group.' }
};

interface Filters {
  q: string;
  company: string;
  status: string;
  stage: string;
  from: string;
  to: string;
  scope: JobScope;
  highlightedOnly: boolean;
  highlightFirst: boolean;
  sort: JobSort;
}

const DEFAULT_FILTERS: Filters = { q: '', company: '', status: ANY, stage: ANY, from: '', to: '', scope: 'all', highlightedOnly: false, highlightFirst: false, sort: 'recent' };

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function DateInput({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  return <Input type="date" aria-label={label} title={label} className="w-[132px]" value={value} onChange={(event) => onChange(event.target.value)} />;
}

function ToggleChip({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn('inline-flex h-8.5 items-center gap-1.5 rounded-md border px-2.5 whitespace-nowrap', active ? 'border-accent bg-accent-soft text-accent-soft-ink' : 'border-border-strong bg-surface text-ink-2 hover:bg-surface-2')}
    >
      {icon}
      {children}
    </button>
  );
}

function Row({ job, view, onOpen }: { job: JobListItem; view: JobsView; onOpen: (id: number) => void }) {
  const mine = job.myApplication;
  return (
    <tr
      tabIndex={0}
      onClick={() => onOpen(job.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) onOpen(job.id);
      }}
      className={cn('group border-b border-border last:border-b-0 hover:bg-surface-2/60 focus-visible:bg-surface-2/60', job.isHighlighted && 'bg-[color-mix(in_srgb,var(--star)_6%,transparent)]')}
    >
      <td className="max-w-[190px] truncate py-2 pl-4 pr-3 font-medium" title={job.company}>
        {job.company}
      </td>
      <td className="max-w-[320px] py-2 pr-3">
        <div className="truncate" title={job.title}>
          {job.title}
        </div>
        {job.location ? (
          <div className="truncate text-[12px] text-ink-3" title={job.location}>
            {job.location}
          </div>
        ) : null}
      </td>
      <td className="py-2 pr-3">
        {mine ? <StatusSelect applicationId={mine.id} status={mine.status} /> : <span className="text-ink-3">Not applied</span>}
      </td>
      {view === 'mine' ? (
        <>
          <td className="whitespace-nowrap py-2 pr-3 text-ink-2">{mine?.nextInterviewAt ? formatDateTime(mine.nextInterviewAt) : <span className="text-ink-3">—</span>}</td>
          <td className="max-w-[220px] truncate py-2 pr-3 text-ink-2" title={mine?.memoPreview}>
            {mine?.memoPreview || <span className="text-ink-3">—</span>}
          </td>
        </>
      ) : null}
      <td className="py-2 pr-3">
        <AvatarStack users={job.applicants} />
      </td>
      <td className="py-2 pr-1 text-center">
        <HighlightButton jobId={job.id} highlighted={job.isHighlighted} />
      </td>
      <td className="whitespace-nowrap py-2 pl-2 pr-4 text-right text-ink-3" title={formatDateTime(mine?.updatedAt ?? job.updatedAt)}>
        {formatRelative(mine?.updatedAt ?? job.updatedAt)}
      </td>
    </tr>
  );
}

export function JobsPage({ view, onOpenJob, onAddJob, focusSearchSignal }: { view: JobsView; onOpenJob: (id: number) => void; onAddJob: () => void; focusSearchSignal: number }) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const searchInput = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setLimit(PAGE_SIZE);
  };

  useEffect(() => {
    setFilters(DEFAULT_FILTERS);
    setLimit(PAGE_SIZE);
  }, [view]);
  useEffect(() => {
    if (focusSearchSignal > 0) searchInput.current?.focus();
  }, [focusSearchSignal]);

  const typedSearch = useDebounced(filters.q, 180);
  const typedCompany = useDebounced(filters.company, 180);

  const query = useMemo<JobListQuery>(() => {
    const scope: JobScope = view === 'mine' ? 'mine' : filters.scope;
    return {
      q: typedSearch.trim() || undefined,
      company: typedCompany.trim() || undefined,
      status: filters.status === ANY ? undefined : (filters.status as ApplicationStatus),
      stage: filters.stage === ANY ? undefined : (filters.stage as InterviewStage),
      interviewFrom: filters.from ? dayBoundary(filters.from, 'start') : undefined,
      interviewTo: filters.to ? dayBoundary(filters.to, 'end') : undefined,
      highlighted: view === 'highlighted' || filters.highlightedOnly || undefined,
      highlightFirst: filters.highlightFirst || undefined,
      scope,
      sort: filters.sort,
      limit
    };
  }, [view, typedSearch, typedCompany, filters.status, filters.stage, filters.from, filters.to, filters.scope, filters.highlightedOnly, filters.highlightFirst, filters.sort, limit]);

  const jobs = useJobs(query);
  const companies = useCompanies();
  const copy = VIEW_COPY[view];
  const items = jobs.data?.items ?? [];
  const total = jobs.data?.total ?? 0;
  const anyFilter =
    filters.q || filters.company || filters.status !== ANY || filters.stage !== ANY || filters.from || filters.to || filters.highlightedOnly || (view !== 'mine' && filters.scope !== 'all');

  return (
    <div className="flex h-full flex-col">
      <header className="px-6 pb-3 pt-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[20px] font-semibold leading-tight">{copy.title}</h1>
            <p className="mt-0.5 text-ink-2">{copy.subtitle}</p>
          </div>
          <Button variant="primary" onClick={onAddJob}>
            <Plus /> Add job
          </Button>
        </div>

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <Input ref={searchInput} aria-label="Search" className="pl-8" placeholder="Search company, title, description and your memos" value={filters.q} onChange={(event) => set({ q: event.target.value })} />
          </div>
          <Input className="w-[170px]" aria-label="Company" list="company-options" placeholder="Company" value={filters.company} onChange={(event) => set({ company: event.target.value })} />
          <datalist id="company-options">{companies.data?.map((company) => <option key={company} value={company} />)}</datalist>
          {view !== 'mine' ? (
            <Select
              ariaLabel="Who applied"
              className="w-[172px]"
              value={filters.scope}
              onChange={(value) => set({ scope: value as JobScope })}
              options={[
                { value: 'all', label: 'All shared jobs' },
                { value: 'mine', label: 'Applied by me' },
                { value: 'others', label: 'Applied by others' }
              ]}
            />
          ) : null}
          <Select ariaLabel="Sort by" className="w-[172px]" value={filters.sort} onChange={(value) => set({ sort: value as JobSort })} options={SORT_OPTIONS} />
          {view !== 'highlighted' ? (
            <ToggleChip active={filters.highlightedOnly} onClick={() => set({ highlightedOnly: !filters.highlightedOnly })} icon={<Star className="size-3.5" fill={filters.highlightedOnly ? 'currentColor' : 'none'} aria-hidden />}>
              Highlighted
            </ToggleChip>
          ) : null}
          <ToggleChip active={filters.highlightFirst} onClick={() => set({ highlightFirst: !filters.highlightFirst })}>
            Starred first
          </ToggleChip>
        </div>

        {/* These look only at your own application, which is why they sit apart from the shared-job filters above. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium text-ink-3">My application</span>
          <Select ariaLabel="My status" className="w-[172px]" value={filters.status} onChange={(value) => set({ status: value })} options={[{ value: ANY, label: 'Any status' }, ...APPLICATION_STATUSES.map((value) => ({ value, label: value }))]} />
          <Select ariaLabel="My interview stage" className="w-[172px]" value={filters.stage} onChange={(value) => set({ stage: value })} options={[{ value: ANY, label: 'Any interview stage' }, ...INTERVIEW_STAGES.map((value) => ({ value, label: value }))]} />
          <span className="ml-1 text-[12px] text-ink-3">Interview from</span>
          <DateInput label="Interviews from" value={filters.from} onChange={(from) => set({ from })} />
          <span className="text-[12px] text-ink-3">to</span>
          <DateInput label="Interviews to" value={filters.to} onChange={(to) => set({ to })} />
          {anyFilter ? (
            <Button size="sm" variant="ghost" onClick={() => set({ ...DEFAULT_FILTERS, sort: filters.sort, highlightFirst: filters.highlightFirst })}>
              <X /> Clear
            </Button>
          ) : null}
          <span className="ml-auto text-[12px] tabular-nums text-ink-3" role="status">
            {jobs.data ? `${total} ${total === 1 ? 'job' : 'jobs'}` : ''}
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto border-t border-border bg-surface">
        {jobs.isError ? (
          <div className="p-5">
            <Notice kind="error" title="Could not load jobs">
              {errorMessage(jobs.error)}
            </Notice>
          </div>
        ) : jobs.isPending ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-7 w-full" />
            ))}
          </div>
        ) : items.length === 0 ? (
          anyFilter ? (
            <EmptyState icon={SearchX} title="Nothing matches these filters">
              Try removing a filter or searching for something broader.
            </EmptyState>
          ) : view === 'highlighted' ? (
            <EmptyState icon={Star} title="No highlighted jobs yet">
              Star a job in any list and it shows up here for everyone.
            </EmptyState>
          ) : view === 'mine' ? (
            <EmptyState
              icon={Inbox}
              title="You haven't added any applications"
              action={
                <Button variant="primary" onClick={onAddJob}>
                  <Plus /> Add your first job
                </Button>
              }
            >
              Paste a job link and the details are filled in for you.
            </EmptyState>
          ) : (
            <EmptyState
              icon={Briefcase}
              title="No jobs in the shared list yet"
              action={
                <Button variant="primary" onClick={onAddJob}>
                  <Plus /> Add a job
                </Button>
              }
            />
          )
        ) : (
          <>
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[170px]" />
                <col />
                <col className="w-[176px]" />
                {view === 'mine' ? (
                  <>
                    <col className="w-[160px]" />
                    <col className="w-[190px]" />
                  </>
                ) : null}
                <col className="w-[112px]" />
                <col className="w-[44px]" />
                <col className="w-[116px]" />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className="border-b border-border text-left text-[12px] font-medium text-ink-3 [&>th]:font-medium">
                  <th className="py-2 pl-4 pr-3">Company</th>
                  <th className="py-2 pr-3">Job title</th>
                  <th className="py-2 pr-3">{view === 'mine' ? 'Status' : 'My status'}</th>
                  {view === 'mine' ? (
                    <>
                      <th className="py-2 pr-3">Next interview</th>
                      <th className="py-2 pr-3">Memo</th>
                    </>
                  ) : null}
                  <th className="py-2 pr-3">Applied</th>
                  <th className="py-2 pr-1">
                    <Tooltip content="Highlighted for everyone">
                      <span className="inline-flex justify-center">
                        <Star className="size-3.5" aria-label="Highlight" />
                      </span>
                    </Tooltip>
                  </th>
                  <th className="py-2 pl-2 pr-4 text-right">Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((job) => (
                  <Row key={job.id} job={job} view={view} onOpen={onOpenJob} />
                ))}
              </tbody>
            </table>
            {items.length < total ? (
              <div className="flex justify-center p-4">
                <Button onClick={() => setLimit((current) => Math.min(current + PAGE_SIZE, 500))} disabled={limit >= 500}>
                  {limit >= 500 ? 'Narrow your search to see more' : `Show more (${total - items.length} left)`}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
