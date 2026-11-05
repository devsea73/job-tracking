import { useQueryClient } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { Applicant } from '@shared/api';
import { APPLICATION_STATUSES, type ApplicationStatus } from '@shared/constants';
import { errorMessage, useSetHighlight, useUpdateApplication } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Select } from './ui/select';
import { Tooltip } from './ui/misc';
import { useToast } from './ui/toast';

const STATUS_TOKENS: Record<ApplicationStatus, string> = {
  Applied: 'applied',
  'Recruiter Screen': 'recruiter',
  'Technical Interview': 'technical',
  'Final Interview': 'final',
  Offer: 'offer',
  Rejected: 'rejected'
};

function statusStyle(status: ApplicationStatus): CSSProperties {
  const token = STATUS_TOKENS[status];
  return { backgroundColor: `var(--status-${token}-bg)`, color: `var(--status-${token}-ink)` };
}

export function StatusBadge({ status, className }: { status: ApplicationStatus; className?: string }) {
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium', className)} style={statusStyle(status)}>
      <span className="size-1.5 rounded-full bg-current opacity-80" aria-hidden />
      {status}
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
      options={APPLICATION_STATUSES.map((value) => ({ value, label: value }))}
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
  const label = shown ? `Highlighted for everyone${highlightedBy ? ` by ${highlightedBy}` : ''}. Click to remove.` : 'Highlight for everyone';
  return (
    <Tooltip content={label}>
      <button
        type="button"
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
    </Tooltip>
  );
}

export function Avatar({ user, size = 'sm', ring = true }: { user: Pick<Applicant, 'username' | 'displayName' | 'initials' | 'color'>; size?: 'sm' | 'md'; ring?: boolean }) {
  const name = user.displayName ? `${user.displayName} (${user.username})` : user.username;
  return (
    <Tooltip content={name}>
      <span
        tabIndex={0}
        role="img"
        aria-label={name}
        className={cn(
          'inline-flex shrink-0 cursor-default select-none items-center justify-center rounded-full font-semibold text-white',
          size === 'sm' ? 'size-6 text-[10px]' : 'size-8 text-[12px]',
          ring && 'ring-2 ring-surface'
        )}
        style={{ backgroundColor: user.color }}
      >
        {user.initials}
      </span>
    </Tooltip>
  );
}

const MAX_SHOWN = 5;

/** Overlapping avatars, with a count for anyone past the fifth. */
export function AvatarStack({ users, size = 'sm' }: { users: Applicant[]; size?: 'sm' | 'md' }) {
  if (users.length === 0) return <span className="text-ink-3">—</span>;
  const shown = users.slice(0, MAX_SHOWN);
  const hidden = users.slice(MAX_SHOWN);
  return (
    <div className={cn('flex items-center', size === 'sm' ? '-space-x-1.5' : '-space-x-2')} onClick={(event) => event.stopPropagation()}>
      {shown.map((user) => (
        <Avatar key={user.id} user={user} size={size} />
      ))}
      {hidden.length > 0 ? (
        <Tooltip content={hidden.map((user) => user.username).join(', ')}>
          <span tabIndex={0} className={cn('inline-flex items-center justify-center rounded-full bg-surface-2 font-semibold text-ink-2 ring-2 ring-surface', size === 'sm' ? 'size-6 text-[10px]' : 'size-8 text-[12px]')}>
            +{hidden.length}
          </span>
        </Tooltip>
      ) : null}
    </div>
  );
}
