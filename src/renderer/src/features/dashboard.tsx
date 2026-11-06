import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, BarChart3, CalendarClock, CalendarDays, Inbox, LineChart as LineChartIcon, Percent, Send, Table2, Trophy, type LucideIcon } from 'lucide-react';
import type { ActivityBucket, ActivityPerson, ActivityResponse, DaySpan, JobListItem } from '@shared/api';
import { addDays, addMonths, autoGroup, daysBetween, groupFits, localCalendarDate, MAX_RANGE_DAYS, monthEnd, monthStart, weekStart, type ActivityGroup } from '@shared/calendar';
import { AvatarStack, StatusBadge, userName } from '@/components/job-bits';
import { JobTags } from '@/components/job-tags';
import { STAGE_ICONS } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Card, EmptyState, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { errorMessage, useActivity, useDashboard } from '@/lib/api';
import { cn, formatDateTime, formatShortAgo, localTimeZone } from '@/lib/utils';
import type { Page } from '../App';

// ---- The date range, in this computer's own calendar ------------------------------------------

type Preset = 'today' | 'yesterday' | 'week' | 'lastWeek' | 'month' | 'lastMonth' | 'last7' | 'last30' | 'last90' | 'year' | 'custom';

const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'This week' },
  { value: 'lastWeek', label: 'Last week' },
  { value: 'month', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'last90', label: 'Last 90 days' },
  { value: 'year', label: 'This year' },
  { value: 'custom', label: 'Custom range' }
];

const GROUP_LABELS: Record<ActivityGroup, string> = { hour: 'Hour', day: 'Day', week: 'Week', month: 'Month' };

interface RangeChoice {
  preset: Preset;
  /** The custom range's days, kept while another preset is chosen. */
  from: string;
  to: string;
}

const RANGE_KEY = 'jobTracker.dashboardRange';

function loadRange(): RangeChoice {
  try {
    const saved = JSON.parse(localStorage.getItem(RANGE_KEY) ?? 'null') as RangeChoice | null;
    if (saved && PRESETS.some((item) => item.value === saved.preset)) return { preset: saved.preset, from: saved.from ?? '', to: saved.to ?? '' };
  } catch {
    // A bad saved value just means the default range.
  }
  return { preset: 'today', from: '', to: '' };
}

/** The days a preset covers on a given day. Weeks run Monday to Sunday. */
function rangeFor(choice: RangeChoice, today: string): DaySpan {
  const week = weekStart(today);
  const month = monthStart(today);
  switch (choice.preset) {
    case 'yesterday':
      return { first: addDays(today, -1), last: addDays(today, -1) };
    case 'week':
      return { first: week, last: addDays(week, 6) };
    case 'lastWeek':
      return { first: addDays(week, -7), last: addDays(week, -1) };
    case 'month':
      return { first: month, last: monthEnd(month) };
    case 'lastMonth':
      return { first: addMonths(month, -1), last: addDays(month, -1) };
    case 'last7':
      return { first: addDays(today, -6), last: today };
    case 'last30':
      return { first: addDays(today, -29), last: today };
    case 'last90':
      return { first: addDays(today, -89), last: today };
    case 'year':
      return { first: `${today.slice(0, 4)}-01-01`, last: `${today.slice(0, 4)}-12-31` };
    case 'custom': {
      const from = choice.from || today;
      const to = choice.to || today;
      const [first, last] = from <= to ? [from, to] : [to, from];
      // The host answers at most this many days: the end stays, the start moves.
      return daysBetween(first, last) < MAX_RANGE_DAYS ? { first, last } : { first: addDays(last, -(MAX_RANGE_DAYS - 1)), last };
    }
    default:
      return { first: today, last: today };
  }
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

// ---- Labels -------------------------------------------------------------------------------

/** A calendar day, as a time on this computer, for formatting and comparing with now. */
const toLocal = (date: string, hour = 0) => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, hour);
};

const fullDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const dayMonth = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dayMonthYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const monthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const monthShort = new Intl.DateTimeFormat(undefined, { month: 'short' });
const monthShortYear = new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' });
const hourOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

function spanLabel(span: DaySpan): string {
  if (span.first === span.last) return fullDay.format(toLocal(span.first));
  return dayMonthYear.formatRange(toLocal(span.first), toLocal(span.last));
}

