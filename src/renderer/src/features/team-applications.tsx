import { useEffect, useMemo, useState } from 'react';
import { ArrowDownWideNarrow, CalendarClock, ChevronLeft, ChevronRight, ClipboardList, Link2, Search, UserRound, X } from 'lucide-react';
import type { TeamApplication, TeamApplicationSort, TeamApplicationsQuery, TeamBoardRow } from '@shared/api';
import { APPLICATION_STATUSES, type ApplicationStatus } from '@shared/constants';
import { applicationLabel, Avatar, ProcessSteps, userName } from '@/components/job-bits';
import { IconLabel, STATUS_ICONS, statusInk } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { EmptyState, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { ANY, Select } from '@/components/ui/select';
import { errorMessage, useTeamApplications } from '@/lib/api';
import { useCopyLink } from '@/lib/copy-link';
import { cn, formatDateTime, formatShortDate } from '@/lib/utils';
import { count, Panel, percent, Refreshing, share, Toggle, type Filters } from './analytics';

/**
 * Every member's applications, one row each, with where each one stands now. The board on top
 * counts each person's applications by status, the viewer's row first, so their own can be read
 * against everyone else's; a count there narrows the list below to those applications.
 */

const PAGE_SIZE = 50;

const SHORT: Record<ApplicationStatus, string> = {
  Applied: 'Applied',
  'Recruiter Screen': 'Screen',
  'Technical Interview': 'Technical',
  'Final Interview': 'Final',
  Offer: 'Offer',
  Rejected: 'Rejected'
};

const SORTS: Array<{ value: TeamApplicationSort; label: string }> = [
  { value: 'applied', label: 'Applied, newest first' },
  { value: 'stage', label: 'Furthest along first' },
  { value: 'updated', label: 'Recently changed' },
  { value: 'company', label: 'Company name' }
];

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

interface Selection {
  person: number | null;
  status: ApplicationStatus | null;
}

function StatusHead({ status }: { status: ApplicationStatus }) {
  const Icon = STATUS_ICONS[status];
  return (
    <span className="inline-flex items-center gap-1" title={status}>
      <Icon className="size-3.5" style={{ color: statusInk(status) }} aria-hidden />
      {SHORT[status]}
    </span>
  );
}

/** A count that narrows the list to what it counts. Pressed again, it lets go. */
function CountCell({ value, of, selected, label, onClick }: { value: number; of: number; selected: boolean; label: string; onClick: () => void }) {
  return (
    <td className="py-0.5 pr-1 text-right">
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${label}: ${value}. Show these.`}
        title={`${label}. Click to list them.`}
        disabled={value === 0 && !selected}
        onClick={onClick}
        className={cn(
          'inline-flex min-w-[64px] items-baseline justify-end gap-1 rounded px-1.5 py-1 tabular-nums',
          selected ? 'bg-accent-soft font-semibold text-accent-soft-ink' : 'hover:bg-surface-2',
          value === 0 && !selected ? 'cursor-default text-ink-3' : 'text-ink'
        )}
      >
        {count(value)}
        {value > 0 && of > 0 ? <span className="text-[11px] font-normal text-ink-3">{percent(share(value, of))}</span> : null}
      </button>
    </td>
  );
}

function Board({ rows, selection, onSelect }: { rows: TeamBoardRow[]; selection: Selection; onSelect: (next: Selection) => void }) {
  const team = useMemo(() => {
    const statuses = Object.fromEntries(APPLICATION_STATUSES.map((status) => [status, rows.reduce((sum, row) => sum + row.statuses[status], 0)])) as Record<ApplicationStatus, number>;
    const total = rows.reduce((sum, row) => sum + row.total, 0);
    const interviews = rows.reduce((sum, row) => sum + row.interviews, 0);
    return { statuses, total, interviewRate: share(interviews, total) };
  }, [rows]);
  const pick = (person: number | null, status: ApplicationStatus | null) => onSelect(selection.person === person && selection.status === status ? { person: null, status: null } : { person, status });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]" aria-label="Applications by person and where they are now">
        <thead className="text-ink-3">
          <tr className="border-b border-border">
            <th className="py-1 pr-3 text-left font-normal">Person</th>
            {APPLICATION_STATUSES.map((status) => (
              <th key={status} className="py-1 pr-2.5 text-right font-normal">
                <StatusHead status={status} />
              </th>
            ))}
            <th className="py-1 pr-2.5 text-right font-normal">Total</th>
            <th className="py-1 pr-1 text-right font-normal" title="Got an interview: Recruiter Screen or later, or one booked">
              Interview rate
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.user.id} className={cn('border-b border-border', row.isMe && 'bg-accent-soft/40')} data-board-row={row.user.username}>
              <td className="max-w-[180px] py-0.5 pr-3">
                <button
                  type="button"
                  aria-pressed={selection.person === row.user.id && selection.status === null}
                  title={`Show every application by ${userName(row.user)}`}
                  onClick={() => pick(row.user.id, null)}
                  className={cn('flex w-full min-w-0 items-center gap-2 rounded px-1 py-1 text-left hover:bg-surface-2', selection.person === row.user.id && selection.status === null && 'bg-accent-soft text-accent-soft-ink')}
                >
                  <Avatar subject={row.user} label={userName(row.user)} ring={false} />
                  <span className={cn('truncate', row.isMe ? 'font-semibold text-ink' : 'text-ink-2')}>
                    {userName(row.user)}
                    {row.isMe ? <span className="font-normal text-ink-3"> (you)</span> : null}
                    {row.isActive ? null : <span className="font-normal text-ink-3"> (off)</span>}
                  </span>
                </button>
              </td>
              {APPLICATION_STATUSES.map((status) => (
                <CountCell
                  key={status}
                  value={row.statuses[status]}
                  of={row.total}
                  label={`${userName(row.user)}, ${status}`}
                  selected={selection.person === row.user.id && selection.status === status}
                  onClick={() => pick(row.user.id, status)}
                />
              ))}
              <CountCell value={row.total} of={0} label={`${userName(row.user)}, every application`} selected={selection.person === row.user.id && selection.status === null} onClick={() => pick(row.user.id, null)} />
              <td className="py-0.5 pr-1.5 text-right font-semibold tabular-nums text-ink">{percent(row.interviewRate)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border-strong font-semibold">
            <td className="py-0.5 pr-3">
              <button
                type="button"
                aria-pressed={selection.person === null && selection.status === null}
                title="Show everyone's applications"
                onClick={() => onSelect({ person: null, status: null })}
                className={cn('w-full rounded px-1 py-1 text-left hover:bg-surface-2', selection.person === null && selection.status === null && 'bg-accent-soft text-accent-soft-ink')}
              >
                Team
              </button>
            </td>
            {APPLICATION_STATUSES.map((status) => (
              <CountCell key={status} value={team.statuses[status]} of={team.total} label={`Everyone, ${status}`} selected={selection.person === null && selection.status === status} onClick={() => pick(null, status)} />
            ))}
            <CountCell value={team.total} of={0} label="Everyone, every application" selected={selection.person === null && selection.status === null} onClick={() => onSelect({ person: null, status: null })} />
            <td className="py-0.5 pr-1.5 text-right tabular-nums">{percent(team.interviewRate)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="mt-1.5 text-[11.5px] text-ink-3">Where each application stands now, with its share of that person&apos;s applications. Click a number to list those applications.</p>
    </div>
  );
}

function ApplicationRow({ application, onOpen }: { application: TeamApplication; onOpen: (jobId: number) => void }) {
  const copy = useCopyLink();
  const { job } = application;
  return (
    <tr
      tabIndex={0}
      data-team-application={application.id}
      onClick={() => onOpen(job.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) onOpen(job.id);
      }}
      className={cn('border-b border-border hover:bg-surface-2/60 focus-visible:bg-surface-2/60', application.isMine && 'bg-accent-soft/25')}
    >
      <td className="whitespace-nowrap py-1.5 pl-3 pr-3 tabular-nums text-ink-2" title={`Applied ${formatDateTime(application.appliedAt)}`}>
        {formatShortDate(application.appliedAt)}
      </td>
      <td className="py-1.5 pr-3">
        {/* Who first: the person is what this list compares; the profile follows when it says more. */}
        <span className="flex min-w-0 items-center gap-1.5" title={applicationLabel(application)}>
          <Avatar subject={application.profile} label={applicationLabel(application)} ring={false} />
          <span className="truncate">
            <span className={application.isMine ? 'font-medium text-ink' : 'text-ink'}>
              {userName(application.owner)}
              {application.isMine ? <span className="font-normal text-ink-3"> (you)</span> : null}
            </span>
            {application.profile.name !== userName(application.owner) ? <span className="text-ink-3"> · {application.profile.name}</span> : null}
          </span>
        </span>
      </td>
      <td className="truncate py-1.5 pr-3 font-medium" title={job.company}>
        {job.company}
      </td>
      <td className="truncate py-1.5 pr-3" title={job.location ? `${job.title} · ${job.location}` : job.title}>
        {job.title}
      </td>
      <td className="py-1.5 pr-3">
        <ProcessSteps status={application.status} furthest={application.furthestStage} />
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-[12px]" style={{ color: statusInk(application.status) }} data-status>
        {SHORT[application.status]}
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 text-[12px] tabular-nums text-ink-2">
        {application.nextInterviewAt ? (
          <span className="inline-flex items-center gap-1" title={`Next interview ${formatDateTime(application.nextInterviewAt)}`}>
            <CalendarClock className="size-3.5 text-ink-3" aria-hidden />
            {formatShortDate(application.nextInterviewAt)}
          </span>
        ) : application.interviewCount > 0 ? (
          <span title={`${application.interviewCount} interviews, none coming up`}>{application.interviewCount} held</span>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </td>
      <td className="py-1.5 pr-2 text-center">
        {application.link ? (
          <Tooltip content={`Copy the link it was added with\n${application.link.url}`}>
            <button
              type="button"
              aria-label={`Copy the link ${application.link.url}`}
              className="inline-flex size-6 items-center justify-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink"
              onClick={(event) => {
                event.stopPropagation();
                copy(application.link?.url ?? '');
              }}
            >
              <Link2 className="size-3.5" aria-hidden />
            </button>
          </Tooltip>
        ) : null}
      </td>
    </tr>
  );
}

export function TeamApplications({ filters, onOpenJob }: { filters: Filters; onOpenJob: (jobId: number) => void }) {
  const [span, setSpan] = useState<'all' | 'range'>('all');
  const [selection, setSelection] = useState<Selection>({ person: null, status: null });
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<TeamApplicationSort>('applied');
  const typed = useDebounced(search.trim(), 150);

  const base = useMemo<TeamApplicationsQuery>(
    () => ({
      ...(span === 'range' ? { tz: filters.tz, from: filters.range.first, to: filters.range.last } : {}),
      person: selection.person ?? undefined,
      status: selection.status ?? undefined,
      q: typed || undefined,
      sort
    }),
    [span, filters.tz, filters.range.first, filters.range.last, selection, typed, sort]
  );
  // A page belongs to the filters it was turned to under: change them, and the list starts at the top.
  const filterKey = JSON.stringify(base);
  const [paging, setPaging] = useState({ key: filterKey, page: 0 });
  const page = paging.key === filterKey ? paging.page : 0;
  const setPage = (next: number) => setPaging({ key: filterKey, page: next });
  const query = useMemo(() => ({ ...base, limit: PAGE_SIZE, offset: page * PAGE_SIZE }), [base, page]);

  const result = useTeamApplications(query);
  const data = result.data;
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Applications removed meanwhile can leave this page past the end: step back to the last there is.
  const answered = !!data && !result.isPlaceholderData;
  useEffect(() => {
    if (answered && page > pages - 1) setPaging({ key: filterKey, page: pages - 1 });
  }, [answered, page, pages, filterKey]);
  const first = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const last = Math.min(total, (page + 1) * PAGE_SIZE);
  const people = data?.board ?? [];
  const chosen = people.find((row) => row.user.id === selection.person);
  const scopeName = span === 'all' ? 'All time' : `${filters.rangeName} · ${filters.label}`;
  const filtered = selection.person !== null || selection.status !== null || !!typed;

  return (
    <Panel
      title={`Everyone's applications · ${scopeName}`}
      icon={ClipboardList}
      aside={
        <Toggle
          label="Applications from"
          value={span}
          onChange={setSpan}
          options={[
            { value: 'all', label: 'All time' },
            { value: 'range', label: filters.rangeName, title: `Applied ${filters.label}` }
          ]}
        />
      }
    >
      {result.isError && !data ? (
        <div className="p-3.5">
          <Notice kind="error" title="Could not load the applications">
            {errorMessage(result.error)}
          </Notice>
        </div>
      ) : !data ? (
        <div className="space-y-2 p-3.5">
          <Skeleton className="h-32" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        <Refreshing active={result.isPlaceholderData}>
          <div className="px-3.5 pb-1 pt-2">
            <Board rows={people} selection={selection} onSelect={setSelection} />
          </div>

          <div className="flex flex-wrap items-center gap-2 border-y border-border bg-surface-2/40 px-3.5 py-2">
            <Select
              ariaLabel="Person"
              className="w-[170px]"
              leading={<UserRound className="size-3.5 text-ink-3" aria-hidden />}
              value={selection.person === null ? ANY : String(selection.person)}
              onChange={(value) => setSelection({ ...selection, person: value === ANY ? null : Number(value) })}
              options={[{ value: ANY, label: 'Everyone' }, ...people.map((row) => ({ value: String(row.user.id), label: `${userName(row.user)}${row.isMe ? ' (you)' : ''}` }))]}
            />
            <Select
              ariaLabel="Status"
              className="w-[190px]"
              value={selection.status ?? ANY}
              onChange={(value) => setSelection({ ...selection, status: value === ANY ? null : (value as ApplicationStatus) })}
              options={[{ value: ANY, label: 'Any status' }, ...APPLICATION_STATUSES.map((value) => ({ value, label: <IconLabel icon={STATUS_ICONS[value]}>{value}</IconLabel> }))]}
            />
            <div className="relative min-w-[160px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
              <Input aria-label="Search applications" className="pl-8" placeholder="Company, title or profile" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <Select
              ariaLabel="Sort applications"
              className="w-[200px]"
              leading={<ArrowDownWideNarrow className="size-3.5 text-ink-3" aria-hidden />}
              value={sort}
              onChange={(value) => setSort(value as TeamApplicationSort)}
              options={SORTS.map((option) => ({ value: option.value, label: option.label }))}
            />
            {filtered ? (
              <Tooltip content="Clear filters">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Clear filters"
                  onClick={() => {
                    setSelection({ person: null, status: null });
                    setSearch('');
                  }}
                >
                  <X />
                </Button>
              </Tooltip>
            ) : null}
            <span className="ml-auto text-[12px] tabular-nums text-ink-3" role="status" data-team-application-count>
              {count(total)} {total === 1 ? 'application' : 'applications'}
              {chosen ? ` by ${userName(chosen.user)}` : ''}
              {selection.status ? ` · ${selection.status}` : ''}
            </span>
          </div>

          {data.items.length === 0 ? (
            <EmptyState icon={ClipboardList} title={filtered ? 'Nothing matches these filters' : span === 'all' ? 'Nobody has applied yet' : `Nobody applied · ${filters.rangeName.toLowerCase()}`} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1020px] table-fixed text-[12.5px]">
                <colgroup>
                  <col className="w-[84px]" />
                  <col className="w-[230px]" />
                  <col className="w-[170px]" />
                  <col />
                  <col className="w-[176px]" />
                  <col className="w-[78px]" />
                  <col className="w-[92px]" />
                  <col className="w-[36px]" />
                </colgroup>
                <thead className="text-left text-ink-3">
                  <tr className="border-b border-border [&>th]:py-1.5 [&>th]:font-normal">
                    <th className="pl-3 pr-3">Applied</th>
                    <th className="pr-3">Person · profile</th>
                    <th className="pr-3">Company</th>
                    <th className="pr-3">Job title</th>
                    <th className="pr-3">Process</th>
                    <th className="pr-3">Now</th>
                    <th className="pr-3">Interview</th>
                    <th aria-label="Link" />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((application) => (
                    <ApplicationRow key={application.id} application={application} onOpen={onOpenJob} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {total > PAGE_SIZE ? (
            <nav aria-label="Pages of applications" className="flex items-center gap-1 px-3.5 py-1.5">
              <span className="text-[12px] tabular-nums text-ink-3">
                {count(first)}–{count(last)} of {count(total)}
              </span>
              <span className="ml-auto text-[12px] tabular-nums text-ink-3">
                Page {page + 1} of {pages}
              </span>
              <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page === 0} onClick={() => setPage(page - 1)}>
                <ChevronLeft />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
                <ChevronRight />
              </Button>
            </nav>
          ) : null}
        </Refreshing>
      )}
    </Panel>
  );
}
