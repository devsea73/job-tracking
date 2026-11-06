import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, BarChart3, CalendarClock, CalendarDays, Inbox, Send, Table2, Trophy, type LucideIcon } from 'lucide-react';
import type { ActivityPerson, ActivityResponse, JobListItem } from '@shared/api';
import { Avatar, AvatarStack, asUserSubject, StatusBadge, userName } from '@/components/job-bits';
import { JobTags } from '@/components/job-tags';
import { STAGE_ICONS } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Card, EmptyState, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { errorMessage, useActivity, useDashboard } from '@/lib/api';
import { cn, formatDateTime, formatShortAgo } from '@/lib/utils';
import type { Page } from '../App';

// ---- Date ranges, in this computer's own days -------------------------------------------------

type Preset = 'today' | 'yesterday' | 'week' | 'last7' | 'month' | 'last30' | 'custom';

const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'This week' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'month', label: 'This month' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom' }
];

const RANGE_KEY = 'jobTracker.dashboardRange';

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const dayInput = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const fromInput = (value: string) => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
};

interface Bounds {
  from: Date;
  /** Exclusive: the start of the day after the range. */
  to: Date;
  day: Date;
  week: Date;
  month: Date;
}

function boundsFor(preset: Preset, custom: { from: string; to: string }, now: Date): Bounds {
  const today = startOfDay(now);
  // Weeks start on Monday.
  const week = addDays(today, -((today.getDay() + 6) % 7));
  const month = new Date(today.getFullYear(), today.getMonth(), 1);
  const shared = { day: today, week, month };
  switch (preset) {
    case 'yesterday':
      return { ...shared, from: addDays(today, -1), to: today };
    case 'week':
      return { ...shared, from: week, to: addDays(week, 7) };
    case 'last7':
      return { ...shared, from: addDays(today, -6), to: addDays(today, 1) };
    case 'month':
      return { ...shared, from: month, to: new Date(month.getFullYear(), month.getMonth() + 1, 1) };
    case 'last30':
      return { ...shared, from: addDays(today, -29), to: addDays(today, 1) };
    case 'custom': {
      const from = custom.from ? fromInput(custom.from) : today;
      const last = custom.to ? fromInput(custom.to) : today;
      return { ...shared, from, to: addDays(last < from ? from : last, 1) };
    }
    default:
      return { ...shared, from: today, to: addDays(today, 1) };
  }
}

const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const shortDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

const weekdayDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function rangeLabel(bounds: Bounds): string {
  const last = addDays(bounds.to, -1);
  if (last.getTime() === bounds.from.getTime()) return dayLabel.format(bounds.from);
  const sameYear = bounds.from.getFullYear() === last.getFullYear();
  return `${sameYear ? weekdayDay.format(bounds.from) : dayLabel.format(bounds.from)} – ${dayLabel.format(last)}`;
}

interface Buckets {
  unit: 'hour' | 'day';
  /** Where each bucket starts, in this computer's time. */
  starts: Date[];
}

/** Hours for one day, days for longer, stepped in local time so daylight saving time lands right. */
function bucketsFor(bounds: Bounds): Buckets {
  const oneDay = addDays(bounds.from, 1).getTime() >= bounds.to.getTime();
  const starts: Date[] = [];
  if (oneDay) {
    for (let hour = 0; hour < 24; hour += 1) {
      const start = new Date(bounds.from.getFullYear(), bounds.from.getMonth(), bounds.from.getDate(), hour);
      if (start < bounds.to) starts.push(start);
    }
  } else {
    for (let day = bounds.from; day < bounds.to && starts.length < 400; day = addDays(day, 1)) starts.push(day);
  }
  return { unit: oneDay ? 'hour' : 'day', starts };
}

/** A person's counts per bucket, from the server's UTC hours. */
function valuesFor(person: ActivityPerson, buckets: Buckets): number[] {
  const values = new Array<number>(buckets.starts.length).fill(0);
  const ends = buckets.starts.map((start, index) => buckets.starts[index + 1]?.getTime() ?? (buckets.unit === 'hour' ? start.getTime() + 3_600_000 : addDays(start, 1).getTime()));
  for (const [hour, total] of person.hours) {
    const at = Date.parse(`${hour}:00:00.000Z`);
    // Half-hour time zones put an hour across two buckets; its middle decides.
    const middle = at + 1_800_000;
    const index = buckets.starts.findIndex((start, position) => middle >= start.getTime() && middle < ends[position]);
    if (index >= 0) values[index] += total;
    else if (at >= buckets.starts[0]?.getTime()) values[values.length - 1] += total;
  }
  return values;
}

