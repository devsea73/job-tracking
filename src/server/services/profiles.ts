import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { MyProfile, MyProfilesResponse, ProfileRef } from '../../shared/api';
import { avatarColor, avatarInitials } from '../../shared/avatar';
import type { AppContext } from '../context';
import { nowIso, type Db } from '../db/client';
import { applications, profileAvatars, profiles } from '../db/schema';
import { ApiError, conflict, notFound } from '../errors';

type ProfileRow = typeof profiles.$inferSelect;

/**
 * Profile ids and user ids share the colour palette, so an offset keeps someone's first
 * profile from always being the same colour as the person.
 */
const PROFILE_COLOR_OFFSET = 7;

export function toProfileRef(row: { id: number; name: string; isArchived: boolean; avatarVersion: string | null }): ProfileRef {
  return {
    kind: 'profile',
    id: row.id,
    name: row.name,
    isArchived: row.isArchived,
    initials: avatarInitials(row.name),
    color: avatarColor(row.id + PROFILE_COLOR_OFFSET),
    avatarVersion: row.avatarVersion
  };
}

/** Looked up by id AND owner, so someone else's profile is simply "not found". */
function getOwnProfile(db: Db, userId: number, profileId: number): ProfileRow {
  const row = db
    .select()
    .from(profiles)
    .where(and(eq(profiles.id, profileId), eq(profiles.userId, userId)))
    .get();
  if (!row) throw notFound('That profile was not found.');
  return row;
}

export function requireOwnProfile(db: Db, userId: number, profileId: number): ProfileRow {
  return getOwnProfile(db, userId, profileId);
}

/** The profile a new application goes under: yours, and not archived. */
export function requireOwnActiveProfile(db: Db, userId: number, profileId: number): ProfileRow {
  const row = db
    .select()
    .from(profiles)
    .where(and(eq(profiles.id, profileId), eq(profiles.userId, userId)))
    .get();
  if (!row) throw new ApiError(400, 'invalid_profile', 'Choose one of your own profiles.');
  if (row.isArchived) throw new ApiError(400, 'invalid_profile', `The profile "${row.name}" is archived. Choose another one.`);
  return row;
}

function assertNameFree(db: Db, userId: number, name: string, exceptId?: number): void {
  const taken = db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.userId, userId), sql`lower(${profiles.name}) = lower(${name})`))
    .get();
  if (taken && taken.id !== exceptId) throw conflict('profile_name_taken', `You already have a profile called "${name}".`);
}

export function listMyProfiles(db: Db, userId: number): MyProfilesResponse {
  const rows = db
    .select({
      id: profiles.id,
      name: profiles.name,
      isArchived: profiles.isArchived,
      createdAt: profiles.createdAt,
      avatarVersion: profileAvatars.updatedAt,
      applicationCount: sql<number>`(SELECT COUNT(*) FROM applications a WHERE a.profile_id = ${profiles.id})`
    })
    .from(profiles)
    .leftJoin(profileAvatars, eq(profileAvatars.profileId, profiles.id))
    .where(eq(profiles.userId, userId))
    .orderBy(profiles.isArchived, sql`${profiles.name} collate nocase`)
    .all();
  const last = db
    .select({ profileId: applications.profileId })
    .from(applications)
    .innerJoin(profiles, eq(profiles.id, applications.profileId))
    .where(and(eq(applications.userId, userId), eq(profiles.isArchived, false)))
    .orderBy(desc(applications.id))
    .limit(1)
    .get();
  return {
    profiles: rows.map((row): MyProfile => ({ ...toProfileRef(row), applicationCount: row.applicationCount, createdAt: row.createdAt })),
    lastUsedProfileId: last?.profileId ?? null
  };
}

export function createProfile(ctx: AppContext, userId: number, name: string): MyProfile {
  assertNameFree(ctx.db, userId, name);
  const row = ctx.db.insert(profiles).values({ userId, name }).returning().get();
  ctx.events.publish('users_changed');
  return { ...toProfileRef({ ...row, avatarVersion: null }), applicationCount: 0, createdAt: row.createdAt };
}

function activeProfileCount(db: Db, userId: number): number {
  return (
    db
      .select({ total: count() })
      .from(profiles)
      .where(and(eq(profiles.userId, userId), eq(profiles.isArchived, false)))
      .get()?.total ?? 0
  );
}

const LAST_PROFILE_MESSAGE = 'You need at least one active profile, so that you can keep adding jobs. Create another one first.';

export function updateProfile(ctx: AppContext, userId: number, profileId: number, input: { name?: string; isArchived?: boolean }): void {
  const existing = getOwnProfile(ctx.db, userId, profileId);
  if (input.name !== undefined) assertNameFree(ctx.db, userId, input.name, profileId);
  if (input.isArchived === true && !existing.isArchived && activeProfileCount(ctx.db, userId) <= 1) {
    throw new ApiError(400, 'last_profile', LAST_PROFILE_MESSAGE);
  }
  ctx.db
    .update(profiles)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.isArchived !== undefined ? { isArchived: input.isArchived } : {}),
      updatedAt: nowIso()
    })
    .where(eq(profiles.id, profileId))
    .run();
  ctx.events.publish('users_changed');
}

/**
 * A profile that has applications is archived instead of deleted, because its history and
 * statistics are shared with everyone. One that was never used leaves no trace.
 */
export function removeProfile(ctx: AppContext, userId: number, profileId: number): { outcome: 'deleted' | 'archived' } {
  const existing = getOwnProfile(ctx.db, userId, profileId);
  if (!existing.isArchived && activeProfileCount(ctx.db, userId) <= 1) {
    throw new ApiError(400, 'last_profile', LAST_PROFILE_MESSAGE);
  }
  const used = ctx.db.select({ total: count() }).from(applications).where(eq(applications.profileId, profileId)).get();
  if ((used?.total ?? 0) > 0) {
    ctx.db.update(profiles).set({ isArchived: true, updatedAt: nowIso() }).where(eq(profiles.id, profileId)).run();
    ctx.events.publish('users_changed');
    return { outcome: 'archived' };
  }
  ctx.db.delete(profiles).where(eq(profiles.id, profileId)).run();
  ctx.events.publish('users_changed');
  return { outcome: 'deleted' };
}
