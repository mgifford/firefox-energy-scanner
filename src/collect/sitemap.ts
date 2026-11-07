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
import type { SampleHealth } from '../core/types.js';

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
  reasons: Record<string, 'random' | 'representative' | 'proportional' | 'rare-section' | 'video-page' | 'legacy-page'>;
  /** What the sitemap said about the eligible pages: translations set aside, video and image pages, last-modified dates. */
  sitemapMeta?: { translationsSetAside?: number; seriesSetAside?: number; videoPages?: number; imagePages?: number; dated?: number; oldest?: string; newest?: string };
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
  /** Listed URLs the server said are not there (404, 410): skipped, and replaced. */
  gone?: PageCheck[];
  /** What checking the sample's URLs found. */
  health?: SampleHealth;
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

/** What a sitemap says about one page, beyond its address. */
export interface SitemapEntry {
  loc: string;
  /** <lastmod>, as written (W3C datetime). */
  lastmod?: string;
  /** <image:image> and <video:video> entries (Google's sitemap extensions). */
  images: number;
  videos: number;
  /** <xhtml:link rel="alternate" hreflang> translations of the page, itself included when listed. */
  alternates: { hreflang: string; href: string }[];
}

/** The <url> entries of a urlset, with their metadata. Pure. */
export function parseSitemapEntries(xml: string): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  const decode = (v: string) => v.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]!);
  for (const m of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    if (out.length >= MAX_LOCS) break;
    const body = m[1]!;
    const loc = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/i.exec(body)?.[1];
    if (!loc || !/^https?:\/\//i.test(decode(loc))) continue;
    const lastmod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(body)?.[1];
    const alternates: SitemapEntry['alternates'] = [];
    for (const a of body.matchAll(/<xhtml:link\b([^>]*)>/gi)) {
      const at = (n: string) => new RegExp(`\\b${n}\\s*=\\s*["']([^"']*)["']`, 'i').exec(a[1]!)?.[1];
      const href = at('href');
      const hreflang = at('hreflang');
      if (at('rel') === 'alternate' && href && hreflang) alternates.push({ hreflang: hreflang.toLowerCase(), href: decode(href) });
    }
    out.push({
      loc: decode(loc),
      ...(lastmod ? { lastmod } : {}),
      images: (body.match(/<image:image\b/gi) ?? []).length,
      videos: (body.match(/<video:video\b/gi) ?? []).length,
      alternates,
    });
  }
  return out;
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
  reason: 'representative' | 'rare-section' | 'proportional' | 'video-page' | 'legacy-page';
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
  /** Page keys already chosen (named pages, key pages): not drawn again. */
  taken?: string[];
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
    // What the sitemaps say about each page, by page key, for the sample's choices.
    const entries = new Map<string, SitemapEntry>();
    const keep = (xml: string) => {
      for (const e of parseSitemapEntries(xml)) if (!entries.has(opts.pageKey(e.loc))) entries.set(opts.pageKey(e.loc), e);
    };
    if (!parsed.isIndex) keep(res.text);
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
          keep(c.text);
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
    const taken = new Set(opts.taken ?? []);
    const listedPages = opts.select(locs, sites).filter((u) => opts.pageKey(u) !== startKey && !taken.has(opts.pageKey(u)));
    // Translations share a template: one page of each translation group is eligible.
    const translated = collapseTranslations(listedPages, entries, opts.pageKey, startKey, site);
    // Pages that differ only by a year (annual-report-2022, -2023, -2024) share one too.
    const { pages, setAside: seriesSetAside } = collapseYearSeries(translated.pages, site);
    const meta = sitemapMetaOf(pages, entries, opts.pageKey, translated.setAside, seriesSetAside);
    if (pages.length === 0) continue;
    const budget = Math.max(0, opts.maxPages - 1);
    const common = {
      source: res.url || candidate,
      listed: listedPages.length,
      ...(meta ? { sitemapMeta: meta } : {}),
      capped,
      order: SAMPLE_ORDER,
      ...(index ? { sitemapsListed: index.listed, sitemapsRead: index.read } : {}),
    };

    // Draw, check the new picks, skip any that are files, draw again: each
    // round only checks the replacements. Capped, so a sitemap of mostly
    // PDFs cannot turn into thousands of requests.
    //
    // A draw is also cleaned: a page that is gone (404, 410), that redirects
    // to a page already in the sample, or that redirects to another site is
    // replaced in the same way, as update_sitemap.py in mgifford's
    // sitemap-tools does for a whole sitemap.
    const skip = new Set<string>();
    const notHtml: PageCheck[] = [];
    const gone: PageCheck[] = [];
    const finalOf = new Map<string, string>();
    const health: SampleHealth = { checked: 0, html: 0, files: 0, gone: 0, redirected: 0, duplicates: 0, offSite: 0, unknown: 0 };
    const checked = new Set<string>();
    const maxChecks = budget * CHECKS_PER_PAGE + 5;
    const settle = async (draw: () => string[]): Promise<string[]> => {
      let urls = draw();
      while (opts.checkPages) {
        const before = skip.size;
        const fresh = urls.filter((u) => !checked.has(u)).slice(0, Math.max(0, maxChecks - checked.size));
        if (fresh.length) {
          const results = await opts.checkPages(fresh);
          for (const u of fresh) checked.add(u);
          for (const r of results) {
            health.checked++;
            if (r.finalUrl) {
              finalOf.set(r.url, r.finalUrl);
              health.redirected++;
            }
            if (r.verdict === 'file') {
              health.files++;
              notHtml.push(r);
              skip.add(r.url);
            } else if (r.verdict === 'gone') {
              health.gone++;
              gone.push(r);
              skip.add(r.url);
            } else if (r.finalUrl && !sites.has(opts.siteOf(r.finalUrl))) {
              health.offSite++;
              skip.add(r.url);
            } else r.verdict === 'html' ? health.html++ : health.unknown++;
          }
        }
        // Two sampled URLs that lead to one page: the later one is replaced.
        const seen = new Set([startKey, ...taken]);
        for (const u of urls) {
          if (skip.has(u)) continue;
          const k = opts.pageKey(finalOf.get(u) ?? u);
          if (seen.has(k)) {
            skip.add(u);
            health.duplicates++;
          } else seen.add(k);
        }
        if (skip.size === before) break;
        urls = draw();
        if (checked.size >= maxChecks && urls.every((u) => checked.has(u))) break;
      }
      return urls;
    };
    const withSkips = () => ({
      ...(notHtml.length ? { notHtml } : {}),
      ...(gone.length ? { gone } : {}),
      ...(opts.checkPages && health.checked ? { health } : {}),
    });

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
    const strataMeta = new Map<string, { section: string; sitemap?: string }>();
    const groupOf = new Map<string, string>();
    for (const u of pages) {
      const section = urlSection(u);
      const sitemap = splitByChild ? childOf.get(opts.pageKey(u)) : undefined;
      const key = sitemap ? `${sitemap} ${section}` : section;
      if (!groups.has(key)) {
        groups.set(key, []);
        strataMeta.set(key, { section, ...(sitemap ? { sitemap } : {}) });
      }
      groups.get(key)!.push(u);
      groupOf.set(u, key);
    }
    const draw = () => {
      const d = adaptiveSample(groups, budget, site, skip);
      return { ...d, picks: withSpecialPages(d.picks, pages, budget, site, skip, groupOf, (u) => entries.get(opts.pageKey(u))) };
    };
    let drawn = draw();
    await settle(() => (drawn = draw()).picks.map((p) => p.url));
    const { picks, rare } = drawn;
    const pickedFrom = new Map<string, string[]>();
    for (const p of picks) pickedFrom.set(p.key, [...(pickedFrom.get(p.key) ?? []), p.url]);
    const strata: Stratum[] = [...groups.keys()]
      .map((k) => ({
        ...strataMeta.get(k)!,
        listed: groups.get(k)!.length,
        picked: pickedFrom.get(k)?.length ?? 0,
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

/** At least this many pages before a sample makes room for a video page or a legacy page. */
const SPECIAL_MIN_BUDGET = 6;
/** Pages last modified this long before the newest are likely to use an older template. */
const LEGACY_YEARS = 3;
const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const dateOf = (e: SitemapEntry | undefined) => {
  const t = e?.lastmod ? Date.parse(e.lastmod) : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
};

/**
 * One page of each translation group, by the sitemap's hreflang alternates:
 * translations share a template, so measuring each language spends the
 * budget on the same page several times. The start page's language is kept
 * when the sitemap names it; otherwise the first in hash order. Pure.
 */
export function collapseTranslations(
  pages: string[],
  entries: Map<string, SitemapEntry>,
  keyOf: (u: string) => string,
  startKey: string,
  seed: string,
): { pages: string[]; setAside: number } {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    if (r !== k) parent.set(k, r);
    return r;
  };
  const langOf = new Map<string, string>();
  for (const [k, e] of entries) {
    for (const a of e.alternates) {
      const ak = keyOf(a.href);
      langOf.set(ak, a.hreflang);
      const [x, y] = [find(k), find(ak)];
      if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
    }
  }
  if (!langOf.size) return { pages, setAside: 0 };
  const startLang = langOf.get(startKey);
  const byGroup = new Map<string, string[]>();
  for (const u of pages) {
    const g = find(keyOf(u));
    byGroup.set(g, [...(byGroup.get(g) ?? []), u]);
  }
  const keep = new Set<string>();
  for (const members of byGroup.values()) {
    const sameLang = startLang ? members.filter((u) => langOf.get(keyOf(u)) === startLang) : [];
    keep.add(hashOrder(sameLang.length ? sameLang : members, seed)[0]!);
  }
  const kept = pages.filter((u) => keep.has(u));
  return { pages: kept, setAside: pages.length - kept.length };
}

/** A summary of what the sitemap said about the eligible pages. Undefined when it said nothing. */
export function sitemapMetaOf(
  pages: string[],
  entries: Map<string, SitemapEntry>,
  keyOf: (u: string) => string,
  translationsSetAside: number,
  seriesSetAside = 0,
): SiteSample['sitemapMeta'] {
  const es = pages.map((u) => entries.get(keyOf(u))).filter((e): e is SitemapEntry => !!e);
  const dates = es.map(dateOf).filter((t): t is number => t !== undefined);
  const videoPages = es.filter((e) => e.videos > 0).length;
  const imagePages = es.filter((e) => e.images > 0).length;
  if (!dates.length && !videoPages && !imagePages && !translationsSetAside && !seriesSetAside) return undefined;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return {
    ...(translationsSetAside ? { translationsSetAside } : {}),
    ...(seriesSetAside ? { seriesSetAside } : {}),
    ...(videoPages ? { videoPages } : {}),
    ...(imagePages ? { imagePages } : {}),
    ...(dates.length ? { dated: dates.length, oldest: iso(Math.min(...dates)), newest: iso(Math.max(...dates)) } : {}),
  };
}

/**
 * Two pages a draw of sections can miss, each in place of the last page of a
 * large section's proportional share: a page with video, when the sitemap
 * marks some (video is the heaviest thing a page can load), and the page
 * least recently modified, when the sitemap spans more than three years
 * (old pages often keep an older template). Neither when the sample is small.
 */
export function withSpecialPages(
  picks: AdaptivePick[],
  pages: string[],
  budget: number,
  seed: string,
  skip: ReadonlySet<string>,
  groupOf: Map<string, string>,
  entryOf: (u: string) => SitemapEntry | undefined,
): AdaptivePick[] {
  if (budget < SPECIAL_MIN_BUDGET) return picks;
  const out = [...picks];
  const inSample = new Set(out.map((p) => p.url));
  const replaceLast = (url: string, reason: AdaptivePick['reason']) => {
    const i = out.map((p) => p.reason).lastIndexOf('proportional');
    if (i < 0) return;
    inSample.delete(out[i]!.url);
    out[i] = { url, key: groupOf.get(url)!, reason };
    inSample.add(url);
  };
  const eligible = (u: string) => !skip.has(u) && !inSample.has(u);

  if (!out.some((p) => (entryOf(p.url)?.videos ?? 0) > 0)) {
    const video = hashOrder(pages.filter((u) => (entryOf(u)?.videos ?? 0) > 0 && eligible(u)), `${seed}|video`)[0];
    if (video) replaceLast(video, 'video-page');
  }

  const dated = pages.map((u) => [u, dateOf(entryOf(u))] as const).filter((x): x is readonly [string, number] => x[1] !== undefined);
  if (dated.length) {
    const newest = Math.max(...dated.map((x) => x[1]));
    const cutoff = newest - LEGACY_YEARS * YEAR_MS;
    const hasLegacy = out.some((p) => (dateOf(entryOf(p.url)) ?? Infinity) < cutoff);
    const oldest = dated
      .filter(([u, t]) => t < cutoff && eligible(u))
      .sort((a, b) => a[1] - b[1] || (hashRank(a[0], seed) < hashRank(b[0], seed) ? -1 : 1))[0];
    if (!hasLegacy && oldest) replaceLast(oldest[0], 'legacy-page');
  }
  return out;
}

/**
 * A year in an address: -2023, /2023, _2023, or a range, -2022-2023
 * (top-task-finder's pattern), followed by a separator or the end.
 */
const YEAR_TOKEN = /[-_/]((?:19|20)\d{2})(?:[-_]((?:19|20)\d{2}))?(?=[-_/?#.]|$)/g;

/**
 * Pages whose addresses differ only by a year (annual-report-2022, -2023,
 * -2024; /budget/2024, /budget/2025) are one series built on one template:
 * only the most recent is eligible. A news archive (/news/2024/05/story) is
 * untouched, since its pages differ by more than the year. Pure.
 */
export function collapseYearSeries(pages: string[], seed: string): { pages: string[]; setAside: number } {
  const series = new Map<string, { url: string; year: number }[]>();
  for (const u of pages) {
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      continue;
    }
    const years = [...url.pathname.matchAll(YEAR_TOKEN)].flatMap((m) => [m[1], m[2]].filter(Boolean).map(Number));
    if (!years.length) continue;
    const key = `${url.host.replace(/^www\./, '')}${url.pathname.replace(YEAR_TOKEN, (m) => `${m[0]![0]}{YEAR}`)}${url.search}`;
    series.set(key, [...(series.get(key) ?? []), { url: u, year: Math.max(...years) }]);
  }
  const drop = new Set<string>();
  for (const members of series.values()) {
    if (members.length < 2) continue;
    const newest = Math.max(...members.map((m) => m.year));
    const keep = hashOrder(members.filter((m) => m.year === newest).map((m) => m.url), seed)[0];
    for (const m of members) if (m.url !== keep) drop.add(m.url);
  }
  return drop.size ? { pages: pages.filter((u) => !drop.has(u)), setAside: drop.size } : { pages, setAside: 0 };
}
