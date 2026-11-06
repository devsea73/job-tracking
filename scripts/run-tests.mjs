// Runs Node tooling under Electron's bundled Node, so that tests exercise the same
// runtime and native-module binaries as the packaged app.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const electronBinary = require('electron');
const args = process.argv.slice(2);

const entry = join(root, 'node_modules', 'vitest', 'vitest.mjs');
let commandArgs;
let env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' };

if (args[0] === '--survey') {
  // Live extraction checks against real URLs. Opt-in only: never part of `npm test`.
  const crossPlatform = args.includes('--cross-platform');
  const dedupe = args.includes('--dedupe');
  const intake = args.includes('--intake');
  env = { ...env, JOB_TRACKER_SURVEY: '1', SURVEY_ARGS: args.slice(1).join(' ') };
  const file = intake ? 'tests/live/intake-run.test.ts' : dedupe ? 'tests/live/dedupe-accuracy.test.ts' : crossPlatform ? 'tests/live/cross-platform.test.ts' : 'tests/live/survey.test.ts';
  commandArgs = [entry, 'run', '--config', 'vitest.survey.config.ts', file];
} else if (args[0] === '--load') {
  // Speed with 10,000 jobs. Opt-in: it takes a while and proves nothing unless someone reads it.
  env = { ...env, JOB_TRACKER_SURVEY: '1', SURVEY_ARGS: args.slice(1).join(' ') };
  commandArgs = [entry, 'run', '--config', 'vitest.survey.config.ts', 'tests/live/load.test.ts'];
} else {
  commandArgs = [entry, ...args];
}

const child = spawn(electronBinary, commandArgs, { cwd: root, stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 1));
