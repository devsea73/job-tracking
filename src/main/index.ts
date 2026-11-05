import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import type { ServerEvent } from '../shared/api';
import { IPC, type ApiCallResult, type BridgeState, type ConnectionStatus, type ProbeResult, type ThemeChoice } from '../shared/bridge';
import { Connection } from './connection';
import { HostServer, type HostReady } from './host-server';
import { probeServer } from './lan-client';
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
    theme: settings.theme
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
  },
  onEvent(event: ServerEvent) {
    window?.webContents.send(IPC.serverEvent, event);
  },
  onSessionEnded() {
    storeToken(null);
    broadcastState();
  }
});

const hostServer = new HostServer((message) => {
  hostInfo = null;
  status = 'host_failed';
  statusMessage = message;
  broadcastState();
  connection.disconnect();
  // A crashed server gets one automatic restart, so people on other computers can keep working.
  setTimeout(() => {
    if (settings.mode === 'host' && !hostServer.running && !quitting) void startHost(settings.hostPort);
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
    ensureTray();
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

/** Closing the host's window must not cut everyone else off, so the server stays reachable from the tray. */
function ensureTray(): void {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
  tray.setToolTip('Job Tracker host');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Job Tracker', click: () => showWindow() },
      { type: 'separator' },
      {
        label: 'Stop server and quit',
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on('click', () => showWindow());
}

function removeTray(): void {
  tray?.destroy();
  tray = null;
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
  window = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (window === win) window = null;
  });
  win.on('close', (event) => {
    if (quitting || settings.mode !== 'host' || !hostServer.running) return;
    event.preventDefault();
    win.hide();
    if (!settings.trayHintShown) {
      settings = { ...settings, trayHintShown: true };
      saveSettings(settings);
      tray?.displayBalloon({ title: 'Job Tracker is still running', content: 'The server stays available to the other computers. Right-click the tray icon to quit.' });
    }
  });

  // This window only ever shows the app itself. Job posting links open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env.ELECTRON_RENDERER_URL;
    if (devServer && url.startsWith(devServer)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
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
      removeTray();
      settings = { ...settings, mode: 'client', server: { host: found.host, port: found.port, fingerprint: found.fingerprint, certPem: found.certPem } };
      saveSettings(settings);
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
    removeTray();
    storeToken(null);
    settings = { ...settings, mode: null, server: null };
    saveSettings(settings);
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

  handle(IPC.openExternal, async (url: string) => {
    if (isSafeExternalUrl(String(url))) await shell.openExternal(String(url));
  });

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
  createWindow();

  if (settings.mode === 'host') {
    void startHost(settings.hostPort);
  } else if (settings.mode === 'client' && settings.server) {
    connection.connect(settings.server, loadStoredToken());
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  void app.whenReady().then(startUp);

  app.on('window-all-closed', () => {
    // Host mode keeps serving from the tray; otherwise the app is done.
    if (!(settings?.mode === 'host' && hostServer.running)) app.quit();
  });

  let stopped = false;
  app.on('before-quit', (event) => {
    quitting = true;
    if (stopped) return;
    event.preventDefault();
    connection.disconnect();
    // The database is closed cleanly before the process goes away.
    void hostServer.stop().finally(() => {
      stopped = true;
      app.quit();
    });
  });
}