const bucketHour = (bucket: ActivityBucket) => Number(bucket.key.slice(11, 13));
const bucketStart = (bucket: ActivityBucket, group: ActivityGroup) => (group === 'hour' ? toLocal(bucket.first, bucketHour(bucket)) : toLocal(bucket.first));

/** Short, for the axis. */
function axisLabel(bucket: ActivityBucket, group: ActivityGroup, manyYears: boolean): string {
  switch (group) {
    case 'hour':
      return hourOnly.format(bucketStart(bucket, group));
    case 'month':
      return (manyYears ? monthShortYear : monthShort).format(toLocal(bucket.first));
    default:
      return dayMonth.format(toLocal(bucket.first));
  }
}

/** In full, with the days a week or month covers in the range. */
function bucketLabel(bucket: ActivityBucket, group: ActivityGroup): string {
  switch (group) {
    case 'hour':
      return `${fullDay.format(toLocal(bucket.first))}, ${hourOnly.format(bucketStart(bucket, group))}`;
    case 'day':
      return fullDay.format(toLocal(bucket.first));
    case 'week':
      return `Week of ${spanLabel(bucket)}`;
    case 'month': {
      const whole = bucket.first === monthStart(bucket.first) && bucket.last === monthEnd(bucket.first);
      return whole ? monthYear.format(toLocal(bucket.first)) : `${monthYear.format(toLocal(bucket.first))} (${spanLabel(bucket)})`;
    }
  }
}

const count = (value: number) => value.toLocaleString();
const percent = (value: number | null) => (value === null ? '–' : `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`);

// ---- One color per person, kept whatever the ranking ----------------------------------------

const SERIES_SLOTS = 8;
const OTHERS_COLOR = 'var(--ink-3)';

/**
 * Who gets a line of their own, and their color. Up to eight people each get one; beyond that, I
 * and the six leaders do and the rest are added together as "others". Colors go by who the person
 * is, never by rank, so a color means the same person on every chart and card.
 */
function chartPeople(people: ActivityPerson[]): { shown: ActivityPerson[]; rest: ActivityPerson[]; colors: Map<number, string> } {
  const ranked = [...people].sort((a, b) => a.rank - b.rank);
  const shown = ranked.length <= SERIES_SLOTS ? ranked : [...ranked.filter((person) => person.isMe), ...ranked.filter((person) => !person.isMe)].slice(0, SERIES_SLOTS - 1);
  const ids = shown.map((person) => person.user.id).sort((a, b) => a - b);
  const colors = new Map(ids.map((id, index) => [id, `var(--series-${index + 1})`]));
  return { shown, rest: ranked.filter((person) => !shown.includes(person)), colors };
}

interface Series {
  key: string;
  name: string;
  color: string;
  isMe: boolean;
  total: number;
  /** Null for a period that has not begun yet: no applications yet is not zero applications. */
  values: Array<number | null>;
}

function seriesFor(data: ActivityResponse, now: Date, cumulative: boolean): Series[] {
  const { shown, rest, colors } = chartPeople(data.people);
  const started = data.buckets.map((bucket) => bucketStart(bucket, data.group) <= now);
  const shape = (raw: number[]): Array<number | null> => {
    let running = 0;
    return raw.map((value, index) => {
      if (!started[index]) return null;
      running += value;
      return cumulative ? running : value;
    });
  };
  const series: Series[] = shown.map((person) => ({
    key: String(person.user.id),
    name: userName(person.user),
    color: colors.get(person.user.id) ?? OTHERS_COLOR,
    isMe: person.isMe,
    total: person.inRange,
    values: shape(person.series)
  }));
  if (rest.length) {
    const summed = data.buckets.map((_, index) => rest.reduce((total, person) => total + person.series[index], 0));
    series.push({ key: 'others', name: `${rest.length} others`, color: OTHERS_COLOR, isMe: false, total: rest.reduce((total, person) => total + person.inRange, 0), values: shape(summed) });
  }
  return series;
}

// ---- Pieces --------------------------------------------------------------------------------

