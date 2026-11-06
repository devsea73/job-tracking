import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, CalendarDays, LineChart as LineChartIcon, Table2, type LucideIcon } from 'lucide-react';
import type { ActivityBucket, ActivityCounts, ActivityProfile, DaySpan, UserRef } from '@shared/api';
import { addDays, addMonths, autoGroup, daysBetween, groupFits, localCalendarDate, MAX_RANGE_DAYS, monthEnd, monthStart, weekStart, type ActivityGroup } from '@shared/calendar';
import { userName } from '@/components/job-bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Card, Skeleton, Tooltip } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { cn, localTimeZone } from '@/lib/utils';

/**
 * What the Dashboard and the Team page share: the date range in this computer's own calendar,
 * labels for days and periods, and the charts. The host counts; these only show.
 */

// ---- The date range -----------------------------------------------------------------------

export type Preset = 'today' | 'yesterday' | 'week' | 'lastWeek' | 'month' | 'lastMonth' | 'last7' | 'last30' | 'last90' | 'year' | 'custom';

export const PRESETS: Array<{ value: Preset; label: string }> = [
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

export const GROUP_LABELS: Record<ActivityGroup, string> = { hour: 'Hour', day: 'Day', week: 'Week', month: 'Month' };

interface RangeChoice {
  preset: Preset;
  /** The custom range's days, kept while another preset is chosen. */
  from: string;
  to: string;
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

/** The current minute: "today" turns over at midnight without a reload, and again on coming back to the window. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const timer = setInterval(tick, 60_000);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, []);
  return now;
}

/** The day it is in a time zone, written 2026-11-05. */
function dayIn(tz: string, moment: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(moment);
  } catch {
    return localCalendarDate(moment);
  }
}

export interface Filters {
  now: Date;
  today: string;
  tz: string;
  preset: Preset;
  range: DaySpan;
  group: ActivityGroup;
  /** The preset's name: "Today", "Last 30 days". */
  rangeName: string;
  /** The range's days, in words. */
  label: string;
  /** Today, this week or this month: periods every page already shows on their own. */
  rangeIsPeriod: boolean;
  /** Changes whenever the range does, so views can go back to their defaults. */
  rangeKey: string;
  choose: (preset: Preset, custom?: { from: string; to: string }) => void;
  setGroup: (group: ActivityGroup) => void;
}

/** The page's range and grouping, remembered under its own name. Today, unless something else was chosen. */
export function useFilters(storageKey: string): Filters {
  const now = useNow();
  // Read on every tick: the computer's time zone can change while the app is open, and the host
  // counts days in the zone it is told, so today has to be the day it is in that same zone.
  const tz = localTimeZone();
  const today = dayIn(tz, now);
  const [choice, setChoice] = useState<RangeChoice>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as RangeChoice | null;
      if (saved && PRESETS.some((item) => item.value === saved.preset)) return { preset: saved.preset, from: saved.from ?? '', to: saved.to ?? '' };
    } catch {
      // A bad saved value just means the default range.
    }
    return { preset: 'today', from: '', to: '' };
  });
  const [groupChoice, setGroupChoice] = useState<ActivityGroup | null>(null);
  const range = useMemo(() => rangeFor(choice, today), [choice, today]);
  const group = groupChoice && groupFits(groupChoice, range.first, range.last) ? groupChoice : autoGroup(range.first, range.last);

  return {
    now,
    today,
    tz,
    preset: choice.preset,
    range,
    group,
    rangeName: PRESETS.find((item) => item.value === choice.preset)?.label ?? 'Range',
    label: spanLabel(range),
    rangeIsPeriod: choice.preset === 'today' || choice.preset === 'week' || choice.preset === 'month',
    rangeKey: `${choice.preset}:${range.first}:${range.last}`,
    choose: (preset, custom) => {
      const next = { preset, from: custom?.from ?? (preset === 'custom' && !choice.from ? range.first : choice.from), to: custom?.to ?? (preset === 'custom' && !choice.to ? range.last : choice.to) };
      setChoice(next);
      setGroupChoice(null);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Not remembering the range only means starting on Today next time.
      }
    },
    setGroup: setGroupChoice
  };
}

