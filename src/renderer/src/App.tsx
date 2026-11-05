import { useEffect, useState } from 'react';
import { Briefcase, CalendarDays, ChartBar, ClipboardList, LayoutDashboard, Loader2, LogOut, Plus, Settings as SettingsIcon, Star, Users, WifiOff } from 'lucide-react';
import { Tooltip as RadixTooltip } from 'radix-ui';
import { useQueryClient } from '@tanstack/react-query';
import type { CurrentUser } from '@shared/api';
import type { BridgeState } from '@shared/bridge';
import { asUserSubject, Avatar, userLabel } from '@/components/job-bits';
import { Button } from '@/components/ui/button';
import { Notice, Tooltip } from '@/components/ui/misc';
import { call, clearAvatarImages, errorMessage, useBridgeState, useCurrentUser, useLiveUpdates } from '@/lib/api';
import { cn } from '@/lib/utils';
import { AddJobDialog } from './features/add-job';
import { LoginPage, RequiredPasswordChange } from './features/auth';
import { DashboardPage } from './features/dashboard';
import { InterviewsPage } from './features/interviews-page';
import { JobDetailSheet } from './features/job-detail';
import { JobsPage } from './features/jobs-page';
import { SettingsPage } from './features/settings-page';
import { CenteredPage, CertificateChanged, HostFailed, ModeSetup } from './features/setup';
import { TeamPage } from './features/team-page';
import { UsersPage } from './features/users-page';

export type Page = 'dashboard' | 'mine' | 'all' | 'highlighted' | 'interviews' | 'team' | 'users' | 'settings';

