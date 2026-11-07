import { createHash } from 'node:crypto';
/**
 * A sample of a site's pages, taken from its sitemap.
 *
 * Asked to scan "canada.ca", a person wants a sampling of the site, not the
 * pages that happen to sit nearest the home page. A sitemap lists the pages
 * the site itself considers its own, so a sample of it is the fairer picture.
 * The sample is seeded by the site's name: the same site gives the same pages
 * while its sitemap is unchanged, so a re-scan compares like with like.
 *
 * Fetching is injected (the crawler passes the browser context's request
 * client, so the network guard checks every sitemap fetch too).
 */

export interface Fetched {
  ok: boolean;
  /** The URL after redirects. */
  url: string;
  text: string;
}

export type Getter = (url: string) => Promise<Fetched | undefined>;

import { urlSection } from '../analysis/url-pattern.js';
import type { PageCheck } from './content-type.js';

export type SampleStrategy = 'random' | 'adaptive';

export interface Stratum {
  /** The URL section, see urlSection. */
  section: string;
  /** The child sitemap the pages came from, when an index named several. */
  sitemap?: string;
  listed: number;
  picked: number;
  /** Small enough to count as an unusual part of the site. */
  rare: boolean;
  /** The pages picked from it. */
  pages: string[];
}

export interface SiteSample {
  /** The start page first, then the sample. */
  urls: string[];
  /** The sitemap the pages came from. */
  source: string;
  /** Pages the sitemap listed that could be scanned (same site, not files). */
  listed: number;
  /** Why each sampled page was picked (the start page is not included). */
  reasons: Record<string, 'random' | 'representative' | 'proportional' | 'rare-section'>;
  /** Adaptive samples only. */
  strata?: Stratum[];
  /** When the sitemap was an index: child sitemaps it named, and how many were read. */
  sitemapsListed?: number;
  sitemapsRead?: number;
  /** True when a sitemap was longer than MAX_LOCS and only its start was read. */
  capped: boolean;
  /** How pages were ordered for the draw. */
  order: typeof SAMPLE_ORDER;
  /** Listed URLs found not to be HTML pages (PDFs, spreadsheets, archives): skipped, and replaced. */
  notHtml?: PageCheck[];
}

/** At most this many child sitemaps are read from a sitemap index. */
const MAX_CHILD_SITEMAPS = 3;
/** An adaptive sample reads more, since child sitemaps often split a site by content type. */
const MAX_CHILD_SITEMAPS_ADAPTIVE = 6;

/**
 * Child sitemaps that list thin, template-identical pages rather than
 * content: WordPress and Yoast attachment pages (one per uploaded image),
 * author, tag and category archives. A scan of thegreenwebfoundation.org
 * drew 38 of its 50 pages from these. They are read only when an index has
 * nothing else.
 */
const THIN_SITEMAP = /(attachment|image|media|video|author|user|tag|categor|archive|format)[^/]*\.xml/i;
/** Enough to sample from; a large site can list hundreds of thousands. */
const MAX_LOCS = 50_000;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** `<loc>` values of a sitemap or sitemap index. */
export function parseSitemapXml(xml: string): { locs: string[]; isIndex: boolean } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs: string[] = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  for (let m = re.exec(xml); m && locs.length < MAX_LOCS; m = re.exec(xml)) {
    const loc = m[1]!.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]!);
    if (/^https?:\/\//i.test(loc)) locs.push(loc);
  }
  return { locs, isIndex };
}