/** One row of filters, above everything they apply to. */
export function FilterBar({ title, filters }: { title: string; filters: Filters }) {
  const { range } = filters;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-2">
      <h1 className="mr-1 text-[17px] font-semibold leading-tight">{title}</h1>
      <Select
        ariaLabel="Date range"
        className="w-[160px]"
        leading={<CalendarDays className="size-3.5 text-ink-3" aria-hidden />}
        value={filters.preset}
        onChange={(preset) => filters.choose(preset as Preset)}
        options={PRESETS.map((item) => ({ value: item.value, label: item.label }))}
      />
      {filters.preset === 'custom' ? (
        <span className="inline-flex items-center gap-1.5">
          <Input type="date" aria-label="From" className="h-8 w-[138px]" value={range.first} max={range.last} onChange={(event) => event.target.value && filters.choose('custom', { from: event.target.value, to: range.last })} />
          <span className="text-ink-3">–</span>
          <Input type="date" aria-label="To" className="h-8 w-[138px]" value={range.last} min={range.first} onChange={(event) => event.target.value && filters.choose('custom', { from: range.first, to: event.target.value })} />
        </span>
      ) : null}
      <span className="text-[12.5px] text-ink-3">Group by</span>
      <Toggle
        label="Group by"
        value={filters.group}
        onChange={filters.setGroup}
        options={(['hour', 'day', 'week', 'month'] as const).map((value) => ({
          value,
          label: GROUP_LABELS[value],
          disabled: !groupFits(value, range.first, range.last),
          title: groupFits(value, range.first, range.last) ? undefined : 'Hours are shown for a single day'
        }))}
      />
      <span className="ml-auto text-[12.5px] text-ink-2" data-range-label>
        {filters.label}
        <span className="text-ink-3"> · {filters.tz}</span>
      </span>
    </div>
  );
}

// ---- Labels -------------------------------------------------------------------------------

/** A calendar day, as a time on this computer, for formatting and comparing with now. */
export const toLocal = (date: string, hour = 0) => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, hour);
};

export const fullDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const dayMonth = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dayMonthYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
export const monthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const monthShort = new Intl.DateTimeFormat(undefined, { month: 'short' });
const monthShortYear = new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' });
const hourOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

export function spanLabel(span: DaySpan): string {
  if (span.first === span.last) return fullDay.format(toLocal(span.first));
  return dayMonthYear.formatRange(toLocal(span.first), toLocal(span.last));
}

