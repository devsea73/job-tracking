import { Activity, ArrowRight, CalendarClock, CalendarDays, Inbox, Send, Star, X, type LucideIcon } from 'lucide-react';
import type { JobListItem } from '@shared/api';
import { AvatarStack, HighlightButton, StatusBadge } from '@/components/job-bits';
import { STAGE_ICONS, Symbol } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { errorMessage, useDashboard } from '@/lib/api';
import { formatDateTime, formatShortAgo } from '@/lib/utils';
import type { Page } from '../App';

function StatTile({ label, icon: Icon, value }: { label: string; icon: LucideIcon; value: number | undefined }) {
  return (
    <Tooltip content={label}>
      <section tabIndex={0} aria-label={`${label}: ${value ?? ''}`} className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
        <Icon className="size-5 shrink-0 text-ink-3" aria-hidden />
        {value === undefined ? <Skeleton className="h-7 w-14" /> : <p className="text-[24px] font-semibold leading-tight tabular-nums">{value.toLocaleString()}</p>}
      </section>
    </Tooltip>
  );
}

function JobLine({ job, onOpen }: { job: JobListItem; onOpen: (id: number) => void }) {
  const mine = job.applications.filter((application) => application.isMine);
  const latest = mine.reduce<string>((newest, application) => (application.updatedAt > newest ? application.updatedAt : newest), job.updatedAt);
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
        <span className="w-9 shrink-0 text-right text-[12px] tabular-nums text-ink-3" title={formatDateTime(latest)}>
          {formatShortAgo(latest)}
        </span>
      </div>
    </li>
  );
}

function Panel({ title, icon: Icon, onViewAll, children }: { title: string; icon: LucideIcon; onViewAll: () => void; children: React.ReactNode }) {
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-10 items-center justify-between border-b border-border pl-4 pr-1.5">
        <h2 className="flex items-center text-ink-2">
          <Symbol icon={Icon} label={title} />
          <span className="sr-only">{title}</span>
        </h2>
        <Tooltip content="View all">
          <Button size="icon-sm" variant="ghost" aria-label={`View all: ${title}`} onClick={onViewAll}>
            <ArrowRight />
          </Button>
        </Tooltip>
      </div>
      {children}
    </Card>
  );
}

export function DashboardPage({ onOpenJob, onNavigate, onAddJob }: { onOpenJob: (id: number) => void; onNavigate: (page: Page) => void; onAddJob: () => void }) {
  const dashboard = useDashboard();
  const data = dashboard.data;

  return (
    <div className="h-full overflow-y-auto px-5 pb-8 pt-4">
      <h1 className="mb-3 text-[17px] font-semibold leading-tight">Dashboard</h1>

      {dashboard.isError ? (
        <Notice kind="error" title="Could not load the dashboard" className="mb-4">
          {errorMessage(dashboard.error)}
        </Notice>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total applications" icon={Send} value={data?.totalApplications} />
        <StatTile label="Active applications" icon={Activity} value={data?.activeApplications} />
        <StatTile label="Upcoming interviews" icon={CalendarClock} value={data?.upcomingInterviews} />
        <StatTile label="Rejected applications" icon={X} value={data?.rejectedApplications} />
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        <Panel title="Recent applications" icon={Send} onViewAll={() => onNavigate('mine')}>
          {!data ? (
            <div className="space-y-3 p-4">
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
          ) : data.recentApplications.length === 0 ? (
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
              {data.recentApplications.map((job) => (
                <JobLine key={job.id} job={job} onOpen={onOpenJob} />
              ))}
            </ul>
          )}
        </Panel>

        <div className="space-y-3">
          <Panel title="Upcoming interviews" icon={CalendarClock} onViewAll={() => onNavigate('interviews')}>
            {!data ? (
              <div className="p-4">
                <Skeleton className="h-9" />
              </div>
            ) : data.nextInterviews.length === 0 ? (
              <p className="flex items-center justify-center py-5 text-ink-3" aria-label="Nothing scheduled">
                <CalendarDays className="size-4" aria-hidden />
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {data.nextInterviews.map((interview) => {
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

          <Panel title="Highlighted jobs" icon={Star} onViewAll={() => onNavigate('highlighted')}>
            {!data ? (
              <div className="p-4">
                <Skeleton className="h-9" />
              </div>
            ) : data.highlightedJobs.length === 0 ? (
              <p className="flex items-center justify-center py-5 text-ink-3" aria-label="No highlighted jobs yet">
                <Star className="size-4" aria-hidden />
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {data.highlightedJobs.map((job) => (
                  <li key={job.id} className="flex items-center">
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => onOpenJob(job.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') onOpenJob(job.id);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-4 pr-2 hover:bg-surface-2/60"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{job.title}</p>
                        <p className="truncate text-[12.5px] text-ink-2">{job.company}</p>
                      </div>
                      <AvatarStack applications={job.applications} />
                    </div>
                    <div className="pr-2">
                      <HighlightButton jobId={job.id} highlighted={job.isHighlighted} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
