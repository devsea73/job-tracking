import { describe, expect, it } from 'vitest';
import { LoginRateLimiter } from '../src/server/auth/rate-limit';
import { resolveSession } from '../src/server/auth/sessions';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../src/shared/constants';
import { ADMIN_PASSWORD, ApiClient, createTestServer, createUsers, signInAdmin } from './helpers';

describe('initial administrator', () => {
  it('is created on first launch and must change the password', async () => {
    const { app, ctx } = await createTestServer();
    const row = ctx.db.$client.prepare(`SELECT username, role, must_change_password, password_hash FROM users`).all() as any[];
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ username: 'admin', role: 'admin', must_change_password: 1 });
    expect(row[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(row[0].password_hash).not.toContain('admin');

    const admin = new ApiClient(app);
    const login = await admin.login('admin', 'admin');
    expect(login.user.mustChangePassword).toBe(true);

    // Nothing else works until the password is replaced.
    const blocked = await admin.get('/api/jobs');
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe('password_change_required');
    expect((await admin.get('/api/admin/users')).status).toBe(403);

    const same = await admin.post('/api/auth/change-password', { currentPassword: 'admin', newPassword: 'admin' });
    expect(same.status).toBe(400);

    const changed = await admin.post('/api/auth/change-password', { currentPassword: 'admin', newPassword: ADMIN_PASSWORD });
    expect(changed.status).toBe(200);
    expect(changed.json.mustChangePassword).toBe(false);
    expect((await admin.get('/api/jobs')).status).toBe(200);

    // The old password is gone.
    const again = new ApiClient(app);
    expect((await again.post('/api/auth/login', { username: 'admin', password: 'admin' })).status).toBe(401);
    await again.login('admin', ADMIN_PASSWORD);
  });

  it('is not created again when the database already has users', async () => {
    const first = await createTestServer();
    await signInAdmin(first.app);
    await first.app.close();
    const { closeDatabase } = await import('../src/server/db/client');
    closeDatabase(first.ctx.handle);

    const second = await createTestServer({ dataDir: first.dataDir });
    const client = new ApiClient(second.app);
    // The changed password survived a restart, the default did not come back.
    expect((await client.post('/api/auth/login', { username: 'admin', password: 'admin' })).status).toBe(401);
    await client.login('admin', ADMIN_PASSWORD);
  });
});

