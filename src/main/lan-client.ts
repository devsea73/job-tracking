import { Agent, request, type RequestOptions } from 'node:https';
import { connect, type PeerCertificate } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { ServerEvent, ServerInfo } from '../shared/api';
import type { ApiCallResult } from '../shared/bridge';
import { DEFAULT_PORT } from '../shared/constants';

/**
 * HTTPS to the LAN host, verified by pinning rather than by certificate authorities. Hosts
 * have self-signed certificates and their IP addresses can change, so a connection is
 * trusted when, and only when, the server presents the exact certificate the person
 * confirmed while pairing. Nothing here changes Node's verification for any other connection.
 */

export interface ServerTarget {
  host: string;
  port: number;
  fingerprint: string;
  certPem: string;
}

export class CertificateMismatchError extends Error {
  constructor() {
    super('The host presented a different security certificate than the one this computer paired with.');
    this.name = 'CertificateMismatchError';
  }
}

export class ServerUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerUnreachableError';
  }
}

export function parseServerAddress(input: string): { host: string; port: number } | null {
  const text = input.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!text) return null;
  const ipv6 = text.match(/^\[([^\]]+)\](?::(\d+))?$/);
  const [host, portText] = ipv6 ? [ipv6[1], ipv6[2]] : text.split(':');
  if (!host || (!ipv6 && text.split(':').length > 2)) return null;
  const port = portText ? Number(portText) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

const CERTIFICATE_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED'
]);

function classifyNetworkError(error: NodeJS.ErrnoException, target: { host: string; port: number }): Error {
  if (error instanceof CertificateMismatchError) return error;
  if (error.code && CERTIFICATE_ERRORS.has(error.code)) return new CertificateMismatchError();
  const where = `${target.host}:${target.port}`;
  switch (error.code) {
    case 'ECONNREFUSED':
      return new ServerUnreachableError(`Nothing is accepting connections at ${where}. Check that Job Tracker is running in Host Mode on that computer.`);
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new ServerUnreachableError(`Could not reach ${where}. Check the address, the network connection and the host's firewall.`);
    case 'ECONNRESET':
    case 'EPIPE':
      return new ServerUnreachableError(`The connection to ${where} was lost. Check that Job Tracker is still running on the host.`);
    default:
      return new ServerUnreachableError(`Could not connect to ${where}. Check that Job Tracker is running on the host.`);
  }
}

/** Reads the certificate a server offers without sending it anything. Used only to show it for pairing. */
export function readServerCertificate(host: string, port: number, timeoutMs = 6_000): Promise<{ certPem: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    const fail = (error: Error) => {
      socket.destroy();
      reject(classifyNetworkError(error as NodeJS.ErrnoException, { host, port }));
    };
    socket.setTimeout(timeoutMs, () => fail(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      const peer = socket.getPeerCertificate(false) as PeerCertificate;
      socket.end();
      if (!peer?.raw) {
        reject(new ServerUnreachableError(`The server at ${host}:${port} did not offer a certificate.`));
        return;
      }
      const certPem = new X509Certificate(peer.raw).toString();
      resolve({ certPem, fingerprint: new X509Certificate(peer.raw).fingerprint256 });
    });
  });
}

/**
 * Idle connections are closed here well before the host closes them (after 72 seconds). Otherwise
 * a request can go out on a connection at the very moment the host is closing it, and fail as
 * "connection lost" although the host is fine.
 */
const IDLE_CONNECTION_MS = 30_000;

/** A reset this side of any answer, on a connection reused from earlier: the host never saw the request. */
class StaleConnectionError extends Error {
  constructor(readonly reset: NodeJS.ErrnoException) {
    super(reset.message);
  }
}

/**
 * Requests that do no harm if the host did get the first try after all. Applying is one: a
 * second try finds the application and answers "already applied" instead of saving another.
 */
function safeToRepeat(method: string, path: string): boolean {
  if (method === 'GET' || method === 'PATCH' || method === 'DELETE') return true;
  return method === 'POST' && (path === '/api/applications' || path === '/api/applications/check' || /^\/api\/jobs\/\d+\/(apply|highlight)$/.test(path));
}

export class PinnedClient {
  private readonly agent: Agent;

  constructor(readonly target: ServerTarget) {
    this.agent = new Agent({
      keepAlive: true,
      maxSockets: 16,
      // The pinned certificate is the only trusted root for this connection...
      ca: target.certPem,
      // ...and the fingerprint check replaces the hostname check, since addresses change.
      checkServerIdentity: (_host, cert) => {
        if (cert.fingerprint256 !== target.fingerprint) return new CertificateMismatchError();
        return undefined;
      }
    });
    // Runs after the agent's own handler has put the connection aside for reuse. A request that
    // takes the connection sets its own time limit, so this only ever ends an idle one.
    this.agent.on('free', (socket: { setTimeout(ms: number): unknown; destroyed?: boolean }) => {
      if (!socket.destroyed) socket.setTimeout(IDLE_CONNECTION_MS);
    });
  }

  private options(method: string, path: string, headers: Record<string, string>): RequestOptions {
    return { host: this.target.host, port: this.target.port, path, method, agent: this.agent, headers };
  }