/** `Sitemap:` lines of a robots.txt, which apply whatever the user-agent group. */
export function parseRobotsSitemaps(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(raw.replace(/#.*$/, ''));
    if (m && /^https?:\/\//i.test(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** FNV-1a: a small, stable hash of the seed string. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The order of samples. Each URL's place depends only on the seed and the URL
 * itself, so adding or removing pages in a sitemap moves no other page: a
 * re-scan a month later keeps most of its sample, and its comparison with the
 * last scan stays meaningful. A seeded shuffle, used before, reshuffled every
 * page when one was added (0 of 20 pages kept after a sitemap grew by 5%).
 */
export const SAMPLE_ORDER = 'url-hash' as const;

/** The part of a URL that names the page: no scheme, no leading www., host in lower case. */
const stableKey = (url: string) => url.replace(/^https?:\/\/(www\.)?([^/?#]*)/i, (_m, _w, host: string) => host.toLowerCase());

/** A URL's rank in a seeded order: SHA-256 of the seed and the page. */
export function hashRank(item: string, seed: string): string {
  return createHash('sha256').update(`${seed}\n${stableKey(item)}`).digest('hex');
}

/** Items in seeded hash order, duplicates removed. */
export function hashOrder<T extends string>(items: T[], seed: string): T[] {
  return [...new Set(items)]
    .map((x) => [hashRank(x, seed), x] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map((x) => x[1]);
}

/**
 * `n` items in seeded hash order: the same pages and seed always give the
 * same choice, whatever order they are listed in, and a changed sitemap
 * changes only the pages that changed. Skipped items (files, found after a
 * first draw) are stepped over, so the next one in the order takes their place.
 */
export function seededSample<T extends string>(items: T[], n: number, seed: string, skip?: ReadonlySet<string>): T[] {
  return hashOrder(items, seed).filter((u) => !skip?.has(u)).slice(0, n);
}

/** A copy of `items` in an order fixed by `seed` (Fisher–Yates with mulberry32). */
export function seededShuffle<T>(items: T[], seed: string): T[] {
  const pool = [...items];
  let state = hash(seed) || 1;
  const random = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool;
}

export interface AdaptivePick {
  url: string;
  /** The stratum it came from. */
  key: string;
  reason: 'representative' | 'rare-section' | 'proportional';
}

/** A section holding at most this share of the listed pages (and at least one page) is rare. */
const RARE_SHARE = 0.01;
/** Share of an adaptive sample kept for rare sections, when there are any. */
const RARE_BUDGET = 0.2;

/**
 * `n` pages spread across the site's sections, as a stratified sample:
 *
 * 1. one page from each common section, largest section first;
 * 2. about a fifth of the sample from rare sections (at most 1% of the listed
 *    pages each), chosen in seeded order: the unusual corners of a site, where
 *    one-off templates and forgotten pages tend to live;
 * 3. the rest shared out in proportion to section size (D'Hondt), so a large
 *    section gets more pages than a small one.
 *
 * Pages within a section are drawn in seeded hash order (see SAMPLE_ORDER).
 * The same pages and seed give the same sample. Representatives come first, then rare sections, then
 * the proportional share, so a page limit cuts the least informative picks.
 *
 * `groups` maps a stratum key to its pages. Pages in `skip` (files, found
 * after a first draw) are stepped over in their section's order, so the next
 * page of the same section takes their place and nothing else moves.
 */
export function adaptiveSample(
  groups: Map<string, string[]>,
  n: number,
  seed: string,
  skip?: ReadonlySet<string>,
): { picks: AdaptivePick[]; picked: Map<string, number>; rare: Set<string> } {
  const keys = [...groups.keys()].sort();
  // Pages within a section, and rare sections among themselves, in hash order:
  // a section's picks do not move when other pages or sections come and go.
  const order = new Map(keys.map((k) => [k, hashOrder(groups.get(k)!, seed)]));
  const total = keys.reduce((t, k) => t + order.get(k)!.length, 0);
  const rareMax = Math.max(1, Math.floor(total * RARE_SHARE));
  const size = (k: string) => order.get(k)!.length;
  const bySize = (a: string, b: string) => size(b) - size(a) || (a < b ? -1 : a > b ? 1 : 0);

  let common = keys.filter((k) => size(k) > rareMax).sort(bySize);
  let rare = hashOrder(keys.filter((k) => size(k) <= rareMax), `${seed}|section`);
  // With no common section, there is nothing for a rare one to stand out from.
  if (common.length === 0) {
    common = [...rare].sort(bySize);
    rare = [];
  }

  const picked = new Map(keys.map((k) => [k, 0]));
  // Where each section's draw has got to: past its picks and any skipped pages.
  const cursor = new Map(keys.map((k) => [k, 0]));
  const picks: AdaptivePick[] = [];
  const advance = (k: string) => {
    let i = cursor.get(k)!;
    while (i < order.get(k)!.length && skip?.has(order.get(k)![i]!)) i++;
    cursor.set(k, i);
    return i;
  };
  const exhausted = (k: string) => advance(k) >= order.get(k)!.length;
  const take = (k: string, reason: AdaptivePick['reason']) => {
    const i = advance(k);
    const url = order.get(k)![i];
    if (url === undefined) return false;
    cursor.set(k, i + 1);
    picked.set(k, picked.get(k)! + 1);
    picks.push({ url, key: k, reason });
    return true;
  };

  const rareQuota = rare.length && n >= 4 ? Math.min(rare.length, Math.max(1, Math.round(n * RARE_BUDGET))) : 0;
  // Count what was taken, not what was tried: a section of files only gives its turn to the next.
  let representatives = 0;
  for (const k of common) {
    if (representatives >= Math.max(0, n - rareQuota)) break;
    if (take(k, 'representative')) representatives++;
  }
  let rareTaken = 0;
  for (const k of rare) {
    if (rareTaken >= rareQuota || picks.length >= n) break;
    if (take(k, 'rare-section')) rareTaken++;
  }

  // The rest in proportion to section size: the next page goes to the section
  // with the largest size / (picked + 1), common sections before rare ones.
  for (const pool of [common, rare]) {
    while (picks.length < n) {
      let best: string | undefined;
      let bestQ = -1;
      for (const k of pool) {
        if (exhausted(k)) continue;
        const q = size(k) / (picked.get(k)! + 1);
        if (q > bestQ) {
          bestQ = q;
          best = k;
        }
      }
      if (!best) break;
      take(best, 'proportional');
    }
  }
  return { picks, picked, rare: new Set(rare) };
}

export interface SampleOptions {
  get: Getter;
  /** Sitemaps named in robots.txt, tried first. */
  robotsSitemaps: string[];
  /** Pages to return, the start page included. */
  maxPages: number;
  /** The site key of a URL (www and scheme ignored). */
  siteOf: (url: string) => string;
  /** The page key of a URL, for de-duplication. */
  pageKey: (url: string) => string;
  /** Keeps the scannable pages: same site, not files, include/exclude, robots. */
  select: (locs: string[], sites: Set<string>) => string[];
  /** random (the default) or adaptive, see adaptiveSample. */
  strategy?: SampleStrategy;
  /**
   * Checks whether URLs are HTML pages. When given, a sampled URL that is a
   * file is replaced by the next page in the same order (the same section,
   * for an adaptive sample), so the sample keeps its size and spread.
   */
  checkPages?: (urls: string[]) => Promise<PageCheck[]>;
}

/** At most this many URLs are checked for each page the sample asks for. */
const CHECKS_PER_PAGE = 3;

/**
 * Sample a site's pages from its sitemap. Undefined when no sitemap lists any
 * scannable page, so the caller can fall back to following links.
 */
export async function sampleFromSitemaps(startUrl: string, opts: SampleOptions): Promise<SiteSample | undefined> {
  const adaptive = opts.strategy === 'adaptive';
  const site = opts.siteOf(startUrl);
  const sites = new Set([site]);
  const origin = new URL(startUrl).origin;
  const candidates = [
    ...opts.robotsSitemaps.filter((u) => opts.siteOf(u) === site),
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
  ].filter((u, i, all) => all.indexOf(u) === i && !/\.gz$/i.test(new URL(u).pathname));

  for (const candidate of candidates) {
    const res = await opts.get(candidate);
    if (!res?.ok || !res.text) continue;
    // A redirect (canada.ca -> www.canada.ca) moves the site, not the request.
    if (res.url) sites.add(opts.siteOf(res.url));
    const parsed = parseSitemapXml(res.text);
    let capped = parsed.locs.length >= MAX_LOCS;
    let locs = parsed.locs;
    // Which child sitemap each page came from, for an adaptive sample's strata.
    const fromChild = new Map<string, string>();
    let index: { listed: number; read: number } | undefined;
    if (parsed.isIndex) {
      const usable = locs.filter((u) => sites.has(opts.siteOf(u)) && !/\.gz$/i.test(u));
      const content = usable.filter((u) => !THIN_SITEMAP.test(new URL(u).pathname));
      const thin = usable.filter((u) => THIN_SITEMAP.test(new URL(u).pathname));
      const children = seededSample(content.length > 0 ? content : thin, adaptive ? MAX_CHILD_SITEMAPS_ADAPTIVE : MAX_CHILD_SITEMAPS, site);
      index = { listed: usable.length, read: 0 };
      locs = [];
      for (const child of children) {
        const c = await opts.get(child);
        if (c?.ok && c.text) {
          index.read++;
          const childLocs = parseSitemapXml(c.text).locs;
          if (childLocs.length >= MAX_LOCS) capped = true;
          const name = new URL(child).pathname.split('/').pop() || child;
          for (const l of childLocs) if (!fromChild.has(l)) fromChild.set(l, name);
          locs.push(...childLocs);
        }
        if (locs.length >= MAX_LOCS) {
          capped = true;
          break;
        }
      }
    }
    const startKey = opts.pageKey(startUrl);
    const pages = opts.select(locs, sites).filter((u) => opts.pageKey(u) !== startKey);
    if (pages.length === 0) continue;
    const budget = Math.max(0, opts.maxPages - 1);
    const common = {
      source: res.url || candidate,
      listed: pages.length,
      capped,
      order: SAMPLE_ORDER,
      ...(index ? { sitemapsListed: index.listed, sitemapsRead: index.read } : {}),
    };

    // Draw, check the new picks, skip any that are files, draw again: each
    // round only checks the replacements. Capped, so a sitemap of mostly
    // PDFs cannot turn into thousands of requests.
    const skip = new Set<string>();
    const notHtml: PageCheck[] = [];
    const checked = new Set<string>();
    const maxChecks = budget * CHECKS_PER_PAGE + 5;
    const settle = async (draw: () => string[]): Promise<string[]> => {
      let urls = draw();
      while (opts.checkPages && checked.size < maxChecks) {
        const fresh = urls.filter((u) => !checked.has(u)).slice(0, maxChecks - checked.size);
        if (!fresh.length) break;
        const results = await opts.checkPages(fresh);
        for (const u of fresh) checked.add(u);
        const files = results.filter((r) => r.verdict === 'file');
        if (!files.length) break;
        for (const f of files) {
          skip.add(f.url);
          notHtml.push(f);
        }
        urls = draw();
      }
      return urls;
    };
    const withSkips = () => (notHtml.length ? { notHtml } : {});

    if (!adaptive) {
      const sample = await settle(() => seededSample(pages, budget, site, skip));
      return { urls: [startUrl, ...sample], reasons: Object.fromEntries(sample.map((u) => [u, 'random' as const])), ...common, ...withSkips() };
    }

    // Strata: URL section, split by child sitemap when an index named several.
    // select() normalises URLs, so look the child up by the normalised form too.
    const childOf = new Map<string, string>();
    for (const [l, name] of fromChild) childOf.set(opts.pageKey(l), name);
    const splitByChild = new Set(fromChild.values()).size > 1;
    const groups = new Map<string, string[]>();
    const meta = new Map<string, { section: string; sitemap?: string }>();
    for (const u of pages) {
      const section = urlSection(u);
      const sitemap = splitByChild ? childOf.get(opts.pageKey(u)) : undefined;
      const key = sitemap ? `${sitemap} ${section}` : section;
      if (!groups.has(key)) {
        groups.set(key, []);
        meta.set(key, { section, ...(sitemap ? { sitemap } : {}) });
      }
      groups.get(key)!.push(u);
    }
    let drawn = adaptiveSample(groups, budget, site, skip);
    await settle(() => (drawn = adaptiveSample(groups, budget, site, skip)).picks.map((p) => p.url));
    const { picks, picked, rare } = drawn;
    const pickedFrom = new Map<string, string[]>();
    for (const p of picks) pickedFrom.set(p.key, [...(pickedFrom.get(p.key) ?? []), p.url]);
    const strata: Stratum[] = [...groups.keys()]
      .map((k) => ({
        ...meta.get(k)!,
        listed: groups.get(k)!.length,
        picked: picked.get(k) ?? 0,
        rare: rare.has(k),
        pages: pickedFrom.get(k) ?? [],
      }))
      .sort((a, b) => b.listed - a.listed || (a.section < b.section ? -1 : 1));
    return {
      urls: [startUrl, ...picks.map((p) => p.url)],
      reasons: Object.fromEntries(picks.map((p) => [p.url, p.reason])),
      strata,
      ...common,
      ...withSkips(),
    };
  }
  return undefined;
}
