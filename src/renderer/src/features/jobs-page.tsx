import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ArrowUpToLine,
  Briefcase,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  Rows3,
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
import { JobTags } from '@/components/job-tags';
import { IconLabel, STAGE_ICONS, STATUS_ICONS, Symbol } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { EmptyState, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { ANY, Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { errorMessage, PAGE_SIZES, useCompanies, useDeleteJob, useJobPage, useTeam, type PageSize } from '@/lib/api';
import { cn, dayBoundary, formatDate, formatDateTime, formatShortAgo, formatShortDate } from '@/lib/utils';

export type JobsView = 'mine' | 'all' | 'highlighted';

const SORT_OPTIONS: Array<{ value: JobSort; label: string; icon: LucideIcon }> = [
  { value: 'recent', label: 'Recently added', icon: Clock },
  { value: 'applied', label: 'Applied date', icon: CalendarCheck },
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

/** My Applications is about when I applied; the shared lists about when jobs arrived. */
const defaultsFor = (view: JobsView): Filters => (view === 'mine' ? { ...DEFAULT_FILTERS, sort: 'applied' } : DEFAULT_FILTERS);

/** Applied date only makes sense for my own applications, and there it replaces "recently added". */
const sortsFor = (view: JobsView) => SORT_OPTIONS.filter(({ value }) => (view === 'mine' ? value !== 'recent' : value !== 'applied'));

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
  view: JobsView;
  columnCount: number;
  expanded: boolean;
  canDelete: boolean;
  onToggle: (id: number) => void;
  onOpen: (id: number) => void;
  onDelete: (job: JobListItem) => void;
}

/** Each row redraws only when its own job changes, and keeps its details in its own table body. */
const Row = memo(function Row({ job, view, columnCount, expanded, canDelete, onToggle, onOpen, onDelete }: RowProps) {
  const mine = job.applications.filter((application) => application.isMine);
  const updated = job.applications.reduce<string>((newest, application) => (application.updatedAt > newest ? application.updatedAt : newest), job.updatedAt);
  const upcoming = mine.map((application) => application.nextInterviewAt).filter((value): value is string => !!value).sort()[0];
  const memoText = mine.find((application) => application.memoPreview)?.memoPreview;
  // My Applications shows when I applied; with several of my profiles, the first time.
  const applied = mine.map((application) => application.appliedAt).sort()[0];
  const canExpand = job.applications.length > 0;
  return (
    <tbody>
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
        <td className="py-1.5 pr-3" title={job.location ? `${job.title} · ${job.location}` : job.title}>
          <JobTags facts={job.facts} reserve className="mb-0.5" />
          <div className="truncate">{job.title}</div>
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
            <td className="truncate py-1.5 pr-3 text-[12.5px] text-ink-2" title={memoText} data-memo>
              {memoText ?? <span className="text-ink-3">—</span>}
            </td>
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
        {view === 'mine' ? (
          <td className="whitespace-nowrap py-1.5 pl-1 pr-4 text-right text-[12px] tabular-nums text-ink-2" title={applied ? `Applied ${formatDate(applied)}` : undefined} data-applied>
            {applied ? formatShortDate(applied) : <span className="text-ink-3">—</span>}
          </td>
        ) : (
          <td className="whitespace-nowrap py-1.5 pl-1 pr-4 text-right text-[12px] tabular-nums text-ink-3" title={formatDateTime(updated)}>
            {formatShortAgo(updated)}
          </td>
        )}
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

const PAGE_SIZE_KEY = 'jobTracker.pageSize';

function savedPageSize(): PageSize {
  const saved = Number(localStorage.getItem(PAGE_SIZE_KEY));
  return (PAGE_SIZES as readonly number[]).includes(saved) ? (saved as PageSize) : 50;
}

function PagerButton({ label, icon: Icon, disabled, onClick }: { label: string; icon: LucideIcon; disabled: boolean; onClick: () => void }) {
  return (
    <Tooltip content={label}>
      <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="inline-flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-surface-2 hover:text-ink disabled:pointer-events-none disabled:opacity-35">
        <Icon className="size-4" aria-hidden />
      </button>
    </Tooltip>
  );
}

/** Page numbers around the current one, with the first and last always in reach. */
function pageNumbers(current: number, count: number): Array<number | 'gap'> {
  const shown = new Set([0, count - 1, current - 2, current - 1, current, current + 1, current + 2].filter((page) => page >= 0 && page < count));
  const sorted = [...shown].sort((a, b) => a - b);
  const result: Array<number | 'gap'> = [];
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) result.push('gap');
    result.push(page);
  });
  return result;
}

function Pager({ page, size, total, onPage, onSize }: { page: number; size: PageSize; total: number; onPage: (page: number) => void; onSize: (size: PageSize) => void }) {
  const count = Math.max(1, Math.ceil(total / size));
  const first = total === 0 ? 0 : page * size + 1;
  const last = Math.min(total, (page + 1) * size);
  return (
    <nav aria-label="Pages" className="flex shrink-0 items-center gap-1 border-t border-border bg-surface px-4 py-1.5">
      <Select
        ariaLabel="Jobs per page"
        className="h-7 w-[84px]"
        leading={<Rows3 className="size-3.5 text-ink-3" aria-hidden />}
        value={String(size)}
        onChange={(value) => onSize(Number(value) as PageSize)}
        options={PAGE_SIZES.map((value) => ({ value: String(value), label: String(value) }))}
      />
      <span className="ml-2 text-[12px] tabular-nums text-ink-3" data-page-range>
        {first.toLocaleString()}–{last.toLocaleString()} / {total.toLocaleString()}
      </span>
      <div className="ml-auto flex items-center gap-0.5">
        <PagerButton label="First page" icon={ChevronsLeft} disabled={page === 0} onClick={() => onPage(0)} />
        <PagerButton label="Previous page" icon={ChevronLeft} disabled={page === 0} onClick={() => onPage(page - 1)} />
        {pageNumbers(page, count).map((item, index) =>
          item === 'gap' ? (
            <span key={`gap-${index}`} className="px-1 text-ink-3" aria-hidden>
              …
            </span>
          ) : (
            <button
              key={item}
              type="button"
              aria-label={`Page ${item + 1}`}
              aria-current={item === page ? 'page' : undefined}
              onClick={() => onPage(item)}
              className={cn('h-7 min-w-7 rounded-md px-1.5 text-[12px] tabular-nums', item === page ? 'bg-accent-soft font-semibold text-accent-soft-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}
            >
              {item + 1}
            </button>
          )
        )}
        <PagerButton label="Next page" icon={ChevronRight} disabled={page >= count - 1} onClick={() => onPage(page + 1)} />
        <PagerButton label="Last page" icon={ChevronsRight} disabled={page >= count - 1} onClick={() => onPage(count - 1)} />
      </div>
    </nav>
  );
}

export function JobsPage({ view, user, onOpenJob, onAddJob, focusSearchSignal }: { view: JobsView; user: CurrentUser; onOpenJob: (id: number) => void; onAddJob: () => void; focusSearchSignal: number }) {
  const [filters, setFilters] = useState<Filters>(() => defaultsFor(view));
  const [showFilters, setShowFilters] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [expandAll, setExpandAll] = useState(false);
  const [deleting, setDeleting] = useState<JobListItem | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<PageSize>(savedPageSize);
  const team = useTeam();
  const remove = useDeleteJob();
  const toast = useToast();
  const searchInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }));

  useEffect(() => {
    setFilters(defaultsFor(view));
    setShowFilters(false);
    setExpanded(new Set());
    setExpandAll(false);
  }, [view]);
  useEffect(() => {
    if (focusSearchSignal > 0) searchInput.current?.focus();
  }, [focusSearchSignal]);

  // Searching costs the host a few milliseconds, so the list follows typing almost at once.
  const typedSearch = useDebounced(filters.q, 50);
  const typedCompany = useDebounced(filters.company, 50);

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

  // A new search, filter or sort starts again from the first page.
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    setPage(0);
  }, [queryKey]);
  const jobs = useJobPage(query, page, pageSize);
  const total = jobs.data?.total;
  // When jobs disappear (deleted, merged), a page past the end moves back to the last one.
  useEffect(() => {
    if (total !== undefined && page > 0 && page * pageSize >= total) setPage(Math.max(0, Math.ceil(total / pageSize) - 1));
  }, [total, page, pageSize]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [page, pageSize, queryKey]);
  const changeSize = (size: PageSize) => {
    // Keeps the first job on screen in view.
    setPage(Math.floor((page * pageSize) / size));
    setPageSize(size);
    localStorage.setItem(PAGE_SIZE_KEY, String(size));
  };

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

  const items = jobs.data?.items ?? [];
  const showList = (total ?? 0) > 0;

  return (
    <div className="flex h-full flex-col">
      <header className="px-5 pb-2.5 pt-4">
        <div className="flex items-center gap-2">
          <h1 className="mr-1 whitespace-nowrap text-[17px] font-semibold leading-tight">{VIEW_TITLES[view]}</h1>
          <span className="inline-flex items-center gap-1 text-[12.5px] tabular-nums text-ink-3" role="status" title={`${(total ?? 0).toLocaleString()} jobs`}>
            <Briefcase className="size-3.5" aria-hidden />
            {total !== undefined ? total.toLocaleString() : ''}
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
            options={sortsFor(view).map(({ value, label, icon }) => ({ value, label: <IconLabel icon={icon}>{label}</IconLabel> }))}
          />
          {view !== 'highlighted' ? <ToolButton active={filters.highlightedOnly} onClick={() => set({ highlightedOnly: !filters.highlightedOnly })} icon={Star} label="Highlighted only" /> : null}
          <ToolButton active={filters.highlightFirst} onClick={() => set({ highlightFirst: !filters.highlightFirst })} icon={ArrowUpToLine} label="Starred first" />
          <ToolButton active={expandAll} onClick={() => setExpandAll(!expandAll)} icon={ChevronsUpDown} label="Show every process" />
          <ToolButton active={showFilters} onClick={() => setShowFilters(!showFilters)} icon={SlidersHorizontal} label="Filters" badge={filterCount} />
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
        {jobs.error && !jobs.data ? (
          <div className="p-5">
            <Notice kind="error" title="Could not load jobs">
              {errorMessage(jobs.error)}
            </Notice>
          </div>
        ) : total === undefined ? (
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
                  <col className="w-[190px]" />
                </>
              ) : null}
              <col className="w-[132px]" />
              <col className="w-[36px]" />
              <col className="w-[36px]" />
              <col className={view === 'mine' ? 'w-[96px]' : 'w-[58px]'} />
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
                    <th className="py-1.5 pr-3">
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
                <th className="py-1.5 pl-1 pr-4 text-right">{view === 'mine' ? <Symbol icon={CalendarCheck} label="Applied" /> : <Symbol icon={Clock} label="Updated" />}</th>
              </tr>
            </thead>
            {items.map((job) => (
              <Row
                key={job.id}
                job={job}
                view={view}
                columnCount={columnCount}
                expanded={expandAll || expanded.has(job.id)}
                canDelete={canDeleteJob(job.applications, user)}
                onToggle={toggle}
                onOpen={onOpenJob}
                onDelete={setDeleting}
              />
            ))}
          </table>
        )}
      </div>
      {showList ? <Pager page={page} size={pageSize} total={total ?? 0} onPage={setPage} onSize={changeSize} /> : null}

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
