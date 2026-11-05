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
 * `n` items chosen by a shuffle seeded with `seed`: the same input and seed
 * always give the same choice. The input is sorted first, so a sitemap that
 * lists the same pages in another order gives the same sample.
 */
export function seededSample<T extends string>(items: T[], n: number, seed: string): T[] {
  const pool = [...items].sort();
  if (pool.length <= n) return pool;
  return seededShuffle(pool, seed).slice(0, n);
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
 * Pages within a section are drawn in seeded order. The same pages and seed
 * give the same sample. Representatives come first, then rare sections, then
 * the proportional share, so a page limit cuts the least informative picks.
 *
 * `groups` maps a stratum key to its pages.
 */
export function adaptiveSample(
  groups: Map<string, string[]>,
  n: number,
  seed: string,
): { picks: AdaptivePick[]; picked: Map<string, number>; rare: Set<string> } {
  const keys = [...groups.keys()].sort();
  const order = new Map(keys.map((k) => [k, seededShuffle([...groups.get(k)!].sort(), `${seed}|${k}`)]));
  const total = keys.reduce((t, k) => t + order.get(k)!.length, 0);
  const rareMax = Math.max(1, Math.floor(total * RARE_SHARE));
  const size = (k: string) => order.get(k)!.length;
  const bySize = (a: string, b: string) => size(b) - size(a) || (a < b ? -1 : a > b ? 1 : 0);

  let common = keys.filter((k) => size(k) > rareMax).sort(bySize);
  let rare = seededShuffle(keys.filter((k) => size(k) <= rareMax), `${seed}|rare`);
  // With no common section, there is nothing for a rare one to stand out from.
  if (common.length === 0) {
    common = [...rare].sort(bySize);
    rare = [];
  }

  const picked = new Map(keys.map((k) => [k, 0]));
  const picks: AdaptivePick[] = [];
  const take = (k: string, reason: AdaptivePick['reason']) => {
    const i = picked.get(k)!;
    const url = order.get(k)![i];
    if (url === undefined) return false;
    picked.set(k, i + 1);
    picks.push({ url, key: k, reason });
    return true;
  };

  const rareQuota = rare.length && n >= 4 ? Math.min(rare.length, Math.max(1, Math.round(n * RARE_BUDGET))) : 0;
  for (const k of common.slice(0, Math.max(0, n - rareQuota))) take(k, 'representative');
  for (const k of rare.slice(0, Math.max(0, Math.min(rareQuota, n - picks.length)))) take(k, 'rare-section');

  // The rest in proportion to section size: the next page goes to the section
  // with the largest size / (picked + 1), common sections before rare ones.
  for (const pool of [common, rare]) {
    while (picks.length < n) {
      let best: string | undefined;
      let bestQ = -1;
      for (const k of pool) {
        if (picked.get(k)! >= size(k)) continue;
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
}

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
      ...(index ? { sitemapsListed: index.listed, sitemapsRead: index.read } : {}),
    };

    if (!adaptive) {
      const sample = seededSample(pages, budget, site);
      return { urls: [startUrl, ...sample], reasons: Object.fromEntries(sample.map((u) => [u, 'random' as const])), ...common };
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
    const { picks, picked, rare } = adaptiveSample(groups, budget, site);
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
    };
  }
  return undefined;
}
