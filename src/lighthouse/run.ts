import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  combineRuns,
  describeThrottling,
  medianRunIndex,
  summarizeLhr,
  type FormFactor,
  type LighthouseCategory,
  type LighthouseRunSummary,
  type LighthouseSummary,
  type Lhr,
} from './summary.js';
import { median } from '../core/stats.js';

/**
 * Run Lighthouse against a list of URLs.
 *
 * Lighthouse is an optional dependency, loaded only when this runs, so the
 * rest of the tool (and CI jobs that only parse issues) never install or
 * import it. The module names are held in variables so TypeScript does not
 * need its types to compile.
 *
 * Lighthouse always runs AFTER the Firefox session has closed. Running both
 * at once would put Chromium's work inside Firefox's energy window.
 */

export interface LighthouseOptions {
  urls: string[];
  runs: number;
  categories: LighthouseCategory[];
  formFactor: FormFactor;
  /** Write the median run's full HTML report here, for local inspection. */
  reportsDir?: string;
  onProgress?: (message: string) => void;
}

interface LaunchedChrome {
  port: number;
  kill: () => void | Promise<void>;
}

interface LighthouseModule {
  default: (
    url: string,
    flags: Record<string, unknown>,
    config?: unknown,
  ) => Promise<{ lhr: Lhr; report: string | string[] } | undefined>;
  desktopConfig: unknown;
}

interface ChromeLauncherModule {
  launch: (opts: { chromePath?: string; chromeFlags?: string[] }) => Promise<LaunchedChrome>;
  getChromePath: () => string;
}

const LIGHTHOUSE = 'lighthouse';
const CHROME_LAUNCHER = 'chrome-launcher';

export class LighthouseUnavailableError extends Error {}

async function loadModules(): Promise<{ lh: LighthouseModule; launcher: ChromeLauncherModule }> {
  try {
    const lh = (await import(LIGHTHOUSE)) as LighthouseModule;
    const launcher = (await import(CHROME_LAUNCHER)) as ChromeLauncherModule;
    return { lh, launcher };
  } catch (err) {
    throw new LighthouseUnavailableError(
      'Lighthouse is not installed. It is an optional dependency: run `npm install` ' +
        '(not `npm install --omit=optional`), on Node.js 22.19 or later. ' +
        `(${(err as Error).message})`,
    );
  }
}

/**
 * Find a Chromium build. CHROME_PATH wins, then an installed Chrome, then the
 * Chromium that Playwright downloads (`npx playwright install chromium`).
 */
export async function resolveChromePath(launcher: ChromeLauncherModule): Promise<string> {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  try {
    const found = launcher.getChromePath();
    if (found && existsSync(found)) return found;
  } catch {
    /* fall through to Playwright's build */
  }
  try {
    const { chromium } = await import('playwright');
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* no Playwright Chromium either */
  }
  throw new LighthouseUnavailableError(
    'No Chrome or Chromium found for Lighthouse. Install Google Chrome, set CHROME_PATH, ' +
      'or run `npx playwright install chromium`.',
  );
}

/**
 * Chrome's sandbox does not start as root or inside most CI containers
 * (Ubuntu 24.04 restricts unprivileged user namespaces). Those hosts are
 * disposable, so the sandbox is dropped there and kept everywhere else.
 */
function chromeFlags(): string[] {
  const flags = ['--headless=new', '--disable-gpu'];
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (process.env.CI === 'true' || isRoot) flags.push('--no-sandbox');
  return flags;
}

export async function runLighthouse(options: LighthouseOptions): Promise<LighthouseSummary> {
  const { lh, launcher } = await loadModules();
  const chromePath = await resolveChromePath(launcher);
  const config = options.formFactor === 'desktop' ? lh.desktopConfig : undefined;

  let version = 'unknown';
  let browser: string | undefined;
  let throttling = 'unknown';
  const benchmarks: number[] = [];
  const results: LighthouseSummary['results'] = [];

  if (options.reportsDir) await mkdir(options.reportsDir, { recursive: true });

  for (const [u, url] of options.urls.entries()) {
    const runs: LighthouseRunSummary[] = [];
    const reports: string[] = [];
    for (let i = 0; i < options.runs; i++) {
      options.onProgress?.(`Lighthouse ${u + 1}/${options.urls.length}, run ${i + 1}/${options.runs}`);
      // A fresh browser per run, as the Lighthouse CLI does, so one run's
      // caches and service workers cannot speed up the next.
      const chrome = await launcher.launch({ chromePath, chromeFlags: chromeFlags() });
      try {
        const result = await lh.default(
          url,
          {
            port: chrome.port,
            output: options.reportsDir ? 'html' : 'json',
            logLevel: 'error',
            onlyCategories: options.categories,
          },
          config,
        );
        if (!result) throw new Error('Lighthouse returned no result.');
        version = result.lhr.lighthouseVersion;
        browser ??= result.lhr.environment?.hostUserAgent?.match(/(?:Headless)?Chrome\/[\d.]+/)?.[0];
        if (throttling === 'unknown') throttling = describeThrottling(result.lhr);
        const run = summarizeLhr(result.lhr, url);
        if (run.benchmarkIndex !== undefined) benchmarks.push(run.benchmarkIndex);
        runs.push(run);
        reports.push(options.reportsDir ? String(result.report) : '');
      } catch (err) {
        runs.push({
          requestedUrl: url,
          error: (err as Error).message,
          scores: {},
          metrics: {},
          recommendations: [],
          failingAudits: {},
          work: {},
          warnings: [],
        });
        reports.push('');
      } finally {
        await chrome.kill();
      }
    }

    const combined = combineRuns(url, runs);
    results.push(combined);

    if (options.reportsDir && combined.runs > 0) {
      // The same run combineRuns took its details from.
      const ok = runs.map((r, i) => ({ r, html: reports[i]! })).filter((x) => !x.r.error);
      const chosen = ok[medianRunIndex(ok.map((x) => x.r))]!;
      const name = `${String(u + 1).padStart(2, '0')}-${slug(url)}.html`;
      await writeFile(join(options.reportsDir, name), chosen.html);
    }
  }

  return {
    tool: 'lighthouse',
    version,
    ...(browser ? { browser } : {}),
    formFactor: options.formFactor,
    throttling,
    categories: options.categories,
    runsPerUrl: options.runs,
    ...(benchmarks.length ? { benchmarkIndex: Math.round(median(benchmarks)) } : {}),
    results,
  };
}

/** Filesystem-safe name for a URL. */
function slug(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * Lighthouse has two device profiles. Desktop-width viewports get the
 * desktop preset; tablets and phones get the default mobile preset (a
 * mid-range Android phone on a throttled 4G connection). The presets are
 * used unmodified so scores line up with PageSpeed Insights.
 */
export function formFactorFor(viewport: { width: number }): FormFactor {
  return viewport.width >= 1100 ? 'desktop' : 'mobile';
}

export function parseCategories(raw: string | undefined): LighthouseCategory[] {
  if (!raw || raw === 'true') return ['performance'];
  if (raw === 'all') return ['performance', 'accessibility', 'best-practices', 'seo'];
  const valid = new Set<LighthouseCategory>(['performance', 'accessibility', 'best-practices', 'seo']);
  const picked = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is LighthouseCategory => valid.has(s as LighthouseCategory));
  if (picked.length === 0) {
    throw new Error(
      `--lighthouse-categories must list any of performance, accessibility, best-practices, seo (got "${raw}")`,
    );
  }
  return [...new Set(picked)];
}
