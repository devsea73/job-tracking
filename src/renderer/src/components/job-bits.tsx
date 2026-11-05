import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Star, StickyNote } from 'lucide-react';
import type { ApplicationSummary, AvatarSubject, CurrentUser, UserRef } from '@shared/api';
import { APPLICATION_STATUSES, type ApplicationStatus } from '@shared/constants';
import { PIPELINE_STAGES, type PipelineStage } from '@shared/pipeline';
import { errorMessage, useAvatarImage, useSetHighlight, useUpdateApplication } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import { IconLabel, STATUS_ICONS, statusInk, statusStyle, Symbol } from './symbols';
import { Select } from './ui/select';
import { Tooltip } from './ui/misc';
import { useToast } from './ui/toast';

/** A status as a colored symbol. Its name is one hover away. */
export function StatusBadge({ status, className }: { status: ApplicationStatus; className?: string }) {
  const Icon = STATUS_ICONS[status];
  return (
    <span role="img" aria-label={status} title={status} className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-full', className)} style={statusStyle(status)}>
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}

/** Saves immediately, so that changing a status is one click and no "save" button. */
export function StatusSelect({ applicationId, status }: { applicationId: number; status: ApplicationStatus }) {
  const update = useUpdateApplication();
  const toast = useToast();
  const shown = update.isPending && update.variables?.body.status ? update.variables.body.status : status;
  return (
    <Select
      value={shown}
      ariaLabel="Application status"
      onChange={(next) =>
        update.mutate(
          { id: applicationId, body: { status: next as ApplicationStatus } },
          { onError: (error) => toast.show(errorMessage(error), 'error') }
        )
      }
      options={APPLICATION_STATUSES.map((value) => ({ value, label: <IconLabel icon={STATUS_ICONS[value]}>{value}</IconLabel> }))}
      renderValue={<StatusBadge status={shown} className="hover:brightness-95 dark:hover:brightness-110" />}
      triggerClassName="rounded-full"
    />
  );
}

export function HighlightButton({ jobId, highlighted, size = 'md', highlightedBy }: { jobId: number; highlighted: boolean; size?: 'md' | 'lg'; highlightedBy?: string | null }) {
  const set = useSetHighlight();
  const toast = useToast();
  const queryClient = useQueryClient();
  const shown = set.isPending && set.variables ? set.variables.highlighted : highlighted;
  return (
    <button
      type="button"
      title={shown ? `Highlighted${highlightedBy ? ` by ${highlightedBy}` : ''}` : 'Highlight'}
      aria-label={shown ? 'Remove highlight' : 'Highlight this job for everyone'}
      aria-pressed={shown}
      className={cn('inline-flex items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink', size === 'lg' ? 'size-8' : 'size-7', shown && 'text-star hover:text-star')}
      onClick={(event) => {
        event.stopPropagation();
        set.mutate(
          { jobId, highlighted: !shown },
          {
            onError: (error) => {
              toast.show(errorMessage(error), 'error');
              void queryClient.invalidateQueries();
            }
          }
        );
      }}
    >
      <Star className={size === 'lg' ? 'size-[18px]' : 'size-4'} fill={shown ? 'currentColor' : 'none'} aria-hidden />
    </button>
  );
}

export function userName(user: Pick<UserRef, 'username' | 'displayName'>): string {
  return user.displayName ?? user.username;
}

export function userLabel(user: Pick<UserRef, 'username' | 'displayName'>): string {
  return user.displayName ? `${user.displayName} (${user.username})` : user.username;
}

/** "Data Engineer (Tyler)": the profile that applied, and the person behind it. */
export function applicationLabel(application: Pick<ApplicationSummary, 'profile' | 'owner'>): string {
  const owner = userName(application.owner);
  // Everyone's first profile is named after them, which needs no explaining.
  return application.profile.name === owner ? owner : `${application.profile.name} (${owner})`;
}

/** Someone's own profiles are the only ones that applied, so deleting it takes nothing from anyone else. */
export function canDeleteJob(applications: Array<Pick<ApplicationSummary, 'isMine'>>, user: Pick<CurrentUser, 'role'>): boolean {
  if (user.role === 'admin') return true;
  return applications.length > 0 && applications.every((application) => application.isMine);
}

export function asUserSubject(user: Pick<UserRef, 'id' | 'initials' | 'color' | 'avatarVersion'>): AvatarSubject {
  return { kind: 'user', id: user.id, initials: user.initials, color: user.color, avatarVersion: user.avatarVersion };
}

const AVATAR_SIZES = {
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-[12px]',
  lg: 'size-14 text-[18px]'
} as const;

/** The uploaded picture when there is one, otherwise initials on a color that stays with the person. */
export function Avatar({
  subject,
  label,
  size = 'sm',
  ring = true,
  status
}: {
  subject: AvatarSubject;
  label: string;
  size?: keyof typeof AVATAR_SIZES;
  ring?: boolean;
  /** Marks the avatar with this application's current stage. */
  status?: ApplicationStatus;
}) {
  const image = useAvatarImage(subject);
  return (
    <Tooltip content={label}>
      <span
        tabIndex={0}
        role="img"
        aria-label={label}
        className={cn('relative inline-flex shrink-0 cursor-default select-none items-center justify-center rounded-full font-semibold text-white', AVATAR_SIZES[size], ring && 'ring-2 ring-surface')}
        style={{ backgroundColor: subject.color }}
      >
        {image ? <img src={image} alt="" className="size-full rounded-full object-cover" /> : subject.initials}
        {status ? <span aria-hidden className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-surface" style={{ backgroundColor: statusInk(status) }} /> : null}
      </span>
    </Tooltip>
  );
}

const MAX_SHOWN = 4;

/** Overlapping profile avatars with the number of applications, each marked with its current stage. */
export function AvatarStack({ applications, size = 'sm', showCount = true }: { applications: ApplicationSummary[]; size?: 'sm' | 'md'; showCount?: boolean }) {
  if (applications.length === 0) return <span className="text-ink-3">—</span>;
  const shown = applications.slice(0, MAX_SHOWN);
  return (
    <div className="flex items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
      <div className={cn('flex items-center', size === 'sm' ? '-space-x-1.5' : '-space-x-2')}>
        {shown.map((application) => (
          <Avatar key={application.id} subject={application.profile} label={`${applicationLabel(application)}: ${application.status}`} size={size} status={application.status} />
        ))}
      </div>
      {showCount ? (
        <span className="text-[12px] tabular-nums text-ink-2" title={`${applications.length} applications`} aria-label={`${applications.length} applications`}>
          {applications.length}
        </span>
      ) : null}
    </div>
  );
}

/** The whole process at a glance: a symbol per stage, passed in green, the current one in its color. */
export function ProcessSteps({ status, furthest, className }: { status: ApplicationStatus; furthest: PipelineStage; className?: string }) {
  const rejected = status === 'Rejected';
  const furthestIndex = PIPELINE_STAGES.indexOf(furthest);
  const stages = rejected ? PIPELINE_STAGES.slice(0, furthestIndex + 1) : PIPELINE_STAGES;
  const RejectedIcon = STATUS_ICONS.Rejected;
  return (
    <ol className={cn('flex items-center gap-0.5', className)} aria-label={rejected ? `Reached ${furthest}, then rejected` : `Current stage: ${status}`}>
      {stages.map((stage, index) => {
        const Icon = STATUS_ICONS[stage];
        const current = !rejected && stage === status;
        const passed = !current && index <= furthestIndex;
        return (
          <li key={stage} className="inline-flex items-center gap-0.5" title={stage}>
            {index > 0 ? <span className={cn('h-px w-2', passed || current ? 'bg-success-ink' : 'bg-border-strong')} aria-hidden /> : null}
            <span
              className={cn('inline-flex size-5 items-center justify-center rounded-full', passed && 'bg-success-soft text-success-ink', !current && !passed && 'border border-border text-ink-3', current && 'ring-1 ring-current')}
              style={current ? statusStyle(stage) : undefined}
            >
              <Icon className="size-3" aria-hidden />
            </span>
          </li>
        );
      })}
      {rejected ? (
        <li className="inline-flex items-center gap-0.5" title="Rejected">
          <span className="h-px w-2 bg-border-strong" aria-hidden />
          <span className="inline-flex size-5 items-center justify-center rounded-full ring-1 ring-current" style={statusStyle('Rejected')}>
            <RejectedIcon className="size-3" aria-hidden />
          </span>
        </li>
      ) : null}
    </ol>
  );
}

/** One line per profile in an expanded job row. Only your own can be changed from here. */
export function ProcessLine({ application }: { application: ApplicationSummary }) {
  return (
    <li className="flex items-center gap-3 py-1.5">
      <Avatar subject={application.profile} label={applicationLabel(application)} ring={false} />
      <span className="w-[170px] min-w-0 truncate" title={applicationLabel(application)}>
        {applicationLabel(application)}
      </span>
      <ProcessSteps status={application.status} furthest={application.furthestStage} className="flex-1" />
      <span onClick={(event) => event.stopPropagation()} className="inline-flex w-7 justify-center">
        {application.isMine ? <StatusSelect applicationId={application.id} status={application.status} /> : <StatusBadge status={application.status} />}
      </span>
      <span className="inline-flex w-[176px] items-center gap-1.5 text-[12px] tabular-nums text-ink-2">
        {application.nextInterviewAt ? (
          <>
            <CalendarClock className="size-3.5 shrink-0 text-ink-3" aria-hidden />
            <span className="truncate" aria-label="Next interview">
              {formatDateTime(application.nextInterviewAt)}
            </span>
          </>
        ) : null}
      </span>
      <span className="inline-flex w-5 justify-center">{application.memoPreview ? <Symbol icon={StickyNote} label={application.memoPreview} className="text-ink-3" size="size-3.5" /> : null}</span>
    </li>
  );
}