/** The current minute: "today" turns over at midnight without a reload. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function loadRange(): { preset: Preset; from: string; to: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(RANGE_KEY) ?? 'null') as { preset: Preset; from: string; to: string } | null;
    if (saved && PRESETS.some((item) => item.value === saved.preset)) return saved;
  } catch {
    // A bad saved value just means the default range.
  }
  return { preset: 'today', from: '', to: '' };
}

// ---- One color per person, kept whatever the ranking ----------------------------------------

const SERIES = 8;
/** Colors go by who the person is, never by rank, so a color means the same person on every chart. */
function colorsFor(people: ActivityPerson[]): Map<number, string> {
  const ids = [...people].map((person) => person.user.id).sort((a, b) => a - b);
  return new Map(ids.map((id, index) => [id, `var(--series-${(index % SERIES) + 1})`]));
}

function percent(person: Pick<ActivityPerson, 'interviewRate'>): string {
  return person.interviewRate === null ? '–' : `${person.interviewRate.toFixed(person.interviewRate % 1 === 0 ? 0 : 1)}%`;
}

// ---- Pieces --------------------------------------------------------------------------------

function Kpi({ label, value, detail, emphasis }: { label: string; value: string | number | undefined; detail?: string; emphasis?: boolean }) {
  return (
    <div className={cn('min-w-0 rounded-lg border bg-surface px-3.5 py-2.5', emphasis ? 'border-accent' : 'border-border')} data-kpi={label}>
      <p className="truncate text-[12px] text-ink-3">{label}</p>
      {value === undefined ? <Skeleton className="mt-1 h-7 w-12" /> : <p className="text-[24px] font-semibold leading-tight tabular-nums">{typeof value === 'number' ? value.toLocaleString() : value}</p>}
      {detail ? <p className="truncate text-[11.5px] text-ink-3">{detail}</p> : null}
    </div>
  );
}

