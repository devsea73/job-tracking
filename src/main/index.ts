import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import type { ServerEvent } from '../shared/api';
import { IPC, NOTIFICATION_HIDE_CHOICES, type ApiCallResult, type AutoBackupState, type BridgeState, type ConnectionStatus, type NoticeAction, type NotificationSettings, type ProbeResult, type ThemeChoice } from '../shared/bridge';
import { AutoBackup } from './auto-backup';
import { Connection } from './connection';
import { HostServer, type HostReady } from './host-server';
import { probeServer } from './lan-client';
import { NotificationCenter } from './notifications';
import { loadSettings, loadStoredToken, saveSettings, storeToken, type Settings } from './settings';

// A separate profile per instance lets several copies run side by side, for trying out
// host and client on one computer.
if (process.env.JOB_TRACKER_USER_DATA) app.setPath('userData', process.env.JOB_TRACKER_USER_DATA);

let settings: Settings;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let hostInfo: HostReady | null = null;
let status: ConnectionStatus = 'unconfigured';
let statusMessage: string | null = null;

function currentState(): BridgeState {
  return {
    version: app.getVersion(),
    mode: settings.mode,
    connection: status,
    connectionMessage: statusMessage,
    server: settings.server ? { address: settings.server.host, port: settings.server.port, fingerprint: settings.server.fingerprint } : null,
    host: hostInfo ? { port: hostInfo.port, addresses: hostInfo.addresses, fingerprint: hostInfo.fingerprint, dataDir: hostInfo.dataDir } : null,
    signedIn: connection.signedIn,
    theme: settings.theme,
    notifications: settings.notifications,
    autoBackup: autoBackup.state()
  };
}

function broadcastState(): void {
  window?.webContents.send(IPC.stateChanged, currentState());
}

const connection = new Connection({
  onStatus(next, message) {
    status = next;
    statusMessage = message;
    broadcastState();
    if (next === 'connected') scheduleBackupCheck();
  },
  onEvent(event: ServerEvent) {
    window?.webContents.send(IPC.serverEvent, event);
    void notifications.handleEvent(event).catch(() => undefined);
  },
  onSessionEnded() {
    storeToken(null);
    notifications.clear();
    broadcastState();
  }
});

const notifications = new NotificationCenter({
  api: <T,>(method: 'GET' | 'POST', path: string, body?: unknown) => connection.api(method, path, body, () => undefined) as Promise<ApiCallResult<T>>,
  settings: () => settings.notifications,
  signedIn: () => connection.signedIn,
  open: (jobId) => {
    showWindow();
    if (jobId !== undefined) {
      // A window opened just now loads first; the job opens once its page can listen.
      const send = () => window?.webContents.send(IPC.openJob, jobId);
      if (window?.webContents.isLoading()) window.webContents.once('did-finish-load', () => setTimeout(send, 400));
      else send();
    }
  },
  copy: (url) => copyLink(url)
});

const autoBackup = new AutoBackup({
  get: () => settings.autoBackup,
  save: (next) => {
    settings = { ...settings, autoBackup: next };
    try {
      saveSettings(settings);
    } catch {
      // Remembered for this run. The copy itself is already safe in its folder.
    }
    broadcastState();
  },
  role: async () => {
    if (!connection.signedIn) return null;
    const me = await connection.api('GET', '/api/auth/me', undefined, () => undefined);
    return me.ok ? (me.data as { role: 'admin' | 'user' }).role : null;
  },
  download: (destination) => connection.download('/api/admin/database/download', destination),
  changed: () => broadcastState()
});

let backupCheck: NodeJS.Timeout | null = null;

/** Looks shortly after the host is reached or someone signs in: a missed week is made up then. */
function scheduleBackupCheck(): void {
  if (backupCheck) clearTimeout(backupCheck);
  backupCheck = setTimeout(() => {
    backupCheck = null;
    void autoBackup.saveIfDue();
  }, 10_000);
}

function setNotifications(changes: Partial<NotificationSettings>): NotificationSettings {
  const next = { ...settings.notifications };
  if (typeof changes.enabled === 'boolean') next.enabled = changes.enabled;
  if (typeof changes.hideSeconds === 'number' && (NOTIFICATION_HIDE_CHOICES as readonly number[]).includes(changes.hideSeconds)) next.hideSeconds = changes.hideSeconds;
  if (changes.applyProfileId === null || (typeof changes.applyProfileId === 'number' && Number.isInteger(changes.applyProfileId) && changes.applyProfileId > 0)) next.applyProfileId = changes.applyProfileId;
  settings = { ...settings, notifications: next };
  saveSettings(settings);
  if (!next.enabled) notifications.clear();
  updateTrayMenu();
  broadcastState();
  return next;
}

