import { eq } from 'drizzle-orm';
import { AVATAR_MAX_BYTES } from '../../shared/constants';
import type { AppContext } from '../context';
import { nowIso } from '../db/client';
import { profileAvatars, profiles, userAvatars, users } from '../db/schema';
import { ApiError, notFound } from '../errors';
import { requireOwnProfile } from './profiles';

const DATA_URL = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/]+={0,2})$/i;

/**
 * The type comes from the file's own first bytes, never from what the client claims. This
 * keeps out SVG in particular, which can carry scripts, however it is labelled.
 */
function sniffImageType(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function decodeAvatar(image: string): { mime: string; data: Buffer } {
  const match = image.match(DATA_URL);
  if (!match) throw new ApiError(400, 'invalid_image', 'That file could not be read as an image.');
  const data = Buffer.from(match[1], 'base64');
  if (data.length > AVATAR_MAX_BYTES) throw new ApiError(400, 'invalid_image', 'That image is too large.');
  const mime = sniffImageType(data);
  if (!mime) throw new ApiError(400, 'invalid_image', 'Use a PNG, JPG or WebP image.');
  return { mime, data };
}

function toDataUrl(row: { mime: string; data: Buffer }): { image: string } {
  return { image: `data:${row.mime};base64,${row.data.toString('base64')}` };
}

export function setUserAvatar(ctx: AppContext, userId: number, image: string): { avatarVersion: string } {
  const { mime, data } = decodeAvatar(image);
  const updatedAt = nowIso();
  ctx.db
    .insert(userAvatars)
    .values({ userId, mime, data, updatedAt })
    .onConflictDoUpdate({ target: userAvatars.userId, set: { mime, data, updatedAt } })
    .run();
  ctx.events.publish('users_changed');
  return { avatarVersion: updatedAt };
}

export function removeUserAvatar(ctx: AppContext, userId: number): void {
  const exists = ctx.db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!exists) throw notFound('That user no longer exists.');
  ctx.db.delete(userAvatars).where(eq(userAvatars.userId, userId)).run();
  ctx.events.publish('users_changed');
}

export function getUserAvatar(ctx: AppContext, userId: number): { image: string } {
  const row = ctx.db.select({ mime: userAvatars.mime, data: userAvatars.data }).from(userAvatars).where(eq(userAvatars.userId, userId)).get();
  if (!row) throw notFound('No image.');
  return toDataUrl(row);
}

export function setProfileAvatar(ctx: AppContext, userId: number, profileId: number, image: string): { avatarVersion: string } {
  requireOwnProfile(ctx.db, userId, profileId);
  const { mime, data } = decodeAvatar(image);
  const updatedAt = nowIso();
  ctx.db
    .insert(profileAvatars)
    .values({ profileId, mime, data, updatedAt })
    .onConflictDoUpdate({ target: profileAvatars.profileId, set: { mime, data, updatedAt } })
    .run();
  ctx.events.publish('users_changed');
  return { avatarVersion: updatedAt };
}

export function removeOwnProfileAvatar(ctx: AppContext, userId: number, profileId: number): void {
  requireOwnProfile(ctx.db, userId, profileId);
  ctx.db.delete(profileAvatars).where(eq(profileAvatars.profileId, profileId)).run();
  ctx.events.publish('users_changed');
}

/** For the administrator, who can take down an inappropriate image on any profile. */
export function removeAnyProfileAvatar(ctx: AppContext, profileId: number): void {
  const exists = ctx.db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, profileId)).get();
  if (!exists) throw notFound('That profile no longer exists.');
  ctx.db.delete(profileAvatars).where(eq(profileAvatars.profileId, profileId)).run();
  ctx.events.publish('users_changed');
}

export function getProfileAvatar(ctx: AppContext, profileId: number): { image: string } {
  const row = ctx.db.select({ mime: profileAvatars.mime, data: profileAvatars.data }).from(profileAvatars).where(eq(profileAvatars.profileId, profileId)).get();
  if (!row) throw notFound('No image.');
  return toDataUrl(row);
}
