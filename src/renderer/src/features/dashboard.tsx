import { useCallback, useMemo, useState } from 'react';
import { CalendarClock, Filter, Inbox, Send, UserRound } from 'lucide-react';
import type { ActivityPerson, ActivityResponse, JobListItem, TrendMetric } from '@shared/api';
import { AvatarStack, StatusBadge } from '@/components/job-bits';
import { JobTags } from '@/components/job-tags';
import { STAGE_ICONS } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { EmptyState, Notice, Skeleton } from '@/components/ui/misc';
import { errorMessage, useActivity, useDashboard } from '@/lib/api';
import { formatDateTime, formatShortAgo } from '@/lib/utils';
import type { Page } from '../App';
import { bucketStart, count, Delta, FilterBar, fullDay, Funnel, monthYear, Panel, percent, ProfileTable, Refreshing, SERIES_SLOTS, seriesColor, spanLabel, Tile, Toggle, toLocal, useFilters } from './analytics';
import { entityLines, previousLine, shapeTrend, TrendCard, type TrendView } from './trend-card';

/**
 * My own numbers, today first: how much I applied today, this week and this month; the measures
 * over time against the period before, or by profile; how far it got; and how each of my profiles
 * is doing. Comparing with others is the Team page's job.
 */

type Lines = 'previous' | 'profiles';

/** My measures as lines: mine against the period before, dashed, or one line per profile. */
function useMyTrends(data: ActivityResponse | undefined, me: ActivityPerson | undefined, lines: Lines, now: Date) {
  const build = useCallback(
    (metric: TrendMetric, cumulative: boolean): TrendView => {
      if (!data || !me) return { series: [] };
      if (lines === 'profiles' && me.profiles.length > 1) {
        return {
          series: entityLines(me.profiles, (profile) => ({ id: profile.id, name: profile.name, raw: profile.trends[metric] }), data, metric, cumulative, now, (rest) => `${rest} other profiles`),
          footer: { label: 'All profiles', values: shapeTrend(me.trends[metric], data, metric, cumulative, now) },
          ranked: true
        };
      }
      return {
        series: [{ key: 'current', name: 'This period', color: seriesColor(0), total: null, values: shapeTrend(me.trends[metric], data, metric, cumulative, now) }, previousLine(me.previousTrends[metric], data, metric, cumulative)],
        footer: null,
        marks: new Map([
          ['current', spanLabel(data.periods.range)],
          ['previous', spanLabel(data.previous.range)]
        ])
      };
    },
    [data, me, lines, now]
  );
  const totals = useCallback((metric: TrendMetric) => me?.trendTotals[metric] ?? { current: null, previous: null }, [me]);
  return { build, totals };
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
  const [lines, setLines] = useState<Lines>('previous');
  const byProfile = lines === 'profiles' && (me?.profiles.length ?? 0) > 1;
  const trends = useMyTrends(data, me, lines, now);

  // An average over the periods that have begun: the ones still to come are not zeros.
  const started = data ? data.buckets.filter((bucket) => bucketStart(bucket, data.group) <= now).length : 0;
  const average = me && started > 0 ? me.series.slice(0, started).reduce((sum, value) => sum + value, 0) / started : null;
  // Each profile keeps the color of its line, by which profile it is.
  const profileColors = useMemo(
    () => new Map([...(me?.profiles ?? [])].sort((a, b) => a.id - b.id).map((profile, index) => [profile.id, index < SERIES_SLOTS ? seriesColor(index) : undefined])),
    [me]
  );

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
            <Tile label={rangeName} value={me ? count(me.inRange) : undefined} emphasis detail={label} extra={average !== null ? `${average.toFixed(1)} per ${group} on average` : undefined} />
          )}
          <Tile
            label={filters.preset === 'today' ? 'Interviews scheduled today' : `Interviews scheduled · ${rangeName}`}
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

        <div className="mt-3">
          {data && me ? (
            <TrendCard
              data={data}
              filters={filters}
              who="Me"
              totals={trends.totals}
              build={trends.build}
              controls={
                <Toggle
                  label="Lines"
                  value={byProfile ? 'profiles' : 'previous'}
                  onChange={setLines}
                  options={[
                    { value: 'previous', label: 'vs previous period' },
                    { value: 'profiles', label: 'By profile', disabled: me.profiles.length < 2, title: me.profiles.length < 2 ? 'With two profiles or more' : undefined }
                  ]}
                />
              }
            />
          ) : (
            <Skeleton className="h-[420px] w-full" />
          )}
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <Panel title={`How far my applications got · ${rangeName}`} icon={Filter}>
            <div className="px-3.5 py-2.5">{me ? <Funnel counts={me} /> : <Skeleton className="h-36 w-full" />}</div>
          </Panel>

          <Panel title={`My profiles · ${rangeName} · ${label}`} icon={UserRound}>
            <div className="px-3.5 py-2">
              {me ? (
                <ProfileTable rows={me.profiles.map((profile) => ({ profile, isMine: true, color: byProfile ? profileColors.get(profile.id) : undefined }))} showOwner={false} rangeName={rangeName} />
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
