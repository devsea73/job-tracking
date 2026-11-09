import { useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Pencil, Trash2, User, UserRound, Users, type LucideIcon } from 'lucide-react';
import type { InterviewListItem } from '@shared/api';
import { addDays, addMonths, localCalendarDate, monthEnd, monthStart, weekStart } from '@shared/calendar';
import { INTERVIEW_STAGES, type InterviewStage } from '@shared/constants';
import { applicationLabel, Avatar, StageBadge } from '@/components/job-bits';
import { JobTags } from '@/components/job-tags';
import { IconLabel, STAGE_ICONS, stageStyle } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Card, EmptyState, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { ANY, Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { errorMessage, useDeleteStep, useInterviews, useTeam } from '@/lib/api';
import { cn, dayBoundary, formatDateTime, formatLongDate, formatTime } from '@/lib/utils';
import { StepFormDialog } from './step-form';

type Whose = 'mine' | 'team';

const WHOSE: Array<{ value: Whose; label: string; icon: LucideIcon }> = [
  { value: 'mine', label: 'My interviews', icon: User },
  { value: 'team', label: "The team's interviews", icon: Users }
];

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SHOWN_PER_DAY = 3;
const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

/** Every day from the Monday on or before the 1st to the Sunday on or after the last: whole weeks. */
function monthGrid(month: string): string[] {
  const first = weekStart(month);
  const last = addDays(weekStart(monthEnd(month)), 6);
  const days: string[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}

/** Me in red, everyone else in blue, as on the Team page. */
const ownerLine = (interview: InterviewListItem) => (interview.isMine ? 'var(--me-line)' : 'var(--others-1)');

/**
 * Interviews on a calendar, by the day and time they take place: your own, or the whole team's.
 * Each is a step on an application's timeline at an interview stage; a day shows the first few,
 * and choosing it lists them all beside the month.
 */
export function InterviewsPage({ onOpenJob }: { onOpenJob: (id: number) => void }) {
  const today = localCalendarDate(new Date());
  const [whose, setWhose] = useState<Whose>('mine');
  const [person, setPerson] = useState<string>(ANY);
  const [stage, setStage] = useState<string>(ANY);
  const [month, setMonth] = useState(monthStart(today));
  const [selected, setSelected] = useState(today);
  const [editing, setEditing] = useState<InterviewListItem | null>(null);
  const [removing, setRemoving] = useState<InterviewListItem | null>(null);
  const team = useTeam();
  const remove = useDeleteStep();
  const toast = useToast();

  const days = useMemo(() => monthGrid(month), [month]);
  const filter = useMemo(
    () => ({
      // Without a person, the host answers with the viewer's own.
      person: whose === 'mine' ? undefined : person === ANY ? ('all' as const) : Number(person),
      stage: stage === ANY ? undefined : (stage as InterviewStage),
      from: dayBoundary(days[0], 'start'),
      to: dayBoundary(days[days.length - 1], 'end'),
      limit: 5_000
    }),
    [whose, person, stage, days]
  );
  const interviews = useInterviews(filter);
  const byDay = useMemo(() => {
    const map = new Map<string, InterviewListItem[]>();
    for (const item of interviews.data ?? []) {
      const day = localCalendarDate(new Date(item.at));
      const list = map.get(day);
      if (list) list.push(item);
      else map.set(day, [item]);
    }
    return map;
  }, [interviews.data]);
  const inMonth = (interviews.data ?? []).filter((item) => localCalendarDate(new Date(item.at)).startsWith(month.slice(0, 7))).length;
  const chosen = byDay.get(selected) ?? [];

  const go = (months: number) => {
    const next = addMonths(month, months);
    setMonth(next);
    setSelected(next.slice(0, 7) === today.slice(0, 7) ? today : next);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="px-5 pb-2.5 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-1 text-[17px] font-semibold leading-tight">Interviews</h1>
          <div className="inline-flex rounded-md border border-border-strong p-0.5" role="group" aria-label="Whose interviews">
            {WHOSE.map(({ value, label, icon: Icon }) => (
              <Tooltip key={value} content={label}>
                <button
                  type="button"
                  aria-label={label}
                  aria-pressed={whose === value}
                  onClick={() => setWhose(value)}
                  className={cn('inline-flex h-7 items-center gap-1.5 rounded px-2 text-[12.5px]', whose === value ? 'bg-accent-soft text-accent-soft-ink' : 'text-ink-2 hover:text-ink')}
                >
                  <Icon className="size-4" aria-hidden />
                  {value === 'mine' ? 'Mine' : 'Team'}
                </button>
              </Tooltip>
            ))}
          </div>
          {whose === 'team' ? (
            <Select
              ariaLabel="Person"
              className="w-[160px]"
              leading={<UserRound className="size-3.5 text-ink-3" aria-hidden />}
              value={person}
              onChange={setPerson}
              options={[{ value: ANY, label: 'Everyone' }, ...(team.data ?? []).map((member) => ({ value: String(member.user.id), label: member.user.displayName ?? member.user.username }))]}
            />
          ) : null}
          <Select
            ariaLabel="Interview stage"
            className="w-[190px]"
            value={stage}
            onChange={setStage}
            options={[{ value: ANY, label: <IconLabel icon={CalendarDays}>Every interview</IconLabel> }, ...INTERVIEW_STAGES.map((value) => ({ value, label: <IconLabel icon={STAGE_ICONS[value]}>{value}</IconLabel> }))]}
          />
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              onClick={() => {
                setMonth(monthStart(today));
                setSelected(today);
              }}
            >
              Today
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label="Previous month" onClick={() => go(-1)}>
              <ChevronLeft />
            </Button>
            <h2 className="w-[150px] text-center font-semibold" aria-live="polite" data-month={month.slice(0, 7)}>
              {monthName.format(new Date(`${month}T12:00:00`))}
            </h2>
            <Button size="icon-sm" variant="ghost" aria-label="Next month" onClick={() => go(1)}>
              <ChevronRight />
            </Button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3">
          <span className="tabular-nums" data-month-total>
            {inMonth === 1 ? '1 interview' : `${inMonth.toLocaleString()} interviews`} this month
          </span>
          {INTERVIEW_STAGES.map((value) => (
            <span key={value} className="inline-flex items-center gap-1">
              <span className="size-2.5 rounded-[3px]" style={{ backgroundColor: stageStyle(value).color as string }} aria-hidden />
              {value}
            </span>
          ))}
          {whose === 'team' ? (
            <>
              <span className="inline-flex items-center gap-1">
                <span className="h-2.5 w-[3px] rounded-full" style={{ backgroundColor: 'var(--me-line)' }} aria-hidden />
                You
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2.5 w-[3px] rounded-full" style={{ backgroundColor: 'var(--others-1)' }} aria-hidden />
                Teammates
              </span>
            </>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-6 xl:flex-row">
        <div className="min-w-0 flex-1">
          {interviews.isError ? (
            <Notice kind="error" title="Could not load interviews">
              {errorMessage(interviews.error)}
            </Notice>
          ) : null}
          <div className="grid grid-cols-7 overflow-hidden rounded-lg border border-border" role="grid" aria-label={`Interviews in ${monthName.format(new Date(`${month}T12:00:00`))}`} data-calendar={whose}>
            {WEEKDAYS.map((name) => (
              <div key={name} role="columnheader" className="border-b border-border bg-surface-2/60 px-2 py-1 text-[11.5px] font-medium text-ink-3">
                {name}
              </div>
            ))}
            {days.map((day, index) => {
              const list = byDay.get(day) ?? [];
              const outside = day.slice(0, 7) !== month.slice(0, 7);
              const isToday = day === today;
              const isSelected = day === selected;
              return (
                <button
                  key={day}
                  type="button"
                  role="gridcell"
                  aria-selected={isSelected}
                  aria-label={`${formatLongDate(`${day}T12:00:00`)}: ${list.length === 0 ? 'no interviews' : list.length === 1 ? '1 interview' : `${list.length} interviews`}`}
                  data-day={day}
                  data-count={list.length}
                  onClick={() => setSelected(day)}
                  className={cn(
                    'flex min-h-[92px] flex-col gap-0.5 border-border p-1 text-left align-top hover:bg-surface-2/50',
                    index % 7 !== 6 && 'border-r',
                    index < days.length - 7 && 'border-b',
                    outside && 'bg-surface-2/30 text-ink-3',
                    isSelected && 'bg-accent-soft/40 outline outline-2 -outline-offset-2 outline-accent'
                  )}
                >
                  <span className={cn('mb-0.5 inline-flex size-6 items-center justify-center rounded-full text-[12px] tabular-nums', isToday ? 'bg-accent font-semibold text-accent-ink' : outside ? 'text-ink-3' : 'text-ink-2')}>{Number(day.slice(8))}</span>
                  {interviews.isPending && !interviews.data ? null : (
                    <>
                      {list.slice(0, SHOWN_PER_DAY).map((item) => (
                        <span
                          key={item.id}
                          className="flex min-w-0 items-center gap-1 truncate rounded px-1 py-px text-[11px] leading-tight"
                          style={{ ...stageStyle(item.stage), ...(whose === 'team' ? { boxShadow: `inset 3px 0 0 ${ownerLine(item)}` } : {}) }}
                          title={`${formatTime(item.at)} ${item.stage}: ${item.title}, ${item.company}${whose === 'team' ? ` (${applicationLabel(item)})` : ''}`}
                          data-interview={item.id}
                        >
                          <span className={cn('shrink-0 tabular-nums', whose === 'team' && 'pl-0.5')}>{formatTime(item.at)}</span>
                          {whose === 'team' ? (
                            <span className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full text-[7.5px] font-semibold text-white" style={{ backgroundColor: item.profile.color }} aria-hidden>
                              {item.profile.initials}
                            </span>
                          ) : null}
                          <span className="truncate">{item.company}</span>
                        </span>
                      ))}
                      {list.length > SHOWN_PER_DAY ? <span className="px-1 text-[11px] font-medium text-ink-2">+{list.length - SHOWN_PER_DAY} more</span> : null}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <aside className="w-full shrink-0 xl:w-[360px]" aria-label="The chosen day">
          <h2 className="mb-1.5 text-[13px] font-semibold" data-selected-day={selected}>
            {formatLongDate(`${selected}T12:00:00`)}
          </h2>
          {interviews.isPending && !interviews.data ? (
            <div className="space-y-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : chosen.length === 0 ? (
            <EmptyState icon={CalendarDays} title="No interviews this day" />
          ) : (
            <Card className="divide-y divide-border overflow-hidden" data-day-list>
              {chosen.map((interview) => (
                <div key={interview.id} className="group flex items-start gap-2.5 px-3 py-2 hover:bg-surface-2/60" style={whose === 'team' ? { boxShadow: `inset 3px 0 0 ${ownerLine(interview)}` } : undefined}>
                  <div className="flex w-[74px] shrink-0 flex-col items-start gap-1 pt-0.5">
                    <span className="whitespace-nowrap font-medium tabular-nums">{formatTime(interview.at)}</span>
                    <StageBadge stage={interview.stage} className="size-5" />
                  </div>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenJob(interview.jobId)} title={`${interview.stage}, ${formatDateTime(interview.at)}`}>
                    <JobTags facts={interview.facts} className="mb-0.5" />
                    <p className="truncate font-medium">{interview.title}</p>
                    <p className="truncate text-[12.5px] text-ink-2">
                      {interview.company} · {interview.stage}
                    </p>
                    {interview.note ? <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-[12px] text-ink-3">{interview.note}</p> : null}
                  </button>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Avatar subject={interview.profile} label={applicationLabel(interview)} ring={false} />
                    {interview.isMine ? (
                      <div className="flex gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                        <Button size="icon-sm" variant="ghost" aria-label="Change interview" onClick={() => setEditing(interview)}>
                          <Pencil />
                        </Button>
                        <Button size="icon-sm" variant="danger-ghost" aria-label="Remove interview" onClick={() => setRemoving(interview)}>
                          <Trash2 />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </Card>
          )}
        </aside>
      </div>

      <StepFormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        applicationId={editing?.applicationId ?? 0}
        step={editing}
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
        {removing ? `${removing.stage} at ${removing.company}, ${formatDateTime(removing.at)}. It comes off the timeline too.` : null}
      </ConfirmDialog>
    </div>
  );
}
