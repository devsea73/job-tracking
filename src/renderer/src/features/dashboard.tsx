import { useMemo, useState } from 'react';
import { BarChart3, CalendarClock, Filter, Inbox, Send, UserRound } from 'lucide-react';
import type { ActivityPerson, ActivityResponse, JobListItem } from '@shared/api';
import { AvatarStack, StatusBadge } from '@/components/job-bits';
import { JobTags } from '@/components/job-tags';
import { STAGE_ICONS } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { EmptyState, Notice, Skeleton } from '@/components/ui/misc';
import { errorMessage, useActivity, useDashboard } from '@/lib/api';
import { formatDateTime, formatShortAgo } from '@/lib/utils';
import type { Page } from '../App';
import {
  ColumnChart,
  count,
  Delta,
  FilterBar,
  fullDay,
  Funnel,
  Legend,
  monthYear,
  Panel,
  percent,
  pickSeries,
  ProfileTable,
  Refreshing,
  SeriesTable,
  shapeValues,
  spanLabel,
  TableSwitch,
  Tile,
  Toggle,
  toLocal,
  toSeries,
  useFilters,
  type Series
} from './analytics';

/**
 * My own numbers, today first: how much I applied today, this week and this month, over time,
 * how far it got, and how each of my profiles is doing. Comparing with others is the Team page's job.
 */

type Metric = 'applications' | 'interviews';

