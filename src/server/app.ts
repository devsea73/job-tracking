import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { eq } from 'drizzle-orm';
import type { ApiErrorBody, CreateApplicationRequest, ServerEvent, ServerInfo } from '../shared/api';
import { resolveSession, revokeSession, type ActiveSession } from './auth/sessions';
import type { AppContext } from './context';
import { nowIso } from './db/client';
import { jobs } from './db/schema';
import { hashDescription, normalizeCompany, normalizeTitle } from './dedupe/text-normalize';
import { ApiError, forbidden, notFound, unauthorized } from './errors';
import { isLanAddress } from './network';
import * as applicationsService from './services/applications';
import * as avatarsService from './services/avatars';
import * as backupsService from './services/backups';
import * as duplicatesService from './services/duplicates';
import { getActivity } from './services/activity';
import { getJobBrief } from './services/job-brief';
import { applyToExistingJob, checkLink, createApplication } from './services/intake';
import { refreshJobFacts } from './services/job-facts-store';
import { getDashboard, getJobDetail, getTeam, listCompanies, listInterviews, listJobs } from './services/job-queries';
import * as profilesService from './services/profiles';
import * as usersService from './services/users';
import * as v from './validation';

declare module 'fastify' {
  interface FastifyRequest {
    session: ActiveSession | null;
  }
  interface FastifyContextConfig {
    /** Reachable without signing in. */
    public?: boolean;
    /** Reachable while the user still has to replace a temporary password. */
    allowPendingPasswordChange?: boolean;
    adminOnly?: boolean;
  }
}

const HEARTBEAT_MS = 25_000;

export interface BuildOptions {
  https?: { key: string; cert: string };
}

function requireSession(request: FastifyRequest): ActiveSession {
  if (!request.session) throw unauthorized();
  return request.session;
}

