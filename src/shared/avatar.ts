/**
 * Initials-based avatars. Colors are derived from the stable user id, so renaming
 * a user keeps their color and every client renders the same avatar.
 */

const AVATAR_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#ea580c',
  '#b45309',
  '#15803d',
  '#0f766e',
  '#0369a1',
  '#4f46e5',
  '#9333ea',
  '#be123c'
] as const;

export function avatarColor(userId: number): string {
  // Knuth multiplicative hash so that consecutive ids get well separated colors.
  const hash = (Math.imul(userId, 2654435761) >>> 0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[hash];
}

/** "Tyler Morgan" → "TM"; "tyler" → "TY"; "john.doe" → "JD". */
export function avatarInitials(username: string, displayName?: string | null): string {
  const source = (displayName ?? '').trim() || username.trim();
  const words = source.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}
