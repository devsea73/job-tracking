import type { JobBrief, ServerEvent, ServerInfo } from './api';

export type AppMode = 'host' | 'client';

/** Set on each computer: whether new jobs found by others pop up, for how long, and who applies. */
export interface NotificationSettings {
  enabled: boolean;
  hideSeconds: number;
  /** The profile the Apply button uses. Null: the one used last. */
  applyProfileId: number | null;
}

export const NOTIFICATION_HIDE_CHOICES = [5, 10, 15, 30, 60] as const;

export type NoticePayload =
  | { id: number; kind: 'job'; brief: JobBrief; hideSeconds: number }
  | { id: number; kind: 'summary'; count: number; owners: string[]; hideSeconds: number };

export type NoticeAction = 'apply' | 'ignore' | 'timeout' | 'open' | 'link' | 'done';

export interface NoticeActionResult {
  ok: boolean;
  message?: string;
  profileName?: string;
  already?: boolean;
  copied?: boolean;
}
export type ThemeChoice = 'system' | 'light' | 'dark';

/** Set on each computer, by an administrator: a full copy of the database saved to a folder here every week. */
export interface AutoBackupSettings {
  enabled: boolean;
  folder: string | null;
  lastSavedAt: string | null;
  lastFile: string | null;
  lastBytes: number | null;
  /** Why the last attempt failed. Cleared by the next one that works. */
  lastError: string | null;
  lastAttemptAt: string | null;
}

export interface AutoBackupState extends AutoBackupSettings {
  /** When the next copy is due. Null when switched off or no folder is chosen. */
  nextDueAt: string | null;
  running: boolean;
}

export type ConnectionStatus =
  /** No mode chosen yet, or client mode without a paired server. */
  | 'unconfigured'
  /** The host's server is starting, or the first connection is being made. */
  | 'connecting'
  | 'connected'
  /** The host could not be reached: it is off, or the network is down. */
  | 'offline'
  /** Something answered at the address, but with a different certificate than the paired one. */
  | 'cert_mismatch'
  /** This computer's own server could not start. */
  | 'host_failed';

export interface BridgeState {
  version: string;
  mode: AppMode | null;
  connection: ConnectionStatus;
  connectionMessage: string | null;
  /** The server this app talks to. */
  server: { address: string; port: number; fingerprint: string } | null;
  /** Filled in when this computer is the host. */
  host: { port: number; addresses: string[]; fingerprint: string; dataDir: string } | null;
  signedIn: boolean;
  theme: ThemeChoice;
  notifications: NotificationSettings;
  autoBackup: AutoBackupState;
}

export interface ApiCallResult<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

export interface ProbeResult {
  address: string;
  port: number;
  fingerprint: string;
  info: ServerInfo;
}

export interface JobTrackerBridge {
  getState(): Promise<BridgeState>;
  onStateChange(listener: (state: BridgeState) => void): () => void;
  onServerEvent(listener: (event: ServerEvent) => void): () => void;

  /** Makes this computer the host. */
  startHost(port?: number): Promise<BridgeState>;
  /** Connects to a host to read its certificate, without trusting it yet. */
  probeServer(address: string): Promise<ApiCallResult<ProbeResult>>;
  /** Trusts the host with this exact certificate fingerprint from now on. */
  pairServer(address: string, fingerprint: string): Promise<ApiCallResult<BridgeState>>;
  /** Forgets the mode and server so that the first-run screen shows again. */
  resetConnection(): Promise<BridgeState>;
  retryConnection(): Promise<BridgeState>;

  /** Calls the LAN server. The session token stays in the main process, out of reach of page code. */
  api<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiCallResult<T>>;

  setTheme(theme: ThemeChoice): Promise<void>;
  setNotifications(changes: Partial<NotificationSettings>): Promise<NotificationSettings>;
  /** The main window: a notification asked to show this job. */
  onOpenJob(listener: (jobId: number) => void): () => void;

  /** The notification card's own page. */
  onNotice(listener: (notice: NoticePayload) => void): () => void;
  noticeReady(): void;
  noticeAction(id: number, action: NoticeAction): Promise<NoticeActionResult>;
  noticeResize(height: number): void;
  /** Copies a link to the clipboard: links in the app are copied, never opened. Only http and https links. */
  copyLink(url: string): Promise<boolean>;

  /** Host only. Saves a backup to a file the person chooses. */
  exportBackup(name: string): Promise<ApiCallResult<{ path: string }>>;
  /** Host only. Copies a chosen file in among the backups and returns its name. */
  importBackup(): Promise<ApiCallResult<{ name: string }>>;
  openDataFolder(): Promise<void>;

  /** Administrators. Asks for the folder weekly copies of the database go to, on this computer. */
  chooseBackupFolder(): Promise<AutoBackupState>;
  /** Administrators. Turns the weekly copy on or off. Turned on, a copy is saved at once if one is due. */
  setAutoBackup(enabled: boolean): Promise<AutoBackupState>;
  /** Administrators. Saves a copy to the chosen folder now, whenever the last one was. */
  saveBackupNow(): Promise<ApiCallResult<AutoBackupState>>;
  openBackupFolder(): Promise<void>;
}

export const IPC = {
  getState: 'state:get',
  stateChanged: 'state:changed',
  serverEvent: 'server:event',
  startHost: 'host:start',
  probeServer: 'client:probe',
  pairServer: 'client:pair',
  resetConnection: 'connection:reset',
  retryConnection: 'connection:retry',
  api: 'api:call',
  setTheme: 'theme:set',
  setNotifications: 'notifications:set',
  openJob: 'window:open-job',
  noticeShow: 'notice:show',
  noticeReady: 'notice:ready',
  noticeAction: 'notice:action',
  noticeResize: 'notice:resize',
  copyLink: 'clipboard:copy-link',
  exportBackup: 'backup:export',
  importBackup: 'backup:import',
  openDataFolder: 'host:open-data-folder',
  chooseBackupFolder: 'auto-backup:choose-folder',
  setAutoBackup: 'auto-backup:set',
  saveBackupNow: 'auto-backup:save-now',
  openBackupFolder: 'auto-backup:open-folder'
} as const;
