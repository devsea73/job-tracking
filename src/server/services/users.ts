import { count, desc, eq, sql } from 'drizzle-orm';
import type { AdminUser, CurrentUser, LoginResponse, UserRef } from '../../shared/api';
import { avatarColor, avatarInitials } from '../../shared/avatar';
import { createSession, revokeUserSessions, type ActiveSession, type UserRow } from '../auth/sessions';
import type { AppContext } from '../context';
import { nowIso, type Db } from '../db/client';
import { applications, profiles, userAvatars, users } from '../db/schema';
import { ApiError, conflict, forbidden, notFound } from '../errors';

export const INITIAL_ADMIN_USERNAME = 'admin';
export const INITIAL_ADMIN_PASSWORD = 'admin';

/** First launch only: the password must be changed before anything else can be done. */
export async function ensureInitialAdmin(ctx: AppContext): Promise<void> {
  const existing = ctx.db.select({ total: count() }).from(users).get();
  if ((existing?.total ?? 0) > 0) return;
  const passwordHash = await ctx.hasher.hash(INITIAL_ADMIN_PASSWORD);
  const admin = ctx.db
    .insert(users)
    .values({ username: INITIAL_ADMIN_USERNAME, passwordHash, role: 'admin', mustChangePassword: true })
    .onConflictDoNothing()
    .returning({ id: users.id })
    .get();
  if (admin) ctx.db.insert(profiles).values({ userId: admin.id, name: INITIAL_ADMIN_USERNAME }).run();
  ctx.logger.info('Created the initial administrator account');
}

function avatarVersionOf(db: Db, userId: number): string | null {
  return db.select({ updatedAt: userAvatars.updatedAt }).from(userAvatars).where(eq(userAvatars.userId, userId)).get()?.updatedAt ?? null;
}

export function toCurrentUser(db: Db, user: UserRow): CurrentUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    initials: avatarInitials(user.username, user.displayName),
    color: avatarColor(user.id),
    avatarVersion: avatarVersionOf(db, user.id)
  };
}

export function toUserRef(user: { id: number; username: string; displayName: string | null; avatarVersion: string | null }): UserRef {
  return {
    kind: 'user',
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    initials: avatarInitials(user.username, user.displayName),
    color: avatarColor(user.id),
    avatarVersion: user.avatarVersion
  };
}