/** When the server was last restarted after a crash: one that crashes again soon after is left stopped. */
let lastAutomaticRestart = 0;
const RESTART_AGAIN_AFTER_MS = 10 * 60_000;

const hostServer = new HostServer((message) => {
  hostInfo = null;
  status = 'host_failed';
  connection.disconnect();
  // A crashed server gets one automatic restart, so people on other computers can keep working.
  // Crashing again within minutes means something is wrong that a restart will not fix.
  if (Date.now() - lastAutomaticRestart < RESTART_AGAIN_AFTER_MS) {
    statusMessage = `${message} It also stopped shortly after the last restart, so it was left stopped. Details are in its log; press Retry to start it again.`;
    broadcastState();
    return;
  }
  statusMessage = message;
  broadcastState();
  setTimeout(() => {
    if (settings.mode === 'host' && !hostServer.running && !quitting) {
      lastAutomaticRestart = Date.now();
      void startHost(settings.hostPort);
    }
  }, 3_000);
});

async function startHost(port: number): Promise<void> {
  connection.disconnect();
  status = 'connecting';
  statusMessage = null;
  broadcastState();
  try {
    await hostServer.stop();
    const ready = await hostServer.start(port);
    hostInfo = ready;
    settings = {
      ...settings,
      mode: 'host',
      hostPort: port,
      server: { host: '127.0.0.1', port: ready.port, fingerprint: ready.fingerprint, certPem: ready.certPem }
    };
    saveSettings(settings);
    connection.connect(settings.server as NonNullable<Settings['server']>, loadStoredToken());
    updateTrayMenu();
  } catch (error) {
    hostInfo = null;
    settings = { ...settings, mode: 'host', hostPort: port };
    saveSettings(settings);
    status = 'host_failed';
    statusMessage = error instanceof Error ? error.message : 'The server could not start.';
  }
  broadcastState();
}

function iconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'build', 'icon.png');
}

/**
 * The app lives in the tray, not the taskbar: closing the window keeps it running, so the host
 * stays reachable and new jobs found by others can still pop up.
 */
function ensureTray(): void {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
  tray.on('click', () => showWindow());
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const hosting = settings.mode === 'host';
  tray.setToolTip(hosting ? 'Job Tracker host' : 'Job Tracker');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Job Tracker', click: () => showWindow() },
      { label: 'Notifications', type: 'checkbox', checked: settings.notifications.enabled, click: (item) => setNotifications({ enabled: item.checked }) },
      { type: 'separator' },
      {
        label: hosting ? 'Stop server and quit' : 'Quit Job Tracker',
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
}

function showWindow(): void {
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Links are copied for the person to paste where they like, never opened from the app. */
async function copyLink(url: string): Promise<boolean> {
  if (url.length > 4_000 || !isSafeExternalUrl(url)) return false;
  await clipboard.writeText(url);
  return true;
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f7f7f8',
    title: 'Job Tracker',
    icon: iconPath(),
    // No skipTaskbar: Windows shows a window without a taskbar button on every virtual desktop.
    // Closed, the window is hidden, so only the tray icon shows that the app is running.
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // Keeps compiled JavaScript on disk, so that later starts skip compiling it again.
      v8CacheOptions: 'bypassHeatCheck',
      devTools: !app.isPackaged
    }
  });
  window = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (window === win) window = null;
  });
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (!settings.trayHintShown) {
      settings = { ...settings, trayHintShown: true };
      saveSettings(settings);
      tray?.displayBalloon({
        title: 'Job Tracker is still running',
        content: settings.mode === 'host' ? 'The server stays available to the other computers. Right-click the tray icon to quit.' : 'New jobs found by others still pop up. Right-click the tray icon to quit.'
      });
    }
  });

  // This window only ever shows the app itself. A link that would leave it is copied instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void copyLink(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env.ELECTRON_RENDERER_URL;
    if (devServer && url.startsWith(devServer)) return;
    event.preventDefault();
    void copyLink(url);
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

