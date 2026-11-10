import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Banknote, CalendarCheck, CalendarDays, CalendarPlus, Clock, Copy, Info, FileText, Link2, MapPin, Pencil, StickyNote, Trash2, User, UserPlus, Users, X, type LucideIcon } from 'lucide-react';
import type { ApplicationDetail, CurrentUser, JobDetail, Step } from '@shared/api';
import type { StepStage } from '@shared/constants';
import { isUnreadableNote } from '@shared/unreadable';
import { applicationLabel, Avatar, canDeleteJob, canEditJob, HighlightButton, ProcessSteps, StageBadge, userName } from '@/components/job-bits';
import { formatSalary, JobTags } from '@/components/job-tags';
import { useCopyLink } from '@/lib/copy-link';
import { Symbol } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, Sheet } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { call, errorMessage, useApplyToJob, useDeleteApplication, useDeleteJob, useDeleteStep, useJob, useProfiles, useUpdateApplication } from '@/lib/api';
import { cn, formatDate, formatDateTime, formatRelative, localTimeZone, toLocalInputValue } from '@/lib/utils';
import { StepFormDialog } from './step-form';

function Section({ title, icon: Icon, count, aside, children }: { title: string; icon: LucideIcon; count?: number; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-border px-5 py-3.5">
      <div className="mb-2 flex items-center gap-3">
        <h3 className="flex shrink-0 items-center gap-1.5 text-ink-3">
          <Symbol icon={Icon} label={title} />
          <span className="sr-only">{title}</span>
          {count !== undefined ? <span className="text-[12.5px] tabular-nums">{count}</span> : null}
        </h3>
        {aside ? <div className="flex min-w-0 flex-1 justify-end">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** The job's links in one row: the one it was added with first. Clicking copies, nothing opens. */
function JobLinks({ job }: { job: JobDetail }) {
  const copy = useCopyLink();
  const links = job.urls.filter((url) => url.kind === 'original' || url.kind === 'canonical');
  if (links.length === 0) return null;
  const [first, ...rest] = links;
  const shortLink = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '');
  return (
    <div className="flex min-w-0 items-center gap-1.5" data-job-links>
      <button
        type="button"
        title={`${first.originalUrl}\nClick to copy`}
        aria-label={`Copy the job link ${first.originalUrl}`}
        onClick={() => copy(first.originalUrl)}
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12.5px] text-accent-soft-ink hover:bg-surface-2"
      >
        <Link2 className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{shortLink(first.originalUrl)}</span>
        <Copy className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      </button>
      {rest.map((url) => (
        <button
          key={url.id}
          type="button"
          title={`${url.originalUrl}\nClick to copy`}
          aria-label={`Copy the link ${url.originalUrl}`}
          onClick={() => copy(url.originalUrl)}
          className="shrink-0 rounded-md border border-border px-2 py-1 text-[12px] text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          {linkHost(url.originalUrl)}
        </button>
      ))}
      <span className="shrink-0 text-ink-3">
        <Symbol icon={job.lastExtractedAt ? FileText : Pencil} label={job.lastExtractedAt ? `Details read ${formatRelative(job.lastExtractedAt)}.` : 'Details entered by hand.'} size="size-3.5" />
      </span>
    </div>
  );
}

function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function MemoEditor({ application }: { application: ApplicationDetail }) {
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
    <div className="relative">
      <StickyNote className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-3" aria-hidden />
      <Textarea aria-label="Memo" title="Saves when you click away. Everyone on this host can see it." className="pl-8" rows={2} value={memo} onChange={(event) => setMemo(event.target.value)} onBlur={save} placeholder="Memo" />
    </div>
  );
}