/** My applications per period, all together or split by profile; or my interviews by the day they take place. */
function mySeries(data: ActivityResponse, me: ActivityPerson, metric: Metric, byProfile: boolean, now: Date): Series[] {
  const shape = (raw: number[]) => shapeValues(raw, data.buckets, data.group, now);
  if (metric === 'interviews') return [{ key: 'interviews', name: 'Interviews', color: 'var(--series-1)', total: me.scheduled, values: shape(me.interviewSeries) }];
  if (!byProfile || me.profiles.length < 2) return [{ key: 'applications', name: 'Applications', color: 'var(--series-1)', total: me.inRange, values: shape(me.series) }];
  const used = me.profiles.filter((profile) => profile.inRange > 0);
  return toSeries(
    pickSeries(used, (profile) => profile.id, () => false),
    (profile) => ({ id: profile.id, name: profile.name, total: profile.inRange, raw: profile.series }),
    shape,
    (rest) => `${rest} other profiles`
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
          <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-ink-3" title={`Applied ${formatDateTime(applied)}`}>
            {formatShortAgo(applied)}
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function DashboardPage({ onOpenJob, onNavigate, onAddJob }: { onOpenJob: (id: number) => void; onNavigate: (page: Page) => void; onAddJob: () => void }) {
  const filters = useFilters('jobTracker.dashboardRange');
  const { range, group, now, rangeName, label } = filters;
  const activity = useActivity({ tz: filters.tz, today: filters.today, from: range.first, to: range.last, group, scope: 'me' });
  const dashboard = useDashboard();
  const data = activity.data;
  const me = data?.people.find((person) => person.isMe);

  const [metric, setMetric] = useState<Metric>('applications');
  const [byProfile, setByProfile] = useState(false);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const series = useMemo(() => (data && me ? mySeries(data, me, metric, byProfile, now) : []), [data, me, metric, byProfile, now]);

  // An average over the periods that have begun: the ones still to come are not zeros.
  const started = series[0]?.values.filter((value) => value !== null).length ?? 0;
  const shownTotal = series.reduce((sum, item) => sum + item.total, 0);
  const average = started > 0 ? shownTotal / started : null;
  const busiest = useMemo(() => {
    if (!data || series.length === 0) return null;
    const totals = data.buckets.map((_, index) => series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0));
    const best = Math.max(...totals);
    return best > 0 ? { value: best, bucket: data.buckets[totals.indexOf(best)] } : null;
  }, [data, series]);
  const profileColors = useMemo(() => new Map(series.map((item) => [item.key, item.color])), [series]);

  return (
    <div className="h-full overflow-y-auto px-5 pb-8 pt-4">
      <FilterBar title="Dashboard" filters={filters} />

      {activity.isError ? (
        <Notice kind="error" title="Could not load the numbers" className="mb-3">
          {errorMessage(activity.error)}
        </Notice>
      ) : null}

      <Refreshing active={activity.isPlaceholderData}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Tile
            label="Applied today"
            value={me ? count(me.today) : undefined}
            emphasis={filters.preset === 'today'}
            detail={me ? <Delta value={me.today - me.yesterday} against={`vs yesterday (${count(me.yesterday)})`} /> : undefined}
            extra={data ? fullDay.format(toLocal(data.periods.today.first)) : undefined}
          />
          <Tile label="This week" value={me ? count(me.week) : undefined} emphasis={filters.preset === 'week'} detail={data ? spanLabel(data.periods.week) : undefined} />
          <Tile label="This month" value={me ? count(me.month) : undefined} emphasis={filters.preset === 'month'} detail={data ? monthYear.format(toLocal(data.periods.month.first)) : undefined} />
          {filters.rangeIsPeriod ? (
            <Tile label="All time" value={me ? count(me.allTime) : undefined} detail="Every application" />
          ) : (
            <Tile label={rangeName} value={me ? count(me.inRange) : undefined} emphasis detail={label} extra={average !== null && metric === 'applications' ? `${average.toFixed(1)} per ${group} on average` : undefined} />
          )}
          <Tile
            label={filters.preset === 'today' ? 'Interviews today' : `Interviews · ${rangeName}`}
            value={me ? count(filters.preset === 'today' ? me.scheduledToday : me.scheduled) : undefined}
            detail={me ? (filters.preset === 'today' ? `${count(me.scheduled)} in the range` : `${count(me.scheduledToday)} today`) : undefined}
            extra="By the day they take place"
          />
          <Tile
            label={`Interview rate · ${rangeName}`}
            value={me ? percent(me.interviewRate) : undefined}
            detail={me ? `${count(me.interviews)} of ${count(me.inRange)} got an interview` : undefined}
            extra={me ? `All time ${percent(me.allTimeInterviewRate)} (${count(me.allTimeInterviews)}/${count(me.allTime)})` : undefined}
          />
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Panel
            title={`My ${metric === 'applications' ? 'applications' : 'interviews'} per ${group} · ${label}`}
            icon={BarChart3}
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
                  label="Split"
                  value={byProfile && metric === 'applications' ? 'profile' : 'all'}
                  onChange={(value) => setByProfile(value === 'profile')}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'profile', label: 'By profile', disabled: metric !== 'applications' || (me?.profiles.length ?? 0) < 2, title: metric !== 'applications' ? 'Profiles split applications' : undefined }
                  ]}
                />
                <TableSwitch view={view} onChange={setView} />
              </>
            }
          >
            <div className="px-3 pb-3 pt-2">
              {!data ? (
                <Skeleton className="h-[240px] w-full" />
              ) : view === 'table' ? (
                <SeriesTable buckets={data.buckets} group={data.group} series={series} />
              ) : (
                <>
                  <ColumnChart buckets={data.buckets} group={data.group} series={series} description={`My ${metric} per ${group}`} />
                  <Legend series={series} mark="block" />
                  <p className="mt-1.5 flex flex-wrap gap-x-4 text-[12px] text-ink-3" data-chart-summary>
                    <span>
                      Total <span className="font-semibold tabular-nums text-ink">{count(shownTotal)}</span>
                    </span>
                    <span>
                      Average <span className="font-semibold tabular-nums text-ink">{average === null ? '–' : average.toFixed(1)}</span> per {group} so far
                    </span>
                    {busiest ? (
                      <span>
                        Busiest <span className="font-semibold tabular-nums text-ink">{count(busiest.value)}</span> · {data.group === 'hour' ? `${toLocal(busiest.bucket.first, Number(busiest.bucket.key.slice(11, 13))).toLocaleTimeString(undefined, { hour: 'numeric' })}` : spanLabel(busiest.bucket)}
                      </span>
                    ) : null}
                  </p>
                </>
              )}
            </div>
          </Panel>

          <Panel title={`How far my applications got · ${rangeName}`} icon={Filter}>
            <div className="px-3.5 py-2.5">{me ? <Funnel counts={me} /> : <Skeleton className="h-36 w-full" />}</div>
          </Panel>
        </div>

        <div className="mt-3">
          <Panel title={`My profiles · ${rangeName} · ${label}`} icon={UserRound}>
            <div className="px-3.5 py-2">
              {me ? (
                <ProfileTable rows={me.profiles.map((profile) => ({ profile, isMine: true, color: byProfile && metric === 'applications' ? profileColors.get(String(profile.id)) : undefined }))} showOwner={false} rangeName={rangeName} />
              ) : (
                <Skeleton className="h-20 w-full" />
              )}
            </div>
          </Panel>
        </div>
      </Refreshing>

      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        <Panel title="My upcoming interviews" icon={CalendarClock} onViewAll={() => onNavigate('interviews')}>
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
