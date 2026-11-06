import { closeSync, existsSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AutoBackupSettings, AutoBackupState } from '../shared/bridge';

/** A full copy every week, counted from the last one that worked. */
export const BACKUP_INTERVAL_MS = 7 * 86_400_000;
/** After a failure (the host off, the folder's drive unplugged), tried again this much later. */
export const RETRY_AFTER_MS = 3_600_000;

export const DEFAULT_AUTO_BACKUP: AutoBackupSettings = { enabled: false, folder: null, lastSavedAt: null, lastFile: null, lastBytes: null, lastError: null, lastAttemptAt: null };

export interface AutoBackupDeps {
  get(): AutoBackupSettings;
  save(next: AutoBackupSettings): void;
  /** The signed-in person's role. Null when nobody is signed in or the host cannot be reached right now. */
  role(): Promise<'admin' | 'user' | null>;
  /** Fetches the whole database from the host into this file. */
  download(destination: string): Promise<{ bytes: number }>;
  /** Told when a copy starts or ends, so the screen can show it. */
  changed?: () => void;
  now?: () => Date;
}

export type BackupOutcome = { saved: true; file: string } | { saved: false; reason: 'off' | 'not_due' | 'waiting' | 'busy' | 'failed'; message?: string };

const SQLITE_HEADER = 'SQLite format 3\u0000';

/** Day and minute in this computer's time, for a file name that sorts by date: 2026-11-05-2130. */
function fileStamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

function isSqliteFile(path: string): boolean {
  const descriptor = openSync(path, 'r');
  try {
    const header = Buffer.alloc(16);
    return readSync(descriptor, header, 0, 16, 0) === 16 && header.toString('latin1') === SQLITE_HEADER;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Saves a full copy of the shared database to a folder on this computer once a week, for an
 * administrator. It runs whenever the app is running (it stays in the tray when closed), and a
 * week missed while the computer was off is made up at the next start. Earlier copies are never
 * touched: the folder keeps every week's file.
 */
export class AutoBackup {
  private running: Promise<BackupOutcome> | null = null;

  constructor(private readonly deps: AutoBackupDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  state(): AutoBackupState {
    const settings = this.deps.get();
    return { ...settings, nextDueAt: this.nextDueAt(settings), running: this.running !== null };
  }

  private nextDueAt(settings: AutoBackupSettings): string | null {
    if (!settings.enabled || !settings.folder) return null;
    if (!settings.lastSavedAt) return settings.lastAttemptAt ?? this.now().toISOString();
    return new Date(Date.parse(settings.lastSavedAt) + BACKUP_INTERVAL_MS).toISOString();
  }

  /** Saves a copy if one is due. Safe to call as often as liked. */
  async saveIfDue(): Promise<BackupOutcome> {
    const settings = this.deps.get();
    if (!settings.enabled || !settings.folder) return { saved: false, reason: 'off' };
    const now = this.now().getTime();
    if (settings.lastSavedAt && now - Date.parse(settings.lastSavedAt) < BACKUP_INTERVAL_MS) return { saved: false, reason: 'not_due' };
    if (settings.lastError && settings.lastAttemptAt && now - Date.parse(settings.lastAttemptAt) < RETRY_AFTER_MS) return { saved: false, reason: 'waiting' };
    return this.save(false);
  }

  /** Saves a copy now, whenever the last one was. */
  saveNow(): Promise<BackupOutcome> {
    return this.save(true);
  }

  private save(asked: boolean): Promise<BackupOutcome> {
    if (this.running) return asked ? this.running : Promise.resolve({ saved: false, reason: 'busy' });
    this.running = this.run(asked).finally(() => {
      this.running = null;
      this.deps.changed?.();
    });
    this.deps.changed?.();
    return this.running;
  }

  /** Remembers how it went. Settings that cannot be written never undo a copy that was saved. */
  private record(next: AutoBackupSettings): void {
    try {
      this.deps.save(next);
    } catch {
      // Kept in memory only; the next attempt writes it again.
    }
  }

  private async run(asked: boolean): Promise<BackupOutcome> {
    const settings = this.deps.get();
    const fail = (message: string): BackupOutcome => {
      this.record({ ...this.deps.get(), lastError: message, lastAttemptAt: this.now().toISOString() });
      return { saved: false, reason: 'failed', message };
    };
    if (!settings.folder) return fail('Choose a folder first.');
    try {
      if (!statSync(settings.folder).isDirectory()) return fail(`${settings.folder} is not a folder.`);
    } catch {
      return fail(`The folder ${settings.folder} cannot be reached. Is its drive connected?`);
    }

    const role = await this.deps.role();
    // Nobody signed in, or the host is off: tried again later without counting it as a failure,
    // unless someone pressed the button and is waiting for an answer.
    if (role === null) return asked ? fail('Sign in as an administrator, with the host running, to save a copy.') : { saved: false, reason: 'waiting' };
    if (role !== 'admin') return fail('Only an administrator can save the database.');

    const at = this.now();
    let name = `job-tracker-backup-${fileStamp(at)}.sqlite`;
    for (let copy = 2; existsSync(join(settings.folder, name)); copy += 1) name = `job-tracker-backup-${fileStamp(at)}-${copy}.sqlite`;
    const destination = join(settings.folder, name);
    const discard = () => {
      try {
        rmSync(destination, { force: true });
      } catch {
        // Held open by something else: an unfinished copy is reported as a failure all the same.
      }
    };
    let bytes: number;
    try {
      ({ bytes } = await this.deps.download(destination));
      if (!isSqliteFile(destination)) {
        discard();
        return fail('The host sent something that is not a database. Nothing was kept.');
      }
    } catch (error) {
      discard();
      return fail(error instanceof Error ? error.message : 'The copy could not be saved.');
    }
    // The copy is complete and checked: nothing from here on removes it.
    this.record({ ...this.deps.get(), lastSavedAt: at.toISOString(), lastFile: name, lastBytes: bytes, lastError: null, lastAttemptAt: at.toISOString() });
    return { saved: true, file: destination };
  }
}
