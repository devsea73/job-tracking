import { useMemo, useState } from 'react';
import { ArrowDown, CalendarDays, CodeXml, Filter, ImageOff, LineChart as LineChartIcon, Percent, Phone, Send, Trophy, User, UserRound, UsersRound, type LucideIcon } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { ActivityPerson, ActivityResponse, CurrentUser, TeamMember } from '@shared/api';
import type { PassRate, ProcessStats } from '@shared/pipeline';
import { Avatar, userLabel, userName } from '@/components/job-bits';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { ANY, Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { call, errorMessage, useActivity, useTeam } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  count,
  Delta,
  FilterBar,
  fullDay,
  Legend,
  LineChart,
  monthYear,
  OTHERS_COLOR,
  Panel,
  peopleSeries,
  percent,
  ProfileTable,
  Refreshing,
  SeriesTable,
  shapeValues,
  share,
  spanLabel,
  TableSwitch,
  Tile,
  Toggle,
  toLocal,
  toSeries,
  useFilters,
  type Filters
} from './analytics';

/**
 * Everyone side by side, today unless another range is chosen: who applied how much, over time,
 * how far it got, who gets interviews, and which profiles work. The all-time process follows below.
 */

// ---- Comparing people over the range ------------------------------------------------------

function PersonCard({ person, color, rangeName, people, lead }: { person: ActivityPerson; color: string; rangeName: string; people: number; lead: string }) {
  return (
    <li
      data-person-card={person.user.username}
      className={cn('flex flex-col rounded-md border bg-surface px-3 py-2.5', person.isMe ? 'border-accent' : 'border-border')}
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
      <p className="mt-1.5 text-[11.5px] text-ink-2">
        Interviews <span className="font-semibold tabular-nums text-ink">{count(person.interviews)}</span>/{count(person.inRange)} · <span className="font-semibold text-ink">{percent(person.interviewRate)}</span>
        <span className="text-ink-3"> · {count(person.scheduled)} dated in range</span>
      </p>
    </li>
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

type PipelineSort = 'inRange' | 'screen' | 'technical' | 'final' | 'offer' | 'rejected' | 'interviewRate' | 'offerRate' | 'scheduled';

const PIPELINE_COLUMNS: Array<{ key: PipelineSort; label: string; title: string; rate?: boolean }> = [
  { key: 'inRange', label: 'Applied', title: 'Applications in the range' },
  { key: 'screen', label: 'Screen', title: 'Reached Recruiter Screen or later' },
  { key: 'technical', label: 'Technical', title: 'Reached Technical Interview or later' },
  { key: 'final', label: 'Final', title: 'Reached Final Interview or later' },
  { key: 'offer', label: 'Offer', title: 'Got an offer' },
  { key: 'rejected', label: 'Rejected', title: 'Turned down, at any stage' },
  { key: 'interviewRate', label: 'Interview rate', title: 'Got an interview: Recruiter Screen or later, or one booked', rate: true },
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

type Metric = 'applications' | 'interviews';

function TeamAnalytics({ filters, data }: { filters: Filters; data: ActivityResponse }) {
  const { rangeName, label, group, now } = filters;
  const [metric, setMetric] = useState<Metric>('applications');
  const [cumulativeChoice, setCumulativeChoice] = useState<{ key: string; value: boolean } | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  // Left alone, one day shows the running total: who is ahead, hour by hour. A choice lasts until the range changes.
  const cumulative = cumulativeChoice?.key === filters.rangeKey ? cumulativeChoice.value : group === 'hour';

  const picked = useMemo(() => peopleSeries(data.people), [data]);
  const ranked = picked.shown.concat(picked.rest).sort((a, b) => a.rank - b.rank);
  const series = useMemo(
    () =>
      toSeries(
        picked,
        (person) => ({
          id: person.user.id,
          name: userName(person.user),
          emphasis: person.isMe,
          total: metric === 'applications' ? person.inRange : person.scheduled,
          raw: metric === 'applications' ? person.series : person.interviewSeries
        }),
        (raw) => shapeValues(raw, data.buckets, data.group, now, cumulative),
        (rest) => `${rest} others`
      ),
    [picked, metric, data, now, cumulative]
  );

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
          label={filters.preset === 'today' ? 'Interviews today' : `Interviews · ${rangeName}`}
          value={count(filters.preset === 'today' ? data.team.scheduledToday : data.team.scheduled)}
          detail="By the day they take place"
          extra={`Offers ${count(data.team.reached.offer)} from ${rangeName.toLowerCase()}`}
        />
        <Tile label={`Interview rate · ${rangeName}`} value={percent(data.team.interviewRate)} detail={`${count(data.team.interviews)} of ${count(data.team.inRange)} got an interview`} />
      </div>

      <div className="mt-3">
        <Panel title={`Leaderboard · ${rangeName} · ${label}`} icon={Trophy}>
          <div className="p-2.5">
            <ol className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-2" aria-label="People by applications">
              {data.people.map((person) => (
                <PersonCard key={person.user.id} person={person} color={picked.colors.get(person.user.id) ?? OTHERS_COLOR} rangeName={rangeName} people={data.people.length} lead={leadOf(person)} />
              ))}
            </ol>
          </div>
        </Panel>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel
          title={`${metric === 'applications' ? 'Applications' : 'Interviews'} per ${group}${cumulative ? ', running total' : ''} · ${label}`}
          icon={LineChartIcon}
          aside={
            <>
              <Toggle
                label="Count"
                value={metric}
                onChange={setMetric}
                options={[
                  { value: 'applications', label: 'Applications' },
                  { value: 'interviews', label: 'Interviews' }
                ]}
              />
              <Toggle
                label="Show"
                value={cumulative ? 'total' : 'each'}
                onChange={(value) => setCumulativeChoice({ key: filters.rangeKey, value: value === 'total' })}
                options={[
                  { value: 'each', label: `Per ${group}` },
                  { value: 'total', label: 'Running total' }
                ]}
              />
              <TableSwitch view={view} onChange={setView} />
            </>
          }
        >
          <div className="px-3 pb-3 pt-2">
            {view === 'table' ? (
              <SeriesTable buckets={data.buckets} group={data.group} series={series} />
            ) : (
              <>
                <LineChart buckets={data.buckets} group={data.group} series={series} description={`${metric === 'applications' ? 'Applications' : 'Interviews'} per ${group}${cumulative ? ', running total' : ''}, by person`} />
                <Legend series={series} mark="line" />
              </>
            )}
            {metric === 'interviews' ? <p className="mt-1.5 text-[11.5px] text-ink-3">Interviews by the day they take place, whenever the application was made.</p> : null}
          </div>
        </Panel>

        <Panel title={`Interview rate · ${rangeName} · ${label}`} icon={Percent}>
          <div className="px-3.5 py-2.5">
            <InterviewRanking data={data} />
            <p className="mt-2 text-[11.5px] text-ink-3">
              Of the applications made {filters.preset === 'today' || filters.preset === 'yesterday' ? 'that day' : 'in the range'}, the share that reached Recruiter Screen or later, or has an interview booked. Recent applications may still get one.
            </p>
          </div>
        </Panel>
      </div>

      <div className="mt-3">
        <Panel title={`How far applications got · ${rangeName} · ${label}`} icon={Filter}>
          <div className="px-3.5 py-2">
            <PipelineTable data={data} />
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
        <Figure label="Interviews" icon={CalendarDays} value={stats.interviews.toLocaleString()} />
        <Figure label="Technical" icon={CodeXml} value={stats.technical.toLocaleString()} />
        <Figure label="Offers" icon={Trophy} value={stats.offers.toLocaleString()} />
        <Figure label="Success" icon={Percent} value={formatRate(stats.success)} />
      </div>

      <PassRateChart stats={stats} />
    </Card>
  );
}

// ---- The page ------------------------------------------------------------------------------

export function TeamPage({ user }: { user: CurrentUser }) {
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
