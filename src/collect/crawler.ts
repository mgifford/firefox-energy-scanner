import type { Config } from '../core/config.js';
import type { StepResult, EnergyResult } from '../core/types.js';
import { BrowserSession, waitForStablePage, readTimings } from './session.js';
import { normalizeUrl, matchesRules, pageKey, siteOf, sortUrls } from './urls.js';
import { StepRunner, buildStepResults, greenHostingFor, type StepRecord } from '../core/runner.js';
import { deriveBaseline, type Baseline } from '../core/baseline.js';
import { loginDrupal, readDrupalCredentials } from '../drupal/helpers.js';

export interface CrawlOptions {
  config: Config;
  startUrl: string;
  onProgress?: (message: string) => void;
}

export interface CrawlOutcome {
  steps: StepResult[];
  baseline?: Baseline;
  warnings: string[];
  firefoxVersion: string;
  discovered: string[];
  /** True only when power counters produced real samples. */
  energyAvailable: boolean;
}

interface QueueItem {
  url: string;
  depth: number;
}

/**
 * Breadth-first crawler.
 *
 * Discovery only: crawls visit different pages under different conditions and
 * are a poor basis for A/B regression. Use journey mode for comparisons.
 */
export async function crawl(options: CrawlOptions): Promise<CrawlOutcome> {
  const { config, startUrl } = options;
  const warnings: string[] = [];
  const useEnergy = config.energy.adapter !== 'noop';

  const session = await BrowserSession.create(config, useEnergy);
  const firefoxVersion = await session.version();
  const runner = new StepRunner(session, config);
  // Each crawled page is visited once, so structural collection is always on.
  runner.enableAnatomy();

  const visited = new Set<string>();
  const discovered: string[] = [];
  let robotsDisallow: string[] = [];
  let baseline: Baseline | undefined;
  let closed = false;
  let energyAvailable = false;
  const steps: StepResult[] = [];

  try {
    if (config.auth?.type === 'drupal') {
      const creds = readDrupalCredentials(
        process.env,
        config.auth.username_env,
        config.auth.password_env,
      );
      if (creds) {
        await loginDrupal(session.getPage(), {
          baseUrl: startUrl,
          username: creds.username,
          password: creds.password,
          loginPath: config.auth.login_path,
        });
      } else {
        warnings.push('Authenticated crawl requested but credentials are not set; crawling anonymously.');
      }
    }

    if (config.crawl.respect_robots) {
      robotsDisallow = await fetchRobotsDisallow(session, startUrl);
    }

    if (config.energy.baseline && useEnergy) {
      options.onProgress?.('Collecting idle baseline');
      // See runner.ts: discard browser startup activity before sampling.
      await session.getPage().goto('about:blank');
      if (config.energy.baseline_settle_ms > 0) {
        await session.getPage().waitForTimeout(config.energy.baseline_settle_ms);
      }
      await runner.measure('__baseline__', async () => {
        await session.getPage().waitForTimeout(config.energy.baseline_duration_ms);
      });
    }

    const keyOpts = { queryStrategy: config.crawl.query_strategy };
    const queue: QueueItem[] = [{ url: normalizeUrl(startUrl, keyOpts), depth: 0 }];
    // The sites in scope: the start URL's, plus wherever it redirects to
    // (france.fr -> www.france.fr/en/), so following the redirect, as a
    // browser does, never empties the crawl.
    const sites = new Set([siteOf(startUrl)]);
    let pagesMeasured = 0;

    while (queue.length > 0 && pagesMeasured < config.crawl.max_pages) {
      const item = queue.shift()!;
      const key = pageKey(item.url, keyOpts);
      if (visited.has(key)) continue;
      visited.add(key);
      discovered.push(item.url);
      pagesMeasured++;

      options.onProgress?.(`[${pagesMeasured}/${config.crawl.max_pages}] ${item.url}`);

      // Each page is a single measured run so the result shape matches other modes.
      await runner.measure(`run:0:${item.url}`, async () => {
        await session.getPage().goto(item.url, { waitUntil: 'domcontentloaded' });
      });

      // After a failed navigation the browser still shows the previous page,
      // so its URL and links say nothing about this one.
      const loaded = runner.getRecords().at(-1)?.valid === true;

      // Where the browser actually ended up. Mark it visited too, so a page
      // reached through a redirect is not crawled again under its own URL.
      const landed = loaded ? session.getPage().url() : '';
      if (siteOf(landed)) {
        visited.add(pageKey(landed, keyOpts));
        if (item.depth === 0) sites.add(siteOf(landed));
      }

      if (loaded && item.depth < config.crawl.max_depth) {
        const links = await extractLinks(session, landed || item.url, sites, config, robotsDisallow);
        for (const link of links) {
          if (!visited.has(pageKey(link, keyOpts))) queue.push({ url: link, depth: item.depth + 1 });
        }
      }

      if (config.crawl.delay_ms > 0) {
        await session.getPage().waitForTimeout(config.crawl.delay_ms);
      }
    }

    const records: StepRecord[] = runner.getRecords();
    await session.close();
    closed = true;

    const energyByLabel = (await session.energy?.finalize()) ?? new Map<string, EnergyResult>();
    energyAvailable = session.energy?.hasPowerData() ?? false;
    if (useEnergy && !energyAvailable) {
      warnings.push(
        'No power counters were found in the Gecko profile. Energy values are unavailable on this platform; timing and network metrics are still valid.',
      );
    }
    const baselineEnergy = energyByLabel.get('__baseline__');
    if (baselineEnergy) baseline = deriveBaseline(baselineEnergy);

    const green = await greenHostingFor(records, config, warnings);
    steps.push(...buildStepResults(records, energyByLabel, baseline, config, 'crawl', green));
  } finally {
    if (!closed) await session.close().catch(() => {});
  }

  return {
    steps,
    baseline,
    warnings,
    firefoxVersion,
    discovered: sortUrls(discovered),
    energyAvailable,
  };
}

