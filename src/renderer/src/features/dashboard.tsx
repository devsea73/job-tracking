import { CalendarDays, Inbox, Star } from 'lucide-react';
import type { CurrentUser, JobListItem } from '@shared/api';
import { AvatarStack, HighlightButton, StatusBadge } from '@/components/job-bits';
import { Button } from '@/components/ui/button';
import { Card, EmptyState, Notice, Skeleton } from '@/components/ui/misc';
import { errorMessage, useDashboard } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/utils';
import type { Page } from '../App';

/** The number is the figure, in plain ink: color here would claim a meaning these counts do not have. */
function StatTile({ label, value }: { label: string; value: number | undefined }) {
  return (
    <Card className="px-4 py-3.5">
      <p className="text-[12.5px] text-ink-2">{label}</p>
      {value === undefined ? <Skeleton className="mt-1.5 h-8 w-14" /> : <p className="mt-0.5 text-[28px] font-semibold leading-tight tabular-nums">{value.toLocaleString()}</p>}
    </Card>
  );
}

function JobLine({ job, onOpen }: { job: JobListItem; onOpen: (id: number) => void }) {
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(job.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onOpen(job.id);
        }}
        className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2/60"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{job.title}</p>
          <p className="truncate text-[12.5px] text-ink-2">{job.company}</p>
        </div>
        {job.myApplication ? <StatusBadge status={job.myApplication.status} /> : null}
        <AvatarStack users={job.applicants} />
        <span className="w-20 shrink-0 text-right text-[12px] text-ink-3">{formatRelative(job.myApplication?.updatedAt ?? job.updatedAt)}</span>
      </div>
    </li>
  );
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="flex min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-11 items-center justify-between border-b border-border pl-4 pr-2">
        <h2 className="font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

export function DashboardPage({ user, onOpenJob, onNavigate, onAddJob }: { user: CurrentUser; onOpenJob: (id: number) => void; onNavigate: (page: Page) => void; onAddJob: () => void }) {
  const dashboard = useDashboard();
  const data = dashboard.data;

  return (
    <div className="h-full overflow-y-auto px-6 pb-8 pt-5">
      <h1 className="text-[20px] font-semibold leading-tight">Welcome back, {user.displayName ?? user.username}</h1>
      <p className="mb-4 mt-0.5 text-ink-2">Your applications at a glance.</p>

      {dashboard.isError ? (
        <Notice kind="error" title="Could not load the dashboard" className="mb-4">
          {errorMessage(dashboard.error)}
        </Notice>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Total applications" value={data?.totalApplications} />
        <StatTile label="Active applications" value={data?.activeApplications} />
        <StatTile label="Upcoming interviews" value={data?.upcomingInterviews} />
        <StatTile label="Rejected applications" value={data?.rejectedApplications} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Panel
          title="Recent applications"
          action={
            <Button size="sm" variant="ghost" onClick={() => onNavigate('mine')}>
              View all
            </Button>
          }
        >
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

        <div className="space-y-4">
          <Panel
            title="Upcoming interviews"
            action={
              <Button size="sm" variant="ghost" onClick={() => onNavigate('interviews')}>
                View all
              </Button>
            }
          >
            {!data ? (
              <div className="p-4">
                <Skeleton className="h-9" />
              </div>
            ) : data.nextInterviews.length === 0 ? (
              <p className="flex items-center gap-2 px-4 py-5 text-ink-3">
                <CalendarDays className="size-4" aria-hidden /> Nothing scheduled.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {data.nextInterviews.map((interview) => (
                  <li key={interview.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => onOpenJob(interview.jobId)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') onOpenJob(interview.jobId);
                      }}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2/60"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{interview.title}</p>
                        <p className="truncate text-[12.5px] text-ink-2">
                          {interview.company} · {interview.stage}
                        </p>
                      </div>
                      <span className="shrink-0 text-right text-[12.5px] text-ink-2">{formatDateTime(interview.scheduledAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Highlighted jobs"
            action={
              <Button size="sm" variant="ghost" onClick={() => onNavigate('highlighted')}>
                View all
              </Button>
            }
          >
            {!data ? (
              <div className="p-4">
                <Skeleton className="h-9" />
              </div>
            ) : data.highlightedJobs.length === 0 ? (
              <p className="flex items-center gap-2 px-4 py-5 text-ink-3">
                <Star className="size-4" aria-hidden /> No highlighted jobs yet.
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
                      className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 pr-2 hover:bg-surface-2/60"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{job.title}</p>
                        <p className="truncate text-[12.5px] text-ink-2">{job.company}</p>
                      </div>
                      <AvatarStack users={job.applicants} />
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
