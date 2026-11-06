import { useState } from 'react';
import { Banknote, CalendarDays, CopyCheck, Link2, MapPin, Merge, Split, Users } from 'lucide-react';
import type { DuplicateJobSummary, DuplicatePair } from '@shared/api';
import { formatSalary, JobTags } from '@/components/job-tags';
import { useCopyLink } from '@/lib/copy-link';
import { Button } from '@/components/ui/button';
import { EmptyState, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { errorMessage, useDismissDuplicate, useDuplicates, useMergeDuplicate } from '@/lib/api';
import { formatDate } from '@/lib/utils';

function hostName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function Side({ job, onOpen }: { job: DuplicateJobSummary; onOpen: (id: number) => void }) {
  const salary = formatSalary(job.facts);
  const copyLink = useCopyLink();
  return (
    <div className="min-w-0 flex-1 p-3">
      <JobTags facts={job.facts} className="mb-1" />
      <button type="button" className="block max-w-full truncate text-left font-semibold hover:underline" title={job.title} onClick={() => onOpen(job.id)}>
        {job.title}
      </button>
      <p className="truncate text-ink-2">{job.company}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-ink-3">
        {job.location ? (
          <span className="inline-flex min-w-0 items-center gap-1" title="Location">
            <MapPin className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{job.location}</span>
          </span>
        ) : null}
        {salary ? (
          <span className="inline-flex items-center gap-1" title="Salary">
            <Banknote className="size-3" aria-hidden /> {salary}
          </span>
        ) : null}
        {job.facts.postedAt ? (
          <span className="inline-flex items-center gap-1" title="Posted">
            <CalendarDays className="size-3" aria-hidden /> {formatDate(job.facts.postedAt)}
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1 tabular-nums" title={`${job.applicationCount} applications`}>
          <Users className="size-3" aria-hidden /> {job.applicationCount}
        </span>
      </div>
      <p className="selectable mt-1.5 line-clamp-3 text-[12.5px] text-ink-2">{job.descriptionPreview}</p>
      <div className="mt-1.5 flex flex-wrap gap-x-2.5 text-[12px] text-ink-3">
        {job.urls.map((url) => (
          <button key={url} type="button" title={`${url}
Click to copy`} className="inline-flex min-w-0 items-center gap-1 hover:text-ink" onClick={() => copyLink(url)}>
            <Link2 className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{hostName(url)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PairCard({ pair, busy, onMerge, onDismiss, onOpen }: { pair: DuplicatePair; busy: boolean; onMerge: () => void; onDismiss: () => void; onOpen: (id: number) => void }) {
  return (
    <li data-duplicate-pair className="rounded-lg border border-border bg-surface">
      <div className="flex divide-x divide-border">
        <Side job={pair.jobA} onOpen={onOpen} />
        <Side job={pair.jobB} onOpen={onOpen} />
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1">
          {pair.reasons.map((reason) => (
            <span key={reason} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] text-ink-2">
              {reason}
            </span>
          ))}
        </div>
        <Tooltip content="These are different jobs">
          <Button size="sm" disabled={busy} aria-label="Different jobs" onClick={onDismiss}>
            <Split /> Different
          </Button>
        </Tooltip>
        <Tooltip content="These are one job: merge them">
          <Button size="sm" variant="primary" disabled={busy} aria-label="Same job" onClick={onMerge}>
            <Merge /> Same
          </Button>
        </Tooltip>
      </div>
    </li>
  );
}

/** Pairs the app could not be sure about. One click settles each, and it never asks about that pair again. */
export function DuplicatesPage({ onOpenJob }: { onOpenJob: (id: number) => void }) {
  const duplicates = useDuplicates();
  const merge = useMergeDuplicate();
  const dismiss = useDismissDuplicate();
  const toast = useToast();
  const [working, setWorking] = useState<string | null>(null);
  const pairs = duplicates.data?.pairs ?? [];

  const settle = (pair: DuplicatePair, action: typeof merge | typeof dismiss) => {
    const key = `${pair.jobA.id}-${pair.jobB.id}`;
    setWorking(key);
    action.mutate(
      { jobIdA: pair.jobA.id, jobIdB: pair.jobB.id },
      {
        onError: (error) => toast.show(errorMessage(error), 'error'),
        onSettled: () => setWorking(null)
      }
    );
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 px-5 pb-2.5 pt-4">
        <h1 className="whitespace-nowrap text-[17px] font-semibold leading-tight">Possible duplicates</h1>
        <span className="inline-flex items-center gap-1 text-[12.5px] tabular-nums text-ink-3" role="status" title={`${duplicates.data?.total ?? 0} pairs to check`}>
          <CopyCheck className="size-3.5" aria-hidden />
          {duplicates.data?.total ?? ''}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto border-t border-border bg-surface-2/40 p-4">
        {duplicates.error ? (
          <Notice kind="error" title="Could not load the list">
            {errorMessage(duplicates.error)}
          </Notice>
        ) : !duplicates.data ? (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : pairs.length === 0 ? (
          <EmptyState icon={CopyCheck} title="No duplicates to check" />
        ) : (
          <ul className="mx-auto max-w-[1100px] space-y-3">
            {pairs.map((pair) => (
              <PairCard
                key={`${pair.jobA.id}-${pair.jobB.id}`}
                pair={pair}
                busy={working === `${pair.jobA.id}-${pair.jobB.id}`}
                onMerge={() => settle(pair, merge)}
                onDismiss={() => settle(pair, dismiss)}
                onOpen={onOpenJob}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
