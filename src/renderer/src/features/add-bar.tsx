import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { AlertTriangle, Briefcase, Building2, CalendarClock, Check, CheckCircle2, CircleSlash, Copy, ExternalLink, FileText, FileWarning, Link2, Loader2, StickyNote, User } from 'lucide-react';
import type { ApplicationSummary, CheckLinkResponse, CreateApplicationRequest, CreateApplicationResponse, DuplicateCandidate } from '@shared/api';
import { unreadableNote } from '@shared/unreadable';
import { applicationLabel, Avatar, StageBadge } from '@/components/job-bits';
import { JobTags } from '@/components/job-tags';
import { Symbol } from '@/components/symbols';
import { Input, Textarea } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Tooltip } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { focusAddBar, registerAddBarInput } from '@/lib/add-bar-focus';
import { call, errorMessage, useCreateApplication, useProfiles } from '@/lib/api';
import { cn, formatDateTime, formatRelative } from '@/lib/utils';

/** Enough of a link to be worth reading: "https://…" or "company.com/…". */
const looksLikeLink = (text: string) => /^https?:\/\/\S+\.\S+/i.test(text) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*/i.test(text);

type Check = { url: string; state: 'checking' } | { url: string; state: 'done'; result: CheckLinkResponse } | { url: string; state: 'failed'; message: string };

const REASONS: Record<string, string> = {
  not_found: 'the posting was closed or removed',
  blocked: 'the site blocks automated reading',
  timeout: 'the site took too long to answer',
  network: 'the site could not be reached',
  http_error: 'the site returned an error',
  incomplete: 'the page has no readable job description',
  not_html: 'the link is not a web page',
  too_large: 'the page is too large'
};

function Line({ tone, icon: Icon, children }: { tone: 'good' | 'warn' | 'bad'; icon: typeof Check; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2" role="status" data-add-check={tone}>
      <Icon className={cn('size-4 shrink-0', tone === 'good' && 'text-success-ink', tone === 'warn' && 'text-warning-ink', tone === 'bad' && 'text-danger-ink')} aria-hidden />
      {children}
    </div>
  );
}

const SHOWN_APPLICATIONS = 5;

const linkHost = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/**
 * What the list already knows about a job someone has pasted the link of: everyone who applied,
 * earliest first, with when, under which profile, with which link, and where each is now.
 */
function AppliedList({ applications }: { applications: ApplicationSummary[] }) {
  if (applications.length === 0) return <p className="ml-6 text-ink-3">Nobody has applied to it yet.</p>;
  return (
    <ul className="ml-6 divide-y divide-border overflow-hidden rounded-md border border-border bg-surface-2/40" aria-label="Who applied to this job" data-add-applied>
      {applications.slice(0, SHOWN_APPLICATIONS).map((application) => (
        <li key={application.id} className="flex items-center gap-2.5 px-2.5 py-1" data-applied-by={application.owner.username}>
          <Avatar subject={application.profile} label={applicationLabel(application)} ring={false} />
          <span className="w-[210px] min-w-0 truncate font-medium" title={applicationLabel(application)}>
            {application.isMine ? (
              <>
                {application.profile.name} <span className="font-normal text-accent-soft-ink">(you)</span>
              </>
            ) : (
              applicationLabel(application)
            )}
          </span>
          <span className="shrink-0 tabular-nums text-ink-2" title={`Applied ${formatDateTime(application.appliedAt)}`}>
            Applied {formatDateTime(application.appliedAt)} <span className="text-ink-3">· {formatRelative(application.appliedAt)}</span>
          </span>
          <span className="min-w-0 flex-1 truncate text-ink-3" title={application.link ? `Applied with ${application.link.url}` : 'Joined the job without a link of their own'}>
            {application.link ? (
              <>
                <Link2 className="mr-1 inline size-3" aria-hidden />
                {linkHost(application.link.url)}
              </>
            ) : (
              'from the shared list'
            )}
          </span>
          {application.nextInterviewAt ? (
            <span className="inline-flex shrink-0 items-center gap-1 tabular-nums text-ink-2" title="Next interview">
              <CalendarClock className="size-3.5 text-ink-3" aria-hidden />
              {formatDateTime(application.nextInterviewAt)}
            </span>
          ) : null}
          <span className="inline-flex w-[150px] shrink-0 items-center gap-1.5">
            <StageBadge stage={application.stage} className="size-5" />
            <span className="truncate text-ink-2">{application.stage}</span>
          </span>
        </li>
      ))}
      {applications.length > SHOWN_APPLICATIONS ? <li className="px-2.5 py-1 text-ink-3">+{applications.length - SHOWN_APPLICATIONS} more: open the job to see everyone</li> : null}
    </ul>
  );
}

