import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Copy, Database, Download, FolderOpen, Moon, RotateCcw, Save, Sun, SunMoon, Trash2, Upload } from 'lucide-react';
import type { BackupInfo, CurrentUser } from '@shared/api';
import type { BridgeState, ThemeChoice } from '@shared/bridge';
import { HelpTip } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Card, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { call, errorMessage, useBackups } from '@/lib/api';
import { formatBytes, formatDateTime } from '@/lib/utils';
import { ChangePasswordForm } from './auth';
import { PhotoCard, ProfilesCard } from './profiles-card';
import { ConnectToHost, Fingerprint } from './setup';

const bridge = window.jobTracker;

function SettingsCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="mb-3 flex items-center gap-1.5 text-[14.5px] font-semibold">
        {title}
        {description ? <HelpTip>{description}</HelpTip> : null}
      </h2>
      {children}
    </Card>
  );
}

function CopyLine({ text }: { text: string }) {
  const toast = useToast();
  return (
    <div className="flex items-center gap-1.5">
      <code className="selectable min-w-0 flex-1 truncate rounded-md bg-surface-2 px-2.5 py-1.5 font-mono text-[12.5px]" title={text}>
        {text}
      </code>
      <Tooltip content="Copy">
        <Button
          size="icon"
          variant="ghost"
          aria-label="Copy"
          onClick={() => {
            void navigator.clipboard.writeText(text);
            toast.show('Copied.');
          }}
        >
          <Copy />
        </Button>
      </Tooltip>
    </div>
  );
}

const THEMES: Array<{ value: ThemeChoice; label: string; icon: typeof Sun }> = [
  { value: 'system', label: 'System', icon: SunMoon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon }
];

