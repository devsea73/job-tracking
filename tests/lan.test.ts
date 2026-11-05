import { X509Certificate } from 'node:crypto';
import { rmSync } from 'node:fs';
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
