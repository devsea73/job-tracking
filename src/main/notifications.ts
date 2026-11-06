import { join } from 'node:path';
import { app, BrowserWindow, screen } from 'electron';
import type { CreateApplicationResponse, JobBrief, MyProfilesResponse, ServerEvent } from '../shared/api';
import { IPC, type ApiCallResult, type NoticeActionResult, type NoticePayload, type NotificationSettings } from '../shared/bridge';

type Api = <T>(method: 'GET' | 'POST', path: string, body?: unknown) => Promise<ApiCallResult<T>>;

interface Options {
  api: Api;
  settings: () => NotificationSettings;
  signedIn: () => boolean;
  /** Brings the main window up, on a job when one is given. */
  open: (jobId?: number) => void;
  /** Puts a link on the clipboard, with the same checks as every other link the app copies. */
  copy: (url: string) => Promise<boolean>;
}

const WIDTH = 384;
const MARGIN = 12;
/** More than this many waiting, and they are summed up in one card instead of shown one by one. */
const SUMMARY_AT = 4;

/**
 * Offers jobs other people applied to, one small card at a time in the corner of the screen.
 * The card asks nothing of the main window, so it works while the app sits in the tray.
 */
export class NotificationCenter {
  private window: BrowserWindow | null = null;
  private ready = false;
  private readonly queue: JobBrief[] = [];
  private current: NoticePayload | null = null;
  /** The card whose Apply was pressed: it stays up to say how that went, whatever else happens. */
  private applyingId: number | null = null;
  private nextId = 1;
  private height = 180;

  constructor(private readonly options: Options) {}

  async handleEvent(event: ServerEvent): Promise<void> {
    // A different database: whatever is waiting may not exist in it.
    if (event.type === 'database_restored') return this.clear();
    if (event.type !== 'application_added' || !event.jobId) return;
    if (!this.options.settings().enabled || !this.options.signedIn()) return;
    const query = event.applicationId ? `?application=${event.applicationId}` : '';
    const result = await this.options.api<JobBrief>('GET', `/api/jobs/${event.jobId}/brief${query}`);
    if (!result.ok || !result.data) return;
    const brief = result.data;
    if (brief.viewerIsAdmin) return;
    // I applied, here or in the main window: nothing about this job is news to me any more.
    if (brief.addedByMe || brief.alreadyApplied) return this.forget(brief.jobId);
    // Only jobs none of my profiles has applied to, found by someone else, each offered once.
    if (this.isKnown(brief.jobId)) return;
    this.queue.push(brief);
    if (!this.current) this.showNext();
  }

  private isKnown(jobId: number): boolean {
    return this.queue.some((brief) => brief.jobId === jobId) || (this.current?.kind === 'job' && this.current.brief.jobId === jobId);
  }

