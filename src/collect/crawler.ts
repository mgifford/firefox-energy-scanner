import type { Config } from '../core/config.js';
import type { StepResult, EnergyResult } from '../core/types.js';
import { BrowserSession, waitForStablePage, readTimings } from './session.js';
import { normalizeUrl, matchesRules, sameOrigin, sortUrls } from './urls.js';
import { StepRunner, buildStepResults, type StepRecord } from '../core/runner.js';
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

    const queue: QueueItem[] = [{ url: normalizeUrl(startUrl, { queryStrategy: config.crawl.query_strategy }), depth: 0 }];

    while (queue.length > 0 && visited.size < config.crawl.max_pages) {
      const item = queue.shift()!;
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      discovered.push(item.url);

      options.onProgress?.(`[${visited.size}/${config.crawl.max_pages}] ${item.url}`);

      // Each page is a single measured run so the result shape matches other modes.
      await runner.measure(`run:0:${item.url}`, async () => {
        await session.getPage().goto(item.url, { waitUntil: 'domcontentloaded' });
      });

      if (item.depth < config.crawl.max_depth) {
        const links = await extractLinks(session, item.url, config, robotsDisallow);
        for (const link of links) {
          if (!visited.has(link)) queue.push({ url: link, depth: item.depth + 1 });
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

    steps.push(...buildStepResults(records, energyByLabel, baseline, config, 'crawl'));
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

/** Collect same-origin links that pass include/exclude and robots rules. */
async function extractLinks(
  session: BrowserSession,
  pageUrl: string,
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

  const out = new Set<string>();
  for (const href of hrefs) {
    let abs: string;
    try {
      abs = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    if (!abs.startsWith('http')) continue;
    if (config.crawl.same_origin && !sameOrigin(abs, pageUrl)) continue;

    const normalized = normalizeUrl(abs, { queryStrategy: config.crawl.query_strategy });
    if (!matchesRules(normalized, config.crawl.include, config.crawl.exclude)) continue;
    if (isRobotsDisallowed(normalized, robotsDisallow)) continue;
    out.add(normalized);
  }
  // Deterministic ordering so repeated crawls visit pages in the same sequence.
  return sortUrls([...out]);
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
