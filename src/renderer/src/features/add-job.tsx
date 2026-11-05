import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, Copy, ExternalLink, Loader2 } from 'lucide-react';
import type { CreateApplicationRequest, CreateApplicationResponse, DuplicateCandidate, ExtractedJobFields, ManualJobFields } from '@shared/api';
import { AvatarStack } from '@/components/job-bits';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { errorMessage, useCreateApplication } from '@/lib/api';

type Step =
  | { kind: 'form' }
  | { kind: 'already'; applicationId: number; jobId: number; title: string; company: string }
  | { kind: 'duplicate'; draftId: string; extracted: ExtractedJobFields; candidates: DuplicateCandidate[] }
  | { kind: 'manual'; draftId: string; message: string; reason: string; fields: ManualJobFields };

const MATCH_MESSAGES: Record<string, string> = {
  url: 'This job was already in the shared list, so you were added to it.',
  canonical: 'This link leads to a job already in the shared list, so you were added to it.',
  identifier: 'This is the same posting as a job already in the shared list, so you were added to it.',
  content: 'This posting matches a job already in the shared list, so you were added to it.',
  user_confirmed: 'Added you to the existing job, and saved this link for it.'
};

export function AddJobDialog({ open, onOpenChange, onOpenJob }: { open: boolean; onOpenChange: (open: boolean) => void; onOpenJob: (jobId: number) => void }) {
  const [url, setUrl] = useState('');
  const [memo, setMemo] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);

  const create = useCreateApplication();
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    setUrl('');
    setMemo('');
    setStep({ kind: 'form' });
    setError(null);
  }, [open]);

  const finish = (response: Extract<CreateApplicationResponse, { outcome: 'created' }>) => {
    toast.show(response.jobWasNew ? 'Application saved.' : MATCH_MESSAGES[response.matchedBy] ?? 'Application saved.');
    onOpenChange(false);
    onOpenJob(response.jobId);
  };

  const submit = async (extra: Partial<CreateApplicationRequest> = {}) => {
    setError(null);
    try {
      const response = await create.mutateAsync({ url, memo, ...extra });
      switch (response.outcome) {
        case 'created':
          finish(response);
          break;
        case 'already_applied':
          setStep({ kind: 'already', applicationId: response.applicationId, jobId: response.jobId, title: response.title, company: response.company });
          break;
        case 'possible_duplicate':
          setStep({ kind: 'duplicate', draftId: response.draftId, extracted: response.extracted, candidates: response.candidates });
          break;
        case 'needs_manual':
          setStep({
            kind: 'manual',
            draftId: response.draftId,
            reason: response.reason,
            message: response.message,
            fields: {
              title: response.extracted.title ?? '',
              company: response.extracted.company ?? '',
              description: response.extracted.description ?? '',
              location: response.extracted.location ?? ''
            }
          });
          break;
      }
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const busy = create.isPending;

  if (step.kind === 'already') {
    return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="You already applied to this job"
        footer={
          <>
            <Button onClick={() => onOpenChange(false)}>Close</Button>
            <Button
              variant="primary"
              onClick={() => {
                onOpenChange(false);
                onOpenJob(step.jobId);
              }}
            >
              Open my application
            </Button>
          </>
        }
      >
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success-ink" aria-hidden />
          <div>
            <p className="font-medium">{step.title}</p>
            <p className="text-ink-2">{step.company}</p>
            <p className="mt-2 text-ink-2">Nothing new was created, and your existing memo and status were left as they are.</p>
          </div>
        </div>
      </Dialog>
    );
  }

  if (step.kind === 'duplicate') {
    return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        className="max-w-2xl"
        title="Is this one of these jobs?"
        description={`"${step.extracted.title ?? 'This posting'}" at ${step.extracted.company ?? 'this company'} looks similar to what's already in the shared list.`}
        footer={
          <>
            <Button onClick={() => setStep({ kind: 'form' })} disabled={busy}>
              Back
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void submit({ draftId: step.draftId, resolution: { action: 'new' } })}>
              It's a different job
            </Button>
          </>
        }
      >
        <div className="space-y-2.5">
          {error ? <Notice kind="error">{error}</Notice> : null}
          {step.candidates.map((candidate) => (
            <div key={candidate.jobId} className="rounded-lg border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{candidate.title}</p>
                  <p className="text-ink-2">
                    {candidate.company}
                    {candidate.location ? ` · ${candidate.location}` : ''}
                  </p>
                </div>
                <Button size="sm" disabled={busy} onClick={() => void submit({ draftId: step.draftId, resolution: { action: 'merge', jobId: candidate.jobId } })}>
                  <Copy /> Same job
                </Button>
              </div>
              {candidate.reasons.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {candidate.reasons.map((reason) => (
                    <span key={reason} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] text-ink-2">
                      {reason}
                    </span>
                  ))}
                </div>
              ) : null}
              <p className="selectable mt-2 line-clamp-3 text-[12.5px] text-ink-2">{candidate.descriptionPreview}</p>
              <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-3">
                <AvatarStack users={candidate.applicants} />
                {candidate.urls[0] ? (
                  <button type="button" className="inline-flex min-w-0 items-center gap-1 truncate hover:text-ink" onClick={() => void window.jobTracker.openExternal(candidate.urls[0])}>
                    <ExternalLink className="size-3 shrink-0" />
                    <span className="truncate">{new URL(candidate.urls[0]).hostname}</span>
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </Dialog>
    );
  }

  if (step.kind === 'manual') {
    const { fields } = step;
    const set = (patch: Partial<ManualJobFields>) => setStep({ ...step, fields: { ...fields, ...patch } });
    const ready = fields.title.trim() && fields.company.trim() && fields.description.trim();
    return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        className="max-w-2xl"
        title="Add the job details"
        footer={
          <>
            <Button onClick={() => setStep({ kind: 'form' })} disabled={busy}>
              Back
            </Button>
            <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void submit({ draftId: step.draftId, manual: fields })}>
              Save application
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Notice kind="warning" title="This job page could not be read automatically">
            {step.message}
          </Notice>
          {error ? <Notice kind="error">{error}</Notice> : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Job title" htmlFor="manual-title">
              <Input id="manual-title" autoFocus value={fields.title} onChange={(event) => set({ title: event.target.value })} />
            </Field>
            <Field label="Company" htmlFor="manual-company">
              <Input id="manual-company" value={fields.company} onChange={(event) => set({ company: event.target.value })} />
            </Field>
          </div>
          <Field label="Location (optional)" htmlFor="manual-location">
            <Input id="manual-location" value={fields.location ?? ''} onChange={(event) => set({ location: event.target.value })} />
          </Field>
          <Field label="Job description" htmlFor="manual-description" hint="Pasting the full text helps recognize this job if someone adds it from another site.">
            <Textarea id="manual-description" rows={9} value={fields.description} onChange={(event) => set({ description: event.target.value })} />
          </Field>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title="Add job"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="add-job-form" loading={busy} disabled={!url.trim()}>
            Save Application
          </Button>
        </>
      }
    >
      <form
        id="add-job-form"
        className="space-y-3"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (url.trim() && !busy) void submit();
        }}
      >
        <Field label="Job URL" htmlFor="job-url">
          <Input id="job-url" autoFocus disabled={busy} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://builtin.com/job/senior-software-engineer/123456" />
        </Field>
        <Field label="Memo (optional)" htmlFor="job-memo" hint="Private to you. Nobody else can see it.">
          <Textarea
            id="job-memo"
            rows={4}
            disabled={busy}
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
            placeholder="Applied through LinkedIn. Recruiter contacted me."
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && url.trim() && !busy) void submit();
            }}
          />
        </Field>
        {busy ? (
          <div className="flex items-center gap-2 text-ink-2" role="status">
            <Loader2 className="spin size-4" aria-hidden />
            Reading the job page. Sites that need a browser can take up to a minute.
          </div>
        ) : null}
        {error ? <Notice kind="error">{error}</Notice> : null}
      </form>
    </Dialog>
  );
}
