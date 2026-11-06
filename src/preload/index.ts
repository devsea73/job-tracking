import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ServerEvent } from '../shared/api';
import { IPC, type BridgeState, type JobTrackerBridge, type NoticePayload } from '../shared/bridge';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/** The narrow set of named operations page code can ask for. No general IPC or Node access is exposed. */
const bridge: JobTrackerBridge = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  onStateChange: (listener) => subscribe<BridgeState>(IPC.stateChanged, listener),
  onServerEvent: (listener) => subscribe<ServerEvent>(IPC.serverEvent, listener),
  startHost: (port) => ipcRenderer.invoke(IPC.startHost, port),
  probeServer: (address) => ipcRenderer.invoke(IPC.probeServer, address),
  pairServer: (address, fingerprint) => ipcRenderer.invoke(IPC.pairServer, address, fingerprint),
  resetConnection: () => ipcRenderer.invoke(IPC.resetConnection),
  retryConnection: () => ipcRenderer.invoke(IPC.retryConnection),
  api: (method, path, body) => ipcRenderer.invoke(IPC.api, method, path, body),
  setTheme: (theme) => ipcRenderer.invoke(IPC.setTheme, theme),
  setNotifications: (changes) => ipcRenderer.invoke(IPC.setNotifications, changes),
  onOpenJob: (listener) => subscribe<number>(IPC.openJob, listener),
  onNotice: (listener) => subscribe<NoticePayload>(IPC.noticeShow, listener),
  noticeReady: () => ipcRenderer.send(IPC.noticeReady),
  noticeAction: (id, action) => ipcRenderer.invoke(IPC.noticeAction, id, action),
  noticeResize: (height) => ipcRenderer.send(IPC.noticeResize, height),
  copyLink: (url) => ipcRenderer.invoke(IPC.copyLink, url),
  exportBackup: (name) => ipcRenderer.invoke(IPC.exportBackup, name),
  importBackup: () => ipcRenderer.invoke(IPC.importBackup),
  openDataFolder: () => ipcRenderer.invoke(IPC.openDataFolder),
  chooseBackupFolder: () => ipcRenderer.invoke(IPC.chooseBackupFolder),
  setAutoBackup: (enabled) => ipcRenderer.invoke(IPC.setAutoBackup, enabled),
  saveBackupNow: () => ipcRenderer.invoke(IPC.saveBackupNow),
  openBackupFolder: () => ipcRenderer.invoke(IPC.openBackupFolder)
};

contextBridge.exposeInMainWorld('jobTracker', bridge);