export const bucketStart = (bucket: ActivityBucket, group: ActivityGroup) => (group === 'hour' ? toLocal(bucket.first, Number(bucket.key.slice(11, 13))) : toLocal(bucket.first));

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
export function bucketLabel(bucket: ActivityBucket, group: ActivityGroup): string {
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

export const count = (value: number) => value.toLocaleString();
export const percent = (value: number | null) => (value === null ? '–' : `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`);
export const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

// ---- Series: one per person or profile, colored by who it is --------------------------------

/** The validated categorical palette has eight hues; a ninth series is never a new color. */
export const SERIES_SLOTS = 8;
export const OTHERS_COLOR = 'var(--ink-3)';
export const seriesColor = (index: number) => `var(--series-${index + 1})`;
/** On the Team page whoever looks is red and everyone else blue: your own line stands out among the rest. */
export const ME_COLOR = 'var(--me-line)';
export const mineColor = (index: number) => (index % 3 === 0 ? ME_COLOR : `var(--mine-${(index % 3) + 1})`);
export const othersColor = (index: number) => `var(--others-${(index % SERIES_SLOTS) + 1})`;

export interface Series {
  key: string;
  name: string;
  color: string;
  /** Drawn dashed and without points: the period before, for comparison. */
  dashed?: boolean;
  /** Drawn on top and a little thicker: the viewer's own line. */
  emphasis?: boolean;
  /** Shown next to the name in the legend and table; null for none. */
  total: number | null;
  /** Null for a period that has not begun yet: no applications yet is not zero applications. */
  values: Array<number | null>;
  /** What each point is called in the hover readout when it is not the bucket's own day: the days of the period before. */
  pointLabels?: Array<string | null>;
}

/** Periods still to come become gaps, and a running total adds up as it goes. */
export function shapeValues(raw: Array<number | null>, buckets: ActivityBucket[], group: ActivityGroup, now: Date, cumulative = false): Array<number | null> {
  let running = 0;
  return raw.map((value, index) => {
    if (!buckets[index] || bucketStart(buckets[index], group) > now) return null;
    running += value ?? 0;
    return cumulative ? running : (value ?? 0);
  });
}

/** The readout's last line: everyone together. Left out, the series are added up; null, there is none. */
export type ChartFooter = { label: string; values: Array<number | null> } | null;

// ---- Pieces --------------------------------------------------------------------------------

export function Delta({ value, against }: { value: number; against: string }) {
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

export function Tile({ label, value, detail, extra, emphasis }: { label: string; value: string | undefined; detail?: React.ReactNode; extra?: React.ReactNode; emphasis?: boolean }) {
  return (
    <div className={cn('min-w-0 rounded-md border bg-surface px-3 py-2', emphasis ? 'border-accent' : 'border-border')} data-kpi={label}>
      <p className="truncate text-[12px] text-ink-3">{label}</p>
      {value === undefined ? <Skeleton className="mt-1 h-7 w-14" /> : <p className="text-[24px] font-semibold leading-tight">{value}</p>}
      {detail ? <p className="truncate text-[11.5px] text-ink-3">{detail}</p> : null}
      {extra ? <p className="truncate text-[11.5px] text-ink-3">{extra}</p> : null}
    </div>
  );
}

export function Panel({ title, icon: Icon, aside, children, onViewAll, className }: { title: string; icon: LucideIcon; aside?: React.ReactNode; children: React.ReactNode; onViewAll?: () => void; className?: string }) {
  return (
    <Card className={cn('flex min-h-0 flex-col overflow-hidden rounded-md', className)}>
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border py-1 pl-3.5 pr-1.5">
        <h2 className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-ink">
          <Icon className="size-4 shrink-0 text-ink-3" aria-hidden />
          <span className="truncate">{title}</span>
        </h2>
        <div className="flex flex-wrap items-center gap-1">
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

export function Toggle<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string; disabled?: boolean; title?: string }>; onChange: (value: T) => void }) {
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

/** Switches a chart between itself and its table. */
export function TableSwitch({ view, onChange }: { view: 'chart' | 'table'; onChange: (view: 'chart' | 'table') => void }) {
  const label = view === 'chart' ? 'Show as a table' : 'Show as a chart';
  return (
    <Tooltip content={label}>
      <Button size="icon-sm" variant="ghost" aria-label={label} onClick={() => onChange(view === 'chart' ? 'table' : 'chart')}>
        {view === 'chart' ? <Table2 /> : <LineChartIcon />}
      </Button>
    </Tooltip>
  );
}

/** A short line in the series' color: dashed for the period before. */
export function LineMark({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <svg width={16} height={6} className="shrink-0" aria-hidden>
      <line x1={1} x2={15} y1={3} y2={3} stroke={color} strokeWidth={2} strokeLinecap="round" strokeDasharray={dashed ? '3 3' : undefined} />
    </svg>
  );
}

/** Which lines are drawn, when the legend chooses them: eight at most at a time. */
export interface LegendChoice {
  isOn: (key: string) => boolean;
  toggle: (key: string) => void;
  /** Eight lines are drawn: another has to go before a new one can come. */
  full: boolean;
}

/**
 * Who each line is, with their number. Pointing at a name brings its line forward. Ranked puts the
 * highest first with its place, for a race; otherwise the series keep their own order. With a
 * choice, every name is listed and clicking one draws or removes its line.
 */
export function Legend({
  series,
  format = count,
  ranked = false,
  marks,
  onHighlight,
  choice
}: {
  series: Series[];
  format?: (value: number) => string;
  ranked?: boolean;
  /** Extra words after a name, by series key: "(you)". */
  marks?: Map<string, string>;
  onHighlight?: (key: string | null) => void;
  choice?: LegendChoice;
}) {
  if (series.length < 2 && !choice) return null;
  const shown = ranked ? [...series].sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || a.name.localeCompare(b.name)) : series;
  return (
    <div className="mt-1.5">
      <ul className="flex flex-wrap gap-x-1 gap-y-0.5 text-[12px] text-ink-2" aria-label="Legend" onMouseLeave={() => onHighlight?.(null)}>
        {shown.map((item, index) => {
          const on = choice ? choice.isOn(item.key) : true;
          const blocked = !!choice && !on && choice.full;
          return (
            <li key={item.key}>
              <button
                type="button"
                aria-pressed={choice ? on : undefined}
                aria-disabled={blocked || undefined}
                title={choice ? (on ? 'Hide this line' : blocked ? 'Eight lines at most: hide one to show this' : 'Show this line') : undefined}
                className={cn('inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-surface-2 focus-visible:bg-surface-2', blocked && 'cursor-not-allowed')}
                onClick={() => {
                  if (!choice || blocked) return;
                  if (on) onHighlight?.(null);
                  choice.toggle(item.key);
                }}
                onMouseEnter={() => onHighlight?.(on ? item.key : null)}
                onFocus={() => onHighlight?.(on ? item.key : null)}
                onBlur={() => onHighlight?.(null)}
                data-legend={item.key}
                data-shown={on}
              >
                {ranked ? <span className="w-3.5 text-right tabular-nums text-ink-3">{index + 1}</span> : null}
                {on ? (
                  <LineMark color={item.color} dashed={item.dashed} />
                ) : (
                  <span className="inline-flex w-4 shrink-0 justify-center" aria-hidden>
                    <span className="size-2.5 rounded-full border border-border-strong" />
                  </span>
                )}
                <span className={on ? 'text-ink' : 'text-ink-3'}>
                  {item.name}
                  {marks?.get(item.key) ? <span className="text-ink-3"> {marks.get(item.key)}</span> : null}
                </span>
                {item.total !== null ? <span className={cn('font-semibold tabular-nums', on ? 'text-ink' : 'text-ink-3')}>{format(item.total)}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {choice ? (
        <p className="mt-0.5 px-1.5 text-[11.5px] text-ink-3" data-legend-hint>
          Click a name to show or hide its line{series.length > SERIES_SLOTS ? `; up to ${SERIES_SLOTS} at a time, ${series.length} in all` : ''}.
        </p>
      ) : null}
    </div>
  );
}

/** An axis that ends on a round number, with four or five round steps: whole ones for counts, finer ones for rates. */
export function niceScale(max: number, integer: boolean): { top: number; ticks: number[] } {
  const ceiling = max > 0 ? max : integer ? 4 : 1;
  const rough = ceiling / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const steps = [1, 2, 2.5, 5, 10].map((step) => step * magnitude).filter((step) => !integer || (Number.isInteger(step) && step >= 1));
  const step = steps.find((value) => value >= rough - 1e-9) ?? (integer ? Math.max(1, Math.ceil(rough)) : 10 * magnitude);
  const count = Math.max(1, Math.ceil(ceiling / step - 1e-9));
  return { top: count * step, ticks: Array.from({ length: count + 1 }, (_, index) => Number((index * step).toFixed(6))) };
}

export function useWidth(least = 280): [React.RefObject<HTMLDivElement | null>, number] {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(least, entry.contentRect.width)));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  return [box, width];
}

interface ChartProps {
  buckets: ActivityBucket[];
  group: ActivityGroup;
  series: Series[];
  /** What is shown, for screen readers: "bids per day, by person". */
  description: string;
  /** How a value reads: a count unless told otherwise. */
  format?: (value: number) => string;
  /** Whole steps on the axis, for counts. */
  integer?: boolean;
  footer?: ChartFooter;
  /** The series pointed at in the legend, drawn on top while the others fade. */
  highlighted?: string | null;
  /** Small, for a card: shorter, with no names at the lines' ends and only the top of the axis. */
  compact?: boolean;
  /** The least the axis reaches: charts side by side share one scale, so their heights compare. */
  least?: number;
}

const FULL_HEIGHT = 260;
const COMPACT_HEIGHT = 130;

/** The readout's last line: the footer given, or the series added up, or nothing. */
function footerAt(series: Series[], footer: ChartFooter | undefined, index: number): { label: string; value: number | null } | null {
  if (footer === null) return null;
  if (footer) return { label: footer.label, value: footer.values[index] ?? null };
  if (series.length < 2 || series.every((item) => item.values[index] === null)) return null;
  return { label: 'Total', value: series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0) };
}

/**
 * One line per series over the range, for comparing people or periods: an axis that starts at
 * zero, a crosshair with every value at the point under it, and, for four lines or fewer, names
 * at the lines' ends. The arrow keys read it point by point.
 */
export function LineChart({ buckets, group, series, description, format = count, integer = true, footer, highlighted = null, compact = false, least = 0 }: ChartProps) {
  const [box, width] = useWidth(compact ? 160 : 280);
  const [hover, setHover] = useState<number | null>(null);
  const CHART_HEIGHT = compact ? COMPACT_HEIGHT : FULL_HEIGHT;
  const values = series.flatMap((item) => item.values.filter((value): value is number => value !== null));
  const scale = niceScale(Math.max(0, least, ...values), integer);
  const top = scale.top;
  const ticks = compact ? [0, top] : scale.ticks;
  const solid = series.filter((item) => !item.dashed);
  const labelled = !compact && solid.length > 0 && solid.length <= 4;
  // Room for the longest tick on the left and the line names on the right.
  const margin = compact
    ? { top: 8, right: 8, bottom: 20, left: Math.max(22, 8 + Math.max(...ticks.map((tick) => format(tick).length)) * 6) }
    : { top: 12, right: labelled ? 104 : 16, bottom: 26, left: Math.max(30, 10 + Math.max(...ticks.map((tick) => format(tick).length)) * 6.6) };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = CHART_HEIGHT - margin.top - margin.bottom;
  const total = buckets.length;
  const slot = total > 0 ? plotWidth / total : plotWidth;
  const x = (index: number) => margin.left + slot * (index + 0.5);
  const y = (value: number) => margin.top + plotHeight - (value / top) * plotHeight;
  const every = Math.max(1, Math.ceil(total / Math.max(2, Math.floor(plotWidth / 58))));
  const manyYears = buckets[0]?.first.slice(0, 4) !== buckets[total - 1]?.last.slice(0, 4);
  const pointAt = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || total === 0) return null;
    return Math.min(total - 1, Math.max(0, Math.floor((clientX - rect.left - margin.left) / slot)));
  };
  const path = (points: Array<number | null>) => {
    let drawing = false;
    return points
      .map((value, index) => {
        if (value === null) {
          drawing = false;
          return '';
        }
        const step = `${drawing ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
        drawing = true;
        return step;
      })
      .join(' ');
  };
  const lastShown = (item: Series) => item.values.reduce<number>((last, value, index) => (value === null ? last : index), -1);
  const ends = solid.map((item) => ({ item, index: lastShown(item) })).filter((end) => end.index >= 0);
  const endYs = ends.map((end) => y(end.item.values[end.index] ?? 0)).sort((a, b) => a - b);
  const endsFit = labelled && endYs.every((value, index) => index === 0 || value - endYs[index - 1] >= 13);
  // The period before goes underneath, and the line pointed at on top.
  const order = [...series].sort((a, b) => Number(!a.dashed) - Number(!b.dashed) || Number(a.key === highlighted) - Number(b.key === highlighted) || Number(!!a.emphasis) - Number(!!b.emphasis));
  const faded = (item: Series) => highlighted !== null && item.key !== highlighted;
  const readout = hover !== null && buckets[hover] ? footerAt(series, footer, hover) : null;

  return (
    <div ref={box} className="relative" onMouseLeave={() => setHover(null)}>
      <svg
        width={width}
        height={CHART_HEIGHT}
        role="img"
        tabIndex={0}
        aria-label={`${description}. Use the arrow keys to read each ${group}.`}
        className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onMouseMove={(event) => setHover(pointAt(event.clientX))}
        onBlur={() => setHover(null)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') setHover((current) => Math.min(total - 1, (current ?? -1) + 1));
          else if (event.key === 'ArrowLeft') setHover((current) => Math.max(0, (current ?? total) - 1));
          else return;
          event.preventDefault();
        }}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={margin.left} x2={margin.left + plotWidth} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeWidth={1} />
            <text x={margin.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--ink-3)" className="tabular-nums">
              {format(tick)}
            </text>
          </g>
        ))}
        {buckets.map((bucket, index) =>
          (index % every === 0 && total - 1 - index >= every) || index === total - 1 ? (
            <text key={bucket.key} x={x(index)} y={CHART_HEIGHT - 8} textAnchor={total > 1 && index === total - 1 && slot < 40 ? 'end' : 'middle'} fontSize={11} fill="var(--ink-3)">
              {axisLabel(bucket, group, manyYears)}
            </text>
          ) : null
        )}
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={margin.top} y2={margin.top + plotHeight} stroke="var(--ink-3)" strokeWidth={1} strokeDasharray="2 3" /> : null}
        {order.map((item) => (
          <g key={item.key} opacity={faded(item) ? 0.18 : 1} data-series={item.key}>
            <path d={path(item.values)} fill="none" stroke={item.color} strokeWidth={item.key === highlighted ? 2.75 : item.emphasis ? 2.75 : compact ? 1.75 : 2} strokeDasharray={item.dashed ? '5 4' : undefined} strokeLinejoin="round" strokeLinecap="round" />
            {!item.dashed && !compact && buckets.length <= 16
              ? item.values.map((value, index) => (value === null ? null : <circle key={index} cx={x(index)} cy={y(value)} r={3} fill={item.color} stroke="var(--surface)" strokeWidth={1.5} />))
              : null}
            {hover !== null && item.values[hover] !== null ? <circle cx={x(hover)} cy={y(item.values[hover] ?? 0)} r={4.5} fill={item.color} stroke="var(--surface)" strokeWidth={2} /> : null}
          </g>
        ))}
        {endsFit
          ? ends.map(({ item, index }) => (
              <text key={item.key} x={x(index) + 8} y={y(item.values[index] ?? 0)} dominantBaseline="middle" fontSize={11.5} fill="var(--ink-2)" opacity={faded(item) ? 0.3 : 1}>
                {item.name.length > 11 ? `${item.name.slice(0, 10)}…` : item.name} <tspan fontWeight={600}>{format(item.values[index] ?? 0)}</tspan>
              </text>
            ))
          : null}
      </svg>
      {hover !== null && buckets[hover] ? (
        <div className="pointer-events-none absolute top-1 z-10 min-w-44 rounded-md border border-border bg-surface px-2.5 py-2 text-[12px] shadow-lg" style={{ left: Math.max(0, Math.min(x(hover) + 12, width - 220)) }} role="status">
          <p className="mb-1 font-medium text-ink">{bucketLabel(buckets[hover], group)}</p>
          {[...series]
            .sort((a, b) => (b.values[hover] ?? -1) - (a.values[hover] ?? -1))
            .map((item) => (
              <p key={item.key} className="flex items-center gap-1.5 text-ink-2">
                <LineMark color={item.color} dashed={item.dashed} />
                <span className="min-w-0 flex-1 truncate">
                  {item.name}
                  {item.pointLabels?.[hover] ? <span className="text-ink-3"> · {item.pointLabels[hover]}</span> : null}
                </span>
                <span className="font-semibold tabular-nums text-ink">{item.values[hover] === null ? '–' : format(item.values[hover] ?? 0)}</span>
              </p>
            ))}
          {readout ? (
            <p className="mt-1 flex justify-between gap-3 border-t border-border pt-1 text-ink-2">
              <span>{readout.label}</span>
              <span className="font-semibold tabular-nums text-ink">{readout.value === null ? '–' : format(readout.value)}</span>
            </p>
          ) : null}
          {series.every((item) => item.values[hover] === null) ? <p className="text-ink-3">Not yet begun</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The chart's numbers as a table, one column per series, with the footer's line at the end of each row. */
export function SeriesTable({ buckets, group, series, format = count, footer }: { buckets: ActivityBucket[]; group: ActivityGroup; series: Series[]; format?: (value: number) => string; footer?: ChartFooter }) {
  const footerName = footer === null ? null : (footer?.label ?? (series.length > 1 ? 'Total' : null));
  return (
    <div className="max-h-[300px] overflow-auto">
      <table className="w-full text-[12.5px] tabular-nums">
        <thead className="sticky top-0 bg-surface text-ink-3">
          <tr className="border-b border-border">
            <th className="py-1 pr-3 text-left font-normal">{GROUP_LABELS[group]}</th>
            {series.map((item) => (
              <th key={item.key} className="py-1 pr-3 text-right font-normal">
                {item.name}
              </th>
            ))}
            {footerName ? <th className="py-1 pr-3 text-right font-normal">{footerName}</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {buckets.map((bucket, index) => {
            const line = footerAt(series, footer, index);
            return (
              <tr key={bucket.key}>
                <td className="py-1 pr-3">{bucketLabel(bucket, group)}</td>
                {series.map((item) => (
                  <td key={item.key} className="py-1 pr-3 text-right">
                    {item.values[index] === null ? <span className="text-ink-3">–</span> : format(item.values[index] ?? 0)}
                  </td>
                ))}
                {footerName ? <td className="py-1 pr-3 text-right font-medium">{line && line.value !== null ? format(line.value) : <span className="text-ink-3">–</span>}</td> : null}
              </tr>
            );
          })}
        </tbody>
        {series.some((item) => item.total !== null) ? (
          <tfoot>
            <tr className="border-t border-border-strong font-semibold">
              <td className="py-1 pr-3">Total</td>
              {series.map((item) => (
                <td key={item.key} className="py-1 pr-3 text-right">
                  {item.total === null ? '' : format(item.total)}
                </td>
              ))}
              {footerName ? <td /> : null}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

// ---- Process and profiles ----------------------------------------------------------------

const STAGES: Array<{ key: keyof ActivityCounts['reached'] | 'applied'; label: string }> = [
  { key: 'applied', label: 'Applied' },
  { key: 'screen', label: 'Recruiter Screen' },
  { key: 'technical', label: 'Technical' },
  { key: 'final', label: 'Final' },
  { key: 'offer', label: 'Offer' }
];

/** How far the range's applications got: each stage as a bar against everything applied. */
export function Funnel({ counts }: { counts: ActivityCounts }) {
  const applied = counts.inRange;
  const value = (key: (typeof STAGES)[number]['key']) => (key === 'applied' ? applied : counts.reached[key]);
  return (
    <div>
      <ul aria-label="Furthest stage reached">
        {STAGES.map((stage, index) => {
          const reached = value(stage.key);
          const previous = index === 0 ? null : value(STAGES[index - 1].key);
          return (
            <li key={stage.key} className="grid grid-cols-[minmax(0,120px)_1fr_56px_96px] items-center gap-x-2.5 border-b border-border py-1.5 text-[12.5px] last:border-b-0" data-stage={stage.key}>
              <span className="truncate text-ink-2">{stage.label}</span>
              <div className="relative h-3">
                <div className="absolute inset-0 rounded-[3px] bg-surface-2" />
                {reached > 0 && applied > 0 ? <div className="absolute inset-y-0 left-0 rounded-r-[4px] bg-accent" style={{ width: `${(reached / applied) * 100}%` }} /> : null}
              </div>
              <span className="text-right font-semibold tabular-nums text-ink">{count(reached)}</span>
              <span className="text-right text-[11.5px] tabular-nums text-ink-3" title={previous === null ? undefined : `${reached} of the ${previous} at the stage before`}>
                {index === 0 ? '' : `${percent(share(reached, applied))} · ${percent(share(reached, previous ?? 0))} step`}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11.5px] text-ink-3">
        Rejected: <span className="font-semibold tabular-nums text-ink-2">{count(counts.reached.rejected)}</span> of {count(applied)} ({percent(share(counts.reached.rejected, applied))}). Each application counts at its furthest stage and every stage before it.
      </p>
    </div>
  );
}

type ProfileSort = 'inRange' | 'interviews' | 'interviewRate' | 'allTime' | 'allTimeInterviewRate';

const PROFILE_COLUMNS: Array<{ key: ProfileSort; label: string; title: string }> = [
  { key: 'inRange', label: 'Applied', title: 'Applications in the range' },
  { key: 'interviews', label: 'Interviews', title: 'Applications in the range that got an interview' },
  { key: 'interviewRate', label: 'Rate', title: 'Interview rate in the range' },
  { key: 'allTime', label: 'All time', title: 'Applications ever' },
  { key: 'allTimeInterviewRate', label: 'All-time rate', title: 'Interview rate over every application' }
];

export interface ProfileRow {
  profile: ActivityProfile;
  owner?: UserRef;
  isMine: boolean;
  color?: string;
}

/** Profiles side by side: which are used most, and which get interviews. Sorted by any column. */
export function ProfileTable({ rows, showOwner, rangeName, initialSort = 'inRange' }: { rows: ProfileRow[]; showOwner: boolean; rangeName: string; initialSort?: ProfileSort }) {
  const [sort, setSort] = useState<ProfileSort>(initialSort);
  const sorted = [...rows].sort((a, b) => (b.profile[sort] ?? -1) - (a.profile[sort] ?? -1) || b.profile.inRange - a.profile.inRange || a.profile.name.localeCompare(b.profile.name));
  const most = Math.max(1, ...rows.map((row) => row.profile.inRange));
  if (rows.length === 0) return <p className="py-4 text-center text-[12.5px] text-ink-3">No profiles yet</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead className="text-ink-3">
          <tr className="border-b border-border">
            <th className="py-1 pr-3 text-left font-normal">Profile</th>
            {showOwner ? <th className="py-1 pr-3 text-left font-normal">Person</th> : null}
            <th className="w-[22%] py-1 pr-3 text-left font-normal">Share of {rangeName.toLowerCase()}</th>
            {PROFILE_COLUMNS.map((column) => (
              <th key={column.key} className="py-1 pr-3 text-right font-normal" aria-sort={sort === column.key ? 'descending' : 'none'}>
                <button type="button" title={`${column.title}. Sort by this.`} onClick={() => setSort(column.key)} className={cn('inline-flex items-center gap-0.5 hover:text-ink', sort === column.key && 'font-medium text-ink')}>
                  {column.label}
                  {sort === column.key ? <ArrowDown className="size-3" aria-hidden /> : null}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {sorted.map(({ profile, owner, isMine, color }) => (
            <tr key={profile.id} className="border-b border-border last:border-b-0" data-profile-row={profile.name}>
              <td className="max-w-[180px] truncate py-1.5 pr-3">
                <span className="inline-flex items-center gap-1.5">
                  {color ? <span className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} aria-hidden /> : null}
                  <span className={cn('truncate', isMine && 'font-medium text-ink')}>{profile.name}</span>
                  {profile.isArchived ? <span className="text-ink-3">(archived)</span> : null}
                </span>
              </td>
              {showOwner ? <td className="max-w-[140px] truncate py-1.5 pr-3 text-ink-2">{owner ? `${userName(owner)}${isMine ? ' (you)' : ''}` : ''}</td> : null}
              <td className="py-1.5 pr-3">
                <div className="h-2 rounded-[3px] bg-surface-2">{profile.inRange > 0 ? <div className="h-full rounded-r-[3px] bg-accent" style={{ width: `${(profile.inRange / most) * 100}%` }} /> : null}</div>
              </td>
              <td className="py-1.5 pr-3 text-right font-semibold text-ink">{count(profile.inRange)}</td>
              <td className="py-1.5 pr-3 text-right text-ink-2">{count(profile.interviews)}</td>
              <td className="py-1.5 pr-3 text-right font-semibold text-ink">{percent(profile.interviewRate)}</td>
              <td className="py-1.5 pr-3 text-right text-ink-2">{count(profile.allTime)}</td>
              <td className="py-1.5 pr-3 text-right text-ink-2">{percent(profile.allTimeInterviewRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Holds the last numbers on screen, dimmed, while a new range loads, instead of flashing empty. */
export function Refreshing({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div className={cn('transition-opacity', active && 'opacity-60')}>{children}</div>;
}