async function extractLinks(
  session: BrowserSession,
  pageUrl: string,
  sites: Set<string>,
  config: Config,
  robotsDisallow: string[],
): Promise<string[]> {
  let hrefs: string[] = [];
  try {
    hrefs = await session
      .getPage()
      .evaluate(() => Array.from(document.querySelectorAll('a[href]'), (a) => (a as HTMLAnchorElement).href));
  } catch {
    return [];
  }
  return selectCrawlLinks(hrefs, pageUrl, sites, config.crawl, robotsDisallow);
}

/**
 * The links worth crawling from one page. Pure, so it is tested directly.
 *
 * `same_origin` (the config key predates this) means "same site": www and
 * non-www, http and https all count, because redirects between them are
 * routine. Each page appears once, under the first spelling seen.
 */
export function selectCrawlLinks(
  hrefs: string[],
  pageUrl: string,
  sites: Set<string>,
  crawl: Pick<Config['crawl'], 'same_origin' | 'query_strategy' | 'include' | 'exclude'>,
  robotsDisallow: string[] = [],
): string[] {
  const out = new Map<string, string>();
  for (const href of hrefs) {
    let abs: string;
    try {
      abs = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs)) continue;
    if (crawl.same_origin && !sites.has(siteOf(abs))) continue;
    // A file, not a page: a browser downloads it and there is nothing to measure.
    if (/\.(pdf|docx?|xlsx?|pptx?|zip|csv|mp3|mp4|mov|jpe?g|png|gif|svg|webp)$/i.test(new URL(abs).pathname)) continue;

    const normalized = normalizeUrl(abs, { queryStrategy: crawl.query_strategy });
    if (!matchesRules(normalized, crawl.include, crawl.exclude)) continue;
    if (isRobotsDisallowed(normalized, robotsDisallow)) continue;
    const key = pageKey(normalized, { queryStrategy: crawl.query_strategy });
    if (!out.has(key)) out.set(key, normalized);
  }
  // Deterministic ordering so repeated crawls visit pages in the same sequence.
  return sortUrls([...out.values()]);
}

/** Minimal robots.txt handling: User-agent: * Disallow prefixes. */
export async function fetchRobotsDisallow(
  session: BrowserSession,
  startUrl: string,
): Promise<string[]> {
  try {
    const robotsUrl = new URL('/robots.txt', startUrl).toString();
    const res = await session.getContext().request.get(robotsUrl, { timeout: 8000 });
    if (!res.ok()) return [];
    return parseRobots(await res.text());
  } catch {
    return [];
  }
}

/** Parse Disallow rules under `User-agent: *`. Exported for testing. */
export function parseRobots(text: string): string[] {
  const disallow: string[] = [];
  let inWildcardGroup = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      inWildcardGroup = value === '*';
    } else if (key === 'disallow' && inWildcardGroup && value) {
      disallow.push(value);
    }
  }
  return disallow;
}

export function isRobotsDisallowed(url: string, disallow: string[]): boolean {
  if (disallow.length === 0) return false;
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return false;
  }
  return disallow.some((rule) => path.startsWith(rule));
}