function OpenJobButton({ jobId, onOpenJob }: { jobId: number; onOpenJob: (id: number) => void }) {
  return (
    <button type="button" onClick={() => onOpenJob(jobId)} className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border-strong px-2 text-[12px] text-ink-2 hover:bg-surface-2 hover:text-ink">
      <ExternalLink className="size-3" aria-hidden />
      Open job
    </button>
  );
}

/**
 * Adding a job in one row on every page: paste a link and it is checked straight away, saying
 * whether it is new or a duplicate; ✓ then saves it without asking anything more. A job already in
 * the list shows who applied to it, when and how, for as long as its link is in the box.
 */
export function AddBar({ onOpenJob }: { onOpenJob: (id: number) => void }) {
  const [url, setUrl] = useState('');
  const [memo, setMemo] = useState('');
  const [profileId, setProfileId] = useState<number | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [sameAs, setSameAs] = useState<number | null>(null);
  const [manual, setManual] = useState({ title: '', company: '', description: '' });
  const [saving, setSaving] = useState(false);
  /** A likely duplicate found only when saving (someone saved it meanwhile): shown, for the person to decide. */
  const [asked, setAsked] = useState<{ url: string; draftId: string; candidates: DuplicateCandidate[] } | null>(null);
  const pending = useRef<{ url: string; promise: Promise<CheckLinkResponse | null> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlInput = useRef<HTMLInputElement | null>(null);
  const toast = useToast();
  const create = useCreateApplication();
  const profiles = useProfiles();

  const active = useMemo(() => (profiles.data?.profiles ?? []).filter((profile) => !profile.isArchived), [profiles.data]);
  // The one picked, else the one used last, else the person's own first profile.
  const first = active.reduce<(typeof active)[number] | null>((oldest, profile) => (!oldest || profile.id < oldest.id ? profile : oldest), null);
  const chosen = active.find((profile) => profile.id === profileId) ?? active.find((profile) => profile.id === profiles.data?.lastUsedProfileId) ?? first;

  const inputRef = useCallback((element: HTMLInputElement | null) => {
    urlInput.current = element;
    registerAddBarInput(element);
  }, []);

  // Ready to type in when the app opens and whenever someone comes back to it.
  useEffect(() => {
    focusAddBar();
    const onFocus = () => focusAddBar();
    const onVisible = () => {
      if (document.visibilityState === 'visible') focusAddBar();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      registerAddBarInput(null);
    };
  }, []);

  /** Reads the link once; asking again for the same link reuses the answer. */
  const runCheck = useCallback((link: string): Promise<CheckLinkResponse | null> => {
    const text = link.trim();
    if (pending.current?.url === text) return pending.current.promise;
    setCheck({ url: text, state: 'checking' });
    setSameAs(null);
    setAsked(null);
    const promise = call<CheckLinkResponse>('POST', '/api/applications/check', { url: text })
      .then((result) => {
        setCheck((current) => (current?.url === text ? { url: text, state: 'done', result } : current));
        if (result.status === 'unreadable') setManual({ title: result.job.title ?? '', company: result.job.company ?? '', description: '' });
        return result;
      })
      .catch((error: unknown) => {
        setCheck((current) => (current?.url === text ? { url: text, state: 'failed', message: errorMessage(error) } : current));
        return null;
      });
    pending.current = { url: text, promise };
    return promise;
  }, []);

  const changeUrl = (value: string) => {
    setUrl(value);
    if (timer.current) clearTimeout(timer.current);
    const text = value.trim();
    if (!text) {
      setCheck(null);
      pending.current = null;
      return;
    }
    // Typed by hand: checked once the typing stops.
    if (looksLikeLink(text) && text !== pending.current?.url) timer.current = setTimeout(() => void runCheck(text), 600);
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text').trim();
    if (!looksLikeLink(pasted)) return;
    event.preventDefault();
    setUrl(pasted);
    if (timer.current) clearTimeout(timer.current);
    void runCheck(pasted);
  };

  const reset = () => {
    setUrl('');
    setMemo('');
    setCheck(null);
    setSameAs(null);
    setAsked(null);
    setManual({ title: '', company: '', description: '' });
    pending.current = null;
    focusAddBar({ force: true });
  };

  const result = check?.state === 'done' && check.url === url.trim() ? check.result : null;
  const askedNow = asked?.url === url.trim() ? asked : null;
  // The likely duplicates on show: found by the check, or, newer, by saving.
  const offered = askedNow?.candidates ?? (result?.status === 'possible' ? result.candidates : null);
  const alreadyMine = result?.status === 'known' && chosen ? result.job.myProfileIds.includes(chosen.id) : false;
  const needsDetails = result?.status === 'unreadable' && (!manual.title.trim() || !manual.company.trim());
  const canSave = !!url.trim() && !!chosen && !saving && !alreadyMine && !needsDetails;

  const save = async () => {
    if (!canSave || !chosen) return;
    const link = url.trim();
    setSaving(true);
    try {
      // Saving uses the check already made, waiting for it if it is still reading the page.
      const checked = await runCheck(link);
      const shown = asked?.url === link ? asked : null;
      const candidates = shown?.candidates ?? (checked?.status === 'possible' ? checked.candidates : null);
      const base: CreateApplicationRequest = { url: link, profileId: chosen.id, memo, draftId: shown?.draftId ?? checked?.draftId ?? undefined };
      // Not "Same job": a new job, as far as the one on show goes. The others shown as "+N more"
      // were not looked at, so they wait on the Duplicates page instead of being called different.
      if (candidates?.length) base.resolution = sameAs ? { action: 'merge', jobId: sameAs } : { action: 'new', seen: [candidates[0].jobId] };
      // The description typed in, when the page could not be read; otherwise a note saying why it is missing.
      const typed = manual.description.trim();
      if (checked?.status === 'unreadable') base.manual = { title: manual.title.trim(), company: manual.company.trim(), description: typed || checked.description, location: checked.job.location };
      let response: CreateApplicationResponse = await create.mutateAsync(base);
      // The page could not be read this time, although the check could: saved with what is known.
      if (response.outcome === 'needs_manual' && response.extracted.title && response.extracted.company) {
        const description = !response.missing.includes('description') && response.extracted.description ? response.extracted.description : typed || unreadableNote(response.reason, response.message);
        response = await create.mutateAsync({ ...base, draftId: response.draftId, manual: { title: response.extracted.title, company: response.extracted.company, description, location: response.extracted.location } });
      }
      if (response.outcome === 'possible_duplicate') {
        // Something that looks like this job turned up since the check, probably saved by someone
        // just now. Nothing is decided for the person: it is shown, and saving again means "new".
        setAsked({ url: link, draftId: response.draftId, candidates: response.candidates });
        setSameAs(null);
        toast.show('This looks like a job just added to the list. Mark it "Same job", or save again to add it as a new job.');
        return;
      }
      if (response.outcome === 'created') {
        const title = checked?.status === 'unreadable' ? manual.title.trim() : checked?.job.title;
        toast.show(response.jobWasNew ? `Saved: ${title ?? 'new job'}` : `Added to the existing job${checked?.status === 'known' ? `: ${checked.job.title}` : ''}`);
        reset();
      } else if (response.outcome === 'already_applied') {
        toast.show(`${response.profileName} already applied to ${response.title}`);
        reset();
      } else {
        toast.show('This page could not be read. Add a title and company to save it.', 'error');
      }
    } catch (error) {
      toast.show(errorMessage(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape' && event.currentTarget === urlInput.current) {
      reset();
    }
  };

  let alert: React.ReactNode = null;
  if (check?.state === 'checking' && check.url === url.trim()) {
    alert = (
      <p className="text-ink-3" role="status" data-add-check="checking">
        Checking this link…
      </p>
    );
  } else if (check?.state === 'failed' && check.url === url.trim()) {
    alert = (
      <Line tone="bad" icon={AlertTriangle}>
        <span className="truncate">Could not check this link: {check.message}</span>
      </Line>
    );
  } else if (askedNow) {
    // Found when saving, so newer than what the check said: only the reading problem, if any, still applies.
    alert = null;
  } else if (result?.status === 'fresh') {
    alert = (
      <Line tone="good" icon={CheckCircle2}>
        <span className="shrink-0 font-medium text-success-ink">Fresh job</span>
        <span className="truncate text-ink-2">
          {result.job.title} · {result.job.company}
        </span>
        {result.job.facts ? <JobTags facts={result.job.facts} className="shrink-0" /> : null}
      </Line>
    );
  } else if (result?.status === 'known') {
    const job = result.job;
    const applied = job.applications ?? [];
    alert = (
      <div className="space-y-1" data-add-known={job.id}>
        {alreadyMine ? (
          <Line tone="bad" icon={CircleSlash}>
            <span className="shrink-0 font-medium text-danger-ink">Already applied as {chosen?.name}</span>
            <span className="truncate text-ink-2">
              {job.title} · {job.company}
            </span>
            <JobTags facts={job.facts} className="shrink-0" />
            <OpenJobButton jobId={job.id} onOpenJob={onOpenJob} />
          </Line>
        ) : (
          <Line tone="warn" icon={Copy}>
            <span className="shrink-0 font-medium text-warning-ink">Already in the list</span>
            <span className="truncate text-ink-2">
              {job.title} · {job.company} · {applied.length === 1 ? '1 application' : `${applied.length} applications`}
            </span>
            <JobTags facts={job.facts} className="shrink-0" />
            <OpenJobButton jobId={job.id} onOpenJob={onOpenJob} />
          </Line>
        )}
        <AppliedList applications={applied} />
      </div>
    );
  }
  // Shown with whatever else is still true, like a page that could not be read.
  const best = offered?.[0] ?? null;
  const duplicateLine =
    best && offered ? (
      <div className="space-y-1" data-add-possible={best.jobId}>
        <Line tone="warn" icon={AlertTriangle}>
          <span className="shrink-0 font-medium text-warning-ink">Maybe a duplicate</span>
          <span className="truncate text-ink-2">
            {best.title} · {best.company}
            {best.reasons.length ? ` (${best.reasons.slice(0, 3).join(', ')})` : ''}
            {offered.length > 1 ? ` +${offered.length - 1} more` : ''}
          </span>
          <button
            type="button"
            aria-pressed={sameAs === best.jobId}
            onClick={() => {
              setSameAs(sameAs === best.jobId ? null : best.jobId);
              focusAddBar({ force: true });
            }}
            className={cn('h-6 shrink-0 rounded-md border px-2 text-[12px]', sameAs === best.jobId ? 'border-accent bg-accent-soft text-accent-soft-ink' : 'border-border-strong text-ink-2 hover:bg-surface-2')}
            title="Save it under that job instead of as a new one"
          >
            {sameAs === best.jobId ? <Check className="mr-1 inline size-3" aria-hidden /> : null}
            Same job
          </button>
          <OpenJobButton jobId={best.jobId} onOpenJob={onOpenJob} />
        </Line>
        <AppliedList applications={best.applications} />
      </div>
    ) : null;
  if (result?.status === 'unreadable') {
    // The page could not be read: a title and company are needed (*), the posting's text is optional.
    const required = (value: string) => (value.trim() ? null : <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-semibold text-danger-ink" aria-hidden>*</span>);
    alert = (
      <div className="flex items-start gap-2" data-add-manual>
        <Symbol icon={FileWarning} label={`Can't read the page: ${REASONS[result.reason] ?? result.message}`} className="mt-1.5 text-warning-ink" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex gap-2">
            <div className="relative w-[280px]">
              <Briefcase className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
              <Input aria-label="Job title" aria-required placeholder="Job title" className="h-7 pl-8 pr-6 text-[12.5px]" value={manual.title} onChange={(event) => setManual({ ...manual, title: event.target.value })} onKeyDown={onKeyDown} />
              {required(manual.title)}
            </div>
            <div className="relative w-[220px]">
              <Building2 className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
              <Input aria-label="Company" aria-required placeholder="Company" className="h-7 pl-8 pr-6 text-[12.5px]" value={manual.company} onChange={(event) => setManual({ ...manual, company: event.target.value })} onKeyDown={onKeyDown} />
              {required(manual.company)}
            </div>
          </div>
          <div className="relative">
            <FileText className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-ink-3" aria-hidden />
            <Textarea
              aria-label="Job description"
              rows={4}
              className="pl-8 text-[12.5px]"
              placeholder="Job description"
              value={manual.description}
              onChange={(event) => setManual({ ...manual, description: event.target.value })}
              onKeyDown={(event) => {
                // Enter makes a new line here; Ctrl+Enter saves.
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void save();
                }
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <section aria-label="Add a job" className="border-b border-border bg-surface px-5 py-2" data-add-bar>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-[3]">
          <Link2 className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input
            ref={inputRef}
            aria-label="Job URL"
            placeholder="Job URL"
            className="pl-8 pr-8"
            value={url}
            onChange={(event) => changeUrl(event.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
          {check?.state === 'checking' && check.url === url.trim() ? <Loader2 className="spin absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-label="Checking" /> : null}
        </div>
        <Select
          ariaLabel="Profile"
          className="w-[170px] shrink-0"
          leading={<User className="size-4 text-ink-3" aria-hidden />}
          disabled={saving || active.length === 0}
          placeholder={profiles.isPending ? 'Loading…' : 'No profile'}
          value={chosen ? String(chosen.id) : ''}
          onChange={(value) => setProfileId(Number(value))}
          // The list would hand the cursor back to itself; the link box is where it belongs.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            focusAddBar({ force: true });
          }}
          options={active.map((profile) => ({ value: String(profile.id), label: profile.name }))}
        />
        <div className="relative min-w-0 flex-[2]">
          <StickyNote className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input aria-label="Memo" placeholder="Memo" className="pl-8" value={memo} onChange={(event) => setMemo(event.target.value)} onKeyDown={onKeyDown} />
        </div>
        <Tooltip content={alreadyMine ? 'This profile already applied' : 'Save (Enter)'}>
          <button
            type="button"
            aria-label="Save job"
            disabled={!canSave}
            onClick={() => void save()}
            className="inline-flex size-8.5 shrink-0 items-center justify-center rounded-md bg-accent text-accent-ink hover:bg-accent-hover disabled:opacity-45"
          >
            {saving ? <Loader2 className="spin size-4" aria-hidden /> : <Check className="size-4" aria-hidden />}
          </button>
        </Tooltip>
      </div>
      {duplicateLine || alert ? (
        <div className="mt-1.5 space-y-1 text-[12.5px]">
          {duplicateLine}
          {alert}
        </div>
      ) : null}
    </section>
  );
}
