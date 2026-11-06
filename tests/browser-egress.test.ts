import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Browser } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import { PlaywrightRenderer, RenderTimeoutError } from '../src/server/extraction/browser';
import { EgressProxy } from '../src/server/extraction/egress-proxy';
import type { Resolver } from '../src/server/extraction/ip-guard';

/*
 * The browser reads pages from the internet on the host's behalf, so it must never reach the LAN.
 * Playwright's request routing never sees a redirect's next hop, so all of the browser's traffic
 * goes through EgressProxy, which checks every connection. And a page that never finishes
 * loading must not hold one of the two reading slots for good.
 */

const PUBLIC = '93.184.216.34';
/** One name that looks public, one that points into the LAN, everything else unknown. */
const resolver: Resolver = async (hostname) => {
  if (hostname === 'jobs.example.com') return [{ address: PUBLIC, family: 4 }];
  if (hostname === 'rebind.example.com') return [{ address: '127.0.0.1', family: 4 }];
  if (hostname === 'mixed.example.com') return [{ address: PUBLIC, family: 4 }, { address: '10.0.0.5', family: 4 }];
  throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
};

const servers: Server[] = [];
const proxies: EgressProxy[] = [];
afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** A local web server, standing in for both the public site and the LAN device behind it. */
async function site(): Promise<{ port: number; hits: Array<{ url: string; host: string | undefined }> }> {
  const hits: Array<{ url: string; host: string | undefined }> = [];
  const server = createServer((incoming, response) => {
    hits.push({ url: incoming.url ?? '', host: incoming.headers.host });
    if (incoming.url === '/redirect') {
      response.writeHead(302, { location: 'http://127.0.0.1:8080/admin' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`hello from ${incoming.url}`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, hits };
}

/** The proxy, with the public address wired to the local site: what a real connection would reach. */
async function proxyTo(port: number): Promise<{ proxy: EgressProxy; url: URL }> {
  const proxy = new EgressProxy(resolver, (_port, address) => connect({ port, host: address === PUBLIC ? '127.0.0.1' : address }));
  proxies.push(proxy);
  return { proxy, url: new URL(await proxy.start()) };
}

function viaProxy(proxyUrl: URL, target: string): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: proxyUrl.hostname, port: proxyUrl.port, method: 'GET', path: target, headers: { host: new URL(target).host } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function tunnel(proxyUrl: URL, target: string): Promise<{ status: number; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: proxyUrl.hostname, port: proxyUrl.port, method: 'CONNECT', path: target });
    outgoing.on('connect', (response, socket) => resolve({ status: response.statusCode ?? 0, socket }));
    outgoing.on('response', (response) => resolve({ status: response.statusCode ?? 0, socket: response.socket }));
    outgoing.on('error', reject);
    outgoing.end();
  });
}

