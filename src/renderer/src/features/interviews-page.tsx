import { useMemo, useState } from 'react';
import { CalendarClock, CalendarDays, History, Infinity as AllTime, Pencil, StickyNote, Trash2, UserRound, type LucideIcon } from 'lucide-react';
import type { InterviewListItem } from '@shared/api';
import { INTERVIEW_STAGES, type InterviewStage } from '@shared/constants';
import { applicationLabel, Avatar } from '@/components/job-bits';
import { JobTags } from '@/components/job-tags';
import { IconLabel, STAGE_ICONS, Symbol } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { Card, EmptyState, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { ANY, Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { errorMessage, useDeleteInterview, useInterviews, useTeam } from '@/lib/api';
import { dayBoundary, formatLongDate, formatTime } from '@/lib/utils';
import { InterviewFormDialog } from './interview-form';

type Range = 'upcoming' | 'past' | 'all';

const RANGES: Array<{ value: Range; label: string; icon: LucideIcon }> = [
  { value: 'upcoming', label: 'Upcoming', icon: CalendarClock },
  { value: 'past', label: 'Past', icon: History },
  { value: 'all', label: 'All', icon: AllTime }
];

const PAGE_SIZE = 300;

export function InterviewsPage({ onOpenJob }: { onOpenJob: (id: number) => void }) {
  const [range, setRange] = useState<Range>('upcoming');
  const [stage, setStage] = useState<string>(ANY);
  const [person, setPerson] = useState<string>(ANY);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [editing, setEditing] = useState<InterviewListItem | null>(null);
  const [removing, setRemoving] = useState<InterviewListItem | null>(null);
  const team = useTeam();
  const remove = useDeleteInterview();
  const toast = useToast();

  const filter = useMemo(() => {
    // Fixed to the minute so that the query key does not change on every render.
    const now = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    return {
      person: person === ANY ? ('all' as const) : Number(person),
      stage: stage === ANY ? undefined : (stage as InterviewStage),
      from: from ? dayBoundary(from, 'start') : range === 'upcoming' ? now : undefined,
      to: to ? dayBoundary(to, 'end') : range === 'past' ? now : undefined,
      limit
    };
  }, [range, person, stage, from, to, limit]);
  const interviews = useInterviews(filter);

  const items = useMemo(() => {
    const list = interviews.data ?? [];
    return range === 'past' ? [...list].reverse() : list;
  }, [interviews.data, range]);

  const groups = useMemo(() => {
    const byDay = new Map<string, InterviewListItem[]>();
    for (const item of items) {
      const day = formatLongDate(item.scheduledAt);
      const list = byDay.get(day);
      if (list) list.push(item);
      else byDay.set(day, [item]);
    }
    return [...byDay.entries()];
  }, [items]);

  return (
    <div className="flex h-full flex-col">
      <header className="px-5 pb-2.5 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-1 text-[17px] font-semibold leading-tight">Interviews</h1>
          <div className="inline-flex rounded-md border border-border-strong p-0.5" role="group" aria-label="Time range">
            {RANGES.map(({ value, label, icon: Icon }) => (
              <Tooltip key={value} content={label}>
                <button
                  type="button"
                  aria-label={label}
                  aria-pressed={range === value}
                  onClick={() => {
                    setRange(value);
                    setLimit(PAGE_SIZE);
                  }}
                  className={`inline-flex size-7 items-center justify-center rounded ${range === value ? 'bg-accent-soft text-accent-soft-ink' : 'text-ink-2 hover:text-ink'}`}
                >
                  <Icon className="size-4" aria-hidden />
                </button>
              </Tooltip>
            ))}
          </div>
          <Select
            ariaLabel="Person"
            className="w-[160px]"
            leading={<UserRound className="size-3.5 text-ink-3" aria-hidden />}
            value={person}
            onChange={setPerson}
            options={[{ value: ANY, label: 'Everyone' }, ...(team.data ?? []).map((member) => ({ value: String(member.user.id), label: member.user.displayName ?? member.user.username }))]}
          />
          <Select
            ariaLabel="Interview stage"
            className="w-[170px]"
            value={stage}
            onChange={setStage}
            options={[{ value: ANY, label: <IconLabel icon={CalendarDays}>Any stage</IconLabel> }, ...INTERVIEW_STAGES.map((value) => ({ value, label: <IconLabel icon={STAGE_ICONS[value]}>{value}</IconLabel> }))]}
          />
          <span className="inline-flex items-center gap-1.5">
            <Input type="date" aria-label="From date" title="From" className="w-[132px]" value={from} onChange={(event) => setFrom(event.target.value)} />
            <span className="text-ink-3">–</span>
            <Input type="date" aria-label="To date" title="To" className="w-[132px]" value={to} onChange={(event) => setTo(event.target.value)} />
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {interviews.isError ? (
          <Notice kind="error" title="Could not load interviews">
            {errorMessage(interviews.error)}
          </Notice>
        ) : interviews.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={CalendarDays} title={range === 'upcoming' ? 'No upcoming interviews' : 'No interviews found'} />
        ) : (
          <div className="space-y-4">
            {groups.map(([day, list]) => (
              // The browser skips laying out days that are off screen.
              <section key={day} style={{ contentVisibility: 'auto', containIntrinsicSize: `auto ${list.length * 50 + 28}px` }}>
                <h2 className="mb-1.5 text-[12.5px] font-semibold text-ink-2">{day}</h2>
                <Card className="divide-y divide-border overflow-hidden">
                  {list.map((interview) => {
                    const StageIcon = STAGE_ICONS[interview.stage];
                    return (
                      <div key={interview.id} className="group flex items-center gap-3 px-4 py-2 hover:bg-surface-2/60">
                        <span className="w-[66px] shrink-0 font-medium tabular-nums">{formatTime(interview.scheduledAt)}</span>
                        <span title={interview.stage}>
                          <StageIcon className="size-4 text-ink-3" aria-label={interview.stage} />
                        </span>
                        <Avatar subject={interview.profile} label={applicationLabel(interview)} ring={false} />
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenJob(interview.jobId)}>
                          <JobTags facts={interview.facts} className="mb-0.5" />
                          <p className="truncate font-medium">{interview.title}</p>
                          <p className="truncate text-[12.5px] text-ink-2">{interview.company}</p>
                        </button>
                        {interview.note ? <Symbol icon={StickyNote} label={interview.note} className="text-ink-3" size="size-3.5" /> : null}
                        {interview.note ? <span className="sr-only">{interview.note}</span> : null}
                        {interview.isMine ? (
                          <div className="flex shrink-0 gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                            <Button size="icon-sm" variant="ghost" aria-label="Edit interview" onClick={() => setEditing(interview)}>
                              <Pencil />
                            </Button>
                            <Button size="icon-sm" variant="danger-ghost" aria-label="Remove interview" onClick={() => setRemoving(interview)}>
                              <Trash2 />
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </Card>
              </section>
            ))}
            {items.length >= limit ? (
              <div className="flex justify-center">
                <Button onClick={() => setLimit(limit + PAGE_SIZE)}>Show more</Button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <InterviewFormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        applicationId={editing?.applicationId ?? 0}
        interview={editing}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="Remove this interview?"
        confirmLabel="Remove"
        danger
        loading={remove.isPending}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate(removing.id, {
            onSuccess: () => setRemoving(null),
            onError: (error) => toast.show(errorMessage(error), 'error')
          });
        }}
      >
        {removing ? `${removing.stage} at ${removing.company}.` : null}
      </ConfirmDialog>
    </div>
  );
}