function PersonCard({ person, color, top, rangeName, people }: { person: ActivityPerson; color: string; top: number; rangeName: string; people: number }) {
  const name = userName(person.user);
  const share = top > 0 ? (person.inRange / top) * 100 : 0;
  return (
    <li
      data-person-card={person.user.username}
      className={cn('flex flex-col gap-2 rounded-lg border bg-surface p-3', person.isMe ? 'border-accent ring-1 ring-accent/30' : 'border-border')}
      title={person.profiles.length ? person.profiles.map((profile) => `${profile.name}: ${profile.count}`).join('\n') : undefined}
    >
      <div className="flex items-center gap-2">
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        <Avatar subject={asUserSubject(person.user)} label={name} ring={false} />
        <p className="min-w-0 flex-1 truncate font-medium">
          {name}
          {person.isMe ? <span className="ml-1 text-[12px] font-normal text-ink-3">(you)</span> : null}
        </p>
        <span
          className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11.5px] font-semibold tabular-nums', person.rank === 1 && person.inRange > 0 ? 'bg-warning-soft text-warning-ink' : 'bg-surface-2 text-ink-2')}
          title={`Rank ${person.rank} of ${people} by applications ${rangeName.toLowerCase()}`}
        >
          {person.rank === 1 && person.inRange > 0 ? <Trophy className="size-3" aria-hidden /> : null}#{person.rank}
        </span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div>
          <p className="text-[26px] font-semibold leading-none tabular-nums" data-range-count>
            {person.inRange.toLocaleString()}
          </p>
          <p className="mt-1 text-[11.5px] text-ink-3">{rangeName}</p>
        </div>
        <p className="text-right text-[11.5px] text-ink-3">{person.behindLeader ? `${person.behindLeader.toLocaleString()} behind #1` : person.inRange > 0 ? 'Leading' : ''}</p>
      </div>
      {/* Share of the leader's count: who is ahead, at a glance. */}
      <div className="h-1.5 rounded-full bg-surface-2" aria-hidden>
        <div className="h-full rounded-full" style={{ width: `${share}%`, backgroundColor: color }} />
      </div>
      <dl className="grid grid-cols-4 gap-1 text-center text-[11.5px]">
        {[
          ['Today', person.today.toLocaleString()],
          ['Week', person.week.toLocaleString()],
          ['Month', person.month.toLocaleString()],
          ['Interview', percent(person)]
        ].map(([label, value]) => (
          <div key={label} className="rounded bg-surface-2 py-1">
            <dt className="text-ink-3">{label}</dt>
            <dd className="font-semibold tabular-nums text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[11.5px] text-ink-3">
        Interviews: {person.interviews.toLocaleString()} of {person.inRange.toLocaleString()} applied
      </p>
    </li>
  );
}

/** Rounded axis tops: 4, 10, 25, 60… */
function niceMax(value: number): number {
  if (value <= 4) return Math.max(1, Math.ceil(value));
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (value <= step * magnitude) return step * magnitude;
  return 10 * magnitude;
}

function bucketLabel(start: Date, unit: Buckets['unit']): string {
  if (unit === 'hour') return `${String(start.getHours()).padStart(2, '0')}:00`;
  return shortDay.format(start);
}

interface Series {
  key: string;
  name: string;
  color: string;
  values: number[];
  total: number;
  isMe: boolean;
}

/** Applications per hour or day, one line per person. Eight people at most; the rest are summed. */
function seriesFor(data: ActivityResponse, buckets: Buckets, colors: Map<number, string>): Series[] {
  const ranked = [...data.people].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const shown = ranked.length > SERIES ? [...ranked.filter((person) => person.isMe), ...ranked.filter((person) => !person.isMe)].slice(0, SERIES - 1) : ranked;
  const rest = ranked.filter((person) => !shown.includes(person));
  const series = shown.map((person) => ({ key: String(person.user.id), name: userName(person.user), color: colors.get(person.user.id) as string, values: valuesFor(person, buckets), total: person.inRange, isMe: person.isMe }));
  if (rest.length) {
    const restValues = rest.map((person) => valuesFor(person, buckets));
    const values = buckets.starts.map((_, index) => restValues.reduce((sum, list) => sum + list[index], 0));
    series.push({ key: 'others', name: `${rest.length} others`, color: 'var(--ink-3)', values, total: values.reduce((a, b) => a + b, 0), isMe: false });
  }
  return series;
}

function LineChart({ buckets, series }: { buckets: Buckets; series: Series[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  const height = 220;
  const margin = { top: 10, right: 12, bottom: 26, left: 34 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const count = buckets.starts.length;
  const top = niceMax(Math.max(0, ...series.flatMap((item) => item.values)));
  const x = (index: number) => margin.left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const y = (value: number) => margin.top + plotHeight - (value / top) * plotHeight;
  const ticks = [0, top / 4, top / 2, (top * 3) / 4, top].filter((value, index, all) => Number.isInteger(value) && all.indexOf(value) === index);
  const every = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(plotWidth / 56))));

  const pointAt = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || count === 0) return null;
    const ratio = (clientX - rect.left - margin.left) / plotWidth;
    return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
  };

  return (
    <div ref={box} className="relative" onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-label={`Applications per ${buckets.unit}, by person`} onMouseMove={(event) => setHover(pointAt(event.clientX))}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeWidth={1} />
            <text x={margin.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--ink-3)">
              {tick}
            </text>
          </g>
        ))}
        {buckets.starts.map((start, index) =>
          (index % every === 0 && count - 1 - index >= every / 2) || index === count - 1 ? (
            <text key={start.getTime()} x={x(index)} y={height - 8} textAnchor={index === 0 && count > 1 ? 'start' : index === count - 1 && count > 1 ? 'end' : 'middle'} fontSize={11} fill="var(--ink-3)">
              {bucketLabel(start, buckets.unit)}
            </text>
          ) : null
        )}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={margin.top} y2={margin.top + plotHeight} stroke="var(--border-strong)" strokeWidth={1} /> : null}
        {/* The viewer's own line is drawn last, so it is never hidden under someone else's. */}
        {[...series].sort((a, b) => Number(a.isMe) - Number(b.isMe)).map((item) => (
          <g key={item.key}>
            <path d={item.values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(value)}`).join(' ')} fill="none" stroke={item.color} strokeWidth={item.isMe ? 2.5 : 2} strokeLinejoin="round" strokeLinecap="round" />
            {count === 1 ? <circle cx={x(0)} cy={y(item.values[0] ?? 0)} r={4} fill={item.color} /> : null}
            {hover !== null ? <circle cx={x(hover)} cy={y(item.values[hover] ?? 0)} r={4} fill={item.color} stroke="var(--surface)" strokeWidth={2} /> : null}
          </g>
        ))}
      </svg>
      {hover !== null ? (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-md border border-border bg-surface px-2.5 py-2 text-[12px] shadow-lg"
          style={{ left: Math.min(Math.max(0, x(hover) + 12), width - 170) }}
          role="status"
        >
          <p className="mb-1 font-medium text-ink">{buckets.unit === 'hour' ? `${dayLabel.format(buckets.starts[hover])}, ${bucketLabel(buckets.starts[hover], 'hour')}` : dayLabel.format(buckets.starts[hover])}</p>
          {[...series]
            .sort((a, b) => (b.values[hover] ?? 0) - (a.values[hover] ?? 0))
            .map((item) => (
              <p key={item.key} className="flex items-center gap-1.5 text-ink-2">
                <span className="size-2 rounded-full" style={{ backgroundColor: item.color }} aria-hidden />
                <span className="flex-1 truncate">{item.name}</span>
                <span className="font-semibold tabular-nums text-ink">{item.values[hover] ?? 0}</span>
              </p>
            ))}
        </div>
      ) : null}
    </div>
  );
}

function SeriesTable({ buckets, series }: { buckets: Buckets; series: Series[] }) {
  return (
    <div className="max-h-[260px] overflow-auto">
      <table className="w-full text-[12.5px] tabular-nums">
        <thead className="sticky top-0 bg-surface text-ink-3">
          <tr>
            <th className="py-1 pr-3 text-left font-normal">{buckets.unit === 'hour' ? 'Hour' : 'Day'}</th>
            {series.map((item) => (
              <th key={item.key} className="py-1 pr-3 text-right font-normal">
                {item.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {buckets.starts.map((start, index) => (
            <tr key={start.getTime()}>
              <td className="py-1 pr-3">{bucketLabel(start, buckets.unit)}</td>
              {series.map((item) => (
                <td key={item.key} className="py-1 pr-3 text-right">
                  {item.values[index] ?? 0}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One fixed 0–100% scale, so people compare directly; the count behind each rate is shown. */
function InterviewRates({ people }: { people: ActivityPerson[] }) {
  return (
    <ul className="space-y-2.5" aria-label="Interview rate by person">
      {people.map((person) => (
        <li key={person.user.id} className="grid grid-cols-[minmax(0,130px)_1fr_104px] items-center gap-2.5" data-interview-rate={person.user.username}>
          <span className={cn('truncate text-[12.5px]', person.isMe ? 'font-semibold text-ink' : 'text-ink-2')}>{userName(person.user)}</span>
          <div className="h-3 rounded-[4px] bg-surface-2" title={`${person.interviews} of ${person.inRange} applications got an interview`}>
            {person.interviewRate ? <div className="h-full rounded-r-[4px] bg-accent" style={{ width: `${Math.min(100, person.interviewRate)}%` }} /> : null}
          </div>
          <span className="whitespace-nowrap text-right text-[12.5px] tabular-nums">
            <span className="font-semibold text-ink">{percent(person)}</span>
            <span className="ml-1.5 text-ink-3">
              {person.interviews}/{person.inRange}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Panel({ title, icon: Icon, onViewAll, children, actions }: { title: string; icon: LucideIcon; onViewAll?: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-10 items-center justify-between gap-2 border-b border-border pl-4 pr-1.5">
        <h2 className="flex items-center gap-2 text-[13px] font-medium text-ink-2">
          <Icon className="size-4 text-ink-3" aria-hidden />
          {title}
        </h2>
        <div className="flex items-center gap-1">
          {actions}
          {onViewAll ? (
            <Tooltip content="View all">
              <Button size="icon-sm" variant="ghost" aria-label={`View all: ${title}`} onClick={onViewAll}>
                <ArrowRight />
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </div>
      {children}
    </Card>
  );
}

function JobLine({ job, onOpen }: { job: JobListItem; onOpen: (id: number) => void }) {
  const mine = job.applications.filter((application) => application.isMine);
  const applied = mine.map((application) => application.appliedAt).sort()[0] ?? job.createdAt;
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(job.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onOpen(job.id);
        }}
        className="flex items-center gap-3 px-4 py-2 hover:bg-surface-2/60"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{job.title}</p>
          <p className="truncate text-[12.5px] text-ink-2">{job.company}</p>
        </div>
        {mine.length === 1 ? <StatusBadge status={mine[0].status} /> : null}
        <AvatarStack applications={job.applications} />
        <span className="w-9 shrink-0 text-right text-[12px] tabular-nums text-ink-3" title={`Applied ${formatDateTime(applied)}`}>
          {formatShortAgo(applied)}
        </span>
      </div>
    </li>
  );
}

// ---- The page ------------------------------------------------------------------------------

export function DashboardPage({ onOpenJob, onNavigate, onAddJob }: { onOpenJob: (id: number) => void; onNavigate: (page: Page) => void; onAddJob: () => void }) {
  const now = useNow();
  const [range, setRange] = useState(loadRange);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const bounds = useMemo(() => boundsFor(range.preset, range, now), [range, now]);
  const activity = useActivity({
    from: bounds.from.toISOString(),
    to: bounds.to.toISOString(),
    day: bounds.day.toISOString(),
    week: bounds.week.toISOString(),
    month: bounds.month.toISOString()
  });
  const dashboard = useDashboard();
  const data = activity.data;
  const me = data?.people.find((person) => person.isMe);
  const colors = useMemo(() => colorsFor(data?.people ?? []), [data]);
  const buckets = useMemo(() => bucketsFor(bounds), [bounds]);
  const series = useMemo(() => (data ? seriesFor(data, buckets, colors) : []), [data, buckets, colors]);
  const top = Math.max(0, ...(data?.people.map((person) => person.inRange) ?? [0]));
  const rangeName = PRESETS.find((item) => item.value === range.preset)?.label ?? 'In range';
  const label = rangeLabel(bounds);

  const choose = (next: typeof range) => {
    setRange(next);
    try {
      localStorage.setItem(RANGE_KEY, JSON.stringify(next));
    } catch {
      // Not remembering the range only means starting on Today next time.
    }
  };

  return (
    <div className="h-full overflow-y-auto px-5 pb-8 pt-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-[17px] font-semibold leading-tight">Dashboard</h1>
        <div className="inline-flex flex-wrap rounded-md border border-border-strong p-0.5" role="group" aria-label="Date range">
          {PRESETS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={range.preset === item.value}
              onClick={() => choose({ ...range, preset: item.value, from: range.from || dayInput(bounds.from), to: range.to || dayInput(addDays(bounds.to, -1)) })}
              className={cn('h-7 rounded px-2.5 text-[12.5px]', range.preset === item.value ? 'bg-accent-soft font-medium text-accent-soft-ink' : 'text-ink-2 hover:text-ink')}
            >
              {item.label}
            </button>
          ))}
        </div>
        {range.preset === 'custom' ? (
          <span className="inline-flex items-center gap-1.5">
            <Input type="date" aria-label="From" className="h-8 w-[136px]" value={range.from} max={range.to || undefined} onChange={(event) => choose({ ...range, from: event.target.value })} />
            <span className="text-ink-3">–</span>
            <Input type="date" aria-label="To" className="h-8 w-[136px]" value={range.to} min={range.from || undefined} onChange={(event) => choose({ ...range, to: event.target.value })} />
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-3" data-range-label>
          <CalendarDays className="size-3.5" aria-hidden />
          {label}
        </span>
      </div>

      {activity.isError ? (
        <Notice kind="error" title="Could not load the numbers" className="mb-3">
          {errorMessage(activity.error)}
        </Notice>
      ) : null}

      {/* Mine first: what I did today, this week, this month, and in the range chosen. */}
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Applied today" value={me?.today} emphasis={range.preset === 'today'} />
        <Kpi label="This week" value={me?.week} detail="Since Monday" emphasis={range.preset === 'week'} />
        <Kpi label="This month" value={me?.month} emphasis={range.preset === 'month'} />
        {/* A range the first three already show would only repeat a number: the total is shown instead. */}
        {['today', 'week', 'month'].includes(range.preset) ? <Kpi label="All time" value={me?.allTime} /> : <Kpi label={rangeName} value={me?.inRange} detail={label} emphasis />}
        <Kpi label="Interview rate" value={me ? percent(me) : undefined} detail={me ? `${me.interviews} of ${me.inRange} got an interview` : undefined} />
        <Kpi label="My rank" value={me ? `#${me.rank}` : undefined} detail={me ? (me.behindLeader ? `${me.behindLeader} behind #1 of ${data?.people.length}` : `of ${data?.people.length}`) : undefined} />
      </div>

      <div className="mt-3" />
      <Panel title={`Applications by person · ${rangeName}`} icon={Trophy}>
        <div className="p-3">
          {!data ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <ol className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5" aria-label="People by applications">
              {data.people.map((person) => (
                <PersonCard key={person.user.id} person={person} color={colors.get(person.user.id) as string} top={top} rangeName={rangeName} people={data.people.length} />
              ))}
            </ol>
          )}
        </div>
      </Panel>

      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel
          title={`Applications per ${buckets.unit} · ${label}`}
          icon={BarChart3}
          actions={
            <Tooltip content={view === 'chart' ? 'Show as a table' : 'Show as a chart'}>
              <Button size="icon-sm" variant="ghost" aria-label={view === 'chart' ? 'Show as a table' : 'Show as a chart'} onClick={() => setView(view === 'chart' ? 'table' : 'chart')}>
                {view === 'chart' ? <Table2 /> : <BarChart3 />}
              </Button>
            </Tooltip>
          }
        >
          <div className="px-3 pb-3 pt-2">
            {!data ? (
              <Skeleton className="h-[220px] w-full" />
            ) : view === 'table' ? (
              <SeriesTable buckets={buckets} series={series} />
            ) : (
              <>
                <LineChart buckets={buckets} series={series} />
                <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2" aria-label="Legend">
                  {series.map((item) => (
                    <li key={item.key} className="inline-flex items-center gap-1.5">
                      <span className="h-0.5 w-3.5 rounded-full" style={{ backgroundColor: item.color, height: item.isMe ? 3 : 2 }} aria-hidden />
                      <span className={item.isMe ? 'font-semibold text-ink' : undefined}>{item.name}</span>
                      <span className="tabular-nums text-ink-3">{item.total}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </Panel>

        <Panel title={`Interview rate · ${rangeName}`} icon={CalendarClock}>
          <div className="px-4 py-3">
            {!data ? <Skeleton className="h-24 w-full" /> : <InterviewRates people={data.people} />}
            <p className="mt-3 text-[11.5px] text-ink-3">Share of the applications made in the range that got an interview so far: a Recruiter Screen or later, or one scheduled.</p>
          </div>
        </Panel>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        <Panel title="Upcoming interviews" icon={CalendarClock} onViewAll={() => onNavigate('interviews')}>
          {!dashboard.data ? (
            <div className="p-4">
              <Skeleton className="h-9" />
            </div>
          ) : dashboard.data.nextInterviews.length === 0 ? (
            <p className="py-5 text-center text-[12.5px] text-ink-3">Nothing scheduled</p>
          ) : (
            <ul className="divide-y divide-border">
              {dashboard.data.nextInterviews.map((interview) => {
                const StageIcon = STAGE_ICONS[interview.stage];
                return (
                  <li key={interview.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => onOpenJob(interview.jobId)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') onOpenJob(interview.jobId);
                      }}
                      className="flex items-center gap-3 px-4 py-2 hover:bg-surface-2/60"
                    >
                      <span title={interview.stage}>
                        <StageIcon className="size-4 text-ink-3" aria-label={interview.stage} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <JobTags facts={interview.facts} className="mb-0.5" />
                        <p className="truncate font-medium">{interview.title}</p>
                        <p className="truncate text-[12.5px] text-ink-2">{interview.company}</p>
                      </div>
                      <span className="shrink-0 text-right text-[12.5px] tabular-nums text-ink-2">{formatDateTime(interview.scheduledAt)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="My latest applications" icon={Send} onViewAll={() => onNavigate('mine')}>
          {!dashboard.data ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
          ) : dashboard.data.recentApplications.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No applications yet"
              action={
                <Button variant="primary" onClick={onAddJob}>
                  Add your first job
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {dashboard.data.recentApplications.map((job) => (
                <JobLine key={job.id} job={job} onOpen={onOpenJob} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

