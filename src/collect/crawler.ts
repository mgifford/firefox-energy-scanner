import type { Config } from '../core/config.js';
import type { CrawlSampling, SampleReason, StepResult, EnergyResult } from '../core/types.js';
import { BrowserSession, waitForStablePage, readTimings } from './session.js';
import { normalizeUrl, matchesRules, pageKey, siteOf, sortUrls } from './urls.js';
import { StepRunner, buildStepResults, greenHostingFor, type StepRecord } from '../core/runner.js';
import { deriveBaseline, type Baseline } from '../core/baseline.js';
import { parseRobotsSitemaps, sampleFromSitemaps, type Getter, type SiteSample } from './sitemap.js';
import { loginDrupal, readDrupalCredentials } from '../drupal/helpers.js';
import { FILE_EXTENSION, checkPage, checkPages, contextRequester, type PageCheck } from './content-type.js';

export interface CrawlOptions {
  config: Config;
  startUrl: string;
  /** Pages the requester named, measured right after the start page. */
  extraPages?: string[];
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
  sampling: CrawlSampling;
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
  let sampledFrom: SiteSample | undefined;
  let requestedPages = 0;
  let extraKeys = new Set<string>();
  const keyOpts = { queryStrategy: config.crawl.query_strategy };
  // Only HTML pages are measured: what each URL is, asked once, before Firefox visits it.
  const checks = new Map<string, PageCheck>();
  const notHtml: PageCheck[] = [];

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

    // robots.txt names the sitemaps as well as the rules, so a sample reads it
    // even when the rules are not applied.
    const sampleFromSitemap = config.crawl.strategy === 'sitemap' || config.crawl.strategy === 'adaptive';
    let robotsSitemaps: string[] = [];
    if (config.crawl.respect_robots || sampleFromSitemap) {
      const robots = await fetchRobots(session, startUrl);
      if (config.crawl.respect_robots) robotsDisallow = robots.disallow;
      robotsSitemaps = robots.sitemaps;
    }

    // Choose the pages before the idle baseline, so no sitemap fetch falls
    // inside an energy window.
    let queue: QueueItem[] = [{ url: normalizeUrl(startUrl, keyOpts), depth: 0 }];
    if (sampleFromSitemap) {
      options.onProgress?.('Reading the sitemap');
      const request = contextRequester(session.getContext().request);
      const sample = await sampleFromSitemaps(startUrl, {
        get: requestGetter(session),
        checkPages: async (urls) => {
          options.onProgress?.(`Checking ${urls.length} sampled URL${urls.length === 1 ? '' : 's'} are HTML pages`);
          const results = await checkPages(urls, request);
          // The queue holds normalised URLs: key both, so no page is checked twice.
          for (const r of results) {
            checks.set(r.url, r);
            checks.set(normalizeUrl(r.url, keyOpts), r);
          }
          return results;
        },
        robotsSitemaps,
        maxPages: config.crawl.max_pages,
        siteOf,
        pageKey: (u) => pageKey(u, keyOpts),
        select: (locs, sites) => selectCrawlLinks(locs, startUrl, sites, config.crawl, robotsDisallow),
        strategy: config.crawl.strategy === 'adaptive' ? 'adaptive' : 'random',
      });
      if (sample) {
        // Sampled pages are measured as listed; no links are followed.
        queue = sample.urls.map((u) => ({ url: normalizeUrl(u, keyOpts), depth: config.crawl.max_depth }));
        sampledFrom = sample;
      } else {
        warnings.push('No usable sitemap was found, so pages were chosen by following links from the start page.');
      }
    }

    // Named pages on the same site go right after the start page, ahead of
    // the sample or the links found, so the page limit never cuts them.
    const startSite = siteOf(startUrl);
    const extras = (options.extraPages ?? [])
      .filter((u) => siteOf(u) === startSite)
      .map((u) => normalizeUrl(u, keyOpts))
      .filter((u, i, all) => all.findIndex((x) => pageKey(x, keyOpts) === pageKey(u, keyOpts)) === i)
      .filter((u) => pageKey(u, keyOpts) !== pageKey(queue[0]!.url, keyOpts));
    if (extras.length) {
      extraKeys = new Set(extras.map((u) => pageKey(u, keyOpts)));
      const depth = sampledFrom ? config.crawl.max_depth : 1;
      queue = [
        queue[0]!,
        ...extras.map((url) => ({ url, depth })),
        ...queue.slice(1).filter((q) => !extraKeys.has(pageKey(q.url, keyOpts))),
      ];
    }
    requestedPages = Math.min(extras.length, Math.max(0, config.crawl.max_pages - 1));

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

      // A file (a PDF, a spreadsheet) is skipped before Firefox visits it, and
      // does not count against the page limit. A sample's were checked already.
      const check = checks.get(item.url) ?? (await checkPage(item.url, contextRequester(session.getContext().request)));
      checks.set(item.url, check);
      if (check.verdict === 'file') {
        if (!notHtml.some((n) => n.url === check.url)) notHtml.push(check);
        continue;
      }
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
    sampling: describeSample({
      sample: sampledFrom,
      notHtml: [...(sampledFrom?.notHtml ?? []), ...notHtml.filter((n) => !sampledFrom?.notHtml?.some((m) => m.url === n.url))],
      adaptive: config.crawl.strategy === 'adaptive',
      measured: discovered,
      startKey: pageKey(normalizeUrl(startUrl, keyOpts), keyOpts),
      extraKeys,
      requested: requestedPages,
      keyOf: (u) => pageKey(u, keyOpts),
    }),
  };
}

/** Strata kept in a result: every one a page came from, and the largest of the rest. */
const MAX_STRATA_RECORDED = 40;

