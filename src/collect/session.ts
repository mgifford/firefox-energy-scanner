import { firefox, type Browser, type BrowserContext, type Page, type Request } from 'playwright';
import type { Config } from '../core/config.js';
import type { NetworkSummary, ResourceEntry, TimingResult } from '../core/types.js';
import { isThirdParty, hostOf } from './urls.js';
import {
  FirefoxProfilerAdapter,
  profilerLaunchEnv,
  createProfileOutputPath,
} from '../energy/firefox-profiler.js';

export interface SessionOptions {
  config: Config;
  /** When set, the Gecko Profiler is enabled for this browser session. */
  energyAdapter?: FirefoxProfilerAdapter;
  profilePath?: string;
  /** Extra profiler features, e.g. stack sampling for diagnostic runs. */
  extraFeatures?: string[];
}

/** Owns the Firefox process and per-step network collection. */
export class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private collecting = false;
  private entries: ResourceEntry[] = [];
  private pageUrl = '';
  /**
   * Incremented per measured step. A request is only counted in the step that
   * issued it: a response that finishes after its step ended (a file download,
   * a slow beacon) must not be billed to whichever step happens to be running.
   */
  private generation = 0;
  private issuedIn = new WeakMap<Request, number>();
  private pending = new Set<Promise<void>>();

  constructor(private readonly options: SessionOptions) {}

  /**
   * @param extraFeatures additional Gecko profiler features. Stack sampling
   *   ('js', 'stackwalk') is needed to attribute work to categories, but adds
   *   observer overhead, so it is opt-in for diagnostic runs only.
   */
  static async create(
    config: Config,
    withEnergy: boolean,
    extraFeatures: string[] = [],
  ): Promise<BrowserSession> {
    let adapter: FirefoxProfilerAdapter | undefined;
    let profilePath: string | undefined;
    if (withEnergy) {
      profilePath = await createProfileOutputPath();
      adapter = new FirefoxProfilerAdapter(profilePath, {
        intervalMs: config.energy.profiler_interval_ms,
        retainProfile: config.energy.retain_profile,
        features: extraFeatures,
      });
    }
    const session = new BrowserSession({
      config,
      energyAdapter: adapter,
      profilePath,
      extraFeatures,
    });
    await session.launch();
    return session;
  }

  /** Path to the raw Gecko profile, when profiling is enabled. */
  profilePath(): string | undefined {
    return this.options.profilePath;
  }

  get energy(): FirefoxProfilerAdapter | undefined {
    return this.options.energyAdapter;
  }

  private async launch(): Promise<void> {
    const { config, profilePath } = this.options;
    const env = profilePath
      ? {
          ...(process.env as Record<string, string>),
          ...profilerLaunchEnv(profilePath, {
            intervalMs: config.energy.profiler_interval_ms,
            features: this.options.extraFeatures ?? [],
          }),
        }
      : undefined;

    this.browser = await firefox.launch({
      headless: !config.browser.headed,
      ...(env ? { env } : {}),
    });
    this.context = await this.browser.newContext({ viewport: config.browser.viewport });
    this.page = await this.context.newPage();
    this.attachNetworkListeners(this.context);
  }

  private attachNetworkListeners(context: BrowserContext): void {
    context.on('request', (req) => {
      if (this.collecting) this.issuedIn.set(req, this.generation);
    });
    context.on('requestfinished', (req) => {
      if (!this.belongsToCurrentStep(req)) return;
      // Bind to this step's list now: the sizes lookup is async, and the next
      // step may have started by the time it resolves.
      const target = this.entries;
      const p = this.recordRequest(req, target).catch(() => {});
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    });
    context.on('requestfailed', (req) => {
      if (!this.belongsToCurrentStep(req)) return;
      this.entries.push({
        url: req.url(),
        domain: hostOf(req.url()),
        thirdParty: isThirdParty(req.url(), this.pageUrl),
        resourceType: req.resourceType(),
        transferBytes: 0,
      });
    });
  }

  private belongsToCurrentStep(req: Request): boolean {
    return this.collecting && this.issuedIn.get(req) === this.generation;
  }

  private async recordRequest(req: Request, target: ResourceEntry[]): Promise<void> {
    const url = req.url();
    let transferBytes = 0;
    let status: number | undefined;
    let fromCache: boolean | undefined;
    let durationMs: number | undefined;

    try {
      const res = await req.response();
      if (res) {
        status = res.status();
        // sizes() gives real transfer sizes; it can throw for some responses.
        try {
          const sizes = await req.sizes();
          transferBytes = sizes.responseBodySize + sizes.responseHeadersSize;
        } catch {
          transferBytes = 0;
        }
      }
      const timing = req.timing();
      if (timing && timing.responseEnd > 0) durationMs = timing.responseEnd;
      // Firefox reports served-from-cache via the response, when available.
      fromCache = status === 304 ? true : undefined;
    } catch {
      /* response unavailable */
    }

    target.push({
      url,
      domain: hostOf(url),
      thirdParty: isThirdParty(url, this.pageUrl),
      resourceType: req.resourceType(),
      transferBytes,
      ...(status !== undefined ? { status } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(fromCache !== undefined ? { fromCache } : {}),
    });
  }

  getPage(): Page {
    if (!this.page) throw new Error('Session not launched');
    return this.page;
  }

  getContext(): BrowserContext {
    if (!this.context) throw new Error('Session not launched');
    return this.context;
  }

  /** Begin collecting network activity for a measured step. */
  beginCollection(pageUrl: string): void {
    this.generation++;
    this.entries = [];
    this.pageUrl = pageUrl || this.page?.url() || '';
    this.collecting = true;
  }

  async endCollection(includeResources: boolean): Promise<NetworkSummary> {
    this.collecting = false;
    // Requests that finished inside the window may still be resolving sizes.
    // Bounded, so one stuck lookup cannot stall the whole benchmark.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all([...this.pending]),
      new Promise((r) => (timer = setTimeout(r, 5000))),
    ]);
    clearTimeout(timer);
    const byType: Record<string, { requests: number; bytes: number }> = {};
    let transferBytes = 0;
    let thirdPartyRequests = 0;
    let thirdPartyBytes = 0;

    for (const e of this.entries) {
      transferBytes += e.transferBytes;
      const bucket = (byType[e.resourceType] ??= { requests: 0, bytes: 0 });
      bucket.requests++;
      bucket.bytes += e.transferBytes;
      if (e.thirdParty) {
        thirdPartyRequests++;
        thirdPartyBytes += e.transferBytes;
      }
    }

    return {
      requests: this.entries.length,
      transferBytes,
      thirdPartyRequests,
      thirdPartyBytes,
      byType,
      ...(includeResources ? { resources: [...this.entries] } : {}),
    };
  }

  /** Reset browser cache state according to the configured cache mode. */
  async applyCacheMode(): Promise<void> {
    const mode = this.options.config.benchmark.cache_mode;
    if (mode === 'warm') return;
    if (mode === 'cold-context') {
      // A fresh context clears cookies and storage. Playwright does not
      // guarantee the HTTP cache is fully evicted, which is documented.
      await this.context?.close();
      this.context = await this.browser!.newContext({
        viewport: this.options.config.browser.viewport,
      });
      this.attachNetworkListeners(this.context);
      this.page = await this.context.newPage();
    }
    // 'new-browser' is handled by the runner, which recreates the session.
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    // The profile is written during shutdown; give Firefox time to flush it.
    if (this.options.profilePath) {
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  async version(): Promise<string> {
    return this.browser?.version() ?? 'unknown';
  }
}

/**
 * Wait for the page to become visually and structurally stable.
 *
 * `networkidle` alone is not a sufficient definition of stability: a page can
 * be network-quiet while still executing JS, laying out, or painting. This
 * combines network quiet with a post-idle settle period and a hard ceiling.
 */
export async function waitForStablePage(
  page: Page,
  stability: Config['stability'],
): Promise<void> {
  const deadline = Date.now() + stability.max_wait_ms;

  try {
    await page.waitForLoadState('load', { timeout: stability.max_wait_ms });
  } catch {
    /* proceed; the ceiling governs */
  }

  const remaining = Math.max(0, deadline - Date.now());
  if (remaining > 0) {
    try {
      await page.waitForLoadState('networkidle', { timeout: remaining });
    } catch {
      /* networkidle may never arrive on polling pages */
    }
  }

  // Settle period after quiet, to let late layout/paint work finish.
  const settle = Math.min(stability.post_idle_ms, Math.max(0, deadline - Date.now()));
  if (settle > 0) await page.waitForTimeout(settle);
}

/** Read navigation timings from the Navigation Timing API (feature detected). */
export async function readTimings(page: Page, durationMs: number): Promise<TimingResult> {
  const timing: TimingResult = { durationMs };
  try {
    const nav = await page.evaluate(() => {
      const [entry] = performance.getEntriesByType('navigation');
      if (!entry) return null;
      const n = entry as PerformanceNavigationTiming;
      return {
        ttfb: n.responseStart - n.startTime,
        response: n.responseEnd - n.startTime,
        dcl: n.domContentLoadedEventEnd - n.startTime,
        load: n.loadEventEnd - n.startTime,
      };
    });
    if (nav) {
      if (nav.ttfb > 0) timing.ttfbMs = nav.ttfb;
      if (nav.response > 0) timing.responseMs = nav.response;
      if (nav.dcl > 0) timing.domContentLoadedMs = nav.dcl;
      if (nav.load > 0) timing.loadMs = nav.load;
    }
  } catch {
    /* timings unavailable */
  }
  return timing;
}