function HostPanel({ state }: { state: BridgeState }) {
  const host = state.host;
  const [port, setPort] = useState(host?.port ?? 3847);
  const [busy, setBusy] = useState(false);
  if (!host) return null;
  const firewall = `netsh advfirewall firewall add rule name="Job Tracker" dir=in action=allow protocol=TCP localport=${host.port} remoteip=localsubnet`;
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[12.5px] font-medium text-ink-2">Server address for other computers</p>
        {host.addresses.length ? (
          <div className="space-y-1">
            {host.addresses.map((address) => (
              <CopyLine key={address} text={`${address}:${host.port}`} />
            ))}
          </div>
        ) : (
          <Notice kind="warning">This computer does not seem to be on a network right now.</Notice>
        )}
      </div>
      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-ink-2">
          Security fingerprint <HelpTip>Other computers show this when they connect. Check that it matches, so that you know they are talking to this host.</HelpTip>
        </p>
        <Fingerprint value={host.fingerprint} />
      </div>
      <div>
        <p className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-ink-2">
          Windows firewall <HelpTip>If other computers cannot connect, run this once in an administrator terminal. It only allows computers on your local network.</HelpTip>
        </p>
        <CopyLine text={firewall} />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Port" htmlFor="settings-port">
          <Input id="settings-port" type="number" min={1024} max={65535} className="w-28" value={port} onChange={(event) => setPort(Number(event.target.value))} />
        </Field>
        <Button
          loading={busy}
          disabled={port === host.port || port < 1024 || port > 65535}
          onClick={() => {
            setBusy(true);
            void bridge.startHost(port).finally(() => setBusy(false));
          }}
        >
          Change port
        </Button>
        <Tooltip content="Open data folder">
          <Button size="icon" aria-label="Open data folder" onClick={() => void bridge.openDataFolder()}>
            <FolderOpen />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

function BackupsCard({ state }: { state: BridgeState }) {
  const backups = useBackups(true);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [restoring, setRestoring] = useState<BackupInfo | null>(null);
  const [deleting, setDeleting] = useState<BackupInfo | null>(null);
  const isHost = state.mode === 'host';

  const create = useMutation({
    mutationFn: () => call<BackupInfo>('POST', '/api/admin/backups'),
    onSuccess: async (backup) => {
      await queryClient.invalidateQueries({ queryKey: ['backups'] });
      toast.show(`Backup saved: ${backup.name}`);
    },
    onError: (error) => toast.show(errorMessage(error), 'error')
  });
  const restore = useMutation({
    mutationFn: (name: string) => call<{ safetyBackup: string }>('POST', `/api/admin/backups/${encodeURIComponent(name)}/restore`),
    onSuccess: async (result) => {
      setRestoring(null);
      await queryClient.invalidateQueries();
      toast.show(`Restored. The previous data was saved as ${result.safetyBackup}.`);
    }
  });
  const remove = useMutation({
    mutationFn: (name: string) => call('DELETE', `/api/admin/backups/${encodeURIComponent(name)}`),
    onSuccess: async () => {
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (error) => toast.show(errorMessage(error), 'error')
  });

  const exportBackup = async (name: string) => {
    const result = await bridge.exportBackup(name);
    if (result.ok) toast.show(`Saved to ${result.data?.path}`);
    else if (result.error?.code !== 'cancelled') toast.show(result.error?.message ?? 'Could not save the backup.', 'error');
  };
  const importBackup = async () => {
    const result = await bridge.importBackup();
    if (result.ok) {
      await queryClient.invalidateQueries({ queryKey: ['backups'] });
      toast.show(`Added ${result.data?.name}. Choose Restore to use it.`);
    } else if (result.error?.code !== 'cancelled') {
      toast.show(result.error?.message ?? 'Could not read that file.', 'error');
    }
  };

  return (
    <SettingsCard title="Database backups" description="Copies of the shared database, kept on the host computer. Backing up is safe while people are working.">
      <div className="mb-3 flex flex-wrap gap-2">
        <Tooltip content="Back up now">
          <Button variant="primary" size="icon" aria-label="Back up now" loading={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? null : <Save />}
          </Button>
        </Tooltip>
        {isHost ? (
          <Tooltip content="Add a backup file">
            <Button size="icon" aria-label="Add a backup file" onClick={() => void importBackup()}>
              <Upload />
            </Button>
          </Tooltip>
        ) : null}
      </div>
      {backups.isPending ? (
        <Skeleton className="h-9" />
      ) : backups.isError ? (
        <Notice kind="error">{errorMessage(backups.error)}</Notice>
      ) : backups.data?.length === 0 ? (
        <p className="flex items-center gap-2 text-ink-3" aria-label="No backups yet">
          <Database className="size-4" aria-hidden /> 0
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {backups.data?.map((backup) => (
            <li key={backup.name} className="flex items-center gap-2 px-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[12px]" title={backup.name}>
                  {backup.name}
                </p>
                <p className="text-[12px] text-ink-3">
                  {formatDateTime(backup.createdAt)} · {formatBytes(backup.sizeBytes)}
                </p>
              </div>
              {isHost ? (
                <Tooltip content="Save a copy elsewhere">
                  <Button size="icon-sm" variant="ghost" aria-label="Save a copy elsewhere" onClick={() => void exportBackup(backup.name)}>
                    <Download />
                  </Button>
                </Tooltip>
              ) : null}
              <Tooltip content="Restore">
                <Button size="icon-sm" variant="ghost" aria-label="Restore" onClick={() => setRestoring(backup)}>
                  <RotateCcw />
                </Button>
              </Tooltip>
              <Tooltip content="Delete backup">
                <Button size="icon-sm" variant="danger-ghost" aria-label="Delete backup" onClick={() => setDeleting(backup)}>
                  <Trash2 />
                </Button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => {
          if (!open) setRestoring(null);
        }}
        title="Restore this backup?"
        confirmLabel="Restore"
        danger
        loading={restore.isPending}
        onConfirm={() => {
          if (restoring) restore.mutate(restoring.name);
        }}
      >
        <p>Everyone's data goes back to how it was on {restoring ? formatDateTime(restoring.createdAt) : ''}. The current data is saved as another backup first, so this can be undone. People may need to sign in again.</p>
        {restore.isError ? (
          <Notice kind="error" className="mt-3">
            {errorMessage(restore.error)}
          </Notice>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this backup?"
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.name);
        }}
      >
        {deleting?.name}
      </ConfirmDialog>
    </SettingsCard>
  );
}

export function SettingsPage({ state, user }: { state: BridgeState; user: CurrentUser }) {
  const [changingServer, setChangingServer] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const where = state.server ? `${state.server.address}:${state.server.port}` : '';

  return (
    <div className="h-full overflow-y-auto px-6 pb-10 pt-5">
      <h1 className="mb-4 text-[20px] font-semibold leading-tight">Settings</h1>
      <div className="grid max-w-[1120px] gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <PhotoCard user={user} />
          <ProfilesCard />
          <SettingsCard title="Appearance">
            <div className="inline-flex rounded-md border border-border-strong p-0.5" role="group" aria-label="Theme">
              {THEMES.map(({ value, label, icon: Icon }) => (
                <Tooltip key={value} content={label}>
                  <button
                    type="button"
                    aria-label={label}
                    aria-pressed={state.theme === value}
                    onClick={() => void bridge.setTheme(value)}
                    className={`inline-flex size-7.5 items-center justify-center rounded ${state.theme === value ? 'bg-accent-soft text-accent-soft-ink' : 'text-ink-2 hover:text-ink'}`}
                  >
                    <Icon className="size-4" aria-hidden />
                  </button>
                </Tooltip>
              ))}
            </div>
          </SettingsCard>

          <SettingsCard title="Your password" description={`Signed in as ${user.username}.`}>
            <ChangePasswordFormBlock />
          </SettingsCard>
        </div>

        <div className="space-y-4">
          <SettingsCard
            title={state.mode === 'host' ? 'This computer is the host' : 'Connection'}
            description={state.mode === 'host' ? 'All shared data is stored here. Other computers connect to this address while Job Tracker is running.' : `Connected to the host at ${where}. All data stays on that computer.`}
          >
            {state.mode === 'host' ? (
              <HostPanel state={state} />
            ) : (
              <div className="space-y-3">
                {state.server ? (
                  <div>
                    <p className="mb-1.5 text-[12.5px] font-medium text-ink-2">Paired security fingerprint</p>
                    <Fingerprint value={state.server.fingerprint} />
                  </div>
                ) : null}
                <Button onClick={() => setChangingServer(true)}>Change server address</Button>
              </div>
            )}
            <div className="mt-4 border-t border-border pt-3">
              <Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)}>
                {state.mode === 'host' ? 'Stop hosting and choose another mode' : 'Disconnect and choose another mode'}
              </Button>
            </div>
          </SettingsCard>

          {user.role === 'admin' ? <BackupsCard state={state} /> : null}
        </div>
      </div>

      <Dialog open={changingServer} onOpenChange={setChangingServer} title="Change server address" className="max-w-md">
        <ConnectToHost initialAddress={where} />
      </Dialog>
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={state.mode === 'host' ? 'Stop hosting?' : 'Disconnect from this host?'}
        confirmLabel={state.mode === 'host' ? 'Stop hosting' : 'Disconnect'}
        danger
        onConfirm={() => void bridge.resetConnection()}
      >
        {state.mode === 'host'
          ? 'Other computers lose access until this computer hosts again. The database stays in place and is used again when you next choose Host on this computer.'
          : 'You will need to enter the host address again. Nothing on the host changes.'}
      </ConfirmDialog>
    </div>
  );
}

function ChangePasswordFormBlock() {
  const toast = useToast();
  return <ChangePasswordForm onDone={() => toast.show('Password changed. Other devices were signed out.')} />;
}