export function buildApp(ctx: AppContext, options: BuildOptions = {}): FastifyInstance {
  const serverOptions: FastifyServerOptions = {
    loggerInstance: ctx.logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2 * 1024 * 1024,
    // Live-update streams stay open indefinitely, and must not hold up a shutdown.
    forceCloseConnections: true,
    ...(options.https ? { https: options.https } : {})
  };
  const app = Fastify(serverOptions) as unknown as FastifyInstance;

  app.decorateRequest('session', null);

  // Anything that tells apps about a change also means cached answers are out of date.
  const unsubscribeCache = ctx.events.subscribe(() => ctx.readCache.invalidate());
  app.addHook('onClose', async () => unsubscribeCache());

  // This server is for the local network. Even if a router forwards the port by
  // mistake, requests from public addresses are refused before anything else runs.
  app.addHook('onRequest', async (request, reply) => {
    if (!isLanAddress(request.socket.remoteAddress)) {
      ctx.logger.warn({ address: request.socket.remoteAddress }, 'Refused a request from outside the local network');
      return reply.code(403).send({ error: { code: 'lan_only', message: 'This server only accepts connections from the local network.' } } satisfies ApiErrorBody);
    }
  });

  app.addHook('onRequest', async (request) => {
    const config = request.routeOptions.config ?? {};
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    request.session = token ? resolveSession(ctx.db, token) : null;

    if (config.public) return;
    if (!request.session) throw unauthorized();
    if (request.session.user.mustChangePassword && !config.allowPendingPasswordChange) {
      throw new ApiError(403, 'password_change_required', 'Please choose a new password first.');
    }
    if (config.adminOnly && request.session.user.role !== 'admin') throw forbidden('Only the administrator can do this.');
  });

  // Runs before the response leaves, so whoever made a change can never read an older answer.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') ctx.readCache.invalidate();
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });

  // Logged by route pattern: query strings can contain personal search text.
  app.addHook('onResponse', async (request, reply) => {
    ctx.logger.info({ method: request.method, route: request.routeOptions.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request');
  });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _request, reply) => {
    if (error instanceof ApiError) {
      if (error.code === 'too_many_attempts') {
        const retry = (error.details as { retryAfter?: number } | undefined)?.retryAfter;
        if (retry) reply.header('retry-after', String(retry));
      }
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } } satisfies ApiErrorBody);
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: { code: error.code ?? 'bad_request', message: error.message } } satisfies ApiErrorBody);
    }
    ctx.logger.error({ err: error }, 'Unhandled request error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong on the host. Details are in its log.' } } satisfies ApiErrorBody);
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } } satisfies ApiErrorBody);
  });

  /** A finished JSON response for a read-only request, shared while the data has not changed. */
  const cachedJson = (reply: FastifyReply, key: string, compute: () => unknown) => reply.type('application/json; charset=utf-8').send(ctx.readCache.read(key, compute));

  // ---- Server info -------------------------------------------------------------------
  app.get('/api/info', { config: { public: true } }, async (): Promise<ServerInfo> => ({ app: 'job-tracker', version: ctx.version, initialized: true }));

  // ---- Session -----------------------------------------------------------------------
  app.post('/api/auth/login', { config: { public: true } }, async (request) => {
    const body = v.parse(v.loginBody, request.body);
    return usersService.login(ctx, request.socket.remoteAddress ?? 'unknown', body.username, body.password);
  });

  app.post('/api/auth/logout', { config: { allowPendingPasswordChange: true } }, async (request) => {
    revokeSession(ctx.db, requireSession(request).tokenHash);
    return { ok: true };
  });

  app.get('/api/auth/me', { config: { allowPendingPasswordChange: true } }, async (request) => usersService.toCurrentUser(ctx.db, requireSession(request).user));

  app.post('/api/auth/change-password', { config: { allowPendingPasswordChange: true } }, async (request) => {
    const body = v.parse(v.changePasswordBody, request.body);
    return usersService.changePassword(ctx, requireSession(request), body.currentPassword, body.newPassword);
  });

  // ---- User management (administrator) -----------------------------------------------
  const admin = { config: { adminOnly: true } };

  app.get('/api/admin/users', admin, async () => usersService.listUsers(ctx.db));

  app.post('/api/admin/users', admin, async (request, reply) => {
    const user = await usersService.createUser(ctx, v.parse(v.createUserBody, request.body));
    return reply.code(201).send(user);
  });

  app.patch('/api/admin/users/:id', admin, async (request) => {
    const { id } = v.parse(v.idParam, request.params);
    return usersService.updateUser(ctx, requireSession(request).user, id, v.parse(v.updateUserBody, request.body));
  });

  app.post('/api/admin/users/:id/reset-password', admin, async (request) => {
    const { id } = v.parse(v.idParam, request.params);
    await usersService.resetPassword(ctx, id, v.parse(v.resetPasswordBody, request.body).password);
    return { ok: true };
  });

  app.delete('/api/admin/users/:id', admin, async (request) => {
    const { id } = v.parse(v.idParam, request.params);
    usersService.deleteUser(ctx, requireSession(request).user, id);
    return { ok: true };
  });

  app.delete('/api/admin/users/:id/avatar', admin, async (request) => {
    avatarsService.removeUserAvatar(ctx, v.parse(v.idParam, request.params).id);
    return { ok: true };
  });

  app.delete('/api/admin/profiles/:id/avatar', admin, async (request) => {
    avatarsService.removeAnyProfileAvatar(ctx, v.parse(v.idParam, request.params).id);
    return { ok: true };
  });

  // ---- Your own avatar and profiles --------------------------------------------------
  app.post('/api/me/avatar', async (request) => avatarsService.setUserAvatar(ctx, requireSession(request).user.id, v.parse(v.avatarBody, request.body).image));

  app.delete('/api/me/avatar', async (request) => {
    avatarsService.removeUserAvatar(ctx, requireSession(request).user.id);
    return { ok: true };
  });

  app.get('/api/profiles', async (request) => profilesService.listMyProfiles(ctx.db, requireSession(request).user.id));

  app.post('/api/profiles', async (request, reply) => {
    const profile = profilesService.createProfile(ctx, requireSession(request).user.id, v.parse(v.createProfileBody, request.body).name);
    return reply.code(201).send(profile);
  });

  app.patch('/api/profiles/:id', async (request) => {
    const { id } = v.parse(v.idParam, request.params);
    profilesService.updateProfile(ctx, requireSession(request).user.id, id, v.parse(v.updateProfileBody, request.body));
    return { ok: true };
  });

  app.delete('/api/profiles/:id', async (request) => profilesService.removeProfile(ctx, requireSession(request).user.id, v.parse(v.idParam, request.params).id));

  app.post('/api/profiles/:id/avatar', async (request) => {
    const { id } = v.parse(v.idParam, request.params);
    return avatarsService.setProfileAvatar(ctx, requireSession(request).user.id, id, v.parse(v.avatarBody, request.body).image);
  });

  app.delete('/api/profiles/:id/avatar', async (request) => {
    avatarsService.removeOwnProfileAvatar(ctx, requireSession(request).user.id, v.parse(v.idParam, request.params).id);
    return { ok: true };
  });

  // ---- Shared by everyone ------------------------------------------------------------
  app.get('/api/avatars/users/:id', async (request) => avatarsService.getUserAvatar(ctx, v.parse(v.idParam, request.params).id));

  app.get('/api/avatars/profiles/:id', async (request) => avatarsService.getProfileAvatar(ctx, v.parse(v.idParam, request.params).id));

  app.get('/api/team', async (_request, reply) => cachedJson(reply, 'team', () => getTeam(ctx.db)));

  // ---- Shared jobs -------------------------------------------------------------------
  app.get('/api/jobs', async (request, reply) => {
    const userId = requireSession(request).user.id;
    return cachedJson(reply, `jobs:${userId}:${request.url}`, () => listJobs(ctx.db, userId, v.parse(v.jobListQuery, request.query)));
  });

  app.get('/api/jobs/companies', async (_request, reply) => cachedJson(reply, 'companies', () => listCompanies(ctx.db)));

  app.get('/api/jobs/:id', async (request) => getJobDetail(ctx, requireSession(request).user.id, v.parse(v.idParam, request.params).id));

  app.get('/api/jobs/:id/brief', async (request) => {
    const { application } = v.parse(v.briefQuery, request.query);
    return getJobBrief(ctx, requireSession(request).user.id, v.parse(v.idParam, request.params).id, application);
  });

  app.post('/api/jobs/:id/highlight', async (request) => {
    const { id } = v.parse(v.idParam, request.params);
    applicationsService.setHighlight(ctx, requireSession(request).user.id, id, v.parse(v.highlightBody, request.body).highlighted);
    return { ok: true };
  });

  app.post('/api/jobs/:id/apply', async (request) => {
    const { id } = v.parse(v.idParam, request.params);
    const body = v.parse(v.applyToJobBody, request.body ?? {});
    return applyToExistingJob(ctx, requireSession(request).user.id, id, body.profileId, body.memo ?? '');
  });

  // Job details are shared by everyone, so corrections go through the administrator.
  // Deleting has its own rule, in the service: see deleteJob.
  app.patch('/api/jobs/:id', admin, async (request) => {
    const { id } = v.parse(v.idParam, request.params);
    const body = v.parse(v.updateJobBody, request.body);
    const result = ctx.db
      .update(jobs)
      .set({
        ...(body.title !== undefined ? { title: body.title, titleKey: normalizeTitle(body.title) } : {}),
        ...(body.company !== undefined ? { companyName: body.company, companyKey: normalizeCompany(body.company) } : {}),
        ...(body.description !== undefined ? { description: body.description, descriptionHash: hashDescription(body.description) } : {}),
        ...(body.location !== undefined ? { location: body.location?.trim() || null } : {}),
        updatedAt: nowIso()
      })
      .where(eq(jobs.id, id))
      .run();
    if (result.changes === 0) throw notFound('That job no longer exists.');
    refreshJobFacts(ctx.handle.sqlite, id);
    ctx.events.publish('jobs_changed', id);
    return getJobDetail(ctx, requireSession(request).user.id, id);
  });

  app.delete('/api/jobs/:id', async (request) => {
    applicationsService.deleteJob(ctx, requireSession(request).user, v.parse(v.idParam, request.params).id);
    return { ok: true };
  });

  // ---- Possible duplicates, for anyone to settle ------------------------------------
  app.get('/api/duplicates', async () => duplicatesService.listDuplicates(ctx));

  app.get('/api/duplicates/count', async () => ({ total: duplicatesService.countDuplicates(ctx) }));

  app.post('/api/duplicates/merge', async (request) => {
    const { jobIdA, jobIdB } = v.parse(v.duplicatePairBody, request.body);
    return duplicatesService.mergeDuplicatePair(ctx, jobIdA, jobIdB);
  });

  app.post('/api/duplicates/dismiss', async (request) => {
    const { jobIdA, jobIdB } = v.parse(v.duplicatePairBody, request.body);
    duplicatesService.dismissDuplicatePair(ctx, jobIdA, jobIdB);
    return { ok: true };
  });

  // ---- Applications: readable by everyone, changed only by their owner -------------------------------------------
  app.post('/api/applications', async (request) => {
    const body = v.parse(v.createApplicationBody, request.body) as CreateApplicationRequest;
    return createApplication(ctx, requireSession(request).user.id, body);
  });

  // Reads a pasted link and says whether it is a new job or a duplicate, saving nothing.
  app.post('/api/applications/check', async (request) => checkLink(ctx, requireSession(request).user.id, v.parse(v.checkLinkBody, request.body).url));

  app.patch('/api/applications/:id', async (request) => {
    const { id } = v.parse(v.idParam, request.params);
    return applicationsService.updateApplication(ctx, requireSession(request).user.id, id, v.parse(v.updateApplicationBody, request.body));
  });

  app.delete('/api/applications/:id', async (request) => {
    const { id } = v.parse(v.idParam, request.params);
    applicationsService.deleteApplication(ctx, requireSession(request).user.id, id);
    return { ok: true };
  });

  app.post('/api/applications/:id/interviews', async (request, reply) => {
    const { id } = v.parse(v.idParam, request.params);
    const interview = applicationsService.addInterview(ctx, requireSession(request).user.id, id, v.parse(v.interviewBody, request.body));
    return reply.code(201).send(interview);
  });

  app.get('/api/interviews', async (request, reply) => {
    const userId = requireSession(request).user.id;
    return cachedJson(reply, `interviews:${userId}:${request.url}`, () => {
      const { limit, ...filter } = v.parse(v.interviewQuery, request.query);
      return listInterviews(ctx.db, userId, filter, limit);
    });
  });

  app.patch('/api/interviews/:id', async (request) => {
    const { id } = v.parse(v.idParam, request.params);
    return applicationsService.updateInterview(ctx, requireSession(request).user.id, id, v.parse(v.interviewBody, request.body));
  });

  app.delete('/api/interviews/:id', async (request) => {
    const { id } = v.parse(v.idParam, request.params);
    applicationsService.deleteInterview(ctx, requireSession(request).user.id, id);
    return { ok: true };
  });

  app.get('/api/activity', async (request, reply) => {
    const userId = requireSession(request).user.id;
    const query = v.parse(v.activityQuery, request.query);
    return cachedJson(reply, `activity:${userId}:${request.url}`, () => getActivity(ctx.handle.sqlite, userId, query));
  });

  app.get('/api/dashboard', async (request, reply) => {
    const userId = requireSession(request).user.id;
    return cachedJson(reply, `dashboard:${userId}`, () => getDashboard(ctx.db, userId));
  });

  // ---- Backups (administrator) -------------------------------------------------------
  app.get('/api/admin/backups', admin, async () => backupsService.listBackups(ctx));

  app.post('/api/admin/backups', admin, async (_request, reply) => reply.code(201).send(await backupsService.createBackup(ctx)));

  app.post('/api/admin/backups/:name/restore', admin, async (request) => {
    const { name } = v.parse(v.backupNameParam, request.params);
    const safety = await backupsService.restoreBackup(ctx, name);
    return { ok: true, safetyBackup: safety.name };
  });

  app.delete('/api/admin/backups/:name', admin, async (request) => {
    const { name } = v.parse(v.backupNameParam, request.params);
    backupsService.deleteBackup(ctx, name);
    return { ok: true };
  });

  // ---- Live updates ------------------------------------------------------------------
  app.get('/api/events', { config: { allowPendingPasswordChange: true } }, (request, reply: FastifyReply) => {
    const token = request.headers.authorization?.slice(7) ?? '';
    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    stream.write(': connected\n\n');

    const send = (event: ServerEvent) => stream.write(`data: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = ctx.events.subscribe(send);
    // Doubles as the check that ends the stream once a session is revoked.
    const heartbeat = setInterval(() => {
      if (resolveSession(ctx.db, token)) stream.write(': heartbeat\n\n');
      else stream.end();
    }, HEARTBEAT_MS);
    heartbeat.unref();
    const stop = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', stop);
    stream.on('close', stop);
  });

  return app;
}
