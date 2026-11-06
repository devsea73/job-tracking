import type { ServerEvent } from '../shared/api';
import type { ApiCallResult, ConnectionStatus } from '../shared/bridge';
import { CertificateMismatchError, PinnedClient, ServerUnreachableError, type ServerTarget } from './lan-client';

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 20_000;
/** Reading a job page can need a full browser, so adding a job is given much longer than other calls. */
const LONG_CALL_MS = 150_000;

export interface ConnectionCallbacks {
  onStatus(status: ConnectionStatus, message: string | null): void;
  onEvent(event: ServerEvent): void;
  onSessionEnded(): void;
}

/**
 * Keeps a live connection to the host and holds the session token. While a token is held
 * the event stream doubles as the connection monitor; without one, the server is pinged.
 * When the host goes away this reports it and keeps retrying: there is no offline database.
 */
export class Connection {
  private client: PinnedClient | null = null;
  private token: string | null = null;
  private generation = 0;
  private stream: { close: () => void } | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay = RETRY_MIN_MS;

  constructor(private readonly callbacks: ConnectionCallbacks) {}

  get signedIn(): boolean {
    return this.token !== null;
  }

  connect(target: ServerTarget, token: string | null): void {
    this.disconnect();
    this.client = new PinnedClient(target);
    this.token = token;
    this.callbacks.onStatus('connecting', null);
    void this.monitor(this.generation);
  }

  disconnect(): void {
    this.generation += 1;
    this.stream?.close();
    this.stream = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.client?.destroy();
    this.client = null;
  }

  retryNow(): void {
    if (!this.client) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryDelay = RETRY_MIN_MS;
    this.generation += 1;
    this.stream?.close();
    this.stream = null;
    this.callbacks.onStatus('connecting', null);
    void this.monitor(this.generation);
  }

  private fail(error: unknown, generation: number): void {
    if (generation !== this.generation) return;
    if (error instanceof CertificateMismatchError) {
      this.callbacks.onStatus('cert_mismatch', error.message);
    } else {
      const message = error instanceof Error ? error.message : 'The host cannot be reached.';
      this.callbacks.onStatus('offline', message);
    }
    this.retryTimer = setTimeout(() => void this.monitor(generation), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
  }

  private async monitor(generation: number): Promise<void> {
    const client = this.client;
    if (!client || generation !== this.generation) return;
    try {
      await client.info();
    } catch (error) {
      this.fail(error, generation);
      return;
    }
    if (generation !== this.generation) return;
    this.retryDelay = RETRY_MIN_MS;
    this.callbacks.onStatus('connected', null);

    if (!this.token) {
      // Signed out: there is no event stream to watch, so just check back periodically.
      this.retryTimer = setTimeout(() => void this.monitor(generation), RETRY_MAX_MS);
      return;
    }

    const stream = client.openEvents(
      this.token,
      () => this.callbacks.onStatus('connected', null),
      (event) => this.callbacks.onEvent(event)
    );
    this.stream = stream;
    const ended = await stream.done;
    if (generation !== this.generation) return;
    this.stream = null;
    if (ended.status === 401) {
      this.endSession();
      void this.monitor(generation);
      return;
    }
    this.fail(ended.error ?? new ServerUnreachableError('The connection to the host was lost.'), generation);
  }

  private endSession(): void {
    this.token = null;
    this.callbacks.onSessionEnded();
  }

  /** Called with the new token after signing in, which also starts the event stream. */
  private restartMonitor(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.generation += 1;
    this.stream?.close();
    this.stream = null;
    void this.monitor(this.generation);
  }

  async api(method: string, path: string, body: unknown, onToken: (token: string | null) => void): Promise<ApiCallResult> {
    const client = this.client;
    if (!client) {
      return { ok: false, status: 0, error: { code: 'not_connected', message: 'This computer is not connected to a host yet.' } };
    }
    if (!path.startsWith('/api/')) {
      return { ok: false, status: 0, error: { code: 'invalid_path', message: 'Invalid request.' } };
    }
    try {
      // Reading a job page can take a browser and a while.
      const timeout = method === 'POST' && (path === '/api/applications' || path === '/api/applications/check') ? LONG_CALL_MS : undefined;
      const result = await client.call(method, path, body, this.token, timeout);

      if (path === '/api/auth/login' && result.ok) {
        // The token stops here: page code gets the user and never the credential.
        const { token, ...rest } = result.data as { token: string };
        this.token = token;
        onToken(token);
        this.restartMonitor();
        return { ...result, data: rest };
      }
      if (path === '/api/auth/logout') {
        this.token = null;
        onToken(null);
        this.restartMonitor();
      } else if (result.status === 401 && this.token) {
        this.endSession();
        onToken(null);
        this.restartMonitor();
      }
      return result;
    } catch (error) {
      const code = error instanceof CertificateMismatchError ? 'cert_mismatch' : 'offline';
      const message = error instanceof Error ? error.message : 'The host cannot be reached.';
      this.callbacks.onStatus(code === 'cert_mismatch' ? 'cert_mismatch' : 'offline', message);
      this.retryNowQuietly();
      return { ok: false, status: 0, error: { code, message } };
    }
  }

  /** Saves a file from the host, as the signed-in person. */
  async download(path: string, destination: string): Promise<{ bytes: number }> {
    if (!this.client || !this.token) throw new Error('Sign in first.');
    if (!path.startsWith('/api/')) throw new Error('Invalid request.');
    return this.client.download(path, this.token, destination);
  }

  /** A failed call means the stream is probably dead too; look again without flashing "connecting". */
  private retryNowQuietly(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => this.restartMonitor(), this.retryDelay);
  }
}