  /** Takes a job out of the queue, and off the screen unless its card is busy applying. */
  private forget(jobId: number): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) if (this.queue[index].jobId === jobId) this.queue.splice(index, 1);
    const showing = this.current;
    if (showing?.kind === 'job' && showing.brief.jobId === jobId && this.applyingId !== showing.id) this.finish();
  }

  /** This card is done: it goes, and the next one follows. */
  private finish(): void {
    this.current = null;
    this.applyingId = null;
    this.window?.hide();
    setTimeout(() => {
      if (!this.current) this.showNext();
    }, 300);
  }

  private showNext(): void {
    if (!this.options.settings().enabled || this.queue.length === 0) {
      this.current = null;
      this.queue.length = 0;
      this.window?.hide();
      return;
    }
    const hideSeconds = this.options.settings().hideSeconds;
    if (this.queue.length >= SUMMARY_AT) {
      const owners = [...new Set(this.queue.map((brief) => brief.owner).filter((name): name is string => !!name))];
      this.current = { id: this.nextId++, kind: 'summary', count: this.queue.length, owners, hideSeconds };
      this.queue.length = 0;
    } else {
      this.current = { id: this.nextId++, kind: 'job', brief: this.queue.shift() as JobBrief, hideSeconds };
    }
    this.present();
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = new BrowserWindow({
      width: WIDTH,
      height: this.height,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Never takes the keyboard away from what the person is doing.
      focusable: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      title: 'Job Tracker notification',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        devTools: !app.isPackaged
      }
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.on('closed', () => {
      if (this.window === win) {
        this.window = null;
        this.ready = false;
      }
    });
    this.ready = false;
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/notification.html`);
    else void win.loadFile(join(__dirname, '../renderer/notification.html'));
    this.window = win;
    return win;
  }

  /** The card page says when it can take a notice. */
  markReady(): void {
    this.ready = true;
    if (this.current) this.present();
  }

  private present(): void {
    const win = this.ensureWindow();
    if (!this.ready || !this.current) return;
    win.webContents.send(IPC.noticeShow, this.current);
    this.place();
    win.showInactive();
  }

  /** The card measures itself, and the window follows, anchored to the bottom-right corner. */
  resize(height: number): void {
    if (!Number.isFinite(height)) return;
    this.height = Math.max(80, Math.min(420, Math.round(height)));
    this.place();
  }

  private place(): void {
    if (!this.window) return;
    const area = screen.getPrimaryDisplay().workArea;
    this.window.setBounds({ x: area.x + area.width - WIDTH - MARGIN, y: area.y + area.height - this.height - MARGIN, width: WIDTH, height: this.height });
  }

  async act(id: number, action: string): Promise<NoticeActionResult> {
    const notice = this.current;
    if (!notice || notice.id !== id) return { ok: false, message: 'This notification has already closed.' };
    if (action === 'apply' && notice.kind === 'job') {
      // Pressed twice: the first press is still on its way.
      if (this.applyingId === id) return { ok: false, message: 'Already applying.' };
      this.applyingId = id;
      return this.apply(notice.brief);
    }
    if (action === 'link') {
      const copied = notice.kind === 'job' && !!notice.brief.url && (await this.options.copy(notice.brief.url));
      return copied ? { ok: true, copied: true } : { ok: false, message: 'This job has no link to copy.' };
    }
    if (action === 'open') this.options.open(notice.kind === 'job' ? notice.brief.jobId : undefined);
    // Ignore, timeout, done, open: this card is finished, and the next one follows.
    this.finish();
    return { ok: true };
  }

  /** Copies the link, then applies with the chosen profile, or the one used last, keeping that link on the application. */
  private async apply(brief: JobBrief): Promise<NoticeActionResult> {
    const copied = !!brief.url && (await this.options.copy(brief.url));
    const profiles = await this.options.api<MyProfilesResponse>('GET', '/api/profiles');
    if (!profiles.ok || !profiles.data) return { ok: false, message: profiles.error?.message ?? 'Could not read your profiles.' };
    const active = profiles.data.profiles.filter((profile) => !profile.isArchived);
    const wanted = this.options.settings().applyProfileId;
    const profile = active.find((item) => item.id === wanted) ?? active.find((item) => item.id === profiles.data?.lastUsedProfileId) ?? active[0];
    if (!profile) return { ok: false, message: 'You have no active profile to apply with.' };
    const result = await this.options.api<CreateApplicationResponse>('POST', `/api/jobs/${brief.jobId}/apply`, { profileId: profile.id, ...(brief.urlId ? { urlId: brief.urlId } : {}) });
    if (!result.ok || !result.data) return { ok: false, message: result.error?.message ?? 'Could not apply.' };
    return { ok: true, profileName: profile.name, already: result.data.outcome === 'already_applied', copied };
  }

  /** Notifications turned off, signed out, another database: whatever is showing or waiting goes away. */
  clear(): void {
    this.queue.length = 0;
    this.current = null;
    this.applyingId = null;
    this.window?.hide();
  }

  destroy(): void {
    this.window?.destroy();
    this.window = null;
  }
}
