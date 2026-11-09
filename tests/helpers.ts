import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach } from 'vitest';
import { buildApp } from '../src/server/app';
import { createPasswordHasher } from '../src/server/auth/passwords';
import type { RateLimitOptions } from '../src/server/auth/rate-limit';
import type { AppContext } from '../src/server/context';
import { createContext } from '../src/server/create-context';
import { closeDatabase } from '../src/server/db/client';
import { FetchError, type FetchOptions, type FetchResult, type HttpClient } from '../src/server/extraction/safe-fetch';
import type { PageRenderer, RenderedPage } from '../src/server/extraction/types';
import { createSilentLogger } from '../src/server/logger';
import type { CreateApplicationResponse, LoginResponse, StepSaved } from '../src/shared/api';
import type { StepStage } from '../src/shared/constants';

/** A page the fake internet serves. Tests never touch real job sites. */
export interface FakePage {
  status?: number;
  body?: string;
  contentType?: string;
  /** Redirects here. */
  redirectTo?: string;
  /** Fails the request instead of answering. */
  error?: FetchError;
  /** Waited for before answering, to line up concurrent requests. */
  delay?: Promise<unknown>;
}

export class FakeHttp implements HttpClient {
  readonly pages = new Map<string, FakePage>();
  readonly requests: string[] = [];

  serve(url: string, page: FakePage | string): this {
    this.pages.set(url, typeof page === 'string' ? { body: page } : page);
    return this;
  }

  async fetch(url: string, _options?: FetchOptions): Promise<FetchResult> {
    this.requests.push(url);
    const chain = [url];
    let current = url;
    for (let hop = 0; hop < 6; hop += 1) {
      const page = this.pages.get(current);
      if (!page) return { status: 404, finalUrl: current, chain, contentType: 'text/html', body: '<html><title>Not found</title><body>Page not found</body></html>' };
      if (page.delay) await page.delay;
      if (page.error) throw page.error;
      if (page.redirectTo) {
        current = page.redirectTo;
        chain.push(current);
        continue;
      }
      return { status: page.status ?? 200, finalUrl: current, chain, contentType: page.contentType ?? 'text/html', body: page.body ?? '' };
    }
    throw new FetchError('network', 'This link redirected too many times.');
  }
}

export class FakeRenderer implements PageRenderer {
  readonly rendered: string[] = [];
  readonly pages = new Map<string, RenderedPage>();

  serve(url: string, html: string, status = 200): this {
    this.pages.set(url, { html, finalUrl: url, status });
    return this;
  }

  async render(url: string): Promise<RenderedPage> {
    this.rendered.push(url);
    const page = this.pages.get(url);
    if (!page) throw new Error('Could not open this page.');
    return page;
  }

  async close(): Promise<void> {}
}

export interface TestServer {
  app: FastifyInstance;
  ctx: AppContext;
  http: FakeHttp;
  renderer: FakeRenderer;
  dataDir: string;
  databasePath: string;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'job-tracker-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

/** A complete server on a temporary database file, with cheap password hashing and a fake internet. */
export async function createTestServer(options: { rateLimit?: RateLimitOptions; dataDir?: string } = {}): Promise<TestServer> {
  const dataDir = options.dataDir ?? tempDir();
  const http = new FakeHttp();
  const renderer = new FakeRenderer();
  const ctx = await createContext({
    dataDir,
    migrationsDir: resolve(__dirname, '..', 'drizzle'),
    version: 'test',
    http,
    renderer,
    logger: createSilentLogger(),
    hasher: createPasswordHasher({ memoryCost: 1024, timeCost: 2 }),
    rateLimit: options.rateLimit
  });
  const app = buildApp(ctx);
  await app.ready();
  cleanups.unshift(async () => {
    await app.close();
    closeDatabase(ctx.handle);
  });
  return { app, ctx, http, renderer, dataDir, databasePath: ctx.handle.path };
}

export class ApiClient {
  token: string | null = null;

  constructor(private readonly app: FastifyInstance) {}