function Delta({ value, against }: { value: number; against: string }) {
  const Icon = value > 0 ? ArrowUp : ArrowDown;
  return (
    <span className={cn('inline-flex items-center gap-0.5', value > 0 ? 'text-success-ink' : value < 0 ? 'text-danger-ink' : 'text-ink-3')}>
      {value !== 0 ? <Icon className="size-3" aria-hidden /> : null}
      {value > 0 ? '+' : value < 0 ? '−' : '±'}
      {count(Math.abs(value))}
      <span className="ml-1 text-ink-3">{against}</span>
    </span>
  );
}

function Tile({ label, value, detail, extra, emphasis }: { label: string; value: string | undefined; detail?: React.ReactNode; extra?: React.ReactNode; emphasis?: boolean }) {
  return (
    <div className={cn('min-w-0 rounded-md border bg-surface px-3 py-2', emphasis ? 'border-accent' : 'border-border')} data-kpi={label}>
      <p className="truncate text-[12px] text-ink-3">{label}</p>
      {value === undefined ? <Skeleton className="mt-1 h-7 w-14" /> : <p className="text-[24px] font-semibold leading-tight">{value}</p>}
      {detail ? <p className="truncate text-[11.5px] text-ink-3">{detail}</p> : null}
      {extra ? <p className="truncate text-[11.5px] text-ink-3">{extra}</p> : null}
    </div>
  );
}