const NAV: Array<{ page: Page; label: string; icon: typeof Star; adminOnly?: boolean }> = [
  { page: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { page: 'mine', label: 'My Applications', icon: ClipboardList },
  { page: 'all', label: 'All Jobs', icon: Briefcase },
  { page: 'highlighted', label: 'Highlighted', icon: Star },
  { page: 'interviews', label: 'Interviews', icon: CalendarDays },
  { page: 'team', label: 'Team', icon: ChartBar },
  { page: 'users', label: 'Users', icon: Users, adminOnly: true },
  { page: 'settings', label: 'Settings', icon: SettingsIcon }
];

function Sidebar({ page, onNavigate, user, state, onAddJob }: { page: Page; onNavigate: (page: Page) => void; user: CurrentUser; state: BridgeState; onAddJob: () => void }) {
  const queryClient = useQueryClient();
  return (
    <aside className="flex w-14 shrink-0 flex-col items-center border-r border-border bg-sidebar py-3">
      <span className="mb-3 flex size-8 items-center justify-center rounded-lg bg-accent text-accent-ink" title="Job Tracker">
        <Briefcase className="size-4" aria-hidden />
      </span>
      <Tooltip content="Add job (Ctrl+N)" side="right">
        <Button variant="primary" size="icon" className="mb-3" aria-label="Add job" onClick={onAddJob}>
          <Plus />
        </Button>
      </Tooltip>
      <nav className="flex flex-1 flex-col items-center gap-1" aria-label="Main">
        {NAV.filter((item) => !item.adminOnly || user.role === 'admin').map(({ page: target, label, icon: Icon }) => (
          <Tooltip key={target} content={label} side="right">
            <button
              type="button"
              aria-label={label}
              aria-current={page === target ? 'page' : undefined}
              onClick={() => onNavigate(target)}
              className={cn('flex size-9 items-center justify-center rounded-md', page === target ? 'bg-accent-soft text-accent-soft-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}
            >
              <Icon className="size-[18px]" aria-hidden />
            </button>
          </Tooltip>
        ))}
      </nav>
      <div className="flex flex-col items-center gap-2 pt-2">
        <Tooltip content={state.connection === 'connected' ? (state.mode === 'host' ? 'Hosting' : 'Connected') : 'Offline'} side="right">
          <span role="status" tabIndex={0} aria-label={state.connection === 'connected' ? 'Connected' : 'Offline'} className={cn('size-2 rounded-full', state.connection === 'connected' ? 'bg-success-ink' : 'bg-danger')} />
        </Tooltip>
        <Avatar subject={asUserSubject(user)} label={userLabel(user)} size="md" ring={false} />
        <Tooltip content="Sign out" side="right">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Sign out"
            onClick={() => {
              void call('POST', '/api/auth/logout').finally(() => queryClient.clear());
            }}
          >
            <LogOut />
          </Button>
        </Tooltip>
      </div>
    </aside>
  );
}

function OfflineBanner({ state }: { state: BridgeState }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border bg-danger-soft px-5 py-2 text-danger-ink" role="alert">
      <WifiOff className="size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-medium">Cannot reach the host.</span> {state.connectionMessage ?? ''} Changes cannot be saved until it is back. Retrying…
      </p>
      <Button size="sm" onClick={() => void window.jobTracker.retryConnection()}>
        Retry now
      </Button>
    </div>
  );
}

function Shell({ state, user }: { state: BridgeState; user: CurrentUser }) {
  const [page, setPage] = useState<Page>('all');
  const [openJob, setOpenJob] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [focusSearch, setFocusSearch] = useState(0);
  useLiveUpdates();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        setAdding(true);
      } else if (key === 'k' || key === 'f') {
        event.preventDefault();
        setPage((current) => (current === 'mine' || current === 'all' || current === 'highlighted' ? current : 'all'));
        setFocusSearch((value) => value + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full">
      <Sidebar page={page} onNavigate={setPage} user={user} state={state} onAddJob={() => setAdding(true)} />
      <main className="flex min-w-0 flex-1 flex-col">
        {state.connection === 'offline' ? <OfflineBanner state={state} /> : null}
        <div className="min-h-0 flex-1">
          {page === 'dashboard' ? <DashboardPage onOpenJob={setOpenJob} onNavigate={setPage} onAddJob={() => setAdding(true)} /> : null}
          {page === 'mine' || page === 'all' || page === 'highlighted' ? <JobsPage view={page} user={user} onOpenJob={setOpenJob} onAddJob={() => setAdding(true)} focusSearchSignal={focusSearch} /> : null}
          {page === 'interviews' ? <InterviewsPage onOpenJob={setOpenJob} /> : null}
          {page === 'team' ? <TeamPage user={user} /> : null}
          {page === 'users' && user.role === 'admin' ? <UsersPage currentUser={user} /> : null}
          {page === 'settings' ? <SettingsPage state={state} user={user} /> : null}
        </div>
      </main>
      <JobDetailSheet jobId={openJob} user={user} onClose={() => setOpenJob(null)} />
      <AddJobDialog open={adding} onOpenChange={setAdding} onOpenJob={setOpenJob} />
    </div>
  );
}

function Splash({ message }: { message: string }) {
  return (
    <CenteredPage>
      <p className="flex items-center gap-2 text-ink-2" role="status">
        <Loader2 className="spin size-4" aria-hidden /> {message}
      </p>
    </CenteredPage>
  );
}

export function App() {
  const state = useBridgeState();
  const signedIn = !!state?.signedIn;
  const me = useCurrentUser(signedIn && state?.connection === 'connected');
  const queryClient = useQueryClient();

  // A session that ended (signed out, reset by the admin) must not leave anyone's data in memory.
  useEffect(() => {
    if (!signedIn) {
      queryClient.clear();
      clearAvatarImages();
    }
  }, [signedIn, queryClient]);

  let content: React.ReactNode;
  if (!state) {
    content = <Splash message="Starting…" />;
  } else if (!state.mode) {
    content = <ModeSetup />;
  } else if (state.connection === 'host_failed') {
    content = <HostFailed state={state} />;
  } else if (state.connection === 'cert_mismatch') {
    content = <CertificateChanged state={state} />;
  } else if (state.connection === 'unconfigured') {
    content = <ModeSetup />;
  } else if (!signedIn) {
    if (state.connection === 'connecting') content = <Splash message={state.mode === 'host' ? 'Starting the server…' : 'Connecting to the host…'} />;
    else content = <LoginPage state={state} />;
  } else if (me.data) {
    content = me.data.mustChangePassword ? <RequiredPasswordChange user={me.data} /> : <Shell state={state} user={me.data} />;
  } else if (state.connection === 'offline') {
    content = (
      <CenteredPage>
        <Notice
          kind="error"
          title="Cannot reach the host"
          action={
            <Button size="sm" onClick={() => void window.jobTracker.retryConnection()}>
              Retry
            </Button>
          }
        >
          {state.connectionMessage}
        </Notice>
      </CenteredPage>
    );
  } else if (me.isError) {
    content = (
      <CenteredPage>
        <Notice kind="error" title="Could not load your account">
          {errorMessage(me.error)}
        </Notice>
      </CenteredPage>
    );
  } else {
    content = <Splash message="Signing in…" />;
  }

  return <RadixTooltip.Provider delayDuration={250}>{content}</RadixTooltip.Provider>;
}
