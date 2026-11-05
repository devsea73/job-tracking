import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { CalendarPlus, ExternalLink, History, Link2, MapPin, Pencil, Trash2, UserPlus, X } from 'lucide-react';
import type { CurrentUser, Interview, JobDetail, MyApplicationDetail } from '@shared/api';
import { AvatarStack, HighlightButton, StatusBadge, StatusSelect } from '@/components/job-bits';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, Sheet } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { call, errorMessage, useApplyToJob, useDeleteApplication, useDeleteInterview, useJob, useUpdateApplication } from '@/lib/api';
import { formatDate, formatDateTime, formatRelative } from '@/lib/utils';
import { InterviewFormDialog } from './interview-form';

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-border px-5 py-4">
      <div className="mb-2.5 flex min-h-7 items-center justify-between gap-2">
        <h3 className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-3">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

const PLATFORM_NAMES: Record<string, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workday: 'Workday',
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  builtin: 'Built In',
  jobright: 'Jobright',
  glassdoor: 'Glassdoor',
  ziprecruiter: 'ZipRecruiter',
  smartrecruiters: 'SmartRecruiters',
  icims: 'iCIMS',
  jobdiva: 'JobDiva',
  company: 'Company site'
};

function MemoEditor({ application }: { application: MyApplicationDetail }) {
  const [memo, setMemo] = useState(application.memo);
  const update = useUpdateApplication();
  const toast = useToast();
  // A change from elsewhere (another window of the same account) replaces an unedited memo.
  useEffect(() => setMemo(application.memo), [application.memo]);
  const dirty = memo !== application.memo;
  const save = () => {
    if (!dirty) return;
    update.mutate({ id: application.id, body: { memo } }, { onError: (error) => toast.show(errorMessage(error), 'error') });
  };
  return (
    <Field label="Memo" htmlFor="application-memo" hint={update.isPending ? 'Saving…' : dirty ? 'Saves when you click away.' : 'Private to you.'}>
      <Textarea id="application-memo" rows={3} value={memo} onChange={(event) => setMemo(event.target.value)} onBlur={save} placeholder="Notes, contacts, anything to remember" />
    </Field>
  );
}

