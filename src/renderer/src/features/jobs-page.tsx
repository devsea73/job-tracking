import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ArrowUpToLine,
  Briefcase,
  Building2,
  CalendarClock,
  CalendarDays,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Globe,
  Inbox,
  Plus,
  RefreshCw,
  Search,
  SearchX,
  SlidersHorizontal,
  Star,
  StickyNote,
  Trash2,
  User,
  UserRound,
  Users,
  X,
  type LucideIcon
} from 'lucide-react';
import type { CurrentUser, JobListItem, JobListQuery } from '@shared/api';
import { APPLICATION_STATUSES, INTERVIEW_STAGES, type ApplicationStatus, type InterviewStage, type JobScope, type JobSort } from '@shared/constants';
import { AvatarStack, canDeleteJob, HighlightButton, ProcessLine, StatusSelect } from '@/components/job-bits';
import { IconLabel, STAGE_ICONS, STATUS_ICONS, Symbol } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { EmptyState, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { ANY, Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { errorMessage, JOB_PAGE_SIZE, useCompanies, useDeleteJob, useJobWindow, useTeam } from '@/lib/api';
import { cn, dayBoundary, formatDateTime, formatShortAgo } from '@/lib/utils';

export type JobsView = 'mine' | 'all' | 'highlighted';

const SORT_OPTIONS: Array<{ value: JobSort; label: string; icon: LucideIcon }> = [
  { value: 'recent', label: 'Recently added', icon: Clock },
  { value: 'updated', label: 'Recently updated', icon: RefreshCw },
  { value: 'company', label: 'Company name', icon: ArrowDownAZ },
  { value: 'interview', label: 'Interview date', icon: CalendarClock },
  { value: 'status', label: 'Application status', icon: Activity },
  { value: 'applicants', label: 'Most applied', icon: Users }
];

const SCOPES: Array<{ value: JobScope; label: string; icon: LucideIcon }> = [
  { value: 'all', label: 'All shared jobs', icon: Globe },
  { value: 'mine', label: 'Applied by me', icon: User },
  { value: 'others', label: 'Applied by others', icon: Users }
];

const VIEW_TITLES: Record<JobsView, string> = { mine: 'My Applications', all: 'All Jobs', highlighted: 'Highlighted' };

interface Filters {
  q: string;
  company: string;
  status: string;
  stage: string;
  from: string;
  to: string;
  scope: JobScope;
  person: string;
  profile: string;
  highlightedOnly: boolean;
  highlightFirst: boolean;
  sort: JobSort;
}

const DEFAULT_FILTERS: Filters = { q: '', company: '', status: ANY, stage: ANY, from: '', to: '', scope: 'all', person: ANY, profile: ANY, highlightedOnly: false, highlightFirst: false, sort: 'recent' };

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function ToolButton({ active, onClick, icon: Icon, label, badge }: { active?: boolean; onClick: () => void; icon: LucideIcon; label: string; badge?: number }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-pressed={active}
        aria-label={label}
        onClick={onClick}
        className={cn('relative inline-flex size-8.5 shrink-0 items-center justify-center rounded-md border', active ? 'border-accent bg-accent-soft text-accent-soft-ink' : 'border-border-strong bg-surface text-ink-2 hover:bg-surface-2')}
      >
        <Icon className="size-4" fill={Icon === Star && active ? 'currentColor' : 'none'} aria-hidden />
        {badge ? <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-accent text-[10px] font-semibold text-accent-ink">{badge}</span> : null}
      </button>
    </Tooltip>
  );
}

interface RowProps {
  job: JobListItem;
  index: number;
  view: JobsView;
  columnCount: number;
  expanded: boolean;
  canDelete: boolean;
  measure: (element: Element | null) => void;
  onToggle: (id: number) => void;
  onOpen: (id: number) => void;
  onDelete: (job: JobListItem) => void;
}

/**
 * Only rows near the viewport exist, and each redraws only when its own job changes. Each is
 * its own table body, which is what lets the list measure a row together with its details.
 */
const Row = memo(function Row({ job, index, view, columnCount, expanded, canDelete, measure, onToggle, onOpen, onDelete }: RowProps) {
  const mine = job.applications.filter((application) => application.isMine);
  const updated = job.applications.reduce<string>((newest, application) => (application.updatedAt > newest ? application.updatedAt : newest), job.updatedAt);
  const upcoming = mine.map((application) => application.nextInterviewAt).filter((value): value is string => !!value).sort()[0];
  const memoText = mine.find((application) => application.memoPreview)?.memoPreview;
  const canExpand = job.applications.length > 0;
  return (
    <tbody data-index={index} ref={measure}>
      <tr
        data-job-row
        tabIndex={0}
        onClick={() => onOpen(job.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.target === event.currentTarget) onOpen(job.id);
        }}
        className={cn('group border-b border-border hover:bg-surface-2/60 focus-visible:bg-surface-2/60', job.isHighlighted && 'bg-[color-mix(in_srgb,var(--star)_6%,transparent)]')}
      >
        <td className="py-1.5 pl-2">
          {canExpand ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} interview process for ${job.title}`}
              className="inline-flex size-6 items-center justify-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink"
              onClick={(event) => {
                event.stopPropagation();
                onToggle(job.id);
              }}
            >
              <ChevronRight className={cn('size-4', expanded && 'rotate-90')} aria-hidden />
            </button>
          ) : null}
        </td>
        <td className="truncate py-1.5 pr-3 font-medium" title={job.company}>
          {job.company}
        </td>
        <td className="truncate py-1.5 pr-3" title={job.location ? `${job.title} · ${job.location}` : job.title}>
          {job.title}
        </td>
        <td className="py-1.5 pr-3">
          {mine.length === 1 ? (
            <StatusSelect applicationId={mine[0].id} status={mine[0].status} />
          ) : mine.length > 1 ? (
            <button
              type="button"
              title={`${mine.length} of my profiles`}
              aria-label={`${mine.length} of my profiles`}
              className="inline-flex size-6 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold tabular-nums text-ink-2 hover:text-ink"
              onClick={(event) => {
                event.stopPropagation();
                onToggle(job.id);
              }}
            >
              {mine.length}
            </button>
          ) : (
            <span className="text-ink-3" aria-label="Not applied">
              —
            </span>
          )}
        </td>
        {view === 'mine' ? (
          <>
            <td className="truncate py-1.5 pr-3 text-[12.5px] text-ink-2">{upcoming ? formatDateTime(upcoming) : <span className="text-ink-3">—</span>}</td>
            <td className="py-1.5 pr-3 text-center">{memoText ? <Symbol icon={StickyNote} label={memoText} className="text-ink-3" size="size-3.5" /> : <span className="text-ink-3">—</span>}</td>
          </>
        ) : null}
        <td className="py-1.5 pr-3">
          <AvatarStack applications={job.applications} />
        </td>
        <td className="py-1.5 text-center">
          <HighlightButton jobId={job.id} highlighted={job.isHighlighted} />
        </td>
        <td className="py-1.5 text-center">
          {canDelete ? (
            <button
              type="button"
              title="Delete job"
              aria-label={`Delete ${job.title}`}
              className="inline-flex size-7 items-center justify-center rounded-md text-ink-3 opacity-0 hover:bg-danger-soft hover:text-danger-ink focus-visible:opacity-100 group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(job);
              }}
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          ) : null}
        </td>
        <td className="whitespace-nowrap py-1.5 pl-1 pr-4 text-right text-[12px] tabular-nums text-ink-3" title={formatDateTime(updated)}>
          {formatShortAgo(updated)}
        </td>
      </tr>
      {expanded && canExpand ? (
        <tr className="border-b border-border bg-surface-2/40">
          <td />
          <td colSpan={columnCount - 1} className="py-1 pr-4">
            <ul className="divide-y divide-border">
              {job.applications.map((application) => (
                <ProcessLine key={application.id} application={application} />
              ))}
            </ul>
          </td>
        </tr>
      ) : null}
    </tbody>
  );
});

function LoadingRow({ index, columnCount, measure }: { index: number; columnCount: number; measure: (element: Element | null) => void }) {
  return (
    <tbody data-index={index} ref={measure}>
      <tr className="border-b border-border">
        <td colSpan={columnCount} className="px-4 py-2.5">
          <Skeleton className="h-5 w-full" />
        </td>
      </tr>
    </tbody>
  );
}

const ROW_HEIGHT = 41;

export function JobsPage({ view, user, onOpenJob, onAddJob, focusSearchSignal }: { view: JobsView; user: CurrentUser; onOpenJob: (id: number) => void; onAddJob: () => void; focusSearchSignal: number }) {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [expandAll, setExpandAll] = useState(false);
  const [deleting, setDeleting] = useState<JobListItem | null>(null);
  const [count, setCount] = useState(0);
  const team = useTeam();
  const remove = useDeleteJob();
  const toast = useToast();
  const searchInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));

  useEffect(() => {
    setFilters(DEFAULT_FILTERS);
    setShowFilters(false);
    setExpanded(new Set());
    setExpandAll(false);
  }, [view]);
  useEffect(() => {
    if (focusSearchSignal > 0) searchInput.current?.focus();
  }, [focusSearchSignal]);

  const typedSearch = useDebounced(filters.q, 120);
  const typedCompany = useDebounced(filters.company, 120);

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
      personId: view === 'mine' || filters.person === ANY ? undefined : Number(filters.person),
      profileId: filters.profile === ANY ? undefined : Number(filters.profile),
      sort: filters.sort
    };
  }, [view, typedSearch, typedCompany, filters.status, filters.stage, filters.from, filters.to, filters.scope, filters.person, filters.profile, filters.highlightedOnly, filters.highlightFirst, filters.sort]);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    getItemKey: (index) => index
  });
  const virtualItems = virtualizer.getVirtualItems();
  const firstPage = Math.floor((virtualItems[0]?.index ?? 0) / JOB_PAGE_SIZE);
  const lastPage = Math.floor((virtualItems[virtualItems.length - 1]?.index ?? 0) / JOB_PAGE_SIZE);
  const jobs = useJobWindow(query, firstPage, lastPage);

  useEffect(() => {
    if (jobs.total !== undefined) setCount(jobs.total);
  }, [jobs.total]);
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    virtualizer.scrollToOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  const companies = useCompanies();
  const members = team.data ?? [];
  // My Applications only offers your own profiles, and a chosen person narrows the list to theirs.
  const profileOwners = view === 'mine' ? members.filter((member) => member.user.id === user.id) : filters.person === ANY ? members : members.filter((member) => String(member.user.id) === filters.person);
  const profileOptions = profileOwners.flatMap((member) =>
    member.profiles.map((entry) => ({ value: String(entry.profile.id), label: profileOwners.length > 1 ? `${entry.profile.name} (${member.user.displayName ?? member.user.username})` : entry.profile.name }))
  );
  const filterCount = [filters.company, filters.status !== ANY, filters.stage !== ANY, filters.from, filters.to, filters.person !== ANY, filters.profile !== ANY].filter(Boolean).length;
  const anyFilter = filterCount > 0 || !!filters.q || filters.highlightedOnly || (view !== 'mine' && filters.scope !== 'all');
  const columnCount = view === 'mine' ? 10 : 8;

  const toggle = useCallback((id: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const total = jobs.total ?? 0;
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom = virtualizer.getTotalSize() - (virtualItems[virtualItems.length - 1]?.end ?? 0);
  const showList = total > 0 && count > 0;

  return (
    <div className="flex h-full flex-col">
      <header className="px-5 pb-2.5 pt-4">
        <div className="flex items-center gap-2">
          <h1 className="mr-1 whitespace-nowrap text-[17px] font-semibold leading-tight">{VIEW_TITLES[view]}</h1>
          <span className="inline-flex items-center gap-1 text-[12.5px] tabular-nums text-ink-3" role="status" title={`${total.toLocaleString()} jobs`}>
            <Briefcase className="size-3.5" aria-hidden />
            {jobs.total !== undefined ? total.toLocaleString() : ''}
          </span>
          <div className="relative ml-1 min-w-[160px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <Input ref={searchInput} aria-label="Search" className="pl-8" placeholder="Search" value={filters.q} onChange={(event) => set({ q: event.target.value })} />
          </div>
          {view !== 'mine' ? (
            <div className="inline-flex shrink-0 rounded-md border border-border-strong p-0.5" role="group" aria-label="Who applied">
              {SCOPES.map(({ value, label, icon: Icon }) => (
                <Tooltip key={value} content={label}>
                  <button
                    type="button"
                    aria-label={label}
                    aria-pressed={filters.scope === value}
                    onClick={() => set({ scope: value })}
                    className={cn('inline-flex size-7 items-center justify-center rounded', filters.scope === value ? 'bg-accent-soft text-accent-soft-ink' : 'text-ink-2 hover:text-ink')}
                  >
                    <Icon className="size-4" aria-hidden />
                  </button>
                </Tooltip>
              ))}
            </div>
          ) : null}
          <Select
            ariaLabel="Sort by"
            className="w-[58px] shrink-0"
            hideValue
            leading={<ArrowDownWideNarrow className="size-4 text-ink-2" aria-hidden />}
            value={filters.sort}
            onChange={(value) => set({ sort: value as JobSort })}
            options={SORT_OPTIONS.map(({ value, label, icon }) => ({ value, label: <IconLabel icon={icon}>{label}</IconLabel> }))}
          />
          {view !== 'highlighted' ? <ToolButton active={filters.highlightedOnly} onClick={() => set({ highlightedOnly: !filters.highlightedOnly })} icon={Star} label="Highlighted only" /> : null}
          <ToolButton active={filters.highlightFirst} onClick={() => set({ highlightFirst: !filters.highlightFirst })} icon={ArrowUpToLine} label="Starred first" />
          <ToolButton active={expandAll} onClick={() => setExpandAll(!expandAll)} icon={ChevronsUpDown} label="Show every process" />
          <ToolButton active={showFilters} onClick={() => setShowFilters(!showFilters)} icon={SlidersHorizontal} label="Filters" badge={filterCount} />
          <Tooltip content="Add job">
            <Button variant="primary" size="icon" aria-label="Add job" className="size-8.5 shrink-0" onClick={onAddJob}>
              <Plus />
            </Button>
          </Tooltip>
        </div>

        {showFilters ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input className="w-[150px]" aria-label="Company" list="company-options" placeholder="Company" value={filters.company} onChange={(event) => set({ company: event.target.value })} />
            <datalist id="company-options">{companies.data?.map((company) => <option key={company} value={company} />)}</datalist>
            {view !== 'mine' ? (
              <Select
                ariaLabel="Person"
                className="w-[150px]"
                leading={<UserRound className="size-3.5 text-ink-3" aria-hidden />}
                value={filters.person}
                onChange={(person) => set({ person, profile: ANY })}
                options={[{ value: ANY, label: 'Anyone' }, ...members.map((member) => ({ value: String(member.user.id), label: member.user.displayName ?? member.user.username }))]}
              />
            ) : null}
            <Select ariaLabel="Profile" className="w-[160px]" leading={<User className="size-3.5 text-ink-3" aria-hidden />} value={filters.profile} onChange={(profile) => set({ profile })} options={[{ value: ANY, label: 'Any profile' }, ...profileOptions]} />
            <Select
              ariaLabel="Status filter"
              className="w-[196px]"
              value={filters.status}
              onChange={(value) => set({ status: value })}
              options={[{ value: ANY, label: <IconLabel icon={Activity}>Any status</IconLabel> }, ...APPLICATION_STATUSES.map((value) => ({ value, label: <IconLabel icon={STATUS_ICONS[value]}>{value}</IconLabel> }))]}
            />
            <Select
              ariaLabel="Interview stage"
              className="w-[196px]"
              value={filters.stage}
              onChange={(value) => set({ stage: value })}
              options={[{ value: ANY, label: <IconLabel icon={CalendarDays}>Any stage</IconLabel> }, ...INTERVIEW_STAGES.map((value) => ({ value, label: <IconLabel icon={STAGE_ICONS[value]}>{value}</IconLabel> }))]}
            />
            {/* Kept together, so that a narrow window never separates the two ends of the range. */}
            <span className="inline-flex items-center gap-1.5">
              <CalendarClock className="size-4 text-ink-3" aria-hidden />
              <Input type="date" aria-label="Interviews from" title="Interviews from" className="w-[132px]" value={filters.from} onChange={(event) => set({ from: event.target.value })} />
              <span className="text-ink-3">–</span>
              <Input type="date" aria-label="Interviews to" title="Interviews to" className="w-[132px]" value={filters.to} onChange={(event) => set({ to: event.target.value })} />
            </span>
            {anyFilter ? (
              <Tooltip content="Clear filters">
                <Button size="icon-sm" variant="ghost" aria-label="Clear filters" onClick={() => set({ ...DEFAULT_FILTERS, sort: filters.sort, highlightFirst: filters.highlightFirst })}>
                  <X />
                </Button>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
      </header>

      <div ref={scroller} data-scroller className="min-h-0 flex-1 overflow-auto border-t border-border bg-surface">
        {jobs.error ? (
          <div className="p-5">
            <Notice kind="error" title="Could not load jobs">
              {errorMessage(jobs.error)}
            </Notice>
          </div>
        ) : jobs.total === undefined ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-7 w-full" />
            ))}
          </div>
        ) : !showList ? (
          anyFilter ? (
            <EmptyState icon={SearchX} title="Nothing matches these filters" />
          ) : view === 'highlighted' ? (
            <EmptyState icon={Star} title="No highlighted jobs yet" />
          ) : view === 'mine' ? (
            <EmptyState
              icon={Inbox}
              title="You haven't added any applications"
              action={
                <Button variant="primary" onClick={onAddJob}>
                  <Plus /> Add your first job
                </Button>
              }
            />
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
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col className="w-[36px]" />
              <col className="w-[190px]" />
              <col />
              <col className="w-[44px]" />
              {view === 'mine' ? (
                <>
                  <col className="w-[150px]" />
                  <col className="w-[44px]" />
                </>
              ) : null}
              <col className="w-[132px]" />
              <col className="w-[36px]" />
              <col className="w-[36px]" />
              <col className="w-[58px]" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="border-b border-border text-left text-ink-3 [&>th]:font-normal">
                <th aria-label="Interview process" />
                <th className="py-1.5 pr-3">
                  <Symbol icon={Building2} label="Company" />
                </th>
                <th className="py-1.5 pr-3">
                  <Symbol icon={Briefcase} label="Job title" />
                </th>
                <th className="py-1.5 pr-3">
                  <Symbol icon={Activity} label={view === 'mine' ? 'Status' : 'My status'} />
                </th>
                {view === 'mine' ? (
                  <>
                    <th className="py-1.5 pr-3">
                      <Symbol icon={CalendarClock} label="Next interview" />
                    </th>
                    <th className="py-1.5 pr-3 text-center">
                      <Symbol icon={StickyNote} label="Memo" />
                    </th>
                  </>
                ) : null}
                <th className="py-1.5 pr-3">
                  <Symbol icon={Users} label="Applied" />
                </th>
                <th className="py-1.5 text-center">
                  <Symbol icon={Star} label="Highlighted for everyone" />
                </th>
                <th aria-label="Delete" />
                <th className="py-1.5 pl-1 pr-4 text-right">
                  <Symbol icon={Clock} label="Updated" />
                </th>
              </tr>
            </thead>
            {paddingTop > 0 ? (
              <tbody aria-hidden>
                <tr style={{ height: paddingTop }}>
                  <td colSpan={columnCount} />
                </tr>
              </tbody>
            ) : null}
            {virtualItems.map((item) => {
              const job = jobs.rowAt(item.index);
              return job ? (
                <Row
                  key={job.id}
                  job={job}
                  index={item.index}
                  view={view}
                  columnCount={columnCount}
                  expanded={expandAll || expanded.has(job.id)}
                  canDelete={canDeleteJob(job.applications, user)}
                  measure={virtualizer.measureElement}
                  onToggle={toggle}
                  onOpen={onOpenJob}
                  onDelete={setDeleting}
                />
              ) : (
                <LoadingRow key={`loading-${item.index}`} index={item.index} columnCount={columnCount} measure={virtualizer.measureElement} />
              );
            })}
            {paddingBottom > 0 ? (
              <tbody aria-hidden>
                <tr style={{ height: paddingBottom }}>
                  <td colSpan={columnCount} />
                </tr>
              </tbody>
            ) : null}
          </table>
        )}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this job?"
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => setDeleting(null),
            onError: (error) => {
              setDeleting(null);
              toast.show(errorMessage(error), 'error');
            }
          });
        }}
      >
        {deleting ? `${deleting.title}, ${deleting.company}` : null}
      </ConfirmDialog>
    </div>
  );
}
