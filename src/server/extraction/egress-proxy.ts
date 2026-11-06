import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { assertSafeUrlShape, resolvePublicAddresses, systemResolver, type Resolver } from './ip-guard';

/** Opens a connection to an address that has already been checked. Tests replace it. */
export type Dialer = (port: number, address: string) => Socket;

const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 60_000;
/** Headers about one connection, not the request: never passed on. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

const passOn = (headers: IncomingHttpHeaders) => Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !HOP_BY_HOP.has(name))) as Record<string, string | string[]>;

/**
 * The browser's only way out. Every connection it makes, for a page, a frame, a script or the
 * next hop of a redirect, comes through here and is checked as the server's own fetches are: the
 * name is resolved once, every address it gives must be public, and the connection goes to one of
 * the addresses that were checked, so a DNS answer cannot change in between.
 *
 * Playwright's request routing cannot do this alone: it sends redirects, and requests that belong
 * to no page, straight on without asking (see its crNetworkManager). HTTPS goes through as a
 * tunnel, so nothing here reads it; plain HTTP is passed on request by request.
 */
export class EgressProxy {
  private server: Server | null = null;
  private starting: Promise<string> | null = null;
  private readonly sockets = new Set<Duplex>();
  /** Requests refused, for the log and for tests. */
  refused = 0;

  constructor(
    private readonly resolver: Resolver = systemResolver,
    private readonly dial: Dialer = (port, address) => connect({ port, host: address })
  ) {}

  /** The proxy's address, http://127.0.0.1:port, starting it on first use. Only this computer can reach it. */
  start(): Promise<string> {
    this.starting ??= new Promise<string>((resolve, reject) => {
      const server = createServer((request, response) => void this.forward(request, response));
      server.on('connect', (request: IncomingMessage, socket: Duplex, head: Buffer) => void this.tunnel(request, socket, head));
      // WebSockets are closed by the browser's own routing; one arriving here is refused.
      server.on('upgrade', (_request: IncomingMessage, socket: Duplex) => socket.destroy());
      server.on('clientError', (_error, socket: Duplex) => socket.destroy());
      server.on('connection', (socket: Socket) => this.track(socket));
      server.once('error', (error) => {
        this.starting = null;
        reject(error);
      });
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
    return this.starting;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.starting = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
  }

  /** The public addresses a request may go to, or a refusal. */
  private async destination(url: URL): Promise<Array<{ address: string }>> {
    assertSafeUrlShape(url);
    return resolvePublicAddresses(url.hostname, this.resolver);
  }

  /** Connects to the first of the checked addresses that answers. */
  private open(addresses: Array<{ address: string }>, port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      let next = 0;
      const attempt = () => {
        if (next >= addresses.length) {
          reject(new Error('No address answered.'));
          return;
        }
        const socket = this.dial(port, addresses[next].address);
        next += 1;
        const timer = setTimeout(() => socket.destroy(new Error('Timed out connecting.')), CONNECT_TIMEOUT_MS);
        const failed = () => {
          clearTimeout(timer);
          socket.destroy();
          attempt();
        };
        socket.once('error', failed);
        socket.once('connect', () => {
          clearTimeout(timer);
          socket.off('error', failed);
          resolve(socket);
        });
      };
      attempt();
    });
  }

  /** CONNECT host:port, what browsers send for HTTPS: a tunnel to a checked address, or 403. */
  private async tunnel(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    let upstream: Socket;
    try {
      const target = new URL(`https://${request.url ?? ''}`);
      if (target.pathname !== '/' || target.search || target.username) throw new Error('Not a host and port.');
      upstream = await this.open(await this.destination(target), Number(target.port || 443));
    } catch {
      this.refused += 1;
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    this.track(upstream);
    const end = () => {
      upstream.destroy();
      client.destroy();
    };
    for (const socket of [upstream, client]) {
      socket.on('error', end);
      socket.on('close', end);
    }
    upstream.setTimeout(IDLE_TIMEOUT_MS, end);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  }

  /** A plain HTTP request in the absolute form proxies are sent ("GET http://host/path"). */
  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let target: URL;
    let socket: Socket;
    try {
      target = new URL(request.url ?? '');
      if (target.protocol !== 'http:') throw new Error('Only plain HTTP comes this way.');
      socket = await this.open(await this.destination(target), Number(target.port || 80));
    } catch {
      this.refused += 1;
      response.writeHead(403, { connection: 'close', 'content-length': '0' }).end();
      return;
    }
    this.track(socket);
    const upstream = httpRequest({
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...passOn(request.headers), host: target.host },
      // With no agent, Node uses this connection, to the address that was checked.
      createConnection: () => socket
    });
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy(new Error('Timed out.')));
    upstream.on('response', (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.statusMessage, passOn(answer.headers));
      answer.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { connection: 'close', 'content-length': '0' }).end();
      else response.destroy();
    });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  }
}
