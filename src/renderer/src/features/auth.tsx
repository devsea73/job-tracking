import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import type { CurrentUser } from '@shared/api';
import type { BridgeState } from '@shared/bridge';
import { PASSWORD_MIN_LENGTH } from '@shared/constants';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Card, Notice } from '@/components/ui/misc';
import { call, errorMessage } from '@/lib/api';
import { CenteredPage } from './setup';

export function LoginPage({ state }: { state: BridgeState }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const queryClient = useQueryClient();
  const login = useMutation({
    mutationFn: () => call<{ user: CurrentUser }>('POST', '/api/auth/login', { username, password }),
    onSuccess: async () => {
      setPassword('');
      await queryClient.invalidateQueries();
    }
  });
  const offline = state.connection === 'offline';
  const where = state.server ? `${state.server.address}:${state.server.port}` : '';

  return (
    <CenteredPage>
      <Card className="p-6">
        <h1 className="text-[17px] font-semibold">Sign in</h1>
        <p className="mb-4 mt-0.5 text-ink-2">{state.mode === 'host' ? 'On this computer' : `Connected to ${where}`}</p>
        <form
          className="space-y-3"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            login.mutate();
          }}
        >
          <Field label="Username" htmlFor="username">
            <Input id="username" autoFocus autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          {offline ? (
            <Notice kind="error" title="Cannot reach the host">
              {state.connectionMessage ?? `The host at ${where} is not responding.`}
            </Notice>
          ) : null}
          {login.isError && !offline ? <Notice kind="error">{errorMessage(login.error)}</Notice> : null}
          <Button variant="primary" type="submit" className="w-full" loading={login.isPending} disabled={!username || !password || offline}>
            Sign in
          </Button>
        </form>
      </Card>
      <div className="mt-4 flex justify-center">
        <button type="button" className="text-[12.5px] text-ink-3 hover:text-ink" onClick={() => void window.jobTracker.resetConnection()}>
          {state.mode === 'host' ? 'Stop hosting and choose another mode' : 'Connect to a different host'}
        </button>
      </div>
    </CenteredPage>
  );
}

export function ChangePasswordForm({ onDone, submitLabel = 'Change password' }: { onDone?: () => void; submitLabel?: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: () => call<CurrentUser>('POST', '/api/auth/change-password', { currentPassword: current, newPassword: next }),
    onSuccess: async () => {
      setCurrent('');
      setNext('');
      setAgain('');
      await queryClient.invalidateQueries();
      onDone?.();
    }
  });
  const mismatch = again.length > 0 && next !== again;
  const tooShort = next.length > 0 && next.length < PASSWORD_MIN_LENGTH;

  return (
    <form
      className="space-y-3"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        change.mutate();
      }}
    >
      <Field label="Current password" htmlFor="current-password">
        <Input id="current-password" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
      </Field>
      <Field label="New password" htmlFor="new-password" hint={tooShort ? `Use at least ${PASSWORD_MIN_LENGTH} characters.` : undefined}>
        <Input id="new-password" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} />
      </Field>
      <Field label="New password again" htmlFor="new-password-again" hint={mismatch ? 'The passwords do not match.' : undefined}>
        <Input id="new-password-again" type="password" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.target.value)} />
      </Field>
      {change.isError ? <Notice kind="error">{errorMessage(change.error)}</Notice> : null}
      <Button variant="primary" type="submit" loading={change.isPending} disabled={!current || !next || next !== again || next.length < PASSWORD_MIN_LENGTH}>
        {submitLabel}
      </Button>
    </form>
  );
}

/** Shown until a temporary password, including the initial admin/admin, has been replaced. */
export function RequiredPasswordChange({ user }: { user: CurrentUser }) {
  return (
    <CenteredPage>
      <Card className="p-6">
        <div className="mb-3 flex size-9 items-center justify-center rounded-lg bg-warning-soft text-warning-ink">
          <KeyRound className="size-[18px]" aria-hidden />
        </div>
        <h1 className="text-[17px] font-semibold">Choose a new password</h1>
        <p className="mb-4 mt-0.5 text-ink-2">Hi {user.username}. Your current password is temporary, so it has to be replaced before you continue.</p>
        <ChangePasswordForm submitLabel="Save and continue" />
      </Card>
      <div className="mt-4 flex justify-center">
        <button type="button" className="text-[12.5px] text-ink-3 hover:text-ink" onClick={() => void call('POST', '/api/auth/logout')}>
          Sign out
        </button>
      </div>
    </CenteredPage>
  );
}
