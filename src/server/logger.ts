import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import pino from 'pino';

export type Logger = pino.Logger;

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Paths that could hold credentials. Requests are also logged without their query strings. */
const REDACTED_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'password_hash',
  'token',
  'authorization',
  'cert',
  'key',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.passwordHash',
  '*.token',
  '*.authorization',
  'req.headers.authorization',
  'req.headers.cookie'
];

export function createFileLogger(path: string): Logger {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) {
    renameSync(path, `${path}.1`);
  }
  return pino(
    { level: 'info', redact: { paths: REDACTED_PATHS, censor: '[redacted]' } },
    pino.destination({ dest: path, sync: true })
  );
}

export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}

/** Reduces a link to where it points. Query strings can hold personal tokens. */
export function loggableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid url]';
  }
}
