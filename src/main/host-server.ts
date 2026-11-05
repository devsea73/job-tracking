import { join } from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import type { HostCommand, HostMessage } from '../shared/host-protocol';

export interface HostReady {
  port: number;
  certPem: string;
  fingerprint: string;
  addresses: string[];
  dataDir: string;
}

const STOP_TIMEOUT_MS = 6_000;

/** Runs the LAN server in a separate process and reports how it is doing. */
export class HostServer {
  private child: UtilityProcess | null = null;
  private stopping = false;
  private exitListeners: Array<() => void> = [];

  constructor(private readonly onUnexpectedExit: (message: string) => void) {}

  get dataDir(): string {
    return join(app.getPath('userData'), 'host-data');
  }

  get running(): boolean {
    return this.child !== null;
  }

  start(port: number): Promise<HostReady> {
    return new Promise((resolve, reject) => {
      const migrationsDir = app.isPackaged ? join(process.resourcesPath, 'drizzle') : join(app.getAppPath(), 'drizzle');
      const child = utilityProcess.fork(join(__dirname, 'server.js'), [], { serviceName: 'Job Tracker Server', stdio: 'ignore' });
      this.child = child;
      this.stopping = false;
      let settled = false;

      child.on('message', (message: HostMessage) => {
        if (message.type === 'ready' && !settled) {
          settled = true;
          resolve({ port: message.port, certPem: message.certPem, fingerprint: message.fingerprint, addresses: message.addresses, dataDir: this.dataDir });
        } else if (message.type === 'failed' && !settled) {
          settled = true;
          reject(new Error(message.message));
        }
      });
      child.once('exit', (code) => {
        if (this.child === child) this.child = null;
        for (const listener of this.exitListeners.splice(0)) listener();
        if (!settled) {
          settled = true;
          reject(new Error(`The server stopped while starting (code ${code}). Details may be in its log.`));
        } else if (!this.stopping) {
          this.onUnexpectedExit(`The server stopped unexpectedly (code ${code}).`);
        }
      });
      child.once('spawn', () => {
        child.postMessage({ type: 'start', dataDir: this.dataDir, migrationsDir, port, version: app.getVersion() } satisfies HostCommand);
      });
    });
  }

  /** Lets the server finish its work and close the database cleanly, within reason. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, STOP_TIMEOUT_MS);
      this.exitListeners.push(() => {
        clearTimeout(timer);
        resolve();
      });
      child.postMessage({ type: 'stop' } satisfies HostCommand);
    });
    this.child = null;
  }
}
