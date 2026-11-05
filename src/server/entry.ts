import { join } from 'node:path';
import { purgeExpiredSessions } from './auth/sessions';
import { buildApp } from './app';
import { createContext } from './create-context';
import { closeDatabase } from './db/client';
import { PlaywrightRenderer } from './extraction/browser';
import { SafeHttpClient } from './extraction/safe-fetch';
import { createFileLogger } from './logger';
import { lanAddresses } from './network';
import { loadOrCreateTls } from './tls';
import type { HostCommand, HostMessage } from '../shared/host-protocol';

/**
 * The LAN server, running in its own process. Synchronous SQLite work and page reading
 * therefore never freeze the host's desktop window, and a crash here cannot take it down.
 */

const parent = (process as unknown as { parentPort?: { postMessage(message: unknown): void; on(event: 'message', listener: (event: { data: unknown }) => void): void } }).parentPort;

function post(message: HostMessage): void {
  parent?.postMessage(message);
}

async function start(command: Extract<HostCommand, { type: 'start' }>): Promise<void> {
  const logger = createFileLogger(join(command.dataDir, 'logs', 'server.log'));
  process.on('uncaughtException', (error) => logger.error({ err: error }, 'Uncaught exception'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled rejection'));

  const http = new SafeHttpClient();
  const renderer = new PlaywrightRenderer();
  const ctx = await createContext({
    dataDir: command.dataDir,
    migrationsDir: command.migrationsDir,
    version: command.version,
    http,
    renderer,
    logger
  });
  const tls = await loadOrCreateTls(command.dataDir);
  const app = buildApp(ctx, { https: { key: tls.key, cert: tls.cert } });

  const purge = setInterval(() => purgeExpiredSessions(ctx.db), 60 * 60 * 1000);
  purge.unref();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(purge);
    // Open event streams would otherwise hold the close open.
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    await renderer.close().catch(() => undefined);
    await http.close().catch(() => undefined);
    closeDatabase(ctx.handle);
    logger.info('Server stopped');
    post({ type: 'stopped' });
    process.exit(0);
  };
  parent?.on('message', (event) => {
    if ((event.data as HostCommand).type === 'stop') void stop();
  });

  await app.listen({ host: '0.0.0.0', port: command.port });
  logger.info({ port: command.port }, 'Server listening');
  post({ type: 'ready', port: command.port, certPem: tls.cert, fingerprint: tls.fingerprint, addresses: lanAddresses() });
}

parent?.on('message', (event) => {
  const command = event.data as HostCommand;
  if (command.type !== 'start') return;
  start(command).catch((error: NodeJS.ErrnoException) => {
    const message =
      error.code === 'EADDRINUSE'
        ? `Port ${command.port} is already in use on this computer. Choose another port in Settings, or close the program using it.`
        : error.code === 'EACCES'
          ? `Windows did not allow listening on port ${command.port}. Choose a port above 1024.`
          : `The server could not start: ${error.message}`;
    post({ type: 'failed', message });
    process.exit(1);
  });
});
