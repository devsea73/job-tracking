import { useState, type FormEvent } from 'react';
import { ArrowLeft, Briefcase, Laptop, Server, ShieldCheck } from 'lucide-react';
import type { BridgeState, ProbeResult } from '@shared/bridge';
import { DEFAULT_PORT } from '@shared/constants';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Card, Notice } from '@/components/ui/misc';

const bridge = window.jobTracker;

export function Fingerprint({ value }: { value: string }) {
  return <code className="selectable block break-all rounded-md bg-surface-2 px-2.5 py-2 font-mono text-[12px] leading-relaxed text-ink">{value}</code>;
}

/** Connects to a host: reads its certificate, then asks the person to confirm it before trusting it. */
export function ConnectToHost({ onBack, initialAddress = '' }: { onBack?: () => void; initialAddress?: string }) {
  const [address, setAddress] = useState(initialAddress);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const look = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await bridge.probeServer(address);
    setBusy(false);
    if (result.ok && result.data) setProbe(result.data);
    else setError(result.error?.message ?? 'Could not reach that address.');
  };

  const pair = async () => {
    if (!probe) return;
    setBusy(true);
    setError(null);
    const result = await bridge.pairServer(`${probe.address}:${probe.port}`, probe.fingerprint);
    setBusy(false);
    if (!result.ok) setError(result.error?.message ?? 'Could not connect.');
  };

  if (probe) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-[16px] font-semibold">Confirm this is your host</h2>
          <p className="mt-1 text-ink-2">
            Found a Job Tracker host at <span className="selectable font-medium text-ink">{probe.address}:{probe.port}</span>. On the host computer, open <b>Settings</b> and check that it shows this same security fingerprint.
          </p>
        </div>
        <Fingerprint value={probe.fingerprint} />
        {error ? <Notice kind="error">{error}</Notice> : null}
        <div className="flex items-center gap-2">
          <Button variant="primary" loading={busy} onClick={() => void pair()}>
            <ShieldCheck /> It matches, connect
          </Button>
          <Button onClick={() => setProbe(null)}>Back</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void look(event)} className="space-y-4">
      {onBack ? (
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-ink-2 hover:text-ink">
          <ArrowLeft className="size-4" /> Back
        </button>
      ) : null}
      <div>
        <h2 className="text-[16px] font-semibold">Connect to the host</h2>
        <p className="mt-1 text-ink-2">The host computer shows its address under Settings. All data stays on that computer.</p>
      </div>
      <Field label="Server address" htmlFor="server-address" hint={`The port is optional when it is the usual ${DEFAULT_PORT}.`}>
        <Input id="server-address" autoFocus value={address} onChange={(event) => setAddress(event.target.value)} placeholder={`192.168.1.100:${DEFAULT_PORT}`} />
      </Field>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Button variant="primary" type="submit" loading={busy} disabled={!address.trim()}>
        Find host
      </Button>
    </form>
  );
}

export function ModeSetup() {
  const [choice, setChoice] = useState<'choose' | 'client'>('choose');
  const [starting, setStarting] = useState(false);

  return (
    <CenteredPage>
      {choice === 'client' ? (
        <Card className="p-6">
          <ConnectToHost onBack={() => setChoice('choose')} />
        </Card>
      ) : (
        <div>
          <h1 className="text-[20px] font-semibold">How will this computer be used?</h1>
          <p className="mt-1 mb-5 text-ink-2">One computer on your network keeps the data. The others connect to it. You can change this later in Settings.</p>
          <div className="grid gap-3">
            <button
              type="button"
              disabled={starting}
              onClick={() => {
                setStarting(true);
                void bridge.startHost().finally(() => setStarting(false));
              }}
              className="flex items-start gap-3.5 rounded-xl border border-border bg-surface p-4 text-left hover:border-accent disabled:opacity-60"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-ink">
                <Server className="size-[18px]" aria-hidden />
              </span>
              <span>
                <span className="block font-semibold">{starting ? 'Starting the server…' : 'Host: this is the main computer'}</span>
                <span className="block text-ink-2">Stores the database and serves everyone on the network. Keep it running while people are working.</span>
              </span>
            </button>
            <button type="button" onClick={() => setChoice('client')} className="flex items-start gap-3.5 rounded-xl border border-border bg-surface p-4 text-left hover:border-accent">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-2">
                <Laptop className="size-[18px]" aria-hidden />
              </span>
              <span>
                <span className="block font-semibold">Client: connect to a host</span>
                <span className="block text-ink-2">Uses the shared data on the main computer. You will need its address.</span>
              </span>
            </button>
          </div>
        </div>
      )}
    </CenteredPage>
  );
}

export function CenteredPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-[440px]">
        <div className="mb-6 flex items-center gap-2 text-ink">
          <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-ink">
            <Briefcase className="size-[18px]" aria-hidden />
          </span>
          <span className="text-[15px] font-semibold">Job Tracker</span>
        </div>
        {children}
      </div>
    </div>
  );
}

/** This computer is the host and its server failed to start, typically a port already in use. */
export function HostFailed({ state }: { state: BridgeState }) {
  const [port, setPort] = useState(DEFAULT_PORT);
  const [busy, setBusy] = useState(false);
  return (
    <CenteredPage>
      <Card className="space-y-4 p-6">
        <Notice kind="error" title="The server could not start">
          {state.connectionMessage}
        </Notice>
        <Field label="Port" htmlFor="host-port">
          <Input id="host-port" type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} />
        </Field>
        <div className="flex gap-2">
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              setBusy(true);
              void bridge.startHost(port).finally(() => setBusy(false));
            }}
          >
            Try again
          </Button>
          <Button onClick={() => void bridge.resetConnection()}>Choose another mode</Button>
        </div>
      </Card>
    </CenteredPage>
  );
}

/** Something else is answering at the host's address. Could be a reinstalled host, could be an impostor. */
export function CertificateChanged({ state }: { state: BridgeState }) {
  return (
    <CenteredPage>
      <Card className="space-y-4 p-6">
        <Notice kind="error" title="The host's security certificate has changed">
          This computer paired with a different certificate at {state.server?.address}:{state.server?.port}, so it has stopped connecting. If the host was reinstalled, pair again and compare the fingerprint with the one in the host's Settings. If not, something else may be answering at that address.
        </Notice>
        <ConnectToHost initialAddress={state.server ? `${state.server.address}:${state.server.port}` : ''} />
      </Card>
    </CenteredPage>
  );
}