/** When the person applied, if not when they added it here: the timeline's first entry. */
function AppliedDateDialog({ application, open, onOpenChange }: { application: ApplicationDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const update = useUpdateApplication();
  useEffect(() => {
    if (!open) return;
    update.reset();
    const [day, clock] = toLocalInputValue(application.appliedAt).split('T');
    setDate(day);
    setTime(clock);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const at = date && time ? new Date(`${date}T${time}`) : null;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-sm"
      title="When did you apply?"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!at || Number.isNaN(at.getTime())}
            onClick={() => at && update.mutate({ id: application.id, body: { appliedAt: at.toISOString() } }, { onSuccess: () => onOpenChange(false) })}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date" htmlFor="applied-date">
          <Input id="applied-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </Field>
        <Field label="Time" htmlFor="applied-time" hint={localTimeZone()}>
          <Input id="applied-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        </Field>
      </div>
      {update.isError ? <Notice kind="error">{errorMessage(update.error)}</Notice> : null}
    </Dialog>
  );
}

/**
 * The application's process as a timeline, oldest first: when it was applied, then each step at
 * the time it takes place. The stage it is at is the latest step's. Several steps at one stage are
 * its rounds, numbered: three technical interviews read Technical Interview 1, 2 and 3.
 */
function Timeline({ application }: { application: ApplicationDetail }) {
  const [editing, setEditing] = useState<Step | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [removing, setRemoving] = useState<Step | null>(null);
  const [changingApplied, setChangingApplied] = useState(false);
  const remove = useDeleteStep();
  const toast = useToast();
  const now = new Date().toISOString();
  const editable = application.isMine;
  const latest = application.steps[application.steps.length - 1];
  const rounds = new Map<StepStage, number>();
  const ofStage = (stage: StepStage) => application.steps.filter((step) => step.stage === stage).length;

  return (
    <>
      <ol className="relative mt-2.5 space-y-1 before:absolute before:bottom-3 before:left-[11px] before:top-3 before:w-px before:bg-border" data-timeline>
        <li className="group relative flex items-center gap-2.5 py-0.5">
          <StageBadge stage="Applied" />
          <span className="min-w-0 flex-1 truncate">Applied</span>
          <span className="whitespace-nowrap tabular-nums text-ink-2">{formatDateTime(application.appliedAt)}</span>
          {editable ? (
            <span className="flex w-[52px] shrink-0 justify-end opacity-0 focus-within:opacity-100 group-hover:opacity-100">
              <Tooltip content="Change when you applied">
                <Button size="icon-sm" variant="ghost" aria-label="Change when you applied" onClick={() => setChangingApplied(true)}>
                  <Pencil />
                </Button>
              </Tooltip>
            </span>
          ) : null}
        </li>
        {application.steps.map((step) => {
          const round = (rounds.get(step.stage) ?? 0) + 1;
          rounds.set(step.stage, round);
          const upcoming = step.at > now;
          const isCurrent = step === latest;
          const name = ofStage(step.stage) > 1 ? `${step.stage} ${round}` : step.stage;
          return (
            <li key={step.id} className="group relative flex items-start gap-2.5 py-0.5" data-step={step.stage}>
              <StageBadge stage={step.stage} label={name} className={isCurrent ? 'ring-2 ring-surface outline outline-1 outline-current' : undefined} />
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="flex items-center gap-1.5">
                  <span className={cn('truncate', isCurrent && 'font-semibold')}>{name}</span>
                  {upcoming ? <span className="rounded bg-accent-soft px-1.5 text-[11px] text-accent-soft-ink">Upcoming</span> : null}
                </p>
                {step.note ? <p className="selectable whitespace-pre-wrap text-[12.5px] text-ink-2">{step.note}</p> : null}
              </div>
              <span className={cn('whitespace-nowrap pt-0.5 tabular-nums', upcoming ? 'font-medium' : 'text-ink-2')}>{formatDateTime(step.at)}</span>
              {editable ? (
                <span className="flex w-[52px] shrink-0 justify-end gap-0.5 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                  <Tooltip content="Change">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Change ${name}`}
                      onClick={() => {
                        setEditing(step);
                        setFormOpen(true);
                      }}
                    >
                      <Pencil />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Remove">
                    <Button size="icon-sm" variant="danger-ghost" aria-label={`Remove ${name}`} onClick={() => setRemoving(step)}>
                      <Trash2 />
                    </Button>
                  </Tooltip>
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {editable ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            className="mt-1.5"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <CalendarPlus /> Add a step
          </Button>
          <StepFormDialog open={formOpen} onOpenChange={setFormOpen} applicationId={application.id} step={editing} current={application.stage} steps={application.steps} />
          <AppliedDateDialog application={application} open={changingApplied} onOpenChange={setChangingApplied} />
          <ConfirmDialog
            open={removing !== null}
            onOpenChange={(open) => {
              if (!open) setRemoving(null);
            }}
            title="Remove this step?"
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
            {removing ? `${removing.stage}, ${formatDateTime(removing.at)}. The stage goes back to the step before it.` : null}
          </ConfirmDialog>
        </>
      ) : null}
    </>
  );
}

/** One profile's whole process on this job. Everyone can read it; only the owner can change it. */
function ApplicationCard({ application }: { application: ApplicationDetail }) {
  const [withdrawing, setWithdrawing] = useState(false);
  const withdraw = useDeleteApplication();
  const toast = useToast();
  const copy = useCopyLink();
  return (
    <article className="rounded-lg border border-border p-3">
      <header className="mb-2 flex items-center gap-2.5">
        <Avatar subject={application.profile} label={applicationLabel(application)} size="md" ring={false} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold leading-tight">{application.profile.name}</p>
          <p className="flex min-w-0 items-center gap-1 text-[12px] text-ink-3">
            <span className="truncate" data-applied-at>
              {application.isMine ? '' : `${userName(application.owner)} · `}Applied {formatDateTime(application.appliedAt)}
            </span>
            {application.link ? (
              <button
                type="button"
                title={`Applied with this link:\n${application.link.url}\nClick to copy`}
                aria-label={`Copy the link this application was added with, ${application.link.url}`}
                data-application-link={application.link.url}
                onClick={() => copy(application.link?.url ?? '')}
                className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 hover:bg-surface-2 hover:text-ink"
              >
                <Link2 className="size-3" aria-hidden />
                {linkHost(application.link.url)}
              </button>
            ) : null}
          </p>
        </div>
        <ProcessSteps stage={application.stage} furthest={application.furthestStage} />
        <StageBadge stage={application.stage} label={`Stage: ${application.stage}`} />
        {application.isMine ? (
          <Tooltip content="Remove this application">
            <Button size="icon-sm" variant="danger-ghost" aria-label="Remove this application" onClick={() => setWithdrawing(true)}>
              <Trash2 />
            </Button>
          </Tooltip>
        ) : null}
      </header>
      {application.isMine ? (
        <MemoEditor key={application.id} application={application} />
      ) : application.memo ? (
        <p className="selectable flex gap-2 whitespace-pre-wrap break-words">
          <StickyNote className="mt-0.5 size-4 shrink-0 text-ink-3" aria-label="Memo" />
          {application.memo}
        </p>
      ) : null}
      <Timeline application={application} />
      <ConfirmDialog
        open={withdrawing}
        onOpenChange={setWithdrawing}
        title={`Remove the application from ${application.profile.name}?`}
        confirmLabel="Remove"
        danger
        loading={withdraw.isPending}
        onConfirm={() =>
          withdraw.mutate(application.id, {
            onSuccess: () => setWithdrawing(false),
            onError: (error) => toast.show(errorMessage(error), 'error')
          })
        }
      >
        Its memo and timeline will be deleted. The job stays in the shared list.
      </ConfirmDialog>
    </article>
  );
}

/** Applying from here, under any of your profiles that has not applied to this job yet. */
function ApplySection({ job }: { job: JobDetail }) {
  const profiles = useProfiles();
  const [memo, setMemo] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const apply = useApplyToJob();
  const toast = useToast();
  const used = new Set(job.applications.filter((application) => application.isMine).map((application) => application.profile.id));
  const available = (profiles.data?.profiles ?? []).filter((profile) => !profile.isArchived && !used.has(profile.id));
  if (available.length === 0) return null;
  const chosen = available.find((profile) => String(profile.id) === picked) ?? available[0];
  return (
    <Section title="Apply with a profile" icon={UserPlus}>
      <div className="flex items-start gap-2">
        <Select
          ariaLabel="Profile to apply with"
          className="w-[170px] shrink-0"
          leading={<User className="size-3.5 text-ink-3" aria-hidden />}
          value={String(chosen.id)}
          onChange={setPicked}
          options={available.map((profile) => ({ value: String(profile.id), label: profile.name }))}
        />
        <Input value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="Memo" aria-label="Memo for this application" />
        <Tooltip content="I applied with this profile">
          <Button
            variant="primary"
            size="icon"
            className="size-8.5 shrink-0"
            aria-label="I applied with this profile"
            loading={apply.isPending}
            onClick={() =>
              apply.mutate(
                { jobId: job.id, profileId: chosen.id, memo },
                {
                  onSuccess: () => setMemo(''),
                  onError: (error) => toast.show(errorMessage(error), 'error')
                }
              )
            }
          >
            {apply.isPending ? null : <UserPlus />}
          </Button>
        </Tooltip>
      </div>
    </Section>
  );
}

type JobFields = { title: string; company: string; location: string; description: string };
const fieldsOf = (job: JobDetail): JobFields => ({ title: job.title, company: job.company, location: job.location ?? '', description: job.description });

function EditJobDialog({ job, open, onOpenChange }: { job: JobDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [fields, setFields] = useState(() => fieldsOf(job));
  // What the job said when the dialog opened, to notice someone else changing it meanwhile.
  const [opened, setOpened] = useState(() => fieldsOf(job));
  const latest = useRef(job);
  latest.current = job;
  const queryClient = useQueryClient();
  // Filled in when the dialog opens, then left alone: live updates fetch the job again whenever
  // anyone changes anything, and refilling then would wipe out what is being typed.
  useEffect(() => {
    if (!open) return;
    setFields(fieldsOf(latest.current));
    setOpened(fieldsOf(latest.current));
  }, [open]);
  const now = fieldsOf(job);
  // Not this person's own save coming back: what changed is neither what was there nor what they typed.
  const changedMeanwhile = open && (Object.keys(now) as Array<keyof JobFields>).some((key) => now[key].trim() !== opened[key].trim() && now[key].trim() !== fields[key].trim());
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
        {changedMeanwhile ? (
          <Notice kind="warning" title="Changed by someone else">
            These details were updated since you opened this. Saving replaces that version with what is here.
          </Notice>
        ) : null}
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
  const remove = useDeleteJob();
  const copyLink = useCopyLink();
  // The link I applied with, when I did; otherwise the one the job was first added with.
  const primaryUrl = job?.applications.find((application) => application.isMine && application.link)?.link?.url ?? job?.urls.find((url) => url.kind === 'original')?.originalUrl ?? job?.urls[0]?.originalUrl;
  const salary = job ? formatSalary(job.facts) : null;
  // With several of my profiles on this job, the first time I applied.
  const myAppliedAt = job?.applications.filter((application) => application.isMine).map((application) => application.appliedAt).sort()[0];

  return (
    <Sheet
      open={jobId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Job details"
    >
      <div className="flex items-start gap-3 px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          {job ? (
            <>
              <JobTags facts={job.facts} className="mb-1.5 h-auto flex-wrap" />
              <h2 className="selectable text-[17px] font-semibold leading-snug">{job.title}</h2>
              <p className="selectable mt-0.5 text-ink-2">{job.company}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
                {job.location ? (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="size-3.5" aria-hidden /> {job.location}
                  </span>
                ) : null}
                {salary ? (
                  <span className="inline-flex items-center gap-1" title="Salary" aria-label={`Salary ${salary}`}>
                    <Banknote className="size-3.5" aria-hidden /> {salary}
                  </span>
                ) : null}
                {job.facts.postedAt ? (
                  <span className="inline-flex items-center gap-1" title={`Posted ${formatRelative(job.facts.postedAt)}`} aria-label={`Posted ${formatDate(job.facts.postedAt)}`}>
                    <CalendarDays className="size-3.5" aria-hidden /> {formatDate(job.facts.postedAt)}
                  </span>
                ) : null}
                {myAppliedAt ? (
                  // My job: when I applied, never when the job was added or last changed.
                  <span className="inline-flex items-center gap-1" title={`Applied ${formatDateTime(myAppliedAt)}`} aria-label={`Applied ${formatDate(myAppliedAt)}`} data-my-applied>
                    <CalendarCheck className="size-3.5" aria-hidden /> Applied {formatDate(myAppliedAt)}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1" title={`Added ${formatRelative(job.createdAt)}`}>
                    <Clock className="size-3.5" aria-hidden /> {formatDate(job.createdAt)}
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="mt-2 h-4 w-1/3" />
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {job ? <HighlightButton jobId={job.id} highlighted={job.isHighlighted} highlightedBy={job.highlightedBy} size="lg" /> : null}
          {primaryUrl ? (
            <Tooltip content="Copy the job link">
              <Button size="icon" variant="ghost" aria-label="Copy the job link" onClick={() => copyLink(primaryUrl)}>
                <Copy />
              </Button>
            </Tooltip>
          ) : null}
          {job && canEditJob(job.applications, user) ? (
            <Tooltip content="Correct details">
              <Button size="icon" variant="ghost" aria-label="Correct details" onClick={() => setEditing(true)}>
                <Pencil />
              </Button>
            </Tooltip>
          ) : null}
          {job && canDeleteJob(job.applications, user) ? (
            <Tooltip content="Delete job">
              <Button size="icon" variant="danger-ghost" aria-label="Delete job" onClick={() => setDeleting(true)}>
                <Trash2 />
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
            <Section title="Interview process" icon={Users} count={job.applications.length} aside={<JobLinks job={job} />}>
              {job.applications.length ? (
                <div className="space-y-2">
                  {[...job.applications]
                    .sort((a, b) => Number(b.isMine) - Number(a.isMine))
                    .map((application) => (
                      <ApplicationCard key={application.id} application={application} />
                    ))}
                </div>
              ) : (
                <span className="text-ink-3" aria-label="Nobody has applied to this job yet">
                  —
                </span>
              )}
            </Section>

            <ApplySection job={job} />

            <Section title="Job description" icon={FileText}>
              {isUnreadableNote(job.description) ? (
                <p className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-ink-2" data-unreadable>
                  <Info className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
                  <span>{job.description}</span>
                </p>
              ) : (
                <div className="selectable whitespace-pre-wrap break-words leading-relaxed">{job.description}</div>
              )}
            </Section>


            {canEditJob(job.applications, user) ? <EditJobDialog job={job} open={editing} onOpenChange={setEditing} /> : null}
            <ConfirmDialog
              open={deleting}
              onOpenChange={setDeleting}
              title="Delete this job?"
              confirmLabel="Delete"
              danger
              loading={remove.isPending}
              onConfirm={() =>
                remove.mutate(job.id, {
                  onSuccess: () => {
                    setDeleting(false);
                    onClose();
                  },
                  onError: (error) => {
                    setDeleting(false);
                    toast.show(errorMessage(error), 'error');
                  }
                })
              }
            >
              {job.title}, {job.company}. This removes {job.applications.length} application(s) and cannot be undone, except by restoring a backup.
            </ConfirmDialog>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