  async request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, remoteAddress?: string) {
    const response = await this.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      ...(remoteAddress ? { remoteAddress } : {}),
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {}
    });
    let json: any = null;
    try {
      json = JSON.parse(response.body);
    } catch {
      json = response.body;
    }
    return { status: response.statusCode, json, headers: response.headers };
  }

  get = (url: string) => this.request('GET', url);
  post = (url: string, body?: unknown) => this.request('POST', url, body);
  patch = (url: string, body?: unknown) => this.request('PATCH', url, body);
  delete = (url: string) => this.request('DELETE', url);

  async login(username: string, password: string): Promise<LoginResponse> {
    const response = await this.post('/api/auth/login', { username, password });
    if (response.status !== 200) throw new Error(`Login failed for ${username}: ${JSON.stringify(response.json)}`);
    this.token = response.json.token;
    return response.json;
  }

  /** The first profile of the signed-in user, created along with their account. */
  async defaultProfileId(): Promise<number> {
    const response = await this.get('/api/profiles');
    if (response.status !== 200) throw new Error(`Listing profiles failed: ${JSON.stringify(response.json)}`);
    return Math.min(...response.json.profiles.map((profile: { id: number }) => profile.id));
  }

  async addJob(url: string, extra: Record<string, unknown> = {}): Promise<CreateApplicationResponse> {
    const response = await this.post('/api/applications', { url, profileId: extra.profileId ?? (await this.defaultProfileId()), ...extra });
    if (response.status !== 200) throw new Error(`Adding ${url} failed: ${response.status} ${JSON.stringify(response.json)}`);
    return response.json;
  }

  /**
   * Puts a step on one of this person's application timelines: an interview, an offer or a
   * rejection, at `at` (an instant, or a Date). The application's stage follows from it.
   */
  async addStep(applicationId: number, stage: StepStage, at: string | Date, extra: { timezone?: string; note?: string | null } = {}): Promise<StepSaved> {
    const response = await this.post(`/api/applications/${applicationId}/steps`, {
      stage,
      at: typeof at === 'string' ? at : at.toISOString(),
      timezone: extra.timezone ?? 'UTC',
      ...(extra.note !== undefined ? { note: extra.note } : {})
    });
    if (response.status !== 201) throw new Error(`Adding ${stage} to application ${applicationId} failed: ${response.status} ${JSON.stringify(response.json)}`);
    return response.json;
  }
}

export const ADMIN_PASSWORD = 'correct-horse-battery';

/** Signs in as the administrator and completes the required first password change. */
export async function signInAdmin(app: FastifyInstance): Promise<ApiClient> {
  const admin = new ApiClient(app);
  await admin.login('admin', 'admin');
  const changed = await admin.post('/api/auth/change-password', { currentPassword: 'admin', newPassword: ADMIN_PASSWORD });
  if (changed.status !== 200) throw new Error(`Password change failed: ${JSON.stringify(changed.json)}`);
  return admin;
}

/** The administrator plus signed-in regular users, one client per name. */
export async function createUsers(app: FastifyInstance, ...names: string[]): Promise<{ admin: ApiClient; users: Record<string, ApiClient> }> {
  const admin = await signInAdmin(app);
  const users: Record<string, ApiClient> = {};
  for (const name of names) {
    const created = await admin.post('/api/admin/users', { username: name, password: `${name}-password` });
    if (created.status !== 201) throw new Error(`Creating ${name} failed: ${JSON.stringify(created.json)}`);
    const client = new ApiClient(app);
    await client.login(name, `${name}-password`);
    users[name] = client;
  }
  return { admin, users };
}

export const LONG_DESCRIPTION = `About the role

We are looking for a Senior Software Engineer to join the payments infrastructure team and help us build reliable systems that move money for millions of customers around the world.

Responsibilities
- Design, build and operate highly available services
- Work closely with product managers and other engineers on the roadmap
- Improve observability, reliability and the developer experience across the platform
- Mentor other engineers and raise the quality bar through design and code review

Requirements
- Six or more years of professional software engineering experience
- Deep experience with distributed systems and relational databases
- Strong written and verbal communication skills

Benefits
Competitive salary, equity, health insurance, and generous parental leave.`;

/** A page with schema.org/JobPosting data, the way most career sites publish it. */
export function jobPage(fields: {
  title: string;
  company: string;
  description?: string;
  location?: string;
  canonical?: string;
  extraHead?: string;
  extraBody?: string;
}): string {
  const posting = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: fields.title,
    description: (fields.description ?? LONG_DESCRIPTION)
      .split('\n\n')
      .map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`)
      .join(''),
    hiringOrganization: { '@type': 'Organization', name: fields.company },
    ...(fields.location ? { jobLocation: { '@type': 'Place', address: { addressLocality: fields.location } } } : {})
  };
  return `<!doctype html><html><head><title>${fields.title} at ${fields.company}</title>
    ${fields.canonical ? `<link rel="canonical" href="${fields.canonical}">` : ''}
    ${fields.extraHead ?? ''}
    <script type="application/ld+json">${JSON.stringify(posting)}</script></head>
    <body><nav>Home Jobs About</nav><h1>${fields.title}</h1><footer>Copyright</footer>${fields.extraBody ?? ''}</body></html>`;
}
