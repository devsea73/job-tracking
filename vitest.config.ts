import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@server': resolve(__dirname, 'src/server')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live/**'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
});