/**
 * How the measured pages were chosen: the method, why each page is there, the
 * strata of an adaptive sample, and what the sample cannot stand for. Pure, so
 * it is tested directly.
 */
export function describeSample(o: {
  sample: SiteSample | undefined;
  /** URLs skipped because they are not HTML pages. */
  notHtml?: PageCheck[];
  adaptive: boolean;
  /** Pages measured, in the order they were. */
  measured: string[];
  startKey: string;
  extraKeys: Set<string>;
  requested: number;
  keyOf: (url: string) => string;
}): CrawlSampling {
  const { sample } = o;
  const why = new Map<string, SampleReason>();
  for (const [u, r] of Object.entries(sample?.reasons ?? {})) why.set(o.keyOf(u), r);
  const reasons: Record<string, SampleReason> = {};
  // The start page is always measured first.
  o.measured.forEach((u, i) => {
    const k = o.keyOf(u);
    reasons[u] = i === 0 ? 'start' : o.extraKeys.has(k) ? 'requested' : (why.get(k) ?? 'linked');
  });

  const limitations: string[] = [];
  if (!sample) {
    limitations.push('Pages were found by following links from the start page, so they lean towards pages near it.');
  } else {
    if (sample.sitemapsListed !== undefined && sample.sitemapsRead !== undefined && sample.sitemapsRead < sample.sitemapsListed) {
      limitations.push(
        `The sitemap index names ${sample.sitemapsListed} sitemaps and ${sample.sitemapsRead} were read, ` +
          'so pages listed only in the others could not be picked.',
      );
    }
    if (sample.capped) limitations.push('A sitemap was very long, so only its first 50,000 entries were read.');
    if (o.adaptive) {
      limitations.push(
        'Sections come from URL paths. Pages in one section can still be built differently; the page families say how the measured pages actually group.',
      );
    } else {
      limitations.push(
        'The sample is random, so a small group of pages built differently from the rest can be missing from it. --adaptive spreads the sample across URL sections.',
      );
    }
  }

  // Strata as measured, not as planned: a page limit or a failed load changes them.
  let strata: CrawlSampling['strata'];
  let strataTotal: number | undefined;
  if (sample?.strata) {
    strataTotal = sample.strata.length;
    const measured = new Set(o.measured.map(o.keyOf));
    const all = sample.strata.map(({ pages, ...s }) => ({ ...s, picked: pages.filter((u) => measured.has(o.keyOf(u))).length }));
    const used = all.filter((s) => s.picked > 0).length;
    strata = all.filter((s, i) => s.picked > 0 || i < Math.max(0, MAX_STRATA_RECORDED - used));
  }

  return {
    method: sample ? (o.adaptive ? 'adaptive' : 'sitemap') : 'links',
    ...(sample ? { source: sample.source, listed: sample.listed } : {}),
    picked: o.measured.length,
    ...(o.requested ? { requested: o.requested } : {}),
    reasons,
    ...(strata ? { strata, strataTotal } : {}),
    ...(sample?.sitemapsListed !== undefined ? { sitemapsListed: sample.sitemapsListed, sitemapsRead: sample.sitemapsRead } : {}),
    ...(o.notHtml?.length ? { notHtml: o.notHtml.slice(0, MAX_NOT_HTML_RECORDED).map((c) => ({ url: c.url, ...(c.contentType ? { contentType: c.contentType } : {}) })), notHtmlCount: o.notHtml.length } : {}),
    limitations,
  };
}

/** Skipped files kept by URL in a result; the count covers them all. */
const MAX_NOT_HTML_RECORDED = 50;

/** The browser context's request client, which the network guard covers. */
function requestGetter(session: BrowserSession): Getter {
  return async (url) => {
    try {
      const res = await session.getContext().request.get(url, { timeout: 15000, maxRedirects: 5 });
      return { ok: res.ok(), url: res.url(), text: res.ok() ? await res.text() : '' };
    } catch {
      return undefined;
    }
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
    // A file, not a page: a browser downloads it or shows it raw, and there is
    // no page to lay out. Sitemaps and <link href> lists contain these too.
    if (FILE_EXTENSION.test(new URL(abs).pathname)) continue;

    const normalized = normalizeUrl(abs, { queryStrategy: crawl.query_strategy });
    if (!matchesRules(normalized, crawl.include, crawl.exclude)) continue;
    if (isRobotsDisallowed(normalized, robotsDisallow)) continue;
    const key = pageKey(normalized, { queryStrategy: crawl.query_strategy });
    if (!out.has(key)) out.set(key, normalized);
  }
  // Deterministic ordering so repeated crawls visit pages in the same sequence.
  return sortUrls([...out.values()]);
}

/** robots.txt: the `User-agent: *` Disallow prefixes, and any sitemaps it names. */
export async function fetchRobots(
  session: BrowserSession,
  startUrl: string,
): Promise<{ disallow: string[]; sitemaps: string[] }> {
  try {
    const robotsUrl = new URL('/robots.txt', startUrl).toString();
    const res = await session.getContext().request.get(robotsUrl, { timeout: 8000 });
    if (!res.ok()) return { disallow: [], sitemaps: [] };
    const text = await res.text();
    return { disallow: parseRobots(text), sitemaps: parseRobotsSitemaps(text) };
  } catch {
    return { disallow: [], sitemaps: [] };
  }
}

/** Minimal robots.txt handling: User-agent: * Disallow prefixes. */
export async function fetchRobotsDisallow(session: BrowserSession, startUrl: string): Promise<string[]> {
  return (await fetchRobots(session, startUrl)).disallow;
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