describe('sign-in', () => {
  it('rejects a wrong password and an unknown user the same way', async () => {
    const { app } = await createTestServer();
    const client = new ApiClient(app);
    const wrong = await client.post('/api/auth/login', { username: 'admin', password: 'nope' });
    const unknown = await client.post('/api/auth/login', { username: 'nobody', password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json.error.message).toBe(unknown.json.error.message);
  });

  it('never returns password hashes', async () => {
    const { app } = await createTestServer();
    const { admin, users } = await createUsers(app, 'tyler');
    const payloads = [
      await admin.get('/api/admin/users'),
      await admin.get('/api/auth/me'),
      await users.tyler.get('/api/auth/me'),
      await users.tyler.post('/api/auth/login', { username: 'tyler', password: 'tyler-password' })
    ];
    for (const payload of payloads) expect(JSON.stringify(payload.json)).not.toMatch(/argon2|passwordHash|password_hash/);
  });

  it('locks out repeated failures, then allows them again after the window', async () => {
    let now = 1_000_000;
    const { app } = await createTestServer({ rateLimit: { maxPerAccount: 3, maxPerAddress: 100, windowMs: 60_000, now: () => now } });
    const client = new ApiClient(app);
    for (let i = 0; i < 3; i += 1) {
      expect((await client.post('/api/auth/login', { username: 'admin', password: 'wrong' })).status).toBe(401);
    }
    const locked = await client.post('/api/auth/login', { username: 'admin', password: 'admin' });
    expect(locked.status).toBe(429);
    expect(locked.json.error.code).toBe('too_many_attempts');
    expect(locked.headers['retry-after']).toBeDefined();

    now += 61_000;
    await client.login('admin', 'admin');
  });

  it('limits one address trying many usernames', () => {
    const limiter = new LoginRateLimiter({ maxPerAccount: 100, maxPerAddress: 3, windowMs: 1_000, now: () => 0 });
    for (const name of ['a', 'b', 'c']) limiter.recordFailure('10.0.0.5', name);
    expect(limiter.retryAfter('10.0.0.5', 'someone-else')).not.toBeNull();
    expect(limiter.retryAfter('10.0.0.6', 'someone-else')).toBeNull();
  });
});

describe('sessions', () => {
  it('stores only a hash of the token', async () => {
    const { app, ctx } = await createTestServer();
    const client = new ApiClient(app);
    const login = await client.login('admin', 'admin');
    const rows = ctx.db.$client.prepare(`SELECT token_hash FROM sessions`).all() as Array<{ token_hash: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(login.token);
  });

  it('ends on sign-out', async () => {
    const { app } = await createTestServer();
    const client = new ApiClient(app);
    await client.login('admin', 'admin');
    expect((await client.post('/api/auth/logout')).status).toBe(200);
    expect((await client.get('/api/auth/me')).status).toBe(401);
  });

  it('expires when idle and at the absolute limit', async () => {
    const { app, ctx } = await createTestServer();
    const client = new ApiClient(app);
    const login = await client.login('admin', 'admin');
    const start = Date.now();
    expect(resolveSession(ctx.db, login.token, start + SESSION_IDLE_MS - 1000)).not.toBeNull();
    // Activity above slid the idle window forward, the absolute limit still applies.
    expect(resolveSession(ctx.db, login.token, start + SESSION_ABSOLUTE_MS + 1000)).toBeNull();
    expect(ctx.db.$client.prepare(`SELECT COUNT(*) AS c FROM sessions`).get()).toEqual({ c: 0 });
  });

  it('rejects made-up tokens and requests without one', async () => {
    const { app } = await createTestServer();
    const client = new ApiClient(app);
    expect((await client.get('/api/jobs')).status).toBe(401);
    client.token = 'made-up';
    expect((await client.get('/api/jobs')).status).toBe(401);
  });
});

describe('user management', () => {
  it('lets the administrator create users who can then sign in', async () => {
    const { app } = await createTestServer();
    const admin = await signInAdmin(app);
    const created = await admin.post('/api/admin/users', { username: 'Tyler', password: 'tyler-password', displayName: 'Tyler Morgan' });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ username: 'Tyler', isActive: true, role: 'user', initials: 'TM' });

    const client = new ApiClient(app);
    const login = await client.login('tyler', 'tyler-password'); // usernames are case-insensitive
    expect(login.user.username).toBe('Tyler');
    expect(login.user.mustChangePassword).toBe(false);
  });

  it('rejects duplicate usernames regardless of case, and weak input', async () => {
    const { app } = await createTestServer();
    const admin = await signInAdmin(app);
    await admin.post('/api/admin/users', { username: 'john', password: 'john-password' });
    expect((await admin.post('/api/admin/users', { username: 'JOHN', password: 'john-password' })).status).toBe(409);
    expect((await admin.post('/api/admin/users', { username: 'x y', password: 'john-password' })).status).toBe(400);
    expect((await admin.post('/api/admin/users', { username: 'mike', password: 'short' })).status).toBe(400);
  });

  it('keeps regular users out of every administrator function', async () => {
    const { app } = await createTestServer();
    const { admin, users } = await createUsers(app, 'tyler');
    const tyler = users.tyler;
    const list = await admin.get('/api/admin/users');
    const adminId = list.json.find((user: any) => user.role === 'admin').id;

    const attempts = [
      await tyler.get('/api/admin/users'),
      await tyler.post('/api/admin/users', { username: 'evil', password: 'evil-password' }),
      await tyler.patch(`/api/admin/users/${adminId}`, { isActive: false }),
      await tyler.post(`/api/admin/users/${adminId}/reset-password`, { password: 'hacked-password' }),
      await tyler.delete(`/api/admin/users/${adminId}`),
      await tyler.get('/api/admin/backups'),
      await tyler.post('/api/admin/backups')
    ];
    for (const attempt of attempts) expect(attempt.status).toBe(403);
    // There is no public registration route either.
    expect((await new ApiClient(app).post('/api/auth/register', { username: 'a', password: 'b' })).status).toBe(401);
  });

  it('disabling an account ends its sessions and blocks sign-in, enabling restores it', async () => {
    const { app } = await createTestServer();
    const { admin, users } = await createUsers(app, 'tyler');
    const id = (await users.tyler.get('/api/auth/me')).json.id;

    expect((await admin.patch(`/api/admin/users/${id}`, { isActive: false })).status).toBe(200);
    expect((await users.tyler.get('/api/jobs')).status).toBe(401);
    expect((await new ApiClient(app).post('/api/auth/login', { username: 'tyler', password: 'tyler-password' })).status).toBe(401);

    await admin.patch(`/api/admin/users/${id}`, { isActive: true });
    await users.tyler.login('tyler', 'tyler-password');
  });

  it('resetting a password ends sessions and forces a new choice', async () => {
    const { app } = await createTestServer();
    const { admin, users } = await createUsers(app, 'tyler');
    const id = (await users.tyler.get('/api/auth/me')).json.id;

    await admin.post(`/api/admin/users/${id}/reset-password`, { password: 'temporary-pass' });
    expect((await users.tyler.get('/api/jobs')).status).toBe(401);
    const login = await users.tyler.login('tyler', 'temporary-pass');
    expect(login.user.mustChangePassword).toBe(true);
    expect((await users.tyler.get('/api/jobs')).status).toBe(403);
  });

  it('protects the administrator account from being locked out', async () => {
    const { app } = await createTestServer();
    const admin = await signInAdmin(app);
    const id = (await admin.get('/api/auth/me')).json.id;
    expect((await admin.patch(`/api/admin/users/${id}`, { isActive: false })).status).toBe(403);
    expect((await admin.delete(`/api/admin/users/${id}`)).status).toBe(403);
  });

  it('deleting a user removes their applications but keeps shared jobs', async () => {
    const { app, ctx, http } = await createTestServer();
    const { admin, users } = await createUsers(app, 'tyler');
    const { jobPage } = await import('./helpers');
    http.serve('https://acme.example.com/jobs/1', jobPage({ title: 'Engineer', company: 'Acme' }));
    await users.tyler.addJob('https://acme.example.com/jobs/1', { memo: 'secret' });
    const id = (await users.tyler.get('/api/auth/me')).json.id;

    expect((await admin.delete(`/api/admin/users/${id}`)).status).toBe(200);
    expect(ctx.db.$client.prepare(`SELECT COUNT(*) AS c FROM applications`).get()).toEqual({ c: 0 });
    expect(ctx.db.$client.prepare(`SELECT COUNT(*) AS c FROM jobs`).get()).toEqual({ c: 1 });
  });
});

describe('local network guard', () => {
  it('refuses public addresses and accepts LAN and overlay ones', async () => {
    const { app } = await createTestServer();
    const client = new ApiClient(app);
    for (const address of ['8.8.8.8', '2606:4700:4700::1111', '::ffff:93.184.216.34']) {
      const response = await client.request('GET', '/api/info', undefined, address);
      expect(response.status, address).toBe(403);
      expect(response.json.error.code).toBe('lan_only');
    }
    for (const address of ['127.0.0.1', '192.168.1.100', '10.1.2.3', '172.16.0.9', '169.254.1.1', '100.103.156.93', 'fe80::1', '::1', '::ffff:192.168.1.5']) {
      expect((await client.request('GET', '/api/info', undefined, address)).status, address).toBe(200);
    }
  });
});
