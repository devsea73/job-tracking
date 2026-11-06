import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';

const sharedAlias = { '@shared': resolve('src/shared') };

/**
 * The page may load only its own files and talk to nothing: all network traffic goes through
 * the main process. Development adds what Vite's hot reload needs, and nothing else.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const dev = !!context.server;
        const policy = [
          "default-src 'none'",
          `script-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data:",
          "font-src 'self'",
          `connect-src ${dev ? "'self' ws://localhost:* http://localhost:*" : "'none'"}`,
          "base-uri 'none'",
          "form-action 'none'"
        ].join('; ');
        return html.replace('%CSP%', policy);
      }
    }
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { ...sharedAlias, '@server': resolve('src/server') } },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The LAN server runs in its own utility process so that synchronous
          // SQLite work and page extraction never block the desktop UI.
          server: resolve('src/server/entry.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [contentSecurityPolicy(), react(), tailwindcss()],
    resolve: {
      alias: { ...sharedAlias, '@': resolve('src/renderer/src') }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html'), notification: resolve('src/renderer/notification.html') } }
    }
  }
});