  async call<T = unknown>(method: string, path: string, body: unknown, token: string | null, timeoutMs = 20_000): Promise<ApiCallResult<T>> {
    try {
      return await this.send<T>(method, path, body, token, timeoutMs);
    } catch (error) {
      if (!(error instanceof StaleConnectionError)) throw error;
      if (!safeToRepeat(method, path)) throw classifyNetworkError(error.reset, this.target);
      // Sent again once, on a new connection.
      try {
        return await this.send<T>(method, path, body, token, timeoutMs, true);
      } catch (retryError) {
        throw retryError instanceof StaleConnectionError ? classifyNetworkError(retryError.reset, this.target) : retryError;
      }
    }
  }

  private send<T>(method: string, path: string, body: unknown, token: string | null, timeoutMs: number, retried = false): Promise<ApiCallResult<T>> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      let answered = false;
      const req = request(
        this.options(method, path, {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {})
        }),
        (res) => {
          answered = true;
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', (error) => reject(classifyNetworkError(error, this.target)));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            let json: unknown = null;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              // Handled below as a response without a usable body.
            }
            if (status >= 200 && status < 300) {
              resolve({ ok: true, status, data: json as T });
              return;
            }
            const error = (json as { error?: ApiCallResult['error'] } | null)?.error;
            resolve({ ok: false, status, error: error ?? { code: 'bad_response', message: `The host answered with an unexpected response (HTTP ${status}).` } });
          });
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', (error: NodeJS.ErrnoException) => {
        const stale = !answered && !retried && req.reusedSocket && (error.code === 'ECONNRESET' || error.code === 'EPIPE');
        reject(stale ? new StaleConnectionError(error) : classifyNetworkError(error, this.target));
      });
      req.end(payload);
    });
  }

  /**
   * Saves a file the host sends straight to disk, under a temporary name until the last byte has
   * arrived, so an interrupted download never leaves a file that looks complete.
   */
  download(path: string, token: string | null, destination: string, timeoutMs = 10 * 60_000): Promise<{ bytes: number }> {
    return new Promise((resolve, reject) => {
      const req = request(this.options('GET', path, { accept: 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }), (res) => {
        if (res.statusCode !== 200) {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            let message = `The host answered with an unexpected response (HTTP ${res.statusCode}).`;
            try {
              message = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: { message?: string } }).error?.message ?? message;
            } catch {
              // The status says enough.
            }
            reject(new Error(message));
          });
          return;
        }
        const expected = Number(res.headers['content-length']);
        const partial = `${destination}.part`;
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
        });
        pipeline(res, createWriteStream(partial, { flags: 'w' }))
          .then(() => {
            if (Number.isFinite(expected) && bytes !== expected) throw new Error('The download was cut short. Nothing was kept.');
            renameSync(partial, destination);
            resolve({ bytes });
          })
          .catch((error: NodeJS.ErrnoException) => {
            rmSync(partial, { force: true });
            reject(error.code ? classifyNetworkError(error, this.target) : error);
          });
      });
      req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', (error) => reject(classifyNetworkError(error, this.target)));
      req.end();
    });
  }

  async info(): Promise<ServerInfo> {
    const result = await this.call<ServerInfo>('GET', '/api/info', undefined, null, 6_000);
    if (!result.ok || result.data?.app !== 'job-tracker') {
      throw new ServerUnreachableError(`The server at ${this.target.host}:${this.target.port} is not a Job Tracker host.`);
    }
    return result.data;
  }

  /** Keeps a live-update stream open until it ends. Resolves with the reason it ended. */
  openEvents(token: string, onOpen: () => void, onEvent: (event: ServerEvent) => void): { done: Promise<{ status: number | null; error: Error | null }>; close: () => void } {
    let close = () => {};
    const done = new Promise<{ status: number | null; error: Error | null }>((resolve) => {
      const req = request(this.options('GET', '/api/events', { accept: 'text/event-stream', authorization: `Bearer ${token}` }), (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve({ status: res.statusCode ?? null, error: null });
          return;
        }
        onOpen();
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let split = buffer.indexOf('\n\n');
          while (split !== -1) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            if (block.startsWith('data: ')) {
              try {
                onEvent(JSON.parse(block.slice(6)) as ServerEvent);
              } catch {
                // A malformed event is skipped. The next one still arrives.
              }
            }
            split = buffer.indexOf('\n\n');
          }
        });
        res.on('end', () => resolve({ status: 200, error: null }));
        res.on('close', () => resolve({ status: 200, error: null }));
        res.on('error', (error) => resolve({ status: 200, error }));
      });
      req.on('error', (error) => resolve({ status: null, error: classifyNetworkError(error, this.target) }));
      // The stream may reuse an idle connection: the idle time limit must not apply to it.
      req.setTimeout(0);
      req.end();
      close = () => req.destroy();
    });
    return { done, close: () => close() };
  }

  destroy(): void {
    this.agent.destroy();
  }
}

/**
 * First contact with a host: reads its certificate, then proves over a connection pinned to
 * that certificate that it really is a Job Tracker server, before anything is trusted.
 */
export async function probeServer(address: string): Promise<{ host: string; port: number; fingerprint: string; certPem: string; info: ServerInfo }> {
  const parsed = parseServerAddress(address);
  if (!parsed) throw new ServerUnreachableError('Enter the host address like 192.168.1.100:3847.');
  const { certPem, fingerprint } = await readServerCertificate(parsed.host, parsed.port);
  const client = new PinnedClient({ ...parsed, certPem, fingerprint });
  try {
    return { ...parsed, certPem, fingerprint, info: await client.info() };
  } finally {
    client.destroy();
  }
}
