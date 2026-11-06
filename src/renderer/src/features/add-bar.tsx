import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { AlertTriangle, Check, CheckCircle2, CircleSlash, Copy, Link2, Loader2, StickyNote, User } from 'lucide-react';
import type { CheckLinkResponse, CreateApplicationRequest, CreateApplicationResponse } from '@shared/api';
import { JobTags } from '@/components/job-tags';
import { Input } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Tooltip } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { focusAddBar, registerAddBarInput } from '@/lib/add-bar-focus';
import { call, errorMessage, useCreateApplication, useProfiles } from '@/lib/api';
import { cn } from '@/lib/utils';

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

/**
 * Adding a job in one row on every page: paste a link and it is checked straight away, saying
 * whether it is new or a duplicate; ✓ then saves it without asking anything more.
 */
export function AddBar() {
  const [url, setUrl] = useState('');
  const [memo, setMemo] = useState('');
  const [profileId, setProfileId] = useState<number | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [sameAs, setSameAs] = useState<number | null>(null);
  const [manual, setManual] = useState({ title: '', company: '' });
  const [saving, setSaving] = useState(false);
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
    const promise = call<CheckLinkResponse>('POST', '/api/applications/check', { url: text })
      .then((result) => {
        setCheck((current) => (current?.url === text ? { url: text, state: 'done', result } : current));
        if (result.status === 'unreadable') setManual({ title: result.job.title ?? '', company: result.job.company ?? '' });
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
    setManual({ title: '', company: '' });
    pending.current = null;
    focusAddBar({ force: true });
  };

  const result = check?.state === 'done' && check.url === url.trim() ? check.result : null;
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
      const base: CreateApplicationRequest = { url: link, profileId: chosen.id, memo, draftId: checked?.draftId ?? undefined };
      if (checked?.status === 'possible') base.resolution = sameAs ? { action: 'merge', jobId: sameAs } : { action: 'new' };
      if (checked?.status === 'unreadable') base.manual = { title: manual.title.trim(), company: manual.company.trim(), description: checked.description, location: checked.job.location };
      let response: CreateApplicationResponse = await create.mutateAsync(base);
      // Something changed since the check: still no questions, it is saved as checked.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (response.outcome === 'possible_duplicate') response = await create.mutateAsync({ ...base, draftId: response.draftId, resolution: { action: 'new' } });
        else if (response.outcome === 'needs_manual' && response.extracted.title && response.extracted.company) {
          response = await create.mutateAsync({ ...base, draftId: response.draftId, manual: { title: response.extracted.title, company: response.extracted.company, description: response.extracted.description || response.message, location: response.extracted.location } });
        } else break;
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
    alert = alreadyMine ? (
      <Line tone="bad" icon={CircleSlash}>
        <span className="shrink-0 font-medium text-danger-ink">Already applied as {chosen?.name}</span>
        <span className="truncate text-ink-2">
          {job.title} · {job.company}
        </span>
      </Line>
    ) : (
      <Line tone="warn" icon={Copy}>
        <span className="shrink-0 font-medium text-warning-ink">Duplicate</span>
        <span className="truncate text-ink-2">
          Already in the list: {job.title} · {job.company} · {job.applicationCount} applied
        </span>
        <JobTags facts={job.facts} className="shrink-0" />
      </Line>
    );
  } else if (result?.status === 'possible') {
    const best = result.candidates[0];
    alert = (
      <Line tone="warn" icon={AlertTriangle}>
        <span className="shrink-0 font-medium text-warning-ink">Maybe a duplicate</span>
        <span className="truncate text-ink-2">
          {best.title} · {best.company}
          {best.reasons.length ? ` (${best.reasons.slice(0, 3).join(', ')})` : ''}
          {result.candidates.length > 1 ? ` +${result.candidates.length - 1} more` : ''}
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
      </Line>
    );
  } else if (result?.status === 'unreadable') {
    alert = (
      <Line tone="warn" icon={AlertTriangle}>
        <span className="shrink-0 font-medium text-warning-ink">Can't read the page</span>
        <span className="min-w-0 shrink truncate text-ink-3">{REASONS[result.reason] ?? result.message}</span>
        <Input aria-label="Job title" placeholder="Job title" className="h-7 w-[200px] shrink-0 text-[12.5px]" value={manual.title} onChange={(event) => setManual({ ...manual, title: event.target.value })} onKeyDown={onKeyDown} />
        <Input aria-label="Company" placeholder="Company" className="h-7 w-[160px] shrink-0 text-[12.5px]" value={manual.company} onChange={(event) => setManual({ ...manual, company: event.target.value })} onKeyDown={onKeyDown} />
      </Line>
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
      {alert ? <div className="mt-1.5 text-[12.5px]">{alert}</div> : null}
    </section>
  );
}
