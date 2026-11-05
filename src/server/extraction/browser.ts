import { chromium, type Browser, type BrowserContext, type Route } from 'playwright-core';
import { assertSafeUrl, systemResolver, type Resolver } from './ip-guard';
import { BROWSER_USER_AGENT } from './safe-fetch';
import type { PageRenderer, RenderedPage } from './types';

const CHANNELS = ['msedge', 'chrome'] as const;
const NAVIGATION_TIMEOUT_MS = 25_000;
const SETTLE_TIMEOUT_MS = 7_000;
const IDLE_CLOSE_MS = 2 * 60 * 1000;
const MAX_CONCURRENT_PAGES = 2;

/** True once the page's text has held still for three checks in a row, with no loading placeholders showing. */
const SETTLED = `(() => {
  const length = (document.body?.innerText ?? '').length;
  const loading = document.querySelector('[data-automation-id*="skeleton" i], [class*="skeleton" i], [aria-busy="true"]');
  const changed = length !== window.__settleLength;
  window.__settleLength = length;
  window.__settleCount = loading || changed || length === 0 ? 0 : (window.__settleCount ?? 0) + 1;
  return window.__settleCount >= 3;
})()`;

export class BrowserUnavailableError extends Error {
  constructor() {
    super('Pages that need a browser cannot be read here: neither Microsoft Edge nor Google Chrome was found.');
    this.name = 'BrowserUnavailableError';
  }
}

/**
 * Renders JavaScript-heavy pages in the computer's installed Edge or Chrome, so that the
 * installer does not need to ship a browser of its own.
 *
 * Page scripts run inside that browser's sandbox, in a throwaway profile, and nothing they
 * produce is executed by this app: only the resulting HTML is read back. Every request the
 * page makes passes the same address check as the server's own fetches, so a posting cannot
 * use the browser to reach the LAN.
 */
export class PlaywrightRenderer implements PageRenderer {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly resolver: Resolver = systemResolver) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= this.launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async launch(): Promise<Browser> {
    for (const channel of CHANNELS) {
      try {
        const browser = await chromium.launch({
          channel,
          headless: true,
          args: ['--disable-extensions', '--disable-sync', '--no-first-run', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
        });
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null;
        });
        this.browser = browser;
        return browser;
      } catch {
        // Not installed: try the next one.
      }
    }
    throw new BrowserUnavailableError();
  }

  private async guardRequest(route: Route): Promise<void> {
    const request = route.request();
    const type = request.resourceType();
    // Only the document matters, images and video are wasted work.
    if (type === 'image' || type === 'media' || type === 'font') {
      await route.abort('aborted');
      return;
    }
    const target = request.url();
    if (target.startsWith('data:') || target.startsWith('blob:')) {
      await route.continue();
      return;
    }
    try {
      await assertSafeUrl(new URL(target), this.resolver);
    } catch {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  }

  private async acquire(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.active < MAX_CONCURRENT_PAGES) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
    if (this.active === 0) {
      // Edge is only kept open while pages are being read.
      this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
      this.idleTimer.unref();
    }
  }

  async render(url: string): Promise<RenderedPage> {
    await this.acquire();
    let context: BrowserContext | null = null;
    try {
      const browser = await this.getBrowser();
      context = await browser.newContext({
        userAgent: BROWSER_USER_AGENT,
        locale: 'en-US',
        acceptDownloads: false,
        serviceWorkers: 'block',
        viewport: { width: 1280, height: 900 }
      });
      await context.route('**/*', (route) => this.guardRequest(route));
      await context.routeWebSocket(/.*/, (socket) => socket.close());

      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);
      // Applicant tracking systems often fetch the posting after the network first goes quiet,
      // showing a placeholder meanwhile, so wait for the page to stop changing.
      await page.waitForFunction(SETTLED, undefined, { timeout: SETTLE_TIMEOUT_MS, polling: 500 }).catch(() => undefined);

      const frames: Array<{ url: string; html: string }> = [];
      for (const frame of page.frames()) {
        if (frame === page.mainFrame() || !frame.url().startsWith('http')) continue;
        const html = await frame.content().catch(() => '');
        if (html.length > 2_000) frames.push({ url: frame.url(), html });
      }
      return {
        html: await page.content(),
        finalUrl: page.url(),
        status: response?.status() ?? null,
        frames
      };
    } finally {
      await context?.close().catch(() => undefined);
      this.release();
    }
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => undefined);
  }
}