function Panel({ title, icon: Icon, aside, children, onViewAll }: { title: string; icon: LucideIcon; aside?: React.ReactNode; children: React.ReactNode; onViewAll?: () => void }) {
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden rounded-md">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border py-1 pl-3.5 pr-1.5">
        <h2 className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-ink">
          <Icon className="size-4 shrink-0 text-ink-3" aria-hidden />
          <span className="truncate">{title}</span>
        </h2>
        <div className="flex items-center gap-1">
          {aside}
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

function Toggle<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string; disabled?: boolean; title?: string }>; onChange: (value: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border-strong p-0.5" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn('h-6.5 rounded px-2 text-[12.5px] disabled:cursor-not-allowed disabled:opacity-40', value === option.value ? 'bg-accent-soft font-medium text-accent-soft-ink' : 'text-ink-2 hover:text-ink')}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** One person's numbers. "You" come first; everyone else follows by applications in the range. */
function PersonCard({ person, color, rangeName, people, lead }: { person: ActivityPerson; color: string; rangeName: string; people: number; lead: string }) {
  return (
    <li
      data-person-card={person.user.username}
      className={cn('flex flex-col rounded-md border bg-surface px-3 py-2.5', person.isMe ? 'border-accent' : 'border-border')}
      title={person.profiles.length ? `By profile, ${rangeName.toLowerCase()}:\n${person.profiles.map((profile) => `${profile.name}: ${profile.count}`).join('\n')}` : undefined}
    >
      <div className="flex items-center gap-2">
        <span className="w-8 shrink-0 text-[12.5px] font-semibold tabular-nums text-ink-2" title={`Rank ${person.rank} of ${people} by applications, ${rangeName.toLowerCase()}`}>
          #{person.rank}
        </span>
        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
        <p className="min-w-0 flex-1 truncate font-medium">
          {userName(person.user)}
          {person.isMe ? <span className="ml-1 font-normal text-ink-3">(you)</span> : null}
          {person.isActive ? null : <span className="ml-1 font-normal text-ink-3">(off)</span>}
        </p>
      </div>
      <p className="mt-1.5 flex items-baseline gap-1.5">
        <span className="text-[24px] font-semibold leading-none" data-range-count>
          {count(person.inRange)}
        </span>
        <span className="min-w-0 truncate text-[12px] text-ink-3">applied · {rangeName}</span>
        <span className="ml-auto shrink-0 text-[11.5px] text-ink-3">{lead}</span>
      </p>
      <dl className="mt-2 grid grid-cols-4 border-t border-border pt-1.5 text-[11.5px]">
        {(
          [
            ['Today', person.today],
            ['Yesterday', person.yesterday],
            ['Week', person.week],
            ['Month', person.month]
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt className="text-ink-3">{label}</dt>
            <dd className="font-semibold tabular-nums text-ink">{count(value)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1.5 text-[11.5px] text-ink-2">
        Interviews <span className="font-semibold tabular-nums text-ink">{count(person.interviews)}</span>/{count(person.inRange)} · <span className="font-semibold text-ink">{percent(person.interviewRate)}</span>
        <span className="text-ink-3"> · all time {percent(person.allTimeInterviewRate)}</span>
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

function LineChart({ data, series, cumulative }: { data: ActivityResponse; series: Series[]; cumulative: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  const { buckets, group } = data;
  const count = buckets.length;
  const lastShown = (item: Series) => item.values.reduce<number>((last, value, index) => (value === null ? last : index), -1);
  const labelled = series.length <= 4;
  const height = 240;
  const margin = { top: 12, right: labelled ? 92 : 14, bottom: 26, left: 36 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const top = niceMax(Math.max(0, ...series.flatMap((item) => item.values.filter((value): value is number => value !== null))));
  const x = (index: number) => margin.left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const y = (value: number) => margin.top + plotHeight - (value / top) * plotHeight;
  const ticks = [0, top / 4, top / 2, (top * 3) / 4, top].filter((value, index, all) => Number.isInteger(value) && all.indexOf(value) === index);
  const every = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(plotWidth / 58))));
  const manyYears = buckets[0]?.first.slice(0, 4) !== buckets[count - 1]?.last.slice(0, 4);

  // End labels name the lines directly, unless two would sit on top of each other.
  const ends = series.map((item) => ({ item, index: lastShown(item) })).filter((end) => end.index >= 0);
  const endYs = ends.map((end) => y(end.item.values[end.index] ?? 0)).sort((a, b) => a - b);
  const endsFit = labelled && endYs.every((value, index) => index === 0 || value - endYs[index - 1] >= 13);

  const pointAt = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || count === 0) return null;
    const ratio = (clientX - rect.left - margin.left) / plotWidth;
    return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
  };
  const path = (values: Array<number | null>) => {
    let drawing = false;
    return values
      .map((value, index) => {
        if (value === null) {
          drawing = false;
          return '';
        }
        const step = `${drawing ? 'L' : 'M'}${x(index)},${y(value)}`;
        drawing = true;
        return step;
      })
      .join(' ');
  };

  return (
    <div ref={box} className="relative" onMouseLeave={() => setHover(null)}>
      <svg
        width={width}
        height={height}
        role="img"
        tabIndex={0}
        aria-label={`Applications per ${group}${cumulative ? ', running total' : ''}, by person. Use the arrow keys to read each ${group}.`}
        className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onMouseMove={(event) => setHover(pointAt(event.clientX))}
        onBlur={() => setHover(null)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') setHover((current) => Math.min(count - 1, (current ?? -1) + 1));
          else if (event.key === 'ArrowLeft') setHover((current) => Math.max(0, (current ?? count) - 1));
          else return;
          event.preventDefault();
        }}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={margin.left} x2={margin.left + plotWidth} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeWidth={1} />
            <text x={margin.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--ink-3)" className="tabular-nums">
              {count > 0 ? tick.toLocaleString() : ''}
            </text>
          </g>
        ))}
        {buckets.map((bucket, index) =>
          (index % every === 0 && count - 1 - index >= every) || index === count - 1 ? (
            <text key={bucket.key} x={x(index)} y={height - 8} textAnchor={index === 0 && count > 1 ? 'start' : index === count - 1 && count > 1 ? 'end' : 'middle'} fontSize={11} fill="var(--ink-3)">
              {axisLabel(bucket, group, manyYears)}
            </text>
          ) : null
        )}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={margin.top} y2={margin.top + plotHeight} stroke="var(--border-strong)" strokeWidth={1} /> : null}
        {/* My own line is drawn last, so it is never hidden under someone else's. */}
        {[...series]
          .sort((a, b) => Number(a.isMe) - Number(b.isMe))
          .map((item) => (
            <g key={item.key}>
              <path d={path(item.values)} fill="none" stroke={item.color} strokeWidth={item.isMe ? 2.5 : 2} strokeLinejoin="round" strokeLinecap="round" />
              {count <= 16
                ? item.values.map((value, index) => (value === null ? null : <circle key={index} cx={x(index)} cy={y(value)} r={3} fill={item.color} stroke="var(--surface)" strokeWidth={1.5} />))
                : null}
              {hover !== null && item.values[hover] !== null ? <circle cx={x(hover)} cy={y(item.values[hover] ?? 0)} r={4.5} fill={item.color} stroke="var(--surface)" strokeWidth={2} /> : null}
            </g>
          ))}
        {endsFit
          ? ends.map(({ item, index }) => (
              <text key={item.key} x={x(index) + 8} y={y(item.values[index] ?? 0)} dominantBaseline="middle" fontSize={11.5} fill="var(--ink-2)" fontWeight={item.isMe ? 600 : 400}>
                {item.name.length > 12 ? `${item.name.slice(0, 11)}…` : item.name} {(item.values[index] ?? 0).toLocaleString()}
              </text>
            ))
          : null}
      </svg>
      {hover !== null ? (
        <div className="pointer-events-none absolute top-1 z-10 min-w-40 rounded-md border border-border bg-surface px-2.5 py-2 text-[12px] shadow-lg" style={{ left: Math.min(Math.max(0, x(hover) + 12), width - 180) }} role="status">
          <p className="mb-1 font-medium text-ink">{bucketLabel(buckets[hover], group)}</p>
          {[...series]
            .sort((a, b) => (b.values[hover] ?? -1) - (a.values[hover] ?? -1))
            .map((item) => (
              <p key={item.key} className="flex items-center gap-1.5 text-ink-2">
                <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: item.color }} aria-hidden />
                <span className="flex-1 truncate">{item.name}</span>
                <span className="font-semibold tabular-nums text-ink">{item.values[hover] === null ? '–' : (item.values[hover] ?? 0).toLocaleString()}</span>
              </p>
            ))}
          {buckets[hover] && bucketStart(buckets[hover], group) > new Date() ? <p className="mt-1 text-ink-3">Not yet begun</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function SeriesTable({ data, series }: { data: ActivityResponse; series: Series[] }) {
  return (
    <div className="max-h-[280px] overflow-auto">
      <table className="w-full text-[12.5px] tabular-nums">
        <thead className="sticky top-0 bg-surface text-ink-3">
          <tr className="border-b border-border">
            <th className="py-1 pr-3 text-left font-normal">{GROUP_LABELS[data.group]}</th>
            {series.map((item) => (
              <th key={item.key} className="py-1 pr-3 text-right font-normal">
                {item.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {data.buckets.map((bucket, index) => (
            <tr key={bucket.key}>
              <td className="py-1 pr-3">{bucketLabel(bucket, data.group)}</td>
              {series.map((item) => (
                <td key={item.key} className="py-1 pr-3 text-right">
                  {item.values[index] === null ? <span className="text-ink-3">–</span> : (item.values[index] ?? 0).toLocaleString()}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border-strong font-semibold">
            <td className="py-1 pr-3">Total</td>
            {series.map((item) => (
              <td key={item.key} className="py-1 pr-3 text-right">
                {item.total.toLocaleString()}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Ranked bars on one scale, with the counts behind each rate and the team's rate as a mark. */
function InterviewRanking({ data }: { data: ActivityResponse }) {
  const rows = [...data.people].sort((a, b) => (b.interviewRate ?? -1) - (a.interviewRate ?? -1) || b.inRange - a.inRange || a.rank - b.rank);
  const team = data.team.interviewRate;
  const top = Math.min(100, Math.max(10, Math.ceil(Math.max(team ?? 0, ...rows.map((person) => person.interviewRate ?? 0)) / 10) * 10));
  const at = (value: number) => `${Math.min(100, (value / top) * 100)}%`;
  return (
    <div>
      <div className="grid grid-cols-[minmax(0,140px)_1fr_52px_64px_60px] gap-x-2.5 border-b border-border pb-1 text-[11.5px] text-ink-3">
        <span>Person</span>
        <span className="flex justify-between tabular-nums">
          <span>0%</span>
          <span>{top}%</span>
        </span>
        <span className="text-right">Rate</span>
        <span className="text-right">Interviews</span>
        <span className="text-right">All time</span>
      </div>
      <ul aria-label="Interview rate by person">
        {rows.map((person) => (
          <li key={person.user.id} className="grid grid-cols-[minmax(0,140px)_1fr_52px_64px_60px] items-center gap-x-2.5 border-b border-border py-1.5 text-[12.5px] last:border-b-0" data-interview-rate={person.user.username}>
            <span className={cn('truncate', person.isMe ? 'font-semibold text-ink' : 'text-ink-2')}>
              {userName(person.user)}
              {person.isMe ? ' (you)' : ''}
            </span>
            <div className="relative h-3" title={`${person.interviews} of ${person.inRange} applications got an interview`}>
              <div className="absolute inset-0 rounded-[3px] bg-surface-2" />
              {person.interviewRate ? <div className="absolute inset-y-0 left-0 rounded-r-[4px] bg-accent" style={{ width: at(person.interviewRate) }} /> : null}
              {team !== null ? <div className="absolute -inset-y-1 w-px bg-ink" style={{ left: at(team) }} aria-hidden /> : null}
            </div>
            <span className="text-right font-semibold tabular-nums text-ink">{percent(person.interviewRate)}</span>
            <span className="text-right tabular-nums text-ink-2">
              {count(person.interviews)}/{count(person.inRange)}
            </span>
            <span className="text-right tabular-nums text-ink-3">{percent(person.allTimeInterviewRate)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-ink-3">
        <span className="inline-block h-3 w-px bg-ink" aria-hidden />
        Team {percent(team)} ({count(data.team.interviews)} of {count(data.team.inRange)})
      </p>
    </div>
  );
}

function JobLine({ job, onOpen }: { job: JobListItem; onOpen: (id: number) => void }) {
  const mine = job.applications.filter((application) => application.isMine);
  const applied = mine.map((application) => application.appliedAt).sort()[0];
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(job.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onOpen(job.id);
        }}
        className="flex items-center gap-3 px-3.5 py-1.5 hover:bg-surface-2/60"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{job.title}</p>
          <p className="truncate text-[12.5px] text-ink-2">{job.company}</p>
        </div>
        {mine.length === 1 ? <StatusBadge status={mine[0].status} /> : null}
        <AvatarStack applications={job.applications} />
        {applied ? (
          <span className="w-9 shrink-0 text-right text-[12px] tabular-nums text-ink-3" title={`Applied ${formatDateTime(applied)}`}>
            {formatShortAgo(applied)}
          </span>
        ) : null}
      </div>
    </li>
  );
}

// ---- The page ------------------------------------------------------------------------------

export function DashboardPage({ onOpenJob, onNavigate, onAddJob }: { onOpenJob: (id: number) => void; onNavigate: (page: Page) => void; onAddJob: () => void }) {
  const now = useNow();
  const today = localCalendarDate(now);
  const tz = useMemo(() => localTimeZone(), []);
  const [choice, setChoice] = useState(loadRange);
  const [groupChoice, setGroupChoice] = useState<ActivityGroup | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  // Left alone, one day shows the running total: who is ahead, hour by hour.
  const [cumulativeChoice, setCumulativeChoice] = useState<boolean | null>(null);

  const range = useMemo(() => rangeFor(choice, today), [choice, today]);
  const group = groupChoice && groupFits(groupChoice, range.first, range.last) ? groupChoice : autoGroup(range.first, range.last);
  const activity = useActivity({ tz, today, from: range.first, to: range.last, group });
  const cumulative = cumulativeChoice ?? group === 'hour';
  const dashboard = useDashboard();
  const data = activity.data;

  const rangeName = PRESETS.find((item) => item.value === choice.preset)?.label ?? 'Range';
  const label = spanLabel(range);
  const me = data?.people.find((person) => person.isMe);
  const ranked = useMemo(() => [...(data?.people ?? [])].sort((a, b) => a.rank - b.rank), [data]);
  const { colors } = useMemo(() => chartPeople(data?.people ?? []), [data]);
  const series = useMemo(() => (data ? seriesFor(data, now, cumulative) : []), [data, now, cumulative]);

  const leadOf = (person: ActivityPerson): string => {
    if (person.inRange === 0) return '';
    if (person.rank > 1) return `${count(person.behindLeader)} behind #1`;
    const margin = person.inRange - (ranked[1]?.inRange ?? 0);
    return margin === 0 ? 'Tied for #1' : `Leads by ${count(margin)}`;
  };

  const choose = (next: RangeChoice) => {
    setChoice(next);
    setGroupChoice(null);
    setCumulativeChoice(null);
    try {
      localStorage.setItem(RANGE_KEY, JSON.stringify(next));
    } catch {
      // Not remembering the range only means starting on Today next time.
    }
  };

  // Tiles for today, this week and this month always; the range gets its own when it is another.
  const rangeIsPeriod = choice.preset === 'today' || choice.preset === 'week' || choice.preset === 'month';

  return (
    <div className="h-full overflow-y-auto px-5 pb-8 pt-4">
      {/* One row of filters, above everything they apply to. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <h1 className="mr-1 text-[17px] font-semibold leading-tight">Dashboard</h1>
        <Select
          ariaLabel="Date range"
          className="w-[160px]"
          leading={<CalendarDays className="size-3.5 text-ink-3" aria-hidden />}
          value={choice.preset}
          onChange={(preset) =>
            choose({ ...choice, preset: preset as Preset, ...(preset === 'custom' && !choice.from ? { from: range.first, to: range.last } : {}) })
          }
          options={PRESETS.map((item) => ({ value: item.value, label: item.label }))}
        />
        {choice.preset === 'custom' ? (
          <span className="inline-flex items-center gap-1.5">
            <Input type="date" aria-label="From" className="h-8 w-[138px]" value={range.first} max={range.last} onChange={(event) => event.target.value && choose({ ...choice, from: event.target.value, to: range.last })} />
            <span className="text-ink-3">–</span>
            <Input type="date" aria-label="To" className="h-8 w-[138px]" value={range.last} min={range.first} onChange={(event) => event.target.value && choose({ ...choice, from: range.first, to: event.target.value })} />
          </span>
        ) : null}
        <span className="text-[12.5px] text-ink-3">Group by</span>
        <Toggle
          label="Group by"
          value={group}
          onChange={setGroupChoice}
          options={(['hour', 'day', 'week', 'month'] as const).map((value) => ({
            value,
            label: GROUP_LABELS[value],
            disabled: !groupFits(value, range.first, range.last),
            title: groupFits(value, range.first, range.last) ? undefined : 'Hours are shown for a single day'
          }))}
        />
        <span className="ml-auto text-[12.5px] text-ink-2" data-range-label>
          {label}
          <span className="text-ink-3"> · {tz}</span>
        </span>
      </div>

      {activity.isError ? (
        <Notice kind="error" title="Could not load the numbers" className="mb-3">
          {errorMessage(activity.error)}
        </Notice>
      ) : null}

      {/* While a new range loads, the old numbers stay, dimmed, instead of flashing empty. */}
      <div className={cn('transition-opacity', activity.isPlaceholderData && 'opacity-60')}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Tile
            label="Applied today"
            value={me ? count(me.today) : undefined}
            emphasis={choice.preset === 'today'}
            detail={me ? <Delta value={me.today - me.yesterday} against={`vs yesterday (${count(me.yesterday)})`} /> : undefined}
            extra={data ? fullDay.format(toLocal(data.periods.today.first)) : undefined}
          />
          <Tile label="This week" value={me ? count(me.week) : undefined} emphasis={choice.preset === 'week'} detail={data ? spanLabel(data.periods.week) : undefined} extra={data ? `Team ${count(data.team.week)}` : undefined} />
          <Tile label="This month" value={me ? count(me.month) : undefined} emphasis={choice.preset === 'month'} detail={data ? monthYear.format(toLocal(data.periods.month.first)) : undefined} extra={data ? `Team ${count(data.team.month)}` : undefined} />
          {rangeIsPeriod ? (
            <Tile label="All time" value={me ? count(me.allTime) : undefined} detail="Every application" />
          ) : (
            <Tile label={rangeName} value={me ? count(me.inRange) : undefined} emphasis detail={label} extra={data ? `Team ${count(data.team.inRange)}` : undefined} />
          )}
          <Tile
            label={`Interview rate · ${rangeName}`}
            value={me ? percent(me.interviewRate) : undefined}
            detail={me ? `${count(me.interviews)} of ${count(me.inRange)} got an interview` : undefined}
            extra={me ? `All time ${percent(me.allTimeInterviewRate)} (${count(me.allTimeInterviews)}/${count(me.allTime)})` : undefined}
          />
          <Tile label={`My rank · ${rangeName}`} value={me ? `#${me.rank}` : undefined} detail={me && data ? `of ${data.people.length} · ${leadOf(me) || 'nothing applied yet'}` : undefined} extra={ranked[0] && me && ranked[0] !== me ? `#1 ${userName(ranked[0].user)}: ${count(ranked[0].inRange)}` : undefined} />
        </div>

        <div className="mt-3">
          <Panel
            title={`Leaderboard · ${rangeName} · ${label}`}
            icon={Trophy}
            aside={
              data ? (
                <span className="pr-2 text-[12px] text-ink-3" data-team-totals>
                  Team: <span className="font-semibold tabular-nums text-ink">{count(data.team.today)}</span> today · <span className="font-semibold tabular-nums text-ink">{count(data.team.week)}</span> this week ·{' '}
                  <span className="font-semibold tabular-nums text-ink">{count(data.team.month)}</span> this month
                  {rangeIsPeriod ? null : (
                    <>
                      {' '}
                      · <span className="font-semibold tabular-nums text-ink">{count(data.team.inRange)}</span> {rangeName.toLowerCase()}
                    </>
                  )}
                </span>
              ) : null
            }
          >
            <div className="p-2.5">
              {!data ? (
                <Skeleton className="h-28 w-full" />
              ) : (
                <ol className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-2" aria-label="People by applications">
                  {data.people.map((person) => (
                    <PersonCard key={person.user.id} person={person} color={colors.get(person.user.id) ?? OTHERS_COLOR} rangeName={rangeName} people={data.people.length} lead={leadOf(person)} />
                  ))}
                </ol>
              )}
            </div>
          </Panel>
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Panel
            title={`Applications per ${group}${cumulative ? ', running total' : ''} · ${label}`}
            icon={BarChart3}
            aside={
              <>
                <Toggle
                  label="Show"
                  value={cumulative ? 'total' : 'each'}
                  onChange={(value) => setCumulativeChoice(value === 'total')}
                  options={[
                    { value: 'each', label: `Per ${group}` },
                    { value: 'total', label: 'Running total' }
                  ]}
                />
                <Tooltip content={view === 'chart' ? 'Show as a table' : 'Show as a chart'}>
                  <Button size="icon-sm" variant="ghost" aria-label={view === 'chart' ? 'Show as a table' : 'Show as a chart'} onClick={() => setView(view === 'chart' ? 'table' : 'chart')}>
                    {view === 'chart' ? <Table2 /> : <LineChartIcon />}
                  </Button>
                </Tooltip>
              </>
            }
          >
            <div className="px-3 pb-3 pt-2">
              {!data ? (
                <Skeleton className="h-[240px] w-full" />
              ) : view === 'table' ? (
                <SeriesTable data={data} series={series} />
              ) : (
                <>
                  <LineChart data={data} series={series} cumulative={cumulative} />
                  <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2" aria-label="Legend">
                    {series.map((item) => (
                      <li key={item.key} className="inline-flex items-center gap-1.5">
                        <span className="w-3.5 rounded-full" style={{ backgroundColor: item.color, height: item.isMe ? 3 : 2 }} aria-hidden />
                        <span className={item.isMe ? 'font-semibold text-ink' : undefined}>{item.name}</span>
                        <span className="tabular-nums text-ink-3">{item.total.toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Panel>

          <Panel title={`Interview rate · ${rangeName} · ${label}`} icon={Percent}>
            <div className="px-3.5 py-2.5">
              {!data ? <Skeleton className="h-24 w-full" /> : <InterviewRanking data={data} />}
              <p className="mt-2 text-[11.5px] text-ink-3">
                Of the applications made {choice.preset === 'today' || choice.preset === 'yesterday' ? 'that day' : 'in the range'}, the share that reached Recruiter Screen or later, or has an interview booked. Recent applications may still get one.
              </p>
            </div>
          </Panel>
        </div>
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
                      className="flex items-center gap-3 px-3.5 py-1.5 hover:bg-surface-2/60"
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