describe('the browser proxy', () => {
  it('passes requests to public addresses on, to the address that was checked', async () => {
    const { port, hits } = await site();
    const { url } = await proxyTo(port);
    const answer = await viaProxy(url, `http://jobs.example.com:${port}/posting?id=7`);
    expect(answer).toMatchObject({ status: 200, body: 'hello from /posting?id=7' });
    expect(hits).toEqual([{ url: '/posting?id=7', host: `jobs.example.com:${port}` }]);
  });

  it('tunnels HTTPS to public addresses', async () => {
    const { port, hits } = await site();
    const { url } = await proxyTo(port);
    const { status, socket } = await tunnel(url, `jobs.example.com:${port}`);
    expect(status).toBe(200);
    const reply = await new Promise<string>((resolve) => {
      let text = '';
      socket.on('data', (chunk: Buffer) => (text += chunk.toString()));
      socket.on('end', () => resolve(text));
      socket.write(`GET /through-tunnel HTTP/1.1\r\nHost: jobs.example.com\r\nConnection: close\r\n\r\n`);
    });
    expect(reply).toContain('hello from /through-tunnel');
    expect(hits.map((hit) => hit.url)).toEqual(['/through-tunnel']);
  });

  it('refuses this computer, the LAN, names that resolve there, and service ports, before connecting', async () => {
    const { port, hits } = await site();
    const { proxy, url } = await proxyTo(port);
    for (const target of [`http://127.0.0.1:${port}/admin`, `http://localhost:${port}/`, `http://rebind.example.com:${port}/`, `http://mixed.example.com:${port}/`, 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:8080/', 'http://jobs.example.com:22/', 'http://printer.local/']) {
      expect((await viaProxy(url, target)).status, target).toBe(403);
    }
    for (const target of [`127.0.0.1:${port}`, `rebind.example.com:${port}`, '10.0.0.1:443', '[::1]:443', 'jobs.example.com:25']) {
      const { status, socket } = await tunnel(url, target);
      socket.destroy();
      expect(status, target).toBe(403);
    }
    expect(hits).toEqual([]);
    expect(proxy.refused).toBe(14);
  });

  it('hands a redirect back to the browser, whose next request is checked like the first', async () => {
    const { port, hits } = await site();
    const { url } = await proxyTo(port);
    const first = await viaProxy(url, `http://jobs.example.com:${port}/redirect`);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('http://127.0.0.1:8080/admin');
    expect((await viaProxy(url, first.headers.location as string)).status).toBe(403);
    expect(hits.map((hit) => hit.url)).toEqual(['/redirect']);
  });

  it('refuses anyone talking to it as if it were a web site', async () => {
    const { port } = await site();
    const { url } = await proxyTo(port);
    const answer = await new Promise<number>((resolve, reject) => {
      const outgoing = request({ host: url.hostname, port: url.port, path: '/' }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
    expect(answer).toBe(403);
  });
});

// ---- The deadline -------------------------------------------------------------------------------

type Behaviour = 'ok' | 'hang' | 'hang-and-stuck';

/** Just enough of Playwright's browser for the renderer, with pages that can hang. */
function fakeBrowser(behaviours: Behaviour[]) {
  const events = { contextsClosed: 0, browserClosed: 0, launched: 0, proxies: [] as string[] };
  const never = new Promise<never>(() => undefined);
  let next = 0;
  const browser = {
    connected: true,
    isConnected() {
      return this.connected;
    },
    on() {
      return this;
    },
    async close() {
      events.browserClosed += 1;
      this.connected = false;
    },
    async newContext() {
      const behaviour = behaviours[next] ?? 'ok';
      next += 1;
      return {
        async route() {},
        async routeWebSocket() {},
        async close() {
          events.contextsClosed += 1;
          if (behaviour === 'hang-and-stuck') await never;
        },
        async newPage() {
          return {
            async goto() {
              if (behaviour !== 'ok') await never;
              return { status: () => 200 };
            },
            async waitForLoadState() {},
            async waitForFunction() {},
            frames: () => [],
            mainFrame: () => null,
            async content() {
              return '<html><body>posting</body></html>';
            },
            url: () => 'https://jobs.example.com/1'
          };
        }
      };
    }
  };
  const launch = async (proxyServer: string) => {
    events.launched += 1;
    events.proxies.push(proxyServer);
    browser.connected = true;
    return browser as unknown as Browser;
  };
  return { launch, events };
}

/** A proxy that is never really started, for renderers that never really browse. */
const stubProxy = () => ({ start: async () => 'http://127.0.0.1:9', close: async () => undefined }) as unknown as EgressProxy;

describe('the render deadline', () => {
  it('gives up on a page that never loads, closes it and frees its slot', async () => {
    const { launch, events } = fakeBrowser(['hang', 'hang', 'ok']);
    const renderer = new PlaywrightRenderer(resolver, { launch, proxy: stubProxy(), deadlineMs: 300 });
    const started = Date.now();
    // Both slots taken by pages that never load; a third waits for one of them.
    const first = renderer.render('https://jobs.example.com/a');
    const second = renderer.render('https://jobs.example.com/b');
    const third = renderer.render('https://jobs.example.com/c');
    await expect(first).rejects.toBeInstanceOf(RenderTimeoutError);
    await expect(second).rejects.toBeInstanceOf(RenderTimeoutError);
    await expect(third).resolves.toMatchObject({ html: '<html><body>posting</body></html>', status: 200 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(events.contextsClosed).toBe(3);
    expect(events.proxies).toEqual(['http://127.0.0.1:9']);
    await renderer.close();
  });

  it('closes the whole browser when even closing a page hangs, and starts a new one next time', async () => {
    const { launch, events } = fakeBrowser(['hang-and-stuck', 'ok']);
    const renderer = new PlaywrightRenderer(resolver, { launch, proxy: stubProxy(), deadlineMs: 200 });
    await expect(renderer.render('https://jobs.example.com/a')).rejects.toBeInstanceOf(RenderTimeoutError);
    expect(events.browserClosed).toBe(1);
    await expect(renderer.render('https://jobs.example.com/b')).resolves.toMatchObject({ status: 200 });
    expect(events.launched).toBe(2);
    await renderer.close();
  }, 20_000);
});
