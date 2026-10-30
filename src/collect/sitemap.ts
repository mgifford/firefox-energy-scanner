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

export interface SiteSample {
  /** The start page first, then the sample. */
  urls: string[];
  /** The sitemap the pages came from. */
  source: string;
  /** Pages the sitemap listed that could be scanned (same site, not files). */
  listed: number;
}

/** At most this many child sitemaps are read from a sitemap index. */
const MAX_CHILD_SITEMAPS = 3;
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
 * `n` items chosen by a shuffle seeded with `seed`: the same input and seed
 * always give the same choice. The input is sorted first, so a sitemap that
 * lists the same pages in another order gives the same sample.
 */
export function seededSample<T extends string>(items: T[], n: number, seed: string): T[] {
  const pool = [...items].sort();
  if (pool.length <= n) return pool;
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
  return pool.slice(0, n);
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
}

/**
 * Sample a site's pages from its sitemap. Undefined when no sitemap lists any
 * scannable page, so the caller can fall back to following links.
 */
export async function sampleFromSitemaps(startUrl: string, opts: SampleOptions): Promise<SiteSample | undefined> {
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
    let locs = parsed.locs;
    if (parsed.isIndex) {
      const children = seededSample(
        locs.filter((u) => sites.has(opts.siteOf(u)) && !/\.gz$/i.test(u)),
        MAX_CHILD_SITEMAPS,
        site,
      );
      locs = [];
      for (const child of children) {
        const c = await opts.get(child);
        if (c?.ok && c.text) locs.push(...parseSitemapXml(c.text).locs);
        if (locs.length >= MAX_LOCS) break;
      }
    }
    const startKey = opts.pageKey(startUrl);
    const pages = opts.select(locs, sites).filter((u) => opts.pageKey(u) !== startKey);
    if (pages.length === 0) continue;
    return {
      urls: [startUrl, ...seededSample(pages, Math.max(0, opts.maxPages - 1), site)],
      source: res.url || candidate,
      listed: pages.length,
    };
  }
  return undefined;
}