function InterviewList({ application }: { application: MyApplicationDetail }) {
  const [editing, setEditing] = useState<Interview | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [removing, setRemoving] = useState<Interview | null>(null);
  const remove = useDeleteInterview();
  const toast = useToast();
  const now = Date.now();

  return (
    <>
      <div className="mb-2 mt-4 flex items-center justify-between">
        <span className="text-[12.5px] font-medium text-ink-2">Interviews</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          <CalendarPlus /> Schedule
        </Button>
      </div>
      {application.interviews.length === 0 ? (
        <p className="text-ink-3">No interviews scheduled.</p>
      ) : (
        <ul className="space-y-1.5">
          {application.interviews.map((interview) => {
            const past = new Date(interview.scheduledAt).getTime() < now;
            return (
              <li key={interview.id} className="group flex items-start gap-3 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className={past ? 'font-medium text-ink-2' : 'font-medium'}>{interview.stage}</p>
                  <p className="text-ink-2">{formatDateTime(interview.scheduledAt)}</p>
                  {interview.note ? <p className="selectable mt-1 whitespace-pre-wrap text-[12.5px] text-ink-2">{interview.note}</p> : null}
                </div>
                <div className="flex shrink-0 gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                  <Tooltip content="Edit">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Edit interview"
                      onClick={() => {
                        setEditing(interview);
                        setFormOpen(true);
                      }}
                    >
                      <Pencil />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Remove">
                    <Button size="icon-sm" variant="danger-ghost" aria-label="Remove interview" onClick={() => setRemoving(interview)}>
                      <Trash2 />
                    </Button>
                  </Tooltip>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <InterviewFormDialog open={formOpen} onOpenChange={setFormOpen} applicationId={application.id} interview={editing} />
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
        {removing ? `${removing.stage}, ${formatDateTime(removing.scheduledAt)}.` : null}
      </ConfirmDialog>
    </>
  );
}

function MyApplicationSection({ job, application }: { job: JobDetail; application: MyApplicationDetail | null }) {
  const [memo, setMemo] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);
  const apply = useApplyToJob();
  const withdraw = useDeleteApplication();
  const toast = useToast();

  if (!application) {
    return (
      <Section title="My application">
        <p className="mb-2 text-ink-2">You haven't marked this job as applied.</p>
        <Textarea rows={2} value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="Memo (optional, private to you)" aria-label="Memo" />
        <Button
          className="mt-2"
          variant="primary"
          loading={apply.isPending}
          onClick={() =>
            apply.mutate({ jobId: job.id, memo }, { onSuccess: () => toast.show('Added to your applications.'), onError: (error) => toast.show(errorMessage(error), 'error') })
          }
        >
          <UserPlus /> I applied to this job
        </Button>
      </Section>
    );
  }

  return (
    <Section
      title="My application"
      action={
        <Button size="sm" variant="danger-ghost" onClick={() => setWithdrawing(true)}>
          Remove
        </Button>
      }
    >
      <div className="mb-3 flex items-center gap-3">
        <StatusSelect applicationId={application.id} status={application.status} />
        <span className="text-ink-3">Applied {formatDate(application.appliedAt)}</span>
      </div>
      <MemoEditor key={application.id} application={application} />
      <InterviewList application={application} />
      {application.history.length > 0 ? (
        <>
          <div className="mb-2 mt-4 flex items-center gap-1.5 text-[12.5px] font-medium text-ink-2">
            <History className="size-3.5" aria-hidden /> History
          </div>
          <ol className="space-y-1.5">
            {application.history.map((entry) => (
              <li key={entry.id} className="flex items-center gap-2 text-[12.5px] text-ink-2">
                {entry.oldStatus ? (
                  <>
                    <StatusBadge status={entry.oldStatus} className="h-5 px-2 text-[11px]" />
                    <span aria-label="changed to">→</span>
                  </>
                ) : null}
                <StatusBadge status={entry.newStatus} className="h-5 px-2 text-[11px]" />
                <span className="ml-auto whitespace-nowrap text-ink-3">{formatDateTime(entry.changedAt)}</span>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      <ConfirmDialog
        open={withdrawing}
        onOpenChange={setWithdrawing}
        title="Remove your application?"
        confirmLabel="Remove"
        danger
        loading={withdraw.isPending}
        onConfirm={() =>
          withdraw.mutate(application.id, {
            onSuccess: () => {
              setWithdrawing(false);
              toast.show('Your application was removed. The job stays in the shared list.');
            },
            onError: (error) => toast.show(errorMessage(error), 'error')
          })
        }
      >
        Your status, memo and interviews for this job will be deleted. The job itself stays in the shared list for everyone else.
      </ConfirmDialog>
    </Section>
  );
}

function EditJobDialog({ job, open, onOpenChange }: { job: JobDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [fields, setFields] = useState({ title: job.title, company: job.company, location: job.location ?? '', description: job.description });
  const queryClient = useQueryClient();
  useEffect(() => {
    if (open) setFields({ title: job.title, company: job.company, location: job.location ?? '', description: job.description });
  }, [open, job]);
  const save = useMutation({
    mutationFn: () => call('PATCH', `/api/jobs/${job.id}`, { ...fields, location: fields.location.trim() || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onOpenChange(false);
    }
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-2xl"
      title="Correct job details"
      description="These details are shared with everyone."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!fields.title.trim() || !fields.company.trim() || !fields.description.trim()} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Job title" htmlFor="edit-title">
            <Input id="edit-title" value={fields.title} onChange={(event) => setFields({ ...fields, title: event.target.value })} />
          </Field>
          <Field label="Company" htmlFor="edit-company">
            <Input id="edit-company" value={fields.company} onChange={(event) => setFields({ ...fields, company: event.target.value })} />
          </Field>
        </div>
        <Field label="Location" htmlFor="edit-location">
          <Input id="edit-location" value={fields.location} onChange={(event) => setFields({ ...fields, location: event.target.value })} />
        </Field>
        <Field label="Job description" htmlFor="edit-description">
          <Textarea id="edit-description" rows={12} value={fields.description} onChange={(event) => setFields({ ...fields, description: event.target.value })} />
        </Field>
        {save.isError ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
      </div>
    </Dialog>
  );
}

export function JobDetailSheet({ jobId, user, onClose }: { jobId: number | null; user: CurrentUser; onClose: () => void }) {
  const query = useJob(jobId);
  const job = query.data && query.data.id === jobId ? query.data : null;
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: number) => call('DELETE', `/api/jobs/${id}`),
    onSuccess: async () => {
      setDeleting(false);
      onClose();
      await queryClient.invalidateQueries();
      toast.show('Job deleted.');
    },
    onError: (error) => toast.show(errorMessage(error), 'error')
  });
  const primaryUrl = job?.urls.find((url) => url.kind === 'original')?.originalUrl ?? job?.urls[0]?.originalUrl;

  return (
    <Sheet
      open={jobId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Job details"
    >
      <div className="flex items-start gap-3 px-5 pb-4 pt-4">
        <div className="min-w-0 flex-1">
          {job ? (
            <>
              <h2 className="selectable text-[18px] font-semibold leading-snug">{job.title}</h2>
              <p className="selectable mt-0.5 text-[14px] text-ink-2">{job.company}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-3">
                {job.location ? (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="size-3.5" aria-hidden /> {job.location}
                  </span>
                ) : null}
                <span>Added {formatRelative(job.createdAt)}</span>
              </div>
            </>
          ) : (
            <>
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="mt-2 h-4 w-1/3" />
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {job ? <HighlightButton jobId={job.id} highlighted={job.isHighlighted} highlightedBy={job.highlightedBy} size="lg" /> : null}
          {primaryUrl ? (
            <Tooltip content="Open posting in your browser">
              <Button size="icon" variant="ghost" aria-label="Open posting in your browser" onClick={() => void window.jobTracker.openExternal(primaryUrl)}>
                <ExternalLink />
              </Button>
            </Tooltip>
          ) : null}
          <Button size="icon" variant="ghost" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isError ? (
          <div className="px-5 pb-4">
            <Notice kind="error">{errorMessage(query.error)}</Notice>
          </div>
        ) : null}
        {job ? (
          <>
            <Section title="Applied">
              {job.applicants.length ? (
                <div className="flex items-center gap-2.5">
                  <AvatarStack users={job.applicants} size="md" />
                  <span className="text-ink-2">{job.applicants.map((applicant) => applicant.displayName ?? applicant.username).join(', ')}</span>
                </div>
              ) : (
                <p className="text-ink-3">Nobody has marked this job as applied.</p>
              )}
            </Section>

            <MyApplicationSection job={job} application={job.myApplication} />

            <Section title="Job description">
              <div className="selectable whitespace-pre-wrap break-words leading-relaxed">{job.description}</div>
            </Section>

            <Section title="Links">
              <ul className="space-y-1">
                {job.urls
                  .filter((url) => url.kind !== 'redirect')
                  .map((url) => (
                  <li key={url.id} className="flex items-center gap-2">
                    <Link2 className="size-3.5 shrink-0 text-ink-3" aria-hidden />
                    <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">{PLATFORM_NAMES[url.sourcePlatform ?? ''] ?? url.sourcePlatform ?? 'Link'}</span>
                    <button type="button" className="min-w-0 truncate text-left text-accent-soft-ink hover:underline" title={url.originalUrl} onClick={() => void window.jobTracker.openExternal(url.originalUrl)}>
                      {url.originalUrl}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[12px] text-ink-3">
                {job.lastExtractedAt ? `Details read ${formatRelative(job.lastExtractedAt)}.` : 'Details entered by hand.'}
                {job.isHighlighted && job.highlightedBy ? ` Highlighted by ${job.highlightedBy}.` : ''}
              </p>
            </Section>

            {user.role === 'admin' ? (
              <Section title="Administrator">
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setEditing(true)}>
                    <Pencil /> Correct details
                  </Button>
                  <Button size="sm" variant="danger-ghost" onClick={() => setDeleting(true)}>
                    <Trash2 /> Delete job
                  </Button>
                </div>
                <EditJobDialog job={job} open={editing} onOpenChange={setEditing} />
                <ConfirmDialog open={deleting} onOpenChange={setDeleting} title="Delete this job for everyone?" confirmLabel="Delete" danger loading={remove.isPending} onConfirm={() => remove.mutate(job.id)}>
                  This removes the job along with {job.applicants.length} application(s), including everyone's memos and interviews. This cannot be undone, except by restoring a backup.
                </ConfirmDialog>
              </Section>
            ) : null}
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
