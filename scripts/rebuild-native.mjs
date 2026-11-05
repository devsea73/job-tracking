// Rebuilds native modules (better-sqlite3) against the Electron ABI so that a
// single binary is used by the app and by the test suite (tests run under
// Electron's bundled Node via ELECTRON_RUN_AS_NODE, see run-tests.mjs).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));

let electronVersion;
try {
  electronVersion = require('electron/package.json').version;
} catch {
  console.log('[rebuild-native] electron not installed (production install), skipping.');
  process.exit(0);
}

// Electron fetches its binary lazily on first use. Do it here so the first
// `npm run dev` or `npm test` does not stall on an unexplained download.
const electronInstall = spawnSync(process.execPath, [join(root, 'node_modules', 'electron', 'install.js')], {
  cwd: root,
  stdio: 'inherit'
});
if (electronInstall.status !== 0) process.exit(electronInstall.status ?? 1);

const cli = join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
const result = spawnSync(
  process.execPath,
  [cli, '--version', electronVersion, '--only', 'better-sqlite3', '--force', '--module-dir', root],
  { cwd: root, stdio: 'inherit' }
);
process.exit(result.status ?? 1);
