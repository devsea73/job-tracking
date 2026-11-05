/** Messages between the desktop app's main process and the LAN server process. */

export type HostCommand =
  | { type: 'start'; dataDir: string; migrationsDir: string; port: number; version: string }
  | { type: 'stop' };

export type HostMessage =
  | { type: 'ready'; port: number; certPem: string; fingerprint: string; addresses: string[] }
  | { type: 'failed'; message: string }
  | { type: 'stopped' };
