import { useCallback, useMemo, useRef, useState } from 'react';
import { CalendarDays, CalendarX2, ChevronLeft, ChevronRight, Pencil, StickyNote, Trash2, User, UserRound, Users, type LucideIcon } from 'lucide-react';
import type { AvatarSubject, InterviewListItem } from '@shared/api';
import { addDays, addMonths, localCalendarDate, monthEnd, monthStart, weekStart } from '@shared/calendar';
import { INTERVIEW_STAGES, type InterviewStage } from '@shared/constants';
import { applicationLabel, Avatar, MiniAvatar, StageBadge } from '@/components/job-bits';
import { STAGE_ICONS, stageStyle, Symbol } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { ANY, Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { errorMessage, useDeleteStep, useInterviews, useTeam } from '@/lib/api';
import { cn, dayBoundary, formatCompactTime, formatDateTime, formatLongDate, formatTime } from '@/lib/utils';
import { StepFormDialog } from './step-form';

type Whose = 'mine' | 'team';

const WHOSE: Array<{ value: Whose; label: string; icon: LucideIcon }> = [
  { value: 'mine', label: 'My interviews', icon: User },
  { value: 'team', label: "The team's interviews", icon: Users }
];

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

// What a day is made of, in pixels: these work out how many interviews fit in it.
const WEEKDAY_ROW = 24;
const DAY_PADDING = 9;
const DATE_ROW = 24;
const CHIP_AND_GAP = 21;

/** Every day from the Monday on or before the 1st to the Sunday on or after the last: whole weeks. */
function monthGrid(month: string): string[] {
  const first = weekStart(month);
  const last = addDays(weekStart(monthEnd(month)), 6);
  const days: string[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}

/** How tall an element is, kept up to date as the window changes. */
function useHeight(): [(element: HTMLElement | null) => void, number] {
  const [height, setHeight] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    observer.current = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.current.observe(element);
  }, []);
  return [ref, height];
}

/** Me in red, everyone else in blue, as on the Team page. */
const ownerLine = (interview: InterviewListItem) => (interview.isMine ? 'var(--me-line)' : 'var(--others-1)');

/** The profile's own picture, then the person's, then the profile's initials. */
const faceOf = (interview: InterviewListItem): AvatarSubject => (interview.profile.avatarVersion || !interview.owner.avatarVersion ? interview.profile : interview.owner);

