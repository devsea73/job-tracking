import { useCallback, useMemo, useState } from 'react';
import { Activity, ArrowDown, CalendarDays, CodeXml, Filter, ImageOff, Percent, Phone, Send, Trophy, User, UserRound, UsersRound, type LucideIcon } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { STAGES as EVERY_STAGE, type Stage } from '@shared/constants';
import { stageInk } from '@/components/symbols';
import type { ActivityPerson, ActivityProfile, ActivityResponse, CurrentUser, TeamBoardRow, TeamMember, TrendMetric } from '@shared/api';
import type { PassRate, ProcessStats } from '@shared/pipeline';
import { Avatar, userLabel, userName } from '@/components/job-bits';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { ANY, Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { call, errorMessage, useActivity, useTeam, useTeamApplications } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  count,
  Delta,
  FilterBar,
  fullDay,
  Legend,
  LineChart,
  LineMark,
  ME_COLOR,
  mineColor,
  monthYear,
  niceScale,
  othersColor,
  Panel,
  percent,
  ProfileTable,
  Refreshing,
  seriesColor,
  share,
  spanLabel,
  TableSwitch,
  Tile,
  useWidth,
  Toggle,
  toLocal,
  useFilters,
  type Filters,
  type Series
} from './analytics';
import { entityChoices, firstChoice, shapeTrend, TREND_INFO, TrendCard, type TrendView } from './trend-card';

/**
 * Everyone side by side, today unless another range is chosen, as pictures more than numbers: the
 * measures as lines, one per person, yours in red and everyone else's in blue; a card for each
 * person with their own measures as lines and where their applications are now; how far each
 * person's applications got, as lines through the stages; who gets interviews; and which profiles
 * work. The all-time process follows below.
 */

// ---- Colors: you in red, everyone else in blue ---------------------------------------------

/** Your own lines red (your profiles in reds), everyone else's a blue by the place their line takes. */
function teamColors(mineKeys: string[]): Pick<TrendView, 'colorOf' | 'mine'> {
  const mine = new Set(mineKeys);
  const order = new Map(mineKeys.map((key, index) => [key, index]));
  return { mine, colorOf: (key, slot) => (mine.has(key) ? mineColor(order.get(key) ?? 0) : othersColor(slot)) };
}

/** Each person's color, the one their line has in the chart of people: you red, the rest blue. */
function usePersonColors(data: ActivityResponse, now: Date): Map<number, string> {
  return useMemo(() => {
    const me = data.people.find((person) => person.isMe);
    const people = entityChoices(data.people, (person) => ({ id: person.user.id, key: `u${person.user.id}`, name: userName(person.user), raw: person.trends.bids, bids: person.trends.bids }), data, 'bids', false, now);
    const mine = new Set(me ? [`u${me.user.id}`] : []);
    const slots = firstChoice(people.series, people.choose ?? new Map<string, number>(), mine);
    let spare = slots.size;
    return new Map(
      data.people.map((person) => {
        const key = `u${person.user.id}`;
        if (person.isMe) return [person.user.id, ME_COLOR];
        return [person.user.id, othersColor(slots.get(key) ?? spare++)];
      })
    );
  }, [data, now]);
}

// ---- Each person's activity, as a card -----------------------------------------------------

/** The measures drawn in every person's card, each in the same color in every card. */
const CARD_MEASURES: Array<{ metric: Exclude<TrendMetric, 'success'>; color: string }> = [
  { metric: 'bids', color: seriesColor(0) },
  { metric: 'interviews', color: seriesColor(1) },
  { metric: 'technical', color: seriesColor(2) },
  { metric: 'final', color: seriesColor(3) },
  { metric: 'offers', color: seriesColor(6) }
];

const STAGE_SHORT: Record<Stage, string> = {
  Applied: 'Applied',
  'Recruiter Screen': 'Screen',
  'Technical Interview': 'Technical',
  'Final Interview': 'Final',
  Offer: 'Offer',
  Rejected: 'Rejected'
};

