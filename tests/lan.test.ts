import { X509Certificate } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { CertificateMismatchError, parseServerAddress, PinnedClient, probeServer, ServerUnreachableError } from '../src/main/lan-client';
import { buildApp } from '../src/server/app';
import { lanAddresses } from '../src/server/network';
import { loadOrCreateTls } from '../src/server/tls';
import type { ServerEvent, LoginResponse } from '../src/shared/api';
import { DEFAULT_PORT } from '../src/shared/constants';
import { createTestServer, jobPage, tempDir } from './helpers';

/** A real HTTPS server on an ephemeral port, the way Host Mode runs it. */
async function startHttpsHost() {
  const server = await createTestServer();
  const tls = await loadOrCreateTls(server.dataDir);
  const app = buildApp(server.ctx, { https: { key: tls.key, cert: tls.cert } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return { server, tls, app, port };
}

describe('server addresses', () => {
  it.each([
    ['192.168.1.100:3847', { host: '192.168.1.100', port: 3847 }],
    ['192.168.1.100', { host: '192.168.1.100', port: DEFAULT_PORT }],
    ['  192.168.1.100:4000 ', { host: '192.168.1.100', port: 4000 }],
    ['https://192.168.1.100:3847/', { host: '192.168.1.100', port: 3847 }],
    ['host-pc:3847', { host: 'host-pc', port: 3847 }],
    ['[fe80::1]:3847', { host: 'fe80::1', port: 3847 }]
  ])('%s', (input, expected) => {
    expect(parseServerAddress(input)).toEqual(expected);
  });

  it.each(['', '192.168.1.100:99999', 'a:b:c', ':3847'])('rejects "%s"', (input) => {
    expect(parseServerAddress(input)).toBeNull();
  });

  it('lists this computer’s LAN addresses without loopback', () => {
    for (const address of lanAddresses()) expect(address).not.toMatch(/^127\./);
  });
});

describe('host certificate', () => {
  it('is generated once and kept, since clients pin it', async () => {
    const dir = tempDir();
    const first = await loadOrCreateTls(dir);
    const second = await loadOrCreateTls(dir);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(new X509Certificate(first.cert).fingerprint256).toBe(first.fingerprint);
    expect(new Date(new X509Certificate(first.cert).validTo).getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 3600 * 1000);
  });

  it('is regenerated when missing, with a different fingerprint', async () => {
    const dir = tempDir();
    const first = await loadOrCreateTls(dir);
    rmSync(join(dir, 'tls'), { recursive: true });
    expect((await loadOrCreateTls(dir)).fingerprint).not.toBe(first.fingerprint);
  });
});

describe('client and host over real TLS', () => {
  it('pairs by fingerprint and then talks over the pinned connection', async () => {
    const { tls, app, port } = await startHttpsHost();
    try {
      const found = await probeServer(`127.0.0.1:${port}`);
      expect(found.fingerprint).toBe(tls.fingerprint);
      expect(found.info.app).toBe('job-tracker');

      const client = new PinnedClient({ host: '127.0.0.1', port, fingerprint: found.fingerprint, certPem: found.certPem });
      const login = await client.call<LoginResponse>('POST', '/api/auth/login', { username: 'admin', password: 'admin' }, null);
      expect(login.ok).toBe(true);
      const me = await client.call('GET', '/api/auth/me', undefined, login.data?.token ?? null);
      expect(me.data).toMatchObject({ username: 'admin' });
      client.destroy();
    } finally {
      await app.close();
    }
  });

  it('refuses a host presenting a different certificate, sending it nothing', async () => {
    const { app, port } = await startHttpsHost();
    const impostor = await loadOrCreateTls(tempDir());
    try {
      const client = new PinnedClient({ host: '127.0.0.1', port, fingerprint: impostor.fingerprint, certPem: impostor.cert });
      await expect(client.call('POST', '/api/auth/login', { username: 'admin', password: 'admin' }, null)).rejects.toBeInstanceOf(CertificateMismatchError);
      client.destroy();
    } finally {
      await app.close();
    }
  });

  it('refuses when only the fingerprint is wrong', async () => {
    const { tls, app, port } = await startHttpsHost();
    try {
      const client = new PinnedClient({ host: '127.0.0.1', port, fingerprint: 'AA:BB', certPem: tls.cert });
      await expect(client.info()).rejects.toThrow();
      client.destroy();
    } finally {
      await app.close();
    }
  });

  it('reports an offline host clearly', async () => {
    const { tls, app, port } = await startHttpsHost();
    await app.close();
    const client = new PinnedClient({ host: '127.0.0.1', port, fingerprint: tls.fingerprint, certPem: tls.cert });
    await expect(client.info()).rejects.toBeInstanceOf(ServerUnreachableError);
    await expect(probeServer(`127.0.0.1:${port}`)).rejects.toBeInstanceOf(ServerUnreachableError);
    client.destroy();
  });

  it('delivers live events to connected clients', async () => {
    const { server, tls, app, port } = await startHttpsHost();
    const client = new PinnedClient({ host: '127.0.0.1', port, fingerprint: tls.fingerprint, certPem: tls.cert });
    try {
      const login = await client.call<LoginResponse>('POST', '/api/auth/login', { username: 'admin', password: 'admin' }, null);
      await client.call('POST', '/api/auth/change-password', { currentPassword: 'admin', newPassword: 'a-new-password' }, login.data?.token ?? null);
      const token = login.data?.token as string;

      const events: ServerEvent[] = [];
      const opened = new Promise<void>((resolve) => {
        const stream = client.openEvents(token, resolve, (event) => events.push(event));
        streams.push(stream);
      });
      await opened;

      server.http.serve('https://company.com/jobs/1', jobPage({ title: 'Engineer', company: 'Acme' }));
      const mine = await client.call<{ profiles: Array<{ id: number }> }>('GET', '/api/profiles', undefined, token);
      const profileId = mine.data?.profiles[0].id;
      const added = await client.call<{ jobId: number }>('POST', '/api/applications', { url: 'https://company.com/jobs/1', profileId }, token);
      expect(added.ok).toBe(true);
      await expect.poll(() => events.map((event) => event.type)).toContain('jobs_changed');
      expect(events[0].jobId).toBe(added.data?.jobId);
    } finally {
      for (const stream of streams.splice(0)) stream.close();
      client.destroy();
      await app.close();
    }
  });

  it('rejects an event stream without a valid session', async () => {
    const { tls, app, port } = await startHttpsHost();
    const client = new PinnedClient({ host: '127.0.0.1', port, fingerprint: tls.fingerprint, certPem: tls.cert });
    try {
      const { done } = client.openEvents('made-up-token', () => undefined, () => undefined);
      expect((await done).status).toBe(401);
    } finally {
      client.destroy();
      await app.close();
    }
  });
});

const streams: Array<{ close: () => void }> = [];

/**
 * A host that closes every connection the moment a second request arrives on it: what happens
 * when a request goes out on an idle connection just as the host closes it.
 */
async function startClosingHost() {
  const tls = await loadOrCreateTls(tempDir());
  const seen = new WeakMap<object, number>();
  const received: string[] = [];
  const host = createHttpsServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    const count = (seen.get(request.socket) ?? 0) + 1;
    seen.set(request.socket, count);
    received.push(`${request.method} ${request.url}`);
    if (count > 1) {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  const port = (host.address() as AddressInfo).port;
  const client = new PinnedClient({ host: '127.0.0.1', port, fingerprint: tls.fingerprint, certPem: tls.cert });
  const close = async () => {
    client.destroy();
    host.closeAllConnections();
    await new Promise((resolve) => host.close(resolve));
  };
  return { client, received, close };
}

/** Lets the finished request's connection go back to the pool of idle ones. */
const idleMoment = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('a connection the host closes as a request goes out', () => {
  it('is retried once on a new connection, so applying does not fail as "connection lost"', async () => {
    const { client, received, close } = await startClosingHost();
    try {
      expect((await client.call('GET', '/api/jobs', undefined, null)).ok).toBe(true);
      await idleMoment();
      expect((await client.call('POST', '/api/applications', { url: 'https://company.com/jobs/1' }, null)).ok).toBe(true);
      expect(received).toEqual(['GET /api/jobs', 'POST /api/applications', 'POST /api/applications']);
    } finally {
      await close();
    }
  });

  it('is not retried when sending again could save something twice', async () => {
    const { client, received, close } = await startClosingHost();
    try {
      await client.call('GET', '/api/jobs', undefined, null);
      await idleMoment();
      await expect(client.call('POST', '/api/applications/1/interviews', { stage: 'Recruiter Screen' }, null)).rejects.toThrow(/was lost/);
      expect(received).toEqual(['GET /api/jobs', 'POST /api/applications/1/interviews']);
    } finally {
      await close();
    }
  });

  it('closes idle connections before the host does', async () => {
    const { client, close } = await startClosingHost();
    try {
      await client.call('GET', '/api/jobs', undefined, null);
      await idleMoment();
      const agent = (client as unknown as { agent: { freeSockets: Record<string, Array<{ timeout: number }>> } }).agent;
      const idle = Object.values(agent.freeSockets).flat();
      expect(idle).toHaveLength(1);
      expect(idle[0].timeout).toBe(30_000);
    } finally {
      await close();
    }
  });
});
