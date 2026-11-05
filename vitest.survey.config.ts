import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/** Opt-in extraction survey against live job sites. Never part of `npm test`. */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@server': resolve(__dirname, 'src/server')
    }
  },
  test: {
    include: ['tests/live/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 4 * 60 * 60 * 1000,
    hookTimeout: 60_000
  }
});
