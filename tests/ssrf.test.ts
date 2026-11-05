import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSafeUrl, assertSafeUrlShape, isPublicIp, resolvePublicAddresses, UnsafeUrlError, type Resolver } from '../src/server/extraction/ip-guard';
import { FetchError, SafeHttpClient } from '../src/server/extraction/safe-fetch';
import { createTestServer, createUsers } from './helpers';

const publicDns: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];

describe('address checks', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.5.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '224.0.0.1', '255.255.255.255'])('%s is not public', (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])('%s is public', (address) => {
    expect(isPublicIp(address)).toBe(true);
  });

  it.each([
    'http://localhost/x',
    'http://LOCALHOST./x',
    'http://127.0.0.1/admin',
    'http://[::1]/x',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://0x7f000001/', // 127.0.0.1 in hex
    'http://2130706433/', // 127.0.0.1 as an integer
    'http://printer.local/',
    'http://intranet/',
    'http://files.internal/x',
    'http://nas.lan/x',
    'ftp://example.com/x',
    'file:///etc/passwd',
    'https://user:pass@example.com/x',
    'https://example.com:22/x',
    'https://example.com:3306/x'
  ])('refuses %s', (url) => {
    expect(() => assertSafeUrlShape(new URL(url))).toThrow(UnsafeUrlError);
  });

  it('accepts an ordinary public link', async () => {
    await expect(assertSafeUrl(new URL('https://example.com/jobs/1'), publicDns)).resolves.toBeUndefined();
  });

  it('refuses a public name that resolves to a private address', async () => {
    const rebinding: Resolver = async () => [{ address: '192.168.1.1', family: 4 }];
    await expect(assertSafeUrl(new URL('https://evil.example.com/'), rebinding)).rejects.toThrow(UnsafeUrlError);
  });

  it('refuses when any one of several addresses is private', async () => {
    const mixed: Resolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 }
    ];
    await expect(resolvePublicAddresses('evil.example.com', mixed)).rejects.toThrow(UnsafeUrlError);
  });
});

describe('fetching', () => {
  let server: Server | null = null;
  let client: SafeHttpClient | null = null;

  afterEach(async () => {
    await client?.close();
    client = null;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  /** A real local server, reached through a resolver that pretends it has a public address at the check. */
  async function start(handler: Parameters<typeof createServer>[1]): Promise<number> {
    server = createServer(handler);
    await new Promise<void>((resolve) => (server as Server).listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  it('refuses before connecting when DNS points at the LAN, so no request ever arrives', async () => {
    let hits = 0;
    const port = await start((_req, res) => {
      hits += 1;
      res.end('secret');
    });
    client = new SafeHttpClient(async () => [{ address: '127.0.0.1', family: 4 }]);
    await expect(client.fetch(`http://rebind.example.com:${port}/`)).rejects.toMatchObject({ reason: 'unsafe_url' });
    expect(hits).toBe(0);
  });

  it('checks every redirect: a public page cannot redirect into the LAN', async () => {
    client = new SafeHttpClient(publicDns);
    await expect(client.fetch('http://127.0.0.1:1/')).rejects.toBeInstanceOf(FetchError);
    await expect(client.fetch('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({ reason: 'unsafe_url' });
  });

  it('refuses unsafe links through the API, before any page is read', async () => {
    const { app, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler');
    for (const url of ['http://192.168.1.1/admin', 'http://localhost:3847/api/admin/users', 'http://169.254.169.254/', 'file:///C:/Windows/win.ini', 'javascript:alert(1)']) {
      const response = await users.tyler.post('/api/applications', { url });
      expect(response.status, url).toBe(400);
      expect(['unsafe_url', 'invalid_url'], url).toContain(response.json.error.code);
    }
    expect(http.requests).toEqual([]);
  });

  it('refuses a link that redirects somewhere unsafe, through the API', async () => {
    const { app, ctx, http } = await createTestServer();
    const { users } = await createUsers(app, 'tyler');
    http.fetch = async () => {
      throw new FetchError('unsafe_url', 'Links to private network addresses cannot be fetched.');
    };
    const response = await users.tyler.post('/api/applications', { url: 'https://short.example.com/x' });
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe('unsafe_url');
    expect(ctx.db.$client.prepare('SELECT COUNT(*) AS c FROM jobs').get()).toEqual({ c: 0 });
  });
});