/** Where one person's applications from the range are now, as one bar split by stage. */
function StageBar({ row }: { row: TeamBoardRow | undefined }) {
  if (!row || row.total === 0) return <div className="h-2.5 rounded-[3px] bg-surface-2" title="No applications in the range" />;
  const parts = EVERY_STAGE.filter((stage) => row.stages[stage] > 0);
  return (
    <div>
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-[3px]" role="img" aria-label={`Where the ${row.total} applications are now: ${parts.map((stage) => `${stage} ${row.stages[stage]}`).join(', ')}`}>
        {parts.map((stage) => (
          <div key={stage} title={`${stage}: ${row.stages[stage]}`} style={{ flexGrow: row.stages[stage], backgroundColor: stageInk(stage) }} />
        ))}
      </div>
      <p className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-ink-3">
        {parts.map((stage) => (
          <span key={stage} className="inline-flex items-center gap-1">
            <span className="size-2 rounded-[2px]" style={{ backgroundColor: stageInk(stage) }} aria-hidden />
            {STAGE_SHORT[stage]} <span className="font-semibold tabular-nums text-ink-2">{row.stages[stage]}</span>
          </span>
        ))}
      </p>
    </div>
  );
}

function PersonCard({
  person,
  color,
  rangeName,
  people,
  lead,
  data,
  now,
  board,
  scaleTop
}: {
  person: ActivityPerson;
  color: string;
  rangeName: string;
  people: number;
  lead: string;
  data: ActivityResponse;
  now: Date;
  board: TeamBoardRow | undefined;
  /** The same axis for every card, so their heights compare. */
  scaleTop: number;
}) {
  // Running totals over the range: how each measure built up, all of them in one small chart.
  const lines: Series[] = CARD_MEASURES.map(({ metric, color: line }) => ({
    key: metric,
    name: TREND_INFO[metric].label,
    color: line,
    total: null,
    values: shapeTrend(person.trends[metric], data, metric, true, now)
  }));
  return (
    <li
      data-person-card={person.user.username}
      className={cn('flex flex-col rounded-md border bg-surface px-3 py-2.5', person.isMe ? 'border-[color:var(--me-line)]' : 'border-border')}
      title={person.profiles.length ? `By profile, ${rangeName.toLowerCase()}:\n${person.profiles.map((profile) => `${profile.name}: ${profile.inRange}`).join('\n')}` : undefined}
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
      <div className="mt-2" data-person-chart>
        <LineChart buckets={data.buckets} group={data.group} series={lines} compact least={scaleTop} description={`${userName(person.user)}: bids, interviews, technical, final and offers, running totals, ${rangeName}`} footer={null} />
      </div>
      <div className="mt-2">
        <p className="mb-1 text-[11px] text-ink-3">Where these applications are now</p>
        <StageBar row={board} />
      </div>
      {/* Two different counts, each named for what it counts: applications that got one, and interviews by their date. */}
      <p className="mt-1.5 text-[11.5px] text-ink-2">
        <span title={`${person.interviews} of the ${person.inRange} applications made ${rangeName.toLowerCase()} got an interview: a step past Applied on its timeline`}>
          Got an interview <span className="font-semibold tabular-nums text-ink">{count(person.interviews)}</span>/{count(person.inRange)} · <span className="font-semibold text-ink">{percent(person.interviewRate)}</span>
        </span>
        <span className="text-ink-3" title="Interviews whose date falls in the range, whenever their application was made">
          {' '}
          · {count(person.scheduled)} {person.scheduled === 1 ? 'interview' : 'interviews'} dated in range
        </span>
      </p>
    </li>
  );
}

