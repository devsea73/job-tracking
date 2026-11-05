import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt, ne } from 'drizzle-orm';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../../shared/constants';
import { nowIso, type Db } from '../db/client';
import { sessions, users } from '../db/schema';

export type UserRow = typeof users.$inferSelect;

export interface ActiveSession {
  user: UserRow;
  tokenHash: string;
  expiresAt: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The token goes to the client and only its hash is kept, so a stolen database cannot be replayed. */
export function createSession(db: Db, userId: number, now = Date.now()): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + SESSION_IDLE_MS).toISOString();
  db.insert(sessions)
    .values({
      tokenHash: hashToken(token),
      userId,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt
    })
    .run();
  return { token, expiresAt };
}

/** Looks up a session and extends its idle window. Disabled accounts and expired sessions resolve to null. */
export function resolveSession(db: Db, token: string, now = Date.now()): ActiveSession | null {
  const tokenHash = hashToken(token);
  const row = db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash))
    .get();
  if (!row) return null;

  const expired = Date.parse(row.session.expiresAt) <= now;
  const pastAbsoluteLimit = Date.parse(row.session.createdAt) + SESSION_ABSOLUTE_MS <= now;
  if (expired || pastAbsoluteLimit || !row.user.isActive) {
    db.delete(sessions).where(eq(sessions.tokenHash, tokenHash)).run();
    return null;
  }

  let expiresAt = row.session.expiresAt;
  // Written at most once a minute: reads should not turn into constant database writes.
  if (now - Date.parse(row.session.lastSeenAt) > 60_000) {
    const limit = Date.parse(row.session.createdAt) + SESSION_ABSOLUTE_MS;
    expiresAt = new Date(Math.min(now + SESSION_IDLE_MS, limit)).toISOString();
    db.update(sessions)
      .set({ lastSeenAt: new Date(now).toISOString(), expiresAt })
      .where(eq(sessions.tokenHash, tokenHash))
      .run();
  }
  return { user: row.user, tokenHash, expiresAt };
}

export function revokeSession(db: Db, tokenHash: string): void {
  db.delete(sessions).where(eq(sessions.tokenHash, tokenHash)).run();
}

export function revokeUserSessions(db: Db, userId: number, exceptTokenHash?: string): void {
  db.delete(sessions)
    .where(exceptTokenHash ? and(eq(sessions.userId, userId), ne(sessions.tokenHash, exceptTokenHash)) : eq(sessions.userId, userId))
    .run();
}

export function purgeExpiredSessions(db: Db): void {
  db.delete(sessions).where(lt(sessions.expiresAt, nowIso())).run();
}
