import { chromium, type Browser, type BrowserContext, type Route } from 'playwright-core';
import { EgressProxy } from './egress-proxy';
import { assertSafeUrl, systemResolver, type Resolver } from './ip-guard';
import { BROWSER_USER_AGENT } from './safe-fetch';
import type { PageRenderer, RenderedPage } from './types';

const CHANNELS = ['msedge', 'chrome'] as const;
const LAUNCH_TIMEOUT_MS = 30_000;
const NAVIGATION_TIMEOUT_MS = 25_000;
const SETTLE_TIMEOUT_MS = 7_000;
/** However a page behaves, its reading ends by then and its slot is free again. */
export const RENDER_DEADLINE_MS = 45_000;
/** Closing a page's context should take moments; past this the browser is taken to be stuck. */
const CLOSE_TIMEOUT_MS = 5_000;
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

export class RenderTimeoutError extends Error {
  constructor() {
    super('The page took too long to open in the browser.');
    this.name = 'RenderTimeoutError';
  }
}

export interface RendererOptions {
  /** Starts the browser with all its traffic sent through the given proxy. Tests replace it. */
  launch?: (proxyServer: string) => Promise<Browser>;
  proxy?: EgressProxy;
  deadlineMs?: number;
}

const settle = <T>(promise: Promise<T> | undefined, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (!promise) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      }
    );
  });

/**
 * Renders JavaScript-heavy pages in the computer's installed Edge or Chrome, so that the
 * installer does not need to ship a browser of its own.
 *
 * Page scripts run inside that browser's sandbox, in a throwaway profile, and nothing they
 * produce is executed by this app: only the resulting HTML is read back. All of the browser's
 * traffic goes through EgressProxy, which lets it reach public addresses only, however a page
 * gets there: a redirect, a frame, a script. Requests are also checked as they are made, which
 * turns them away sooner and skips images and fonts. A page that never finishes loading is closed
 * at RENDER_DEADLINE_MS, so it cannot hold a slot for ever.
 */
export class PlaywrightRenderer implements PageRenderer {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly proxy: EgressProxy;
  private readonly deadlineMs: number;

  constructor(
    private readonly resolver: Resolver = systemResolver,
    private readonly options: RendererOptions = {}
  ) {
    this.proxy = options.proxy ?? new EgressProxy(resolver);
    this.deadlineMs = options.deadlineMs ?? RENDER_DEADLINE_MS;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= this.launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async launch(): Promise<Browser> {
    const proxyServer = await this.proxy.start();
    const browser = await (this.options.launch ?? launchInstalled)(proxyServer);
    browser.on('disconnected', () => {
      if (this.browser === browser) this.browser = null;
    });
    this.browser = browser;
    return browser;
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
    const visit: Visit = { context: null, over: false };
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RenderTimeoutError()), this.deadlineMs);
      });
      return await Promise.race([this.read(url, visit), deadline]);
    } finally {
      clearTimeout(timer);
      visit.over = true;
      // Closing the context ends whatever the page is still doing, and what was waiting on it.
      if (!(await settle(visit.context?.close(), CLOSE_TIMEOUT_MS))) await this.restart();
      this.release();
    }
  }

  private async read(url: string, visit: Visit): Promise<RenderedPage> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
      locale: 'en-US',
      acceptDownloads: false,
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 900 }
    });
    if (visit.over) {
      // The deadline passed while the context was being made.
      await context.close().catch(() => undefined);
      throw new RenderTimeoutError();
    }
    visit.context = context;
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
  }

  /** A browser that cannot even close a page is closed whole; the next page starts a new one. */
  private async restart(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    await settle(browser?.close(), CLOSE_TIMEOUT_MS);
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const browser = this.browser;
    this.browser = null;
    // Let go of the proxy at once: a page starting meanwhile then gets a browser and proxy of its own.
    const proxyClosed = this.proxy.close();
    await settle(browser?.close(), CLOSE_TIMEOUT_MS);
    await proxyClosed;
  }
}

interface Visit {
  context: BrowserContext | null;
  /** Set once the render has ended, by its deadline or otherwise. */
  over: boolean;
}

async function launchInstalled(proxyServer: string): Promise<Browser> {
  for (const channel of CHANNELS) {
    try {
      return await chromium.launch({
        channel,
        headless: true,
        timeout: LAUNCH_TIMEOUT_MS,
        // "<-loopback>": this computer's own addresses go through the proxy too, to be refused there.
        proxy: { server: proxyServer, bypass: '<-loopback>' },
        args: ['--disable-extensions', '--disable-sync', '--no-first-run', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
      });
    } catch {
      // Not installed: try the next one.
    }
  }
  throw new BrowserUnavailableError();
}
