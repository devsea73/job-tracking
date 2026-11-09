import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { TREND_METRICS, type ActivityResponse, type TrendMetric, type TrendTotal } from '@shared/api';
import { cn } from '@/lib/utils';
import { bucketLabel, bucketStart, count, GROUP_LABELS, Legend, LineChart, OTHERS_COLOR, percent, SERIES_SLOTS, seriesColor, SeriesTable, shapeValues, spanLabel, TableSwitch, Toggle, type ChartFooter, type Filters, type Series } from './analytics';

/**
 * The measures side by side, the way web analytics shows them: a tab for each with its total and
 * how it moved against the period before, and over them the chosen one as lines over time.
 */

export const TREND_INFO: Record<TrendMetric, { label: string; rate?: boolean; about: string }> = {
  bids: { label: 'Bids', about: 'Applications sent, on the day they were applied.' },
  interviews: { label: 'Interviews', about: 'Applications that got an interview, on the day of their first one: the time entered for it, not when it was saved.' },
  technical: { label: 'Technical', about: 'Applications that reached Technical Interview, on the day of their first technical round (or a later stage).' },
  final: { label: 'Final', about: 'Applications that reached Final Interview, on the day of their final interview (or offer).' },
  offers: { label: 'Offers', about: 'Applications that got an offer, on the day it came.' },
  success: { label: 'Success rate', rate: true, about: 'Offers out of every application up to that point, all time.' }
};

export const formatRate = (value: number) => percent(value);
export const formatterFor = (metric: TrendMetric) => (TREND_INFO[metric].rate ? formatRate : count);

/** Up or down against the period before: a percentage for counts, points for a rate. Higher is better for every measure here. */
function Change({ total, rate }: { total: TrendTotal; rate: boolean }) {
  const { current, previous } = total;
  if (current === null || previous === null) return <span className="text-[12px] text-ink-3">–</span>;
  const difference = Math.round((current - previous) * 10) / 10;
  const amount = rate ? `${Math.abs(difference).toFixed(1)} pts` : previous > 0 ? `${Math.round((Math.abs(difference) / previous) * 100)}%` : count(Math.abs(difference));
  const Icon = difference > 0 ? ArrowUp : ArrowDown;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[12px] font-medium tabular-nums', difference > 0 ? 'text-success-ink' : difference < 0 ? 'text-danger-ink' : 'text-ink-3')}>
      {difference !== 0 ? <Icon className="size-3" aria-hidden /> : null}
      {difference === 0 ? '±0' : `${!rate && previous === 0 ? '+' : ''}${amount}`}
    </span>
  );
}

export interface TrendView {
  series: Series[];
  footer?: ChartFooter;
  /** Ranked legend: the highest first, with its place. */
  ranked?: boolean;
  /** Extra words after a name in the legend, by series key. */
  marks?: Map<string, string>;
  /**
   * The lines are chosen in the legend, eight at most at a time, each in a color of its own. The
   * first ones drawn are the most active here (bids over the range), so everyone starts on the
   * same chart. The series' own colors are then ignored.
   */
  choose?: Map<string, number>;
  /** The color of a line drawn in the given place; left out, the standard palette's. */
  colorOf?: (key: string, slot: number) => string;
  /** The viewer's own lines: always drawn at first, on top of the rest. */
  mine?: Set<string>;
}

/**
 * The lines drawn at first: the viewer's own, then the most active, eight at most, each in a place
 * of the series' own order.
 */
export function firstChoice(series: Series[], activity: Map<string, number>, mine?: Set<string>): Map<string, number> {
  const order = new Map(series.map((item, index) => [item.key, index]));
  const place = (key: string) => order.get(key) ?? 0;
  const own = (key: string) => Number(mine?.has(key) ?? false);
  const top = [...series].sort((a, b) => own(b.key) - own(a.key) || (activity.get(b.key) ?? 0) - (activity.get(a.key) ?? 0) || place(a.key) - place(b.key)).slice(0, SERIES_SLOTS);
  return new Map(top.sort((a, b) => place(a.key) - place(b.key)).map((item, index) => [item.key, index]));
}

