import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Banknote, Building, Check, Code2, Link2, Loader2, Send, Sparkles, X } from 'lucide-react';
import type { NoticeActionResult, NoticePayload } from '@shared/bridge';
import { formatSalary, JobTags } from './components/job-tags';
import './styles.css';

const bridge = window.jobTracker;

function Chip({ icon: Icon, children, title }: { icon: typeof Code2; children: React.ReactNode; title: string }) {
  return (
    <span title={title} className="inline-flex min-w-0 items-center gap-1 text-[11.5px] text-ink-2">
      <Icon className="size-3 shrink-0 text-ink-3" aria-hidden />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** One notice at a time: a job someone else applied to, or a summary of several. */
function NoticeCard() {
  const [notice, setNotice] = useState<NoticePayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<NoticeActionResult | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stop = bridge.onNotice((next) => {
      setNotice(next);
      setBusy(false);
      setResult(null);
      // The tick belonged to the last card's link.
      setLinkCopied(false);
    });
    bridge.noticeReady();
    return stop;
  }, []);

  // The window takes the card's height, so nothing is cut off and nothing is blank.
  useLayoutEffect(() => {
    if (!card.current) return;
    const report = () => bridge.noticeResize((card.current?.offsetHeight ?? 0) + 16);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [notice, result]);

  if (!notice) return null;
  const act = (action: Parameters<typeof bridge.noticeAction>[1]) => bridge.noticeAction(notice.id, action);

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    const outcome = await act('apply');
    setBusy(false);
    setResult(outcome);
    // Long enough to read what happened.
    setTimeout(() => void act('done'), outcome.ok ? 2500 : 5000);
  };

  const copyLink = async () => {
    const outcome = await act('link');
    if (!outcome.ok) {
      setResult(outcome);
      return;
    }
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1500);
  };

  const countdown = !busy && !result ? <div key={notice.id} className="notice-countdown absolute inset-x-0 bottom-0 h-0.5 bg-accent" style={{ animationDuration: `${notice.hideSeconds}s` }} onAnimationEnd={() => void act('timeout')} /> : null;

  const shell = (children: React.ReactNode) => (
    <div className="p-2">
      <div ref={card} role="alertdialog" aria-label="New job" className="notice-card relative overflow-hidden rounded-xl border border-border-strong bg-surface p-3 text-[13px] text-ink shadow-lg">
        {children}
        {countdown}
      </div>
    </div>
  );

  if (notice.kind === 'summary') {
    return shell(
      <>
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          <p className="min-w-0 flex-1 font-semibold">
            {notice.count} new jobs found{notice.owners.length ? ` by ${notice.owners.join(', ')}` : ''}
          </p>
          <button type="button" aria-label="Ignore" title="Ignore" className="rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink" onClick={() => void act('ignore')}>
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="mt-2.5 flex gap-2">
          <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-3 text-[12.5px] font-medium text-accent-ink hover:bg-accent-hover" onClick={() => void act('open')}>
            Open
          </button>
          <button type="button" className="inline-flex h-7 items-center rounded-md border border-border-strong px-3 text-[12.5px] text-ink-2 hover:bg-surface-2" onClick={() => void act('ignore')}>
            Ignore
          </button>
        </div>
      </>
    );
  }

  const { brief } = notice;
  const salary = formatSalary(brief.facts);
  return shell(
    <>
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-[11.5px] text-ink-3" data-notice-from>
          New job found by {brief.owner ?? 'someone'}
          {brief.profile && brief.profile !== brief.owner ? ` - ${brief.profile}` : ''}
        </p>
        <button type="button" aria-label="Ignore" title="Ignore" className="-mr-1 -mt-1 rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink" onClick={() => void act('ignore')}>
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <button type="button" title="Open in Job Tracker" className="mt-1 block max-w-full truncate text-left text-[14px] font-semibold hover:underline" onClick={() => void act('open')}>
        {brief.title}
      </button>
      <p className="truncate text-[12.5px] text-ink-2">
        {brief.company}
        {brief.location ? ` · ${brief.location}` : ''}
      </p>
      <JobTags facts={brief.facts} className="mt-1.5 h-auto flex-wrap" />
      {brief.industry || salary || brief.stack.length ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          {brief.industry ? (
            <Chip icon={Building} title="Industry">
              {brief.industry}
            </Chip>
          ) : null}
          {salary ? (
            <Chip icon={Banknote} title="Salary">
              {salary}
            </Chip>
          ) : null}
          {brief.stack.length ? (
            <Chip icon={Code2} title="Main stack">
              {brief.stack.join(' · ')}
            </Chip>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <p className={`mt-2.5 flex items-center gap-1.5 text-[12.5px] ${result.ok ? 'text-success-ink' : 'text-danger-ink'}`} role="status" data-notice-result>
          {result.ok ? <Check className="size-4" aria-hidden /> : null}
          {result.ok
            ? `${result.already ? 'Already applied' : 'Applied'} as ${result.profileName}${result.copied ? ' · link copied' : ''}`
            : result.message}
        </p>
      ) : (
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            title="Copy the link and add this job to my applications"
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-3 text-[12.5px] font-medium text-accent-ink hover:bg-accent-hover disabled:opacity-70"
            onClick={() => void apply()}
          >
            {busy ? <Loader2 className="spin size-3.5" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
            Apply
          </button>
          <button type="button" disabled={busy} className="inline-flex h-7 items-center rounded-md border border-border-strong px-3 text-[12.5px] text-ink-2 hover:bg-surface-2" onClick={() => void act('ignore')}>
            Ignore
          </button>
          {brief.url ? (
            <button
              type="button"
              aria-label="Copy the link"
              title={linkCopied ? 'Link copied' : `Copy the link\n${brief.url}`}
              data-notice-link={brief.url}
              disabled={busy}
              className="ml-auto rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
              onClick={() => void copyLink()}
            >
              {linkCopied ? <Check className="size-4 text-success-ink" aria-hidden /> : <Link2 className="size-4" aria-hidden />}
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <NoticeCard />
  </StrictMode>
);