/** Only pages this app loaded may use the bridge. */
function fromApp(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  const devServer = process.env.ELECTRON_RENDERER_URL;
  return url.startsWith('file://') || (!!devServer && url.startsWith(devServer));
}

function handle<Args extends unknown[], Result>(channel: string, listener: (...args: Args) => Promise<Result> | Result): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error('Refused a call from an unknown page.');
    return listener(...(args as Args));
  });
}

function errorResult<T>(error: unknown, code = 'error'): ApiCallResult<T> {
  return { ok: false, status: 0, error: { code, message: error instanceof Error ? error.message : 'Something went wrong.' } };
}

function registerIpc(): void {
  handle(IPC.getState, () => currentState());

  handle(IPC.startHost, async (port?: number) => {
    const chosen = typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : settings.hostPort;
    await startHost(chosen);
    return currentState();
  });

  handle(IPC.probeServer, async (address: string): Promise<ApiCallResult<ProbeResult>> => {
    try {
      const found = await probeServer(String(address));
      return { ok: true, status: 200, data: { address: found.host, port: found.port, fingerprint: found.fingerprint, info: found.info } };
    } catch (error) {
      return errorResult(error, 'unreachable');
    }
  });

  handle(IPC.pairServer, async (address: string, fingerprint: string): Promise<ApiCallResult<BridgeState>> => {
    try {
      // Read again and compare: what gets pinned is exactly what the person confirmed.
      const found = await probeServer(String(address));
      if (found.fingerprint !== fingerprint) return errorResult(new Error('The certificate changed while pairing. Please check the address and try again.'), 'cert_mismatch');
      const sameServer = settings.server?.fingerprint === found.fingerprint;
      await hostServer.stop();
      hostInfo = null;
      settings = { ...settings, mode: 'client', server: { host: found.host, port: found.port, fingerprint: found.fingerprint, certPem: found.certPem } };
      saveSettings(settings);
      updateTrayMenu();
      if (!sameServer) storeToken(null);
      connection.connect(settings.server as NonNullable<Settings['server']>, sameServer ? loadStoredToken() : null);
      return { ok: true, status: 200, data: currentState() };
    } catch (error) {
      return errorResult(error, 'unreachable');
    }
  });

  handle(IPC.resetConnection, async () => {
    connection.disconnect();
    await hostServer.stop();
    hostInfo = null;
    storeToken(null);
    settings = { ...settings, mode: null, server: null };
    saveSettings(settings);
    updateTrayMenu();
    status = 'unconfigured';
    statusMessage = null;
    broadcastState();
    return currentState();
  });

  handle(IPC.retryConnection, async () => {
    if (settings.mode === 'host' && !hostServer.running) await startHost(settings.hostPort);
    else connection.retryNow();
    return currentState();
  });

  handle(IPC.api, async (method: string, path: string, body?: unknown) => {
    const result = await connection.api(String(method), String(path), body, (token) => {
      storeToken(token);
      broadcastState();
      if (token) scheduleBackupCheck();
      // Signed out, or in as someone else: the last person's cards are not for them.
      notifications.clear();
    });
    return result;
  });

  handle(IPC.setTheme, (theme: ThemeChoice) => {
    if (theme !== 'system' && theme !== 'light' && theme !== 'dark') return;
    settings = { ...settings, theme };
    saveSettings(settings);
    nativeTheme.themeSource = theme;
    broadcastState();
  });

  handle(IPC.setNotifications, (changes: Partial<NotificationSettings>) => setNotifications(changes && typeof changes === 'object' ? changes : {}));

  handle(IPC.noticeAction, (id: number, action: NoticeAction) => notifications.act(Number(id), String(action)));
  ipcMain.on(IPC.noticeReady, (event) => {
    if (fromApp(event as unknown as IpcMainInvokeEvent)) notifications.markReady();
  });
  ipcMain.on(IPC.noticeResize, (event, height: number) => {
    if (fromApp(event as unknown as IpcMainInvokeEvent)) notifications.resize(Number(height));
  });

  handle(IPC.copyLink, async (url: string) => copyLink(String(url)));

  handle(IPC.exportBackup, async (name: string): Promise<ApiCallResult<{ path: string }>> => {
    if (!hostInfo || !/^[A-Za-z0-9._-]+\.sqlite$/.test(String(name))) return errorResult(new Error('Only available on the host computer.'));
    if (!window) return errorResult(new Error('No window is open.'));
    const chosen = await dialog.showSaveDialog(window, { title: 'Save backup', defaultPath: name, filters: [{ name: 'SQLite database', extensions: ['sqlite'] }] });
    if (chosen.canceled || !chosen.filePath) return { ok: false, status: 0, error: { code: 'cancelled', message: 'Cancelled.' } };
    try {
      copyFileSync(join(hostInfo.dataDir, 'backups', name), chosen.filePath);
      return { ok: true, status: 200, data: { path: chosen.filePath } };
    } catch (error) {
      return errorResult(error);
    }
  });

  handle(IPC.importBackup, async (): Promise<ApiCallResult<{ name: string }>> => {
    if (!hostInfo) return errorResult(new Error('Only available on the host computer.'));
    if (!window) return errorResult(new Error('No window is open.'));
    const chosen = await dialog.showOpenDialog(window, { title: 'Choose a backup to restore', properties: ['openFile'], filters: [{ name: 'SQLite database', extensions: ['sqlite', 'db'] }] });
    const source = chosen.filePaths[0];
    if (chosen.canceled || !source) return { ok: false, status: 0, error: { code: 'cancelled', message: 'Cancelled.' } };
    try {
      const name = `imported-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
      const directory = join(hostInfo.dataDir, 'backups');
      mkdirSync(directory, { recursive: true });
      copyFileSync(source, join(directory, name));
      return { ok: true, status: 200, data: { name } };
    } catch (error) {
      return errorResult(error);
    }
  });

  handle(IPC.openDataFolder, async () => {
    if (hostInfo) await shell.openPath(hostInfo.dataDir);
  });

  handle(IPC.chooseBackupFolder, async () => {
    if (!window) return autoBackup.state();
    const chosen = await dialog.showOpenDialog(window, {
      title: 'Choose the folder for weekly database copies',
      defaultPath: settings.autoBackup.folder ?? app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    });
    const folder = chosen.filePaths[0];
    if (!chosen.canceled && folder) {
      settings = { ...settings, autoBackup: { ...settings.autoBackup, folder, lastError: null } };
      saveSettings(settings);
      broadcastState();
      void autoBackup.saveIfDue();
    }
    return autoBackup.state();
  });

  handle(IPC.setAutoBackup, (enabled: boolean) => {
    const on = enabled === true && !!settings.autoBackup.folder;
    settings = { ...settings, autoBackup: { ...settings.autoBackup, enabled: on, lastError: on ? settings.autoBackup.lastError : null } };
    saveSettings(settings);
    broadcastState();
    // Switched on with no copy yet, or the last one over a week old: one is saved straight away.
    if (on) void autoBackup.saveIfDue();
    return autoBackup.state();
  });

  handle(IPC.saveBackupNow, async (): Promise<ApiCallResult<AutoBackupState>> => {
    const outcome = await autoBackup.saveNow();
    if (outcome.saved) return { ok: true, status: 200, data: autoBackup.state() };
    return { ok: false, status: 0, error: { code: outcome.reason, message: outcome.message ?? 'The copy could not be saved.' }, data: autoBackup.state() };
  });

  handle(IPC.openBackupFolder, async () => {
    if (settings.autoBackup.folder) await shell.openPath(settings.autoBackup.folder);
  });
}

function lockDownSession(): void {
  // The UI never needs the camera, location, notifications or the like.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

function startUp(): void {
  settings = loadSettings();
  nativeTheme.themeSource = settings.theme;
  Menu.setApplicationMenu(null);
  lockDownSession();
  registerIpc();
  ensureTray();
  createWindow();

  if (settings.mode === 'host') {
    void startHost(settings.hostPort);
  } else if (settings.mode === 'client' && settings.server) {
    connection.connect(settings.server, loadStoredToken());
  }
  // The weekly copy is looked at regularly while the app runs, including from the tray.
  setInterval(() => void autoBackup.saveIfDue(), 15 * 60_000);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  void app.whenReady().then(startUp);

  app.on('window-all-closed', () => {
    // The app keeps running from the tray until someone quits it there.
    if (quitting) app.quit();
  });

  let stopped = false;
  app.on('before-quit', (event) => {
    quitting = true;
    if (stopped) return;
    event.preventDefault();
    notifications.destroy();
    connection.disconnect();
    // The database is closed cleanly before the process goes away.
    void hostServer.stop().finally(() => {
      stopped = true;
      app.quit();
    });
  });
}
