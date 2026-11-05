import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';
import type { AppMode, ThemeChoice } from '../shared/bridge';
import { DEFAULT_PORT } from '../shared/constants';

export interface PairedServer {
  host: string;
  port: number;
  fingerprint: string;
  certPem: string;
}

export interface Settings {
  mode: AppMode | null;
  hostPort: number;
  server: PairedServer | null;
  theme: ThemeChoice;
  trayHintShown: boolean;
}

const DEFAULTS: Settings = { mode: null, hostPort: DEFAULT_PORT, server: null, theme: 'system', trayHintShown: false };

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Written to a temporary file first, so that a crash cannot leave half a settings file behind. */
export function saveSettings(settings: Settings): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2));
  renameSync(temporary, path);
}

function sessionPath(): string {
  return join(app.getPath('userData'), 'session.bin');
}

/** The session token, encrypted with the Windows account's key. Kept for this run only if that is unavailable. */
export function loadStoredToken(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable() || !existsSync(sessionPath())) return null;
    return safeStorage.decryptString(readFileSync(sessionPath()));
  } catch {
    return null;
  }
}

export function storeToken(token: string | null): void {
  try {
    if (token && safeStorage.isEncryptionAvailable()) {
      mkdirSync(dirname(sessionPath()), { recursive: true });
      writeFileSync(sessionPath(), safeStorage.encryptString(token));
    } else {
      rmSync(sessionPath(), { force: true });
    }
  } catch {
    // Not being remembered across restarts only means signing in again.
  }
}
