import { useMemo, useState } from 'react';
import { CalendarDays, Pencil, Trash2 } from 'lucide-react';
import type { InterviewListItem } from '@shared/api';
import { INTERVIEW_STAGES, type InterviewStage } from '@shared/constants';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { Card, EmptyState, Notice, Skeleton } from '@/components/ui/misc';
import { ANY, Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { errorMessage, useDeleteInterview, useInterviews } from '@/lib/api';
import { dayBoundary, formatLongDate, formatTime } from '@/lib/utils';
import { InterviewFormDialog } from './interview-form';

type Range = 'upcoming' | 'past' | 'all';

export function InterviewsPage({ onOpenJob }: { onOpenJob: (id: number) => void }) {
  const [range, setRange] = useState<Range>('upcoming');
  const [stage, setStage] = useState<string>(ANY);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [editing, setEditing] = useState<InterviewListItem | null>(null);
  const [removing, setRemoving] = useState<InterviewListItem | null>(null);
  const remove = useDeleteInterview();
  const toast = useToast();

  const filter = useMemo(() => {
    // Fixed to the minute so that the query key does not change on every render.
    const now = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    return {
      stage: stage === ANY ? undefined : (stage as InterviewStage),
      from: from ? dayBoundary(from, 'start') : range === 'upcoming' ? now : undefined,
      to: to ? dayBoundary(to, 'end') : range === 'past' ? now : undefined
    };
  }, [range, stage, from, to]);
  const interviews = useInterviews(filter);

  const items = useMemo(() => {
    const list = interviews.data ?? [];
    return range === 'past' ? [...list].reverse() : list;
  }, [interviews.data, range]);

  const groups = useMemo(() => {
    const byDay = new Map<string, InterviewListItem[]>();
    for (const item of items) {
      const day = formatLongDate(item.scheduledAt);
      byDay.set(day, [...(byDay.get(day) ?? []), item]);
    }
    return [...byDay.entries()];
  }, [items]);

  return (
    <div className="flex h-full flex-col">
      <header className="px-6 pb-3 pt-5">
        <h1 className="text-[20px] font-semibold leading-tight">Interviews</h1>
        <p className="mt-0.5 text-ink-2">Your own interviews, shown in this computer's timezone. Nobody else can see them.</p>
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border-strong p-0.5" role="group" aria-label="Time range">
            {(['upcoming', 'past', 'all'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={range === value}
                onClick={() => setRange(value)}
                className={`h-7 rounded px-3 capitalize ${range === value ? 'bg-accent-soft font-medium text-accent-soft-ink' : 'text-ink-2 hover:text-ink'}`}
              >
                {value}
              </button>
            ))}
          </div>
          <Select ariaLabel="Interview stage" className="w-[180px]" value={stage} onChange={setStage} options={[{ value: ANY, label: 'Any stage' }, ...INTERVIEW_STAGES.map((value) => ({ value, label: value }))]} />
          <span className="ml-1 text-[12px] text-ink-3">From</span>
          <Input type="date" aria-label="From date" className="w-[132px]" value={from} onChange={(event) => setFrom(event.target.value)} />
          <span className="text-[12px] text-ink-3">to</span>
          <Input type="date" aria-label="To date" className="w-[132px]" value={to} onChange={(event) => setTo(event.target.value)} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        {interviews.isError ? (
          <Notice kind="error" title="Could not load interviews">
            {errorMessage(interviews.error)}
          </Notice>
        ) : interviews.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={CalendarDays} title={range === 'upcoming' ? 'No upcoming interviews' : 'No interviews found'}>
            Open a job from My Applications to schedule one.
          </EmptyState>
        ) : (
          <div className="space-y-5">
            {groups.map(([day, list]) => (
              <section key={day}>
                <h2 className="mb-2 text-[12.5px] font-semibold text-ink-2">{day}</h2>
                <Card className="divide-y divide-border overflow-hidden">
                  {list.map((interview) => (
                    <div key={interview.id} className="group flex items-start gap-4 px-4 py-3 hover:bg-surface-2/60">
                      <span className="w-[72px] shrink-0 pt-px font-medium tabular-nums">{formatTime(interview.scheduledAt)}</span>
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenJob(interview.jobId)}>
                        <p className="truncate font-medium">{interview.title}</p>
                        <p className="truncate text-ink-2">
                          {interview.company} · {interview.stage}
                        </p>
                        {interview.note ? <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-ink-2">{interview.note}</p> : null}
                      </button>
                      <div className="flex shrink-0 gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                        <Button size="icon-sm" variant="ghost" aria-label="Edit interview" onClick={() => setEditing(interview)}>
                          <Pencil />
                        </Button>
                        <Button size="icon-sm" variant="danger-ghost" aria-label="Remove interview" onClick={() => setRemoving(interview)}>
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  ))}
                </Card>
              </section>
            ))}
          </div>
        )}
      </div>

      <InterviewFormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        applicationId={editing?.applicationId ?? 0}
        interview={editing}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="Remove this interview?"
        confirmLabel="Remove"
        danger
        loading={remove.isPending}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate(removing.id, {
            onSuccess: () => setRemoving(null),
            onError: (error) => toast.show(errorMessage(error), 'error')
          });
        }}
      >
        {removing ? `${removing.stage} at ${removing.company}.` : null}
      </ConfirmDialog>
    </div>
  );
}