/**
 * Interviews on a calendar, by the day and time they take place: your own, or the whole team's.
 * Every day is the same size and shows as many as fit, with the number left over beside its date,
 * so a day with ten looks no different from a day with three. The chosen day lists them all, in
 * its own scrolling panel, so the month stays in view however long the list is.
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
  const [gridRef, gridHeight] = useHeight();
  const team = useTeam();
  const remove = useDeleteStep();
  const toast = useToast();

  const days = useMemo(() => monthGrid(month), [month]);
  const weeks = days.length / 7;
  const fits = gridHeight > 0 ? Math.max(1, Math.floor(((gridHeight - WEEKDAY_ROW) / weeks - DAY_PADDING - DATE_ROW) / CHIP_AND_GAP)) : 3;
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
  const now = new Date().toISOString();
  const shownMonth = monthName.format(new Date(`${month}T12:00:00`));

  const go = (months: number) => {
    const next = addMonths(month, months);
    setMonth(next);
    setSelected(next.slice(0, 7) === today.slice(0, 7) ? today : next);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 px-5 pb-2.5 pt-4">
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
        {/* The stages are the calendar's colors too: each is its own key, and pressing one shows only that. */}
        <div className="inline-flex items-center gap-1" role="group" aria-label="Interview stage">
          {INTERVIEW_STAGES.map((value) => {
            const Icon = STAGE_ICONS[value];
            const pressed = stage === value;
            return (
              <Tooltip key={value} content={value}>
                <button
                  type="button"
                  aria-label={value}
                  aria-pressed={pressed}
                  onClick={() => setStage(pressed ? ANY : value)}
                  className={cn('inline-flex size-7 items-center justify-center rounded-full', pressed && 'ring-2 ring-current', stage !== ANY && !pressed && 'opacity-35')}
                  style={stageStyle(value)}
                >
                  <Icon className="size-3.5" aria-hidden />
                </button>
              </Tooltip>
            );
          })}
        </div>
        {whose === 'team' ? (
          <div className="inline-flex items-center">
            {[
              { label: 'You', color: 'var(--me-line)' },
              { label: 'Teammates', color: 'var(--others-1)' }
            ].map(({ label, color }) => (
              <Tooltip key={label} content={label}>
                <span role="img" aria-label={label} tabIndex={0} className="inline-flex h-7 w-4 items-center justify-center">
                  <span className="h-4 w-[3px] rounded-full" style={{ backgroundColor: color }} />
                </span>
              </Tooltip>
            ))}
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <span className="mr-2 inline-flex items-center gap-1 text-[12.5px] tabular-nums text-ink-3" title={`${inMonth.toLocaleString()} in ${shownMonth}`} aria-label={`${inMonth.toLocaleString()} interviews in ${shownMonth}`} data-month-total={inMonth}>
            <CalendarDays className="size-3.5" aria-hidden />
            {inMonth.toLocaleString()}
          </span>
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
          <h2 className="w-[140px] text-center font-semibold" aria-live="polite" data-month={month.slice(0, 7)}>
            {shownMonth}
          </h2>
          <Button size="icon-sm" variant="ghost" aria-label="Next month" onClick={() => go(1)}>
            <ChevronRight />
          </Button>
        </div>
      </header>

      {/* Side by side, each scrolls apart; on a narrow window, one above the other and the page scrolls. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5 xl:flex-row xl:overflow-hidden">
        <div className="flex min-h-[600px] min-w-0 flex-1 flex-col gap-2 xl:min-h-0">
          {interviews.isError ? (
            <Notice kind="error" title="Could not load interviews">
              {errorMessage(interviews.error)}
            </Notice>
          ) : null}
          <div
            ref={gridRef}
            className="grid min-h-0 flex-1 grid-cols-7 overflow-hidden rounded-lg border border-border bg-surface"
            style={{ gridTemplateRows: `${WEEKDAY_ROW}px repeat(${weeks}, minmax(0, 1fr))` }}
            role="grid"
            aria-label={`Interviews in ${shownMonth}`}
            data-calendar={whose}
          >
            {WEEKDAYS.map((name) => (
              <div key={name} role="columnheader" className="flex items-center border-b border-border bg-surface-2/60 px-2 text-[11.5px] font-medium text-ink-3">
                {name}
              </div>
            ))}
            {days.map((day, index) => {
              const list = byDay.get(day) ?? [];
              const outside = day.slice(0, 7) !== month.slice(0, 7);
              const isToday = day === today;
              const isSelected = day === selected;
              const shown = list.slice(0, fits);
              const left = list.length - shown.length;
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
                    'flex min-h-0 min-w-0 flex-col gap-[3px] overflow-hidden border-border p-1 text-left hover:bg-surface-2/50',
                    index % 7 !== 6 && 'border-r',
                    index < days.length - 7 && 'border-b',
                    outside && 'bg-surface-2/30',
                    isSelected && 'outline outline-2 -outline-offset-2 outline-accent'
                  )}
                >
                  <span className="flex h-6 shrink-0 items-center justify-between">
                    <span className={cn('inline-flex size-6 items-center justify-center rounded-full text-[12px] tabular-nums', isToday ? 'bg-accent font-semibold text-accent-ink' : outside ? 'text-ink-3' : 'text-ink-2')}>{Number(day.slice(8))}</span>
                    {left > 0 ? (
                      <span className="rounded-full bg-surface-2 px-1.5 text-[11px] font-semibold tabular-nums leading-[18px] text-ink-2" title={`${list.length} interviews`} data-more={left}>
                        +{left}
                      </span>
                    ) : null}
                  </span>
                  {shown.map((item) => (
                    <span
                      key={item.id}
                      className={cn('flex h-[18px] min-w-0 shrink-0 items-center gap-1 rounded pr-1 text-[11px] leading-4', whose === 'team' ? 'pl-1.5' : 'pl-0.5', outside && 'opacity-55')}
                      style={{ ...stageStyle(item.stage), ...(whose === 'team' ? { boxShadow: `inset 3px 0 0 ${ownerLine(item)}` } : {}) }}
                      title={`${formatTime(item.at)} ${item.stage}: ${item.title}, ${item.company} (${applicationLabel(item)})`}
                      data-interview={item.id}
                    >
                      <MiniAvatar subject={faceOf(item)} />
                      <span className="shrink-0 tabular-nums">{formatCompactTime(item.at)}</span>
                      <span className="truncate">{item.company}</span>
                    </span>
                  ))}
                </button>
              );
            })}
          </div>
        </div>

        <aside className="flex w-full shrink-0 flex-col xl:min-h-0 xl:w-[380px]" aria-label="The chosen day">
          <div className="mb-1.5 flex h-6 shrink-0 items-center gap-2">
            <h2 className="min-w-0 truncate text-[13px] font-semibold" data-selected-day={selected}>
              {formatLongDate(`${selected}T12:00:00`)}
            </h2>
            {chosen.length > 0 ? (
              <span className="rounded-full bg-accent-soft px-1.5 text-[11.5px] font-semibold tabular-nums leading-[18px] text-accent-soft-ink" aria-label={`${chosen.length} interviews`} data-day-total={chosen.length}>
                {chosen.length}
              </span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-surface" data-day-scroll>
            {interviews.isPending && !interviews.data ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : chosen.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-ink-3" role="status" aria-label="No interviews this day">
                <CalendarX2 className="size-7" aria-hidden />
              </div>
            ) : (
              <ul className="divide-y divide-border" data-day-list>
                {chosen.map((interview) => (
                  <li key={interview.id} className="group flex items-center gap-2.5 py-1.5 pl-3 pr-2 hover:bg-surface-2" style={whose === 'team' ? { boxShadow: `inset 3px 0 0 ${ownerLine(interview)}` } : undefined} data-day-row>
                    <span className={cn('w-[62px] shrink-0 whitespace-nowrap text-[12.5px] font-medium tabular-nums', interview.at < now && 'text-ink-3')}>{formatTime(interview.at)}</span>
                    <Avatar subject={faceOf(interview)} label={applicationLabel(interview)} ring={false} />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenJob(interview.jobId)} title={`${interview.title}, ${interview.company}: ${interview.stage}, ${formatDateTime(interview.at)}`}>
                      <p className="truncate font-medium leading-tight">{interview.title}</p>
                      <p className="truncate text-[12px] leading-tight text-ink-2">{interview.company}</p>
                    </button>
                    {interview.note ? <Symbol icon={StickyNote} label={interview.note} className="text-ink-3" size="size-3.5" /> : null}
                    {/* The stage, and on your own, what you can do about it when you point at the row. */}
                    <span className="relative flex h-7 w-[58px] shrink-0 items-center justify-end">
                      <StageBadge stage={interview.stage} className="size-5" />
                      {interview.isMine ? (
                        <span className="absolute inset-0 flex items-center justify-end gap-0.5 bg-surface-2 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                          <Button size="icon-sm" variant="ghost" aria-label="Change interview" onClick={() => setEditing(interview)}>
                            <Pencil />
                          </Button>
                          <Button size="icon-sm" variant="danger-ghost" aria-label="Remove interview" onClick={() => setRemoving(interview)}>
                            <Trash2 />
                          </Button>
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
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
        {removing ? `${removing.stage} at ${removing.company}, ${formatDateTime(removing.at)}.` : null}
      </ConfirmDialog>
    </div>
  );
}