/** Ranked bars on one scale, with the counts behind each rate and the team's rate as a mark. */
function InterviewRanking({ data, colors }: { data: ActivityResponse; colors: Map<number, string> }) {
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
              {person.interviewRate ? <div className="absolute inset-y-0 left-0 rounded-r-[4px]" style={{ width: at(person.interviewRate), backgroundColor: colors.get(person.user.id) ?? othersColor(0) }} /> : null}
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

type PipelineSort = 'inRange' | 'screen' | 'technical' | 'final' | 'offer' | 'rejected' | 'interviewRate' | 'offerRate' | 'scheduled';

const PIPELINE_COLUMNS: Array<{ key: PipelineSort; label: string; title: string; rate?: boolean }> = [
  { key: 'inRange', label: 'Applied', title: 'Applications in the range' },
  { key: 'screen', label: 'Screen', title: 'Reached Recruiter Screen or later' },
  { key: 'technical', label: 'Technical', title: 'Reached Technical Interview or later' },
  { key: 'final', label: 'Final', title: 'Reached Final Interview or later' },
  { key: 'offer', label: 'Offer', title: 'Got an offer' },
  { key: 'rejected', label: 'Rejected', title: 'Turned down, at any stage' },
  { key: 'interviewRate', label: 'Interview rate', title: 'Got an interview: a step past Applied on its timeline', rate: true },
  { key: 'offerRate', label: 'Offer rate', title: 'Offers out of applications', rate: true },
  { key: 'scheduled', label: 'Interviews dated', title: 'Interviews whose date falls in the range' }
];

function pipelineValue(person: ActivityPerson, key: PipelineSort): number {
  switch (key) {
    case 'inRange':
    case 'scheduled':
      return person[key];
    case 'interviewRate':
      return person.interviewRate ?? -1;
    case 'offerRate':
      return share(person.reached.offer, person.inRange) ?? -1;
    default:
      return person.reached[key];
  }
}

/** Each person's applications in the range, stage by stage, with the team's totals. Sorted by any column. */
function PipelineTable({ data }: { data: ActivityResponse }) {
  const [sort, setSort] = useState<PipelineSort>('inRange');
  const rows = [...data.people].sort((a, b) => pipelineValue(b, sort) - pipelineValue(a, sort) || a.rank - b.rank);
  const cell = (person: Pick<ActivityPerson, 'inRange' | 'reached' | 'interviewRate' | 'scheduled'>, key: PipelineSort) => {
    switch (key) {
      case 'interviewRate':
        return percent(person.interviewRate);
      case 'offerRate':
        return percent(share(person.reached.offer, person.inRange));
      case 'inRange':
      case 'scheduled':
        return count(person[key]);
      default: {
        const reached = person.reached[key];
        return (
          <>
            {count(reached)}
            {person.inRange > 0 ? <span className="ml-1 text-[11px] text-ink-3">{percent(share(reached, person.inRange))}</span> : null}
          </>
        );
      }
    }
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead className="text-ink-3">
          <tr className="border-b border-border">
            <th className="py-1 pr-3 text-left font-normal">Person</th>
            {PIPELINE_COLUMNS.map((column) => (
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
          {rows.map((person) => (
            <tr key={person.user.id} className="border-b border-border" data-pipeline-row={person.user.username}>
              <td className={cn('max-w-[160px] truncate py-1.5 pr-3', person.isMe ? 'font-semibold text-ink' : 'text-ink-2')}>
                {userName(person.user)}
                {person.isMe ? ' (you)' : ''}
              </td>
              {PIPELINE_COLUMNS.map((column) => (
                <td key={column.key} className={cn('whitespace-nowrap py-1.5 pr-3 text-right', column.key === 'inRange' || column.rate ? 'font-semibold text-ink' : 'text-ink-2')}>
                  {cell(person, column.key)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot className="tabular-nums">
          <tr className="border-t border-border-strong font-semibold">
            <td className="py-1.5 pr-3">Team</td>
            {PIPELINE_COLUMNS.map((column) => (
              <td key={column.key} className="whitespace-nowrap py-1.5 pr-3 text-right">
                {cell(data.team, column.key)}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
      <p className="mt-2 text-[11.5px] text-ink-3">Of the applications made in the range. Each counts at its furthest stage and every stage before it; percentages are of what was applied.</p>
    </div>
  );
}

const STAGE_POINTS: Array<{ label: string; of: (person: Pick<ActivityPerson, 'inRange' | 'reached'>) => number }> = [
  { label: 'Applied', of: (person) => person.inRange },
  { label: 'Screen', of: (person) => person.reached.screen },
  { label: 'Technical', of: (person) => person.reached.technical },
  { label: 'Final', of: (person) => person.reached.final },
  { label: 'Offer', of: (person) => person.reached.offer }
];

/**
 * How far each person's applications got, as one line per person through the stages: as a share
 * of what they applied, so people who apply more or less can be compared, or as counts. Yours is
 * red. Pointing at a name or a stage reads the numbers.
 */
function StageLines({ data, colors }: { data: ActivityResponse; colors: Map<number, string> }) {
  const [measure, setMeasure] = useState<'share' | 'count'>('share');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const valueOf = (person: Pick<ActivityPerson, 'inRange' | 'reached'>, index: number) => {
    const reached = STAGE_POINTS[index].of(person);
    return measure === 'count' ? reached : (share(reached, person.inRange) ?? 0);
  };
  const format = measure === 'count' ? count : (value: number) => `${Math.round(value)}%`;
  const series: Series[] = data.people
    .filter((person) => person.inRange > 0)
    .map((person) => ({
      key: `u${person.user.id}`,
      name: userName(person.user),
      color: colors.get(person.user.id) ?? othersColor(0),
      emphasis: person.isMe,
      total: person.inRange,
      values: STAGE_POINTS.map((_, index) => valueOf(person, index))
    }));
  const [box, width] = useWidth(320);
  const height = 250;
  const margin = { top: 12, right: 18, bottom: 26, left: 40 };
  const { top, ticks } = niceScale(Math.max(measure === 'share' ? 100 : 1, ...series.flatMap((item) => item.values.map((value) => value ?? 0))), true);
  const step = (width - margin.left - margin.right) / (STAGE_POINTS.length - 1);
  const x = (index: number) => margin.left + step * index;
  const y = (value: number) => margin.top + (height - margin.top - margin.bottom) * (1 - value / top);
  const order = [...series].sort((a, b) => Number(a.key === highlighted) - Number(b.key === highlighted) || Number(!!a.emphasis) - Number(!!b.emphasis));
  const marks = new Map(data.people.filter((person) => person.isMe).map((person) => [`u${person.user.id}`, '(you)']));

  if (series.length === 0) return <p className="py-6 text-center text-[12.5px] text-ink-3">Nobody applied in the range.</p>;
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center justify-end gap-2">
        <Toggle
          label="Measure"
          value={measure}
          onChange={setMeasure}
          options={[
            { value: 'share', label: 'Share of applied' },
            { value: 'count', label: 'Count' }
          ]}
        />
        <TableSwitch view={view} onChange={setView} />
      </div>
      {view === 'table' ? (
        <PipelineTable data={data} />
      ) : (
        <>
          <div ref={box} className="relative" onMouseLeave={() => setHover(null)}>
            <svg width={width} height={height} role="img" aria-label={`How far each person's applications got, ${measure === 'share' ? 'as a share of what they applied' : 'as counts'}, by stage`}>
              {ticks.map((tick) => (
                <g key={tick}>
                  <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} stroke="var(--border)" />
                  <text x={margin.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--ink-3)">
                    {format(tick)}
                  </text>
                </g>
              ))}
              {STAGE_POINTS.map((stage, index) => (
                <g key={stage.label}>
                  {hover === index ? <line x1={x(index)} x2={x(index)} y1={margin.top} y2={height - margin.bottom} stroke="var(--ink-3)" strokeDasharray="2 3" /> : null}
                  <text x={x(index)} y={height - 8} textAnchor={index === 0 ? 'start' : index === STAGE_POINTS.length - 1 ? 'end' : 'middle'} fontSize={11} fill="var(--ink-3)">
                    {stage.label}
                  </text>
                  {/* The whole column is the place to point at. */}
                  <rect x={x(index) - step / 2} y={0} width={step} height={height} fill="transparent" onMouseEnter={() => setHover(index)} />
                </g>
              ))}
              {order.map((item) => (
                <g key={item.key} opacity={highlighted !== null && item.key !== highlighted ? 0.15 : 1} data-stage-line={item.key} pointerEvents="none">
                  <path d={item.values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(value ?? 0).toFixed(1)}`).join(' ')} fill="none" stroke={item.color} strokeWidth={item.emphasis || item.key === highlighted ? 3 : 2} strokeLinejoin="round" />
                  {item.values.map((value, index) => (
                    <circle key={index} cx={x(index)} cy={y(value ?? 0)} r={item.emphasis ? 3.5 : 2.5} fill={item.color} stroke="var(--surface)" strokeWidth={1.5} />
                  ))}
                </g>
              ))}
            </svg>
            {hover !== null ? (
              <div className="pointer-events-none absolute top-1 z-10 min-w-44 rounded-md border border-border bg-surface px-2.5 py-2 text-[12px] shadow-lg" style={{ left: Math.max(0, Math.min(x(hover) + 12, width - 220)) }} role="status">
                <p className="mb-1 font-medium text-ink">{STAGE_POINTS[hover].label}</p>
                {[...series]
                  .sort((a, b) => (b.values[hover] ?? 0) - (a.values[hover] ?? 0))
                  .map((item) => (
                    <p key={item.key} className="flex items-center gap-1.5 text-ink-2">
                      <LineMark color={item.color} />
                      <span className="min-w-0 flex-1 truncate">
                        {item.name}
                        {marks.get(item.key) ? ` ${marks.get(item.key)}` : ''}
                      </span>
                      <span className="font-semibold tabular-nums text-ink">{format(item.values[hover] ?? 0)}</span>
                    </p>
                  ))}
              </div>
            ) : null}
          </div>
          <Legend series={series} format={(value) => `${count(value)} applied`} ranked marks={marks} onHighlight={setHighlighted} />
        </>
      )}
      <p className="mt-1.5 text-[11.5px] text-ink-3">Of the applications made in the range, how many reached each stage or went further. A line that stays high goes further.</p>
    </div>
  );
}

type TeamLines = 'people' | 'profiles';

/** "Backend · Andy": the profile, and whose it is. A first profile named after its owner needs no repeating. */
function profileLine(profile: ActivityProfile, owner: ActivityPerson): string {
  const who = userName(owner.user);
  return `${profile.name === who ? who : `${profile.name} · ${who}`}${profile.isArchived ? ' (archived)' : ''}`;
}

/**
 * Everyone's lines on one chart, one per person or one per profile, each in its own color: the same
 * chart for everyone who opens it, until they pick other lines in the legend. Nobody's line is drawn
 * differently; only the legend marks your own.
 */
function useTeamTrends(data: ActivityResponse, now: Date, lines: TeamLines) {
  const build = useCallback(
    (metric: TrendMetric, cumulative: boolean): TrendView => {
      const footer = { label: 'Team', values: shapeTrend(data.teamTrends[metric], data, metric, cumulative, now) };
      if (lines === 'profiles') {
        const profiles = data.people.flatMap((person) => person.profiles.map((profile) => ({ person, profile })));
        const mine = profiles.filter(({ person }) => person.isMe).map(({ profile }) => `p${profile.id}`);
        return {
          ...entityChoices(profiles, ({ person, profile }) => ({ id: profile.id, key: `p${profile.id}`, name: profileLine(profile, person), raw: profile.trends[metric], bids: profile.trends.bids }), data, metric, cumulative, now),
          ...teamColors(mine),
          footer,
          ranked: true,
          marks: new Map(mine.map((key) => [key, '(yours)']))
        };
      }
      const mine = data.people.filter((person) => person.isMe).map((person) => `u${person.user.id}`);
      return {
        ...entityChoices(data.people, (person) => ({ id: person.user.id, key: `u${person.user.id}`, name: userName(person.user), raw: person.trends[metric], bids: person.trends.bids }), data, metric, cumulative, now),
        ...teamColors(mine),
        footer,
        ranked: true,
        marks: new Map(mine.map((key) => [key, '(you)']))
      };
    },
    [data, now, lines]
  );
  const totals = useCallback((metric: TrendMetric) => data.teamTrendTotals[metric], [data]);
  return { build, totals };
}

function TeamAnalytics({ filters, data }: { filters: Filters; data: ActivityResponse }) {
  const { rangeName, label, now } = filters;
  const [lines, setLines] = useState<TeamLines>('people');
  const trends = useTeamTrends(data, now, lines);
  const profileCount = data.people.reduce((sum, person) => sum + person.profiles.length, 0);
  const ranked = [...data.people].sort((a, b) => a.rank - b.rank);
  // Each person keeps one color everywhere on the page: yours red, everyone else's the blue of their line.
  const colors = usePersonColors(data, now);
  // Where everyone's applications from the range are now, person by person. Only the counts are needed.
  const statuses = useTeamApplications({ tz: filters.tz, from: filters.range.first, to: filters.range.last, limit: 1 });
  const boardOf = new Map((statuses.data?.board ?? []).map((row) => [row.user.id, row]));
  // The most anyone sent: bids are the highest line in every card, so this tops them all.
  const scaleTop = Math.max(0, ...data.people.map((person) => person.inRange));

  const leadOf = (person: ActivityPerson): string => {
    if (person.inRange === 0) return '';
    if (person.rank > 1) return person.behindLeader === 0 ? 'Tied for #1' : `${count(person.behindLeader)} behind #1`;
    const margin = person.inRange - (ranked[1]?.inRange ?? 0);
    return margin === 0 ? 'Tied for #1' : `Leads by ${count(margin)}`;
  };
  const activeToday = data.people.filter((person) => person.today > 0).length;
  const profileRows = data.people.flatMap((person) => person.profiles.map((profile) => ({ profile, owner: person.user, isMine: person.isMe })));

  return (
    <>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Tile
          label="Team applied today"
          value={count(data.team.today)}
          emphasis={filters.preset === 'today'}
          detail={<Delta value={data.team.today - data.team.yesterday} against={`vs yesterday (${count(data.team.yesterday)})`} />}
          extra={`${activeToday} of ${data.people.length} applied · ${fullDay.format(toLocal(data.periods.today.first))}`}
        />
        <Tile label="This week" value={count(data.team.week)} emphasis={filters.preset === 'week'} detail={spanLabel(data.periods.week)} extra={`${(data.team.week / Math.max(1, data.people.length)).toFixed(1)} per person`} />
        <Tile label="This month" value={count(data.team.month)} emphasis={filters.preset === 'month'} detail={monthYear.format(toLocal(data.periods.month.first))} extra={`${(data.team.month / Math.max(1, data.people.length)).toFixed(1)} per person`} />
        {filters.rangeIsPeriod ? (
          <Tile label="All time" value={count(data.people.reduce((sum, person) => sum + person.allTime, 0))} detail="Every application" />
        ) : (
          <Tile label={rangeName} value={count(data.team.inRange)} emphasis detail={label} extra={`${(data.team.inRange / Math.max(1, data.people.length)).toFixed(1)} per person`} />
        )}
        <Tile
          label={filters.preset === 'today' ? 'Interviews scheduled today' : `Interviews scheduled · ${rangeName}`}
          value={count(filters.preset === 'today' ? data.team.scheduledToday : data.team.scheduled)}
          detail="By the day they take place"
          extra={`Offers ${count(data.team.reached.offer)} from ${rangeName.toLowerCase()}`}
        />
        <Tile label={`Interview rate · ${rangeName}`} value={percent(data.team.interviewRate)} detail={`${count(data.team.interviews)} of ${count(data.team.inRange)} got an interview`} />
      </div>

      <div className="mt-3">
        <TrendCard
          data={data}
          filters={filters}
          who={lines === 'profiles' ? 'Every profile' : 'Everyone'}
          totals={trends.totals}
          build={trends.build}
          racing
          controls={
            <Toggle
              label="Lines"
              value={lines}
              onChange={setLines}
              options={[
                { value: 'people', label: 'By person' },
                { value: 'profiles', label: 'By profile', disabled: profileCount === 0 }
              ]}
            />
          }
        />
      </div>

      <div className="mt-3">
        <Panel
          title={`Everyone's activity · ${rangeName} · ${label}`}
          icon={Activity}
          aside={
            <span className="flex flex-wrap items-center gap-x-2.5 pr-2 text-[11.5px] text-ink-3" aria-label="Lines in each card">
              {CARD_MEASURES.map(({ metric, color }) => (
                <span key={metric} className="inline-flex items-center gap-1">
                  <LineMark color={color} />
                  {TREND_INFO[metric].label}
                </span>
              ))}
              <span>· running totals</span>
            </span>
          }
        >
          <div className="p-2.5">
            <ol className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2" aria-label="Each person's activity">
              {ranked.map((person) => (
                <PersonCard
                  key={person.user.id}
                  person={person}
                  color={colors.get(person.user.id) ?? othersColor(0)}
                  rangeName={rangeName}
                  people={data.people.length}
                  lead={leadOf(person)}
                  data={data}
                  now={now}
                  board={boardOf.get(person.user.id)}
                  scaleTop={scaleTop}
                />
              ))}
            </ol>
          </div>
        </Panel>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title={`How far applications got · ${rangeName} · ${label}`} icon={Filter}>
          <div className="px-3.5 py-2">
            <StageLines data={data} colors={colors} />
          </div>
        </Panel>

        <Panel title={`Interview rate · ${rangeName} · ${label}`} icon={Percent}>
          <div className="px-3.5 py-2.5">
            <InterviewRanking data={data} colors={colors} />
            <p className="mt-2 text-[11.5px] text-ink-3">
              Of the applications made {filters.preset === 'today' || filters.preset === 'yesterday' ? 'that day' : 'in the range'}, the share whose timeline has an interview or an offer. Recent applications may still get one.
            </p>
          </div>
        </Panel>
      </div>

      <div className="mt-3">
        <Panel title={`Profiles across the team · ${rangeName} · ${label}`} icon={UserRound}>
          <div className="px-3.5 py-2">
            <ProfileTable rows={profileRows} showOwner rangeName={rangeName} />
            <p className="mt-2 text-[11.5px] text-ink-3">Sort by Applied to see the profiles used most, or by Rate to see the ones that get interviews.</p>
          </div>
        </Panel>
      </div>
    </>
  );
}

// ---- The process over all time, by person and profile -------------------------------------

export function formatRate(rate: PassRate): string {
  return rate.percent === null ? '–' : `${rate.percent}%`;
}

const STAGES: Array<{ key: keyof Pick<ProcessStats, 'screenPass' | 'technicalPass' | 'interviewPass' | 'offerPass'>; label: string; icon: LucideIcon; explain: (rate: PassRate) => string }> = [
  { key: 'screenPass', label: 'Screen pass', icon: Phone, explain: (rate) => `${rate.reached} of ${rate.from} applications reached Recruiter Screen` },
  { key: 'technicalPass', label: 'Technical pass', icon: CodeXml, explain: (rate) => `${rate.reached} of ${rate.from} went from Recruiter Screen to Technical Interview` },
  { key: 'interviewPass', label: 'Interview pass', icon: UsersRound, explain: (rate) => `${rate.reached} of ${rate.from} went from Technical Interview to Final Interview` },
  { key: 'offerPass', label: 'Offer pass', icon: Trophy, explain: (rate) => `${rate.reached} of ${rate.from} went from Final Interview to Offer` }
];

/** Horizontal bars on one fixed 0-100% scale, so bars can be compared between people and stages. */
function PassRateChart({ stats }: { stats: ProcessStats }) {
  return (
    <ul className="space-y-2" aria-label="Pass rate at each stage">
      {STAGES.map(({ key, label, icon: Icon, explain }) => {
        const rate = stats[key];
        const noData = rate.percent === null;
        return (
          <li key={key}>
            <Tooltip content={`${label}: ${noData ? 'no data yet' : explain(rate)}`}>
              {/* The whole row is the hover target: a short bar should still be easy to point at. */}
              <div tabIndex={0} className="grid grid-cols-[20px_1fr_96px] items-center gap-2.5 rounded outline-offset-2">
                <span role="img" aria-label={label} className="text-ink-3">
                  <Icon className="size-4" aria-hidden />
                </span>
                <div className="h-3 rounded-[4px] bg-surface-2" aria-hidden>
                  {rate.percent ? <div className="h-full rounded-r-[4px] bg-accent" style={{ width: `${rate.percent}%` }} /> : null}
                </div>
                <span className="whitespace-nowrap text-right text-[12.5px] tabular-nums">
                  <span className="font-semibold text-ink">{formatRate(rate)}</span>
                  {noData ? null : (
                    <span className="ml-1.5 text-ink-3">
                      {rate.reached}/{rate.from}
                    </span>
                  )}
                </span>
              </div>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}

function Figure({ label, icon: Icon, value }: { label: string; icon: LucideIcon; value: string | number }) {
  return (
    <Tooltip content={label}>
      <div tabIndex={0} aria-label={`${label}: ${value}`} className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        <span className="text-[15px] font-semibold leading-tight tabular-nums">{value}</span>
      </div>
    </Tooltip>
  );
}

const ALL_PROFILES = ANY;

function MemberCard({ member, isAdmin }: { member: TeamMember; isAdmin: boolean }) {
  const [selected, setSelected] = useState<string>(ALL_PROFILES);
  const queryClient = useQueryClient();
  const toast = useToast();
  const chosen = selected === ALL_PROFILES ? null : (member.profiles.find((entry) => String(entry.profile.id) === selected) ?? null);
  const stats = chosen?.stats ?? member.stats;
  const removePhoto = () => {
    if (!chosen) return;
    void call('DELETE', `/api/admin/profiles/${chosen.profile.id}/avatar`)
      .then(() => queryClient.invalidateQueries())
      .then(() => toast.show('Photo removed.'))
      .catch((error) => toast.show(errorMessage(error), 'error'));
  };

  return (
    <Card className="rounded-md p-3.5">
      <div className="mb-2.5 flex items-center gap-2.5">
        {chosen ? <Avatar subject={chosen.profile} label={chosen.profile.name} size="md" ring={false} /> : <Avatar subject={member.user} label={userLabel(member.user)} size="md" ring={false} />}
        <h2 className="min-w-0 flex-1 truncate font-semibold leading-tight">
          {userName(member.user)}
          {member.isActive ? null : <span className="ml-1.5 font-normal text-ink-3">(off)</span>}
        </h2>
        {isAdmin && chosen?.profile.avatarVersion ? (
          <Button size="icon-sm" variant="danger-ghost" title="Remove this profile's photo" aria-label={`Remove photo of ${chosen.profile.name}`} onClick={removePhoto}>
            <ImageOff />
          </Button>
        ) : null}
        {member.profiles.length > 1 ? (
          <Select
            ariaLabel={`Profile of ${userName(member.user)}`}
            className="w-[150px]"
            leading={<User className="size-3.5 text-ink-3" aria-hidden />}
            value={selected}
            onChange={setSelected}
            options={[
              { value: ALL_PROFILES, label: `All (${member.profiles.length})` },
              ...member.profiles.map((entry) => ({ value: String(entry.profile.id), label: `${entry.profile.name}${entry.profile.isArchived ? ' (archived)' : ''}` }))
            ]}
          />
        ) : null}
      </div>

      <div className="mb-3 flex flex-wrap justify-between gap-x-3 gap-y-1 border-y border-border py-2">
        <Figure label="Applications" icon={Send} value={stats.applications.toLocaleString()} />
        {/* Interviews on timelines, not applications that got one: one application can have several. */}
        <Figure label="Interviews, every stage and round (one application can have several)" icon={CalendarDays} value={stats.interviews.toLocaleString()} />
        <Figure label="Technical" icon={CodeXml} value={stats.technical.toLocaleString()} />
        <Figure label="Offers" icon={Trophy} value={stats.offers.toLocaleString()} />
        <Figure label="Success" icon={Percent} value={formatRate(stats.success)} />
      </div>

      <PassRateChart stats={stats} />
    </Card>
  );
}

// ---- The page ------------------------------------------------------------------------------

export function TeamPage({ user }: { user: CurrentUser; onOpenJob?: (jobId: number) => void }) {
  const filters = useFilters('jobTracker.teamRange');
  const { range, group } = filters;
  const activity = useActivity({ tz: filters.tz, today: filters.today, from: range.first, to: range.last, group, scope: 'team' });
  const team = useTeam();
  const members = useMemo(() => [...(team.data ?? [])].sort((a, b) => b.stats.applications - a.stats.applications || userName(a.user).localeCompare(userName(b.user))), [team.data]);

  return (
    <div className="h-full overflow-y-auto px-5 pb-8 pt-4">
      <FilterBar title="Team" filters={filters} />

      {activity.isError ? (
        <Notice kind="error" title="Could not load the numbers" className="mb-3">
          {errorMessage(activity.error)}
        </Notice>
      ) : null}

      {activity.data ? (
        <Refreshing active={activity.isPlaceholderData}>
          <TeamAnalytics filters={filters} data={activity.data} />
        </Refreshing>
      ) : activity.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-40" />
          <Skeleton className="h-64" />
        </div>
      ) : null}

      <h2 className="mb-2 mt-5 text-[14px] font-semibold">Process by person · all time</h2>
      {team.isError ? (
        <Notice kind="error" title="Could not load the team" className="mb-4">
          {errorMessage(team.error)}
        </Notice>
      ) : null}
      {team.isPending ? (
        <Skeleton className="h-52" />
      ) : members.length === 0 ? (
        <EmptyState icon={UsersRound} title="Nobody here yet" />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {members.map((member) => (
            <MemberCard key={member.user.id} member={member} isAdmin={user.role === 'admin'} />
          ))}
        </div>
      )}
    </div>
  );
}