function findByUsername(db: Db, username: string): UserRow | undefined {
  return db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`)
    .get();
}

// Verified against when the username does not exist, so that response time gives nothing away.
let decoyHash: Promise<string> | null = null;

export async function login(ctx: AppContext, address: string, username: string, password: string): Promise<LoginResponse> {
  const retryAfter = ctx.limiter.retryAfter(address, username);
  if (retryAfter !== null) {
    throw new ApiError(429, 'too_many_attempts', `Too many failed sign-ins. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`, { retryAfter });
  }
  const user = findByUsername(ctx.db, username);
  decoyHash ??= ctx.hasher.hash('decoy-password-for-timing');
  const valid = await ctx.hasher.verify(user?.passwordHash ?? (await decoyHash), password);
  if (!user || !valid || !user.isActive) {
    ctx.limiter.recordFailure(address, username);
    ctx.logger.warn({ address }, 'Failed sign-in');
    throw new ApiError(401, 'invalid_credentials', 'Incorrect username or password, or the account is disabled.');
  }
  ctx.limiter.recordSuccess(address, username);
  const session = createSession(ctx.db, user.id);
  return { token: session.token, expiresAt: session.expiresAt, user: toCurrentUser(ctx.db, user) };
}

export async function changePassword(ctx: AppContext, session: ActiveSession, currentPassword: string, newPassword: string): Promise<CurrentUser> {
  const { user } = session;
  if (!(await ctx.hasher.verify(user.passwordHash, currentPassword))) {
    throw new ApiError(400, 'wrong_password', 'Your current password is not correct.');
  }
  if (await ctx.hasher.verify(user.passwordHash, newPassword)) {
    throw new ApiError(400, 'password_unchanged', 'Choose a password that is different from your current one.');
  }
  const passwordHash = await ctx.hasher.hash(newPassword);
  const updated = ctx.db
    .update(users)
    .set({ passwordHash, mustChangePassword: false, updatedAt: nowIso() })
    .where(eq(users.id, user.id))
    .returning()
    .get();
  // Anywhere else this account was signed in now has to prove the new password.
  revokeUserSessions(ctx.db, user.id, session.tokenHash);
  return toCurrentUser(ctx.db, updated);
}

function toAdminUser(row: UserRow, applicationCount: number, avatarVersion: string | null): AdminUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    isActive: row.isActive,
    mustChangePassword: row.mustChangePassword,
    applicationCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    initials: avatarInitials(row.username, row.displayName),
    color: avatarColor(row.id),
    avatarVersion
  };
}

export function listUsers(db: Db): AdminUser[] {
  const counts = new Map(
    db
      .select({ userId: applications.userId, total: count() })
      .from(applications)
      .groupBy(applications.userId)
      .all()
      .map((row) => [row.userId, row.total])
  );
  const avatars = new Map(
    db
      .select({ userId: userAvatars.userId, updatedAt: userAvatars.updatedAt })
      .from(userAvatars)
      .all()
      .map((row) => [row.userId, row.updatedAt])
  );
  return db
    .select()
    .from(users)
    .orderBy(desc(sql`${users.role} = 'admin'`), sql`${users.username} collate nocase`)
    .all()
    .map((row) => toAdminUser(row, counts.get(row.id) ?? 0, avatars.get(row.id) ?? null));
}

function assertUsernameFree(db: Db, username: string, exceptId?: number): void {
  const taken = findByUsername(db, username);
  if (taken && taken.id !== exceptId) throw conflict('username_taken', `The username "${username}" is already in use.`);
}

export async function createUser(
  ctx: AppContext,
  input: { username: string; password: string; displayName?: string | null; mustChangePassword?: boolean }
): Promise<AdminUser> {
  assertUsernameFree(ctx.db, input.username);
  const passwordHash = await ctx.hasher.hash(input.password);
  // The hash takes time: check again so two admins' requests cannot collide on the unique index.
  assertUsernameFree(ctx.db, input.username);
  // Everyone starts with one profile, named after them, so adding a job always has one to offer.
  const row = ctx.handle.sqlite.transaction(() => {
    const created = ctx.db
      .insert(users)
      .values({
        username: input.username,
        displayName: input.displayName?.trim() || null,
        passwordHash,
        mustChangePassword: input.mustChangePassword ?? false
      })
      .returning()
      .get();
    ctx.db.insert(profiles).values({ userId: created.id, name: created.displayName ?? created.username }).run();
    return created;
  })();
  ctx.events.publish('users_changed');
  return toAdminUser(row, 0, null);
}

function getUserOr404(db: Db, id: number): UserRow {
  const user = db.select().from(users).where(eq(users.id, id)).get();
  if (!user) throw notFound('That user no longer exists.');
  return user;
}

export function updateUser(
  ctx: AppContext,
  actor: UserRow,
  id: number,
  input: { username?: string; displayName?: string | null; isActive?: boolean }
): AdminUser {
  const target = getUserOr404(ctx.db, id);
  if (input.isActive === false && target.id === actor.id) {
    throw forbidden('You cannot disable your own account.');
  }
  if (input.isActive === false && target.role === 'admin') {
    throw forbidden('Administrator accounts cannot be disabled.');
  }
  if (input.username) assertUsernameFree(ctx.db, input.username, id);
  const row = ctx.db
    .update(users)
    .set({
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName?.trim() || null } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: nowIso()
    })
    .where(eq(users.id, id))
    .returning()
    .get();
  if (input.isActive === false) revokeUserSessions(ctx.db, id);
  ctx.events.publish('users_changed');
  const total = ctx.db.select({ total: count() }).from(applications).where(eq(applications.userId, id)).get();
  return toAdminUser(row, total?.total ?? 0, avatarVersionOf(ctx.db, id));
}

/** A reset password is temporary by definition: the user must replace it, and existing sessions end. */
export async function resetPassword(ctx: AppContext, id: number, password: string): Promise<void> {
  getUserOr404(ctx.db, id);
  const passwordHash = await ctx.hasher.hash(password);
  ctx.db.update(users).set({ passwordHash, mustChangePassword: true, updatedAt: nowIso() }).where(eq(users.id, id)).run();
  revokeUserSessions(ctx.db, id);
}

/**
 * Removes the account together with its profiles, applications, memos, interviews and avatars.
 * Shared job listings stay, since other users may rely on them.
 */
export function deleteUser(ctx: AppContext, actor: UserRow, id: number): void {
  const target = getUserOr404(ctx.db, id);
  if (target.id === actor.id) throw forbidden('You cannot delete your own account.');
  if (target.role === 'admin') throw forbidden('Administrator accounts cannot be deleted.');
  ctx.db.delete(users).where(eq(users.id, id)).run();
  ctx.events.publish('users_changed');
  ctx.events.publish('applications_changed');
}