export function TrendCard({
  data,
  filters,
  who,
  totals,
  build,
  controls,
  racing = false
}: {
  data: ActivityResponse;
  filters: Filters;
  /** Whose lines these are, for the title: "Everyone", "Me". */
  who: string;
  /** Each tab's number, now and in the period before. */
  totals: (metric: TrendMetric) => TrendTotal;
  build: (metric: TrendMetric, cumulative: boolean) => TrendView;
  /** More switches, next to the running-total one. */
  controls?: React.ReactNode;
  /** A race between people: running totals unless chosen otherwise, which show who is ahead at every point. */
  racing?: boolean;
}) {
  const id = useId();
  const [metric, setMetric] = useState<TrendMetric>('bids');
  const [cumulativeChoice, setCumulativeChoice] = useState<{ key: string; value: boolean } | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const info = TREND_INFO[metric];
  // Left alone, a race and a single day show running totals: who is ahead, at every point. A choice lasts until the range changes.
  const cumulative = !info.rate && (cumulativeChoice?.key === filters.rangeKey ? cumulativeChoice.value : racing || data.group === 'hour');
  const built = useMemo(() => build(metric, cumulative), [build, metric, cumulative]);
  const format = formatterFor(metric);
  const compared = data.previous.compared;
  const per = GROUP_LABELS[data.group].toLowerCase();

  // Lines chosen in the legend keep their colors while others come and go. A choice holds while
  // the same people or profiles are listed; until one is made, the most active are drawn.
  const listed = built.series.map((item) => item.key).join(',');
  const [choice, setChoice] = useState<{ listed: string; slots: Map<string, number> } | null>(null);
  const slots = built.choose ? (choice?.listed === listed ? choice.slots : firstChoice(built.series, built.choose, built.mine)) : null;
  const colorOf = built.colorOf ?? ((_key: string, slot: number) => seriesColor(slot));
  const colored = slots
    ? built.series.map((item) => ({ ...item, emphasis: built.mine?.has(item.key), color: slots.has(item.key) ? colorOf(item.key, slots.get(item.key) ?? 0) : OTHERS_COLOR }))
    : built.series;
  const drawn = slots ? colored.filter((item) => slots.has(item.key)) : colored;
  const legendChoice = slots
    ? {
        isOn: (key: string) => slots.has(key),
        full: slots.size >= SERIES_SLOTS,
        toggle: (key: string) => {
          const next = new Map(slots);
          if (next.has(key)) next.delete(key);
          else if (next.size < SERIES_SLOTS) {
            const taken = new Set(next.values());
            let slot = 0;
            while (taken.has(slot)) slot += 1;
            next.set(key, slot);
          }
          setChoice({ listed, slots: next });
        }
      }
    : undefined;
  const shown = { ...built, series: drawn };

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TREND_METRICS[(TREND_METRICS.indexOf(metric) + step + TREND_METRICS.length) % TREND_METRICS.length];
    setMetric(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };

  return (
    <section aria-label={`${who}: trends`} data-trend-card={who} className="overflow-hidden rounded-md border border-border bg-surface">
      <div role="tablist" aria-label="Measure" className="grid grid-cols-3 border-b border-border lg:grid-cols-6" onKeyDown={onTabKey}>
        {TREND_METRICS.map((key) => {
          const total = totals(key);
          const selected = key === metric;
          const value = total.current === null ? '–' : formatterFor(key)(total.current);
          return (
            <button
              key={key}
              type="button"
              role="tab"
              id={`${id}-tab-${key}`}
              aria-selected={selected}
              aria-controls={`${id}-panel`}
              tabIndex={selected ? 0 : -1}
              title={`${TREND_INFO[key].about}${compared ? `\n${spanLabel(compared.current)}: ${value} · ${spanLabel(compared.previous)}: ${total.previous === null ? '–' : formatterFor(key)(total.previous)}` : ''}`}
              onClick={() => setMetric(key)}
              className={cn('relative flex min-w-0 flex-col items-start border-b border-r border-border px-3.5 pb-2.5 pt-3 text-left lg:border-b-0', selected ? 'bg-surface' : 'bg-surface-2/60 hover:bg-surface-2')}
              data-trend-tab={key}
            >
              {selected ? <span className="absolute inset-x-0 top-0 h-[3px] bg-accent" aria-hidden /> : null}
              <span className={cn('max-w-full truncate text-[12.5px]', selected ? 'font-medium text-accent-soft-ink' : 'text-ink-2')}>{TREND_INFO[key].label}</span>
              <span className="text-[24px] font-semibold leading-tight tabular-nums text-ink" data-trend-value>
                {value}
              </span>
              <Change total={total} rate={!!TREND_INFO[key].rate} />
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${metric}`} className="px-3 pb-3 pt-2">
        <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
            {who} · {info.rate ? `${info.label.toLowerCase()} by ${per}` : `${info.label.toLowerCase()} per ${per}${cumulative ? ', running total' : ''}`}
            <span className="font-normal text-ink-3"> · {filters.label}</span>
          </p>
          {controls}
          <Toggle
            label="Show"
            value={cumulative ? 'total' : 'each'}
            onChange={(value) => setCumulativeChoice({ key: filters.rangeKey, value: value === 'total' })}
            options={[
              { value: 'each', label: `Per ${per}`, disabled: !!info.rate },
              { value: 'total', label: 'Running total', disabled: !!info.rate, title: info.rate ? 'A rate is already as it stood at each point' : undefined }
            ]}
          />
          <TableSwitch view={view} onChange={setView} />
        </div>
        {view === 'table' ? (
          <SeriesTable buckets={data.buckets} group={data.group} series={shown.series} format={format} footer={shown.footer} />
        ) : (
          <>
            <LineChart
              buckets={data.buckets}
              group={data.group}
              series={shown.series}
              format={format}
              integer={!info.rate}
              footer={shown.footer}
              highlighted={highlighted}
              description={`${who}: ${info.label.toLowerCase()} per ${per}${cumulative ? ', running total' : ''}, ${filters.label}`}
            />
            <Legend series={slots ? colored : shown.series} format={format} ranked={shown.ranked} marks={shown.marks} onHighlight={setHighlighted} choice={legendChoice} />
          </>
        )}
        <p className="mt-1.5 text-[11.5px] text-ink-3" data-trend-about>
          {info.about}
          {compared ? ` Changes compare ${spanLabel(compared.current)} with ${spanLabel(compared.previous)}.` : ' The range has not begun.'}
        </p>
      </div>
    </section>
  );
}

// ---- Building the lines -------------------------------------------------------------------

/** A measure as drawn: counts per period or running, a rate as it stood; periods still to come left out. */
export function shapeTrend(raw: Array<number | null>, data: ActivityResponse, metric: TrendMetric, cumulative: boolean, now: Date): Array<number | null> {
  if (TREND_INFO[metric].rate) return raw.map((value, index) => (data.buckets[index] && bucketStart(data.buckets[index], data.group) <= now ? value : null));
  return shapeValues(raw, data.buckets, data.group, now, cumulative);
}

/** What a legend shows for a line: the count over the periods so far, or the rate as it stands now. */
export function standing(raw: Array<number | null>, data: ActivityResponse, metric: TrendMetric, now: Date): number | null {
  const values = shapeTrend(raw, data, metric, false, now);
  if (TREND_INFO[metric].rate) return values.reduce<number | null>((last, value) => (value === null ? last : value), null);
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/**
 * A line for every person or profile, in a fixed order (by id), with how many bids each sent over
 * the range: the legend lists them all and draws the most active first, each in its own color.
 */
export function entityChoices<T>(
  items: T[],
  describe: (item: T) => { id: number; key: string; name: string; raw: Array<number | null>; bids: Array<number | null> },
  data: ActivityResponse,
  metric: TrendMetric,
  cumulative: boolean,
  now: Date
): Pick<TrendView, 'series' | 'choose'> {
  const entries = items.map(describe).sort((a, b) => a.id - b.id);
  return {
    series: entries.map((entry) => ({ key: entry.key, name: entry.name, color: OTHERS_COLOR, values: shapeTrend(entry.raw, data, metric, cumulative, now), total: standing(entry.raw, data, metric, now) })),
    choose: new Map(entries.map((entry) => [entry.key, standing(entry.bids, data, 'bids', now) ?? 0]))
  };
}

/** The period before as a dashed line under this one, point for point, named by its own days. */
export function previousLine(raw: Array<number | null>, data: ActivityResponse, metric: TrendMetric, cumulative: boolean): Series {
  let running = 0;
  const shaped = raw.map((value) => {
    if (TREND_INFO[metric].rate) return value;
    running += value ?? 0;
    return cumulative ? running : (value ?? 0);
  });
  return {
    key: 'previous',
    name: 'Previous period',
    color: OTHERS_COLOR,
    dashed: true,
    total: null,
    values: data.buckets.map((_, index) => (index < shaped.length ? shaped[index] : null)),
    pointLabels: data.buckets.map((_, index) => (data.previous.buckets[index] ? bucketLabel(data.previous.buckets[index], data.group) : null))
  };
}
