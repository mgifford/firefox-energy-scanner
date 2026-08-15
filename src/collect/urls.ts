/** URL normalization and crawl filtering. Pure functions, unit tested. */

export type QueryStrategy = 'strip' | 'keep';

export interface NormalizeOptions {
  queryStrategy?: QueryStrategy;
}

/**
 * Normalize a URL for deduplication.
 *
 * - drops the fragment (never a separate document)
 * - drops or sorts the query string per policy (sorting makes ?a=1&b=2 and
 *   ?b=2&a=1 the same page)
 * - removes a trailing slash except at the site root
 * - lowercases scheme and host, and drops a default port
 *
 * Aggressive normalization is what stops crawls exploding on faceted URLs.
 */
export function normalizeUrl(input: string, options: NormalizeOptions = {}): string {
  const strategy = options.queryStrategy ?? 'strip';
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input;
  }

  u.hash = '';
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();

  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }

  if (strategy === 'strip') {
    u.search = '';
  } else {
    const params = [...u.searchParams.entries()].sort(([a], [b]) =>
      a === b ? 0 : a < b ? -1 : 1,
    );
    u.search = '';
    for (const [k, v] of params) u.searchParams.append(k, v);
  }

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }

  return u.toString();
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Decide whether a URL should be crawled.
 *
 * Patterns are regular expressions matched against the PATH (plus query when
 * present), so '^/admin' behaves as users expect.
 */
export function matchesRules(
  url: string,
  include: string[] = [],
  exclude: string[] = [],
): boolean {
  let target: string;
  try {
    const u = new URL(url);
    target = u.pathname + u.search;
  } catch {
    target = url;
  }

  for (const pattern of exclude) {
    if (safeTest(pattern, target)) return false;
  }
  if (include.length === 0) return true;
  return include.some((pattern) => safeTest(pattern, target));
}

function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    // An invalid pattern must not silently match everything.
    return false;
  }
}

/** Deterministic ordering so repeated crawls visit pages in the same order. */
export function sortUrls(urls: string[]): string[] {
  return [...urls].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

/** Extract the registrable-ish host for first/third-party classification. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * First-party check.
 *
 * Treats exact host matches and subdomains of the target's host as first
 * party (e.g. static.example.com for example.com). This is a heuristic and is
 * documented as such; it does not consult the public suffix list.
 */
export function isThirdParty(resourceUrl: string, pageUrl: string): boolean {
  const rh = hostOf(resourceUrl);
  const ph = hostOf(pageUrl);
  if (!rh || !ph) return false;
  if (rh === ph) return false;
  return !(rh.endsWith(`.${ph}`) || ph.endsWith(`.${rh}`));
}
