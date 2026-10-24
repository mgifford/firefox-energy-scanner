/**
 * Parse a scan request from a GitHub issue body.
 *
 * This is untrusted public input. URLs are validated strictly: anything that is
 * not a public http(s) address is skipped and listed, both because a hosted
 * runner cannot reach private hosts and because the scanner must not be usable
 * to probe internal networks.
 *
 * The default is meant to be easy: paste URLs, nothing else is required.
 *   - one URL    -> crawl that site (www/non-www and http/https included)
 *   - a list     -> scan exactly those pages
 *   - runs       -> one visit per page in GitHub's cloud, which cannot
 *                   measure energy; repeated runs only on a machine that can
 *   - Lighthouse -> on, for the 10 heaviest pages
 * Bodies written for the older, longer form still parse.
 */

/** 'measure' scans the listed pages; 'crawl' follows links from the first. */
export type ScanMode = 'measure' | 'crawl';

/**
 * 'auto' uses the repository's energy-measuring machine when one is set up
 * (the ENERGY_RUNNER variable), otherwise GitHub's cloud. 'macos' is kept for
 * older requests that asked for a hosted Mac.
 */
export type RunnerChoice = 'auto' | 'cloud' | 'macos';

/** 'all' adds accessibility, best practices and SEO to performance. */
export type LighthouseChoice = 'none' | 'performance' | 'all';
/** 'top' audits the heaviest pages; 'every' audits all of them. */
export type LighthouseScope = 'top' | 'every';

/** A listed URL that will not be scanned, and why. Reported in the results. */
export interface NotScanned {
  url: string;
  reason: string;
}

export interface ScanRequest {
  mode: ScanMode;
  urls: string[];
  runner: RunnerChoice;
  /**
   * Measured runs per page on a machine that can measure energy. In the
   * cloud every page is visited once instead; see planRuns().
   */
  runs: number;
  /** Crawl mode only. */
  maxPages: number;
  include?: string;
  viewport: { width: number; height: number };
  lighthouse: LighthouseChoice;
  lighthouseScope: LighthouseScope;
  /** Lighthouse runs per audited page. */
  lighthouseRuns: number;
  /**
   * Entries left out of this scan — past the URL limit, not a public URL, or
   * extra lines when crawling from one URL. The request still runs on the
   * rest, and the results list these so nothing silently disappears.
   */
  notScanned: NotScanned[];
  /** Expected scanning time in GitHub's cloud, quoted when the run starts. */
  estimatedMinutes: number;
  errors: string[];
  notes: string[];
}

/** One visit per page keeps a long list cheap; 200 is about 15 minutes. */
export const MAX_URLS = 200;
export const MAX_RUNS = 30;
/** Runs per page on an energy-measuring machine. */
export const DEFAULT_RUNS = 10;
export const ENERGY_WARMUPS = 2;

/** Crawl page limits. A crawl visits each page once: 200 pages is ~15 minutes. */
export const MAX_CRAWL_PAGES = 200;
export const DEFAULT_CRAWL_PAGES = 50;

/**
 * Lighthouse cost. One run is ~15 s on a fast machine and slower on a shared
 * runner against a heavy page, so the estimate is deliberately generous.
 */
export const LIGHTHOUSE_SECONDS_PER_RUN = 25;
export const LIGHTHOUSE_TOP_PAGES = 10;
/** @deprecated kept for older callers; the heaviest-pages limit applies to both modes. */
export const LIGHTHOUSE_CRAWL_PAGES = LIGHTHOUSE_TOP_PAGES;

/** Seconds per measured page visit, from observed timings (load + settle). */
const SECONDS_PER_VISIT = 2.4 + 2.0;

export function parseLighthouseChoice(raw: string | undefined): LighthouseChoice {
  const value = (raw ?? '').toLowerCase().trim();
  if (!value || value.startsWith('no') || value.startsWith('off')) return 'none';
  if (value.includes('accessibility') || value.startsWith('all')) return 'all';
  return 'performance';
}

export function parseLighthouseScope(raw: string | undefined): LighthouseScope {
  return /every/i.test(raw ?? '') ? 'every' : 'top';
}

/**
 * Runs and warmups for a scan. A machine that cannot measure energy visits
 * each page once, cold — repeating would only refine timing medians, at a
 * multiple of the cost. A machine that can measure energy repeats each page
 * so the energy result can be resolved, scaled down for long lists so the
 * scan still fits the job budget.
 */
export function planRuns(
  urlCount: number,
  energyMachine: boolean,
  requested = DEFAULT_RUNS,
): { runs: number; warmups: number } {
  if (!energyMachine) return { runs: 1, warmups: 0 };
  const budget = JOB_BUDGET_MINUTES * 60 - 120;
  const fit = Math.floor(budget / (Math.max(1, urlCount) * SECONDS_PER_VISIT)) - ENERGY_WARMUPS;
  return { runs: Math.max(3, Math.min(requested, MAX_RUNS, fit)), warmups: ENERGY_WARMUPS };
}

const VIEWPORTS: Record<string, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  'tablet-portrait': { width: 768, height: 1024 },
  'tablet-landscape': { width: 1024, height: 768 },
  'mobile-portrait': { width: 390, height: 844 },
  'mobile-landscape': { width: 844, height: 390 },
};

/**
 * Resolve a viewport from the issue-form label.
 *
 * Matches the most specific label first so that "Tablet landscape" is not
 * captured by the "tablet portrait" entry. An explicit `WIDTHxHEIGHT` is
 * accepted too, bounded to sane values.
 */
export function parseViewport(raw: string | undefined): { width: number; height: number } {
  const value = (raw ?? '').toLowerCase().trim();
  if (!value) return VIEWPORTS.desktop!;

  const custom = /(\d{2,5})\s*[x×]\s*(\d{2,5})/.exec(value);
  if (custom) {
    const width = Math.min(Math.max(Number(custom[1]), 240), 3840);
    const height = Math.min(Math.max(Number(custom[2]), 240), 2160);
    return { width, height };
  }

  const isMobile = value.includes('mobile');
  const isTablet = value.includes('tablet');
  const isLandscape = value.includes('landscape');
  if (isMobile) return VIEWPORTS[isLandscape ? 'mobile-landscape' : 'mobile-portrait']!;
  if (isTablet) return VIEWPORTS[isLandscape ? 'tablet-landscape' : 'tablet-portrait']!;
  return VIEWPORTS.desktop!;
}

/**
 * Make issue text safe to echo back: one line, no control characters, and
 * bounded. Everything the parser quotes from the body goes through this,
 * because it ends up in workflow outputs and in a public comment.
 */
export function clip(text: string, max = 200): string {
  const oneLine = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/** Reject non-public hosts. */
export function isPublicHttpUrl(candidate: string): boolean {
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host === '::1') return false;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;

  if (host.startsWith('[')) {
    const inner = host.slice(1, -1);
    if (inner === '::1' || inner.startsWith('fe80:') || inner.startsWith('fc') || inner.startsWith('fd')) {
      return false;
    }
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 127 || a === 10) return false;
    if (a === 169 && b === 254) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a >= 224) return false;
  }

  if (!v4 && !host.startsWith('[') && !host.includes('.')) return false;

  return true;
}

/** Extract a section from a GitHub issue-forms body (`### Label` + value). */
export function extractSection(body: string, label: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(
    (l) => l.trim().toLowerCase() === `### ${label.toLowerCase()}`,
  );
  if (start === -1) return undefined;

  const collected: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,6}\s/.test(line.trim())) break;
    collected.push(line);
  }
  const value = collected.join('\n').trim();
  return value === '_No response_' ? undefined : value;
}

/**
 * Wall-clock budget for one scan job.
 *
 * GitHub's hard ceiling is 360 minutes, but shared runners are billed and
 * noisy, and a multi-hour scan on one is poor value.
 */
export const JOB_BUDGET_MINUTES = 90;

/**
 * Estimate wall-clock minutes for a request in GitHub's cloud (one visit per
 * page). Derived from observed timings: ~2.4 s per load plus ~2.0 s settle,
 * with a one-off idle baseline.
 */
export function estimateMinutes(request: {
  mode: ScanMode;
  urls: string[];
  maxPages: number;
  runs?: number;
  /** True for a machine that measures energy and so repeats each page. */
  energyMachine?: boolean;
  lighthouse?: LighthouseChoice;
  lighthouseScope?: LighthouseScope;
}): number {
  const baselineSeconds = 15;
  const pages = request.mode === 'crawl' ? request.maxPages : request.urls.length;
  const plan =
    request.mode === 'crawl'
      ? { runs: 1, warmups: 0 }
      : planRuns(pages, !!request.energyMachine, request.runs);
  return (baselineSeconds + pages * (plan.runs + plan.warmups) * SECONDS_PER_VISIT + lighthouseSeconds(request)) / 60;
}

function lighthouseSeconds(request: {
  mode: ScanMode;
  urls: string[];
  maxPages: number;
  lighthouse?: LighthouseChoice;
  lighthouseScope?: LighthouseScope;
}): number {
  if (!request.lighthouse || request.lighthouse === 'none') return 0;
  const pages = request.mode === 'crawl' ? request.maxPages : request.urls.length;
  const audited = request.lighthouseScope === 'every' ? pages : Math.min(pages, LIGHTHOUSE_TOP_PAGES);
  return audited * LIGHTHOUSE_SECONDS_PER_RUN;
}

/**
 * What to scan. The new form's "What to scan" field wins; the older form's
 * "Scan mode" is honoured, except that a pasted list is always scanned as a
 * list — crawling from its first line and ignoring the rest is never what a
 * list means.
 */
function chooseMode(body: string, urlCount: number, notes: string[]): ScanMode {
  const what = extractSection(body, 'What to scan')?.toLowerCase();
  const legacy = extractSection(body, 'Scan mode')?.toLowerCase();
  const wantsCrawl = what ? what.startsWith('crawl') : legacy?.includes('crawl') ?? false;
  const wantsList = what ? what.startsWith('only') : legacy !== undefined && !legacy.includes('crawl');

  if (wantsCrawl && urlCount > 1 && !what) {
    notes.push(`${urlCount} URLs were listed, so they are scanned as a list. To crawl a site, give one URL.`);
    return 'measure';
  }
  if (wantsCrawl) return 'crawl';
  if (wantsList) return 'measure';
  return urlCount === 1 ? 'crawl' : 'measure';
}

function chooseRunner(body: string): RunnerChoice {
  const where = extractSection(body, 'Where to run')?.toLowerCase();
  // "Auto — ... otherwise GitHub's cloud" also mentions the cloud, so key on
  // how the label starts.
  if (where) return where.startsWith('auto') ? 'auto' : /cloud/.test(where) ? 'cloud' : 'auto';
  // Older form: "Measurement type".
  const legacy = (extractSection(body, 'Measurement type') ?? '').toLowerCase();
  if (legacy.includes('self')) return 'auto';
  if (legacy.includes('macos')) return 'macos';
  return legacy ? 'cloud' : 'auto';
}

export function parseScanRequest(body: string): ScanRequest {
  const errors: string[] = [];
  const notes: string[] = [];

  const urlBlock = extractSection(body, 'URLs') ?? '';
  const candidates = urlBlock
    .split(/[\r\n,]+/)
    .map((l) => l.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean);

  const urls: string[] = [];
  const notScanned: NotScanned[] = [];
  for (const c of candidates) {
    if (isPublicHttpUrl(c)) {
      if (!urls.includes(c)) urls.push(c);
    } else {
      notScanned.push({ url: clip(c), reason: 'not a public http(s) URL' });
    }
  }

  // One bad line should not sink a request: scan the valid URLs and list the
  // rest. Only a request with nothing scannable is rejected.
  if (urls.length === 0) {
    errors.push(
      'No valid public http(s) URLs were found in the request.' +
        (notScanned.length
          ? ` Not usable: ${notScanned.slice(0, 5).map((n) => n.url).join(', ')}`
          : ''),
    );
  }

  const mode = chooseMode(body, urls.length, notes);

  if (mode === 'crawl' && urls.length > 1) {
    for (const u of urls.slice(1)) {
      notScanned.push({ url: u, reason: 'crawling starts from one URL' });
    }
    urls.length = 1;
  }
  if (mode === 'measure' && urls.length > MAX_URLS) {
    const extra = urls.length - MAX_URLS;
    for (const u of urls.slice(MAX_URLS)) {
      notScanned.push({ url: u, reason: `over the ${MAX_URLS}-URL limit` });
    }
    notes.push(
      `${urls.length} URLs were listed; the first ${MAX_URLS} are scanned and the other ${extra} ` +
        'are listed as not scanned. Open a second request to cover them.',
    );
    urls.length = MAX_URLS;
  }

  const runner = chooseRunner(body);

  // Older form only; the new form leaves runs to planRuns().
  const runsRaw = extractSection(body, 'Measured runs per URL');
  let runs = DEFAULT_RUNS;
  if (runsRaw) {
    const parsed = Number.parseInt(runsRaw.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      runs = Math.min(parsed, MAX_RUNS);
    }
  }

  const pagesRaw = extractSection(body, 'Maximum pages to crawl');
  let maxPages = DEFAULT_CRAWL_PAGES;
  if (pagesRaw) {
    const parsed = Number.parseInt(pagesRaw.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      maxPages = Math.min(parsed, MAX_CRAWL_PAGES);
      if (parsed > MAX_CRAWL_PAGES && mode === 'crawl') {
        notes.push(`Requested ${parsed} pages; capped at ${MAX_CRAWL_PAGES}.`);
      }
    } else if (mode === 'crawl') {
      notes.push(`Could not read a page limit from "${clip(pagesRaw, 40)}"; using ${DEFAULT_CRAWL_PAGES}.`);
    }
  }

  const includeRaw = extractSection(body, 'Include pattern');
  const include = includeRaw ? includeRaw.trim() : undefined;
  if (include) {
    if (/[\r\n]/.test(include)) {
      errors.push('Include pattern must be a single line.');
    } else {
      try {
        new RegExp(include);
      } catch {
        errors.push(`Include pattern is not a valid regular expression: ${clip(include, 80)}`);
      }
    }
  }

  const viewport = parseViewport(extractSection(body, 'Viewport'));

  const lighthouseRaw = extractSection(body, 'Lighthouse');
  const lighthouse = parseLighthouseChoice(lighthouseRaw);
  let lighthouseScope = parseLighthouseScope(lighthouseRaw);

  const pages = mode === 'crawl' ? maxPages : urls.length;
  let minutes = estimateMinutes({ mode, urls, maxPages, lighthouse, lighthouseScope });
  // Lighthouse on every page of a long list is the one way to overrun the
  // budget; fall back to the heaviest pages rather than reject the request.
  if (minutes > JOB_BUDGET_MINUTES && lighthouseScope === 'every') {
    lighthouseScope = 'top';
    minutes = estimateMinutes({ mode, urls, maxPages, lighthouse, lighthouseScope });
    notes.push(
      `Lighthouse on all ${pages} pages would overrun the ${JOB_BUDGET_MINUTES}-minute budget, so it ` +
        `audits the ${LIGHTHOUSE_TOP_PAGES} heaviest instead.`,
    );
  }
  if (minutes > JOB_BUDGET_MINUTES) {
    errors.push(
      `This request would take roughly ${Math.round(minutes)} minutes, over the ${JOB_BUDGET_MINUTES}-minute budget. ` +
        (mode === 'crawl' ? 'Lower the page limit.' : 'Split the URLs across two requests.'),
    );
  }

  notes.unshift(
    mode === 'crawl'
      ? `Crawling ${urls[0] ?? 'the site'} and the pages it links to on the same site, up to ${maxPages} pages, once each.`
      : `Scanning ${urls.length} listed page${urls.length === 1 ? '' : 's'}.`,
  );
  if (lighthouse !== 'none') {
    const audited = lighthouseScope === 'every' ? 'every page' : `the ${Math.min(LIGHTHOUSE_TOP_PAGES, pages)} heaviest page${Math.min(LIGHTHOUSE_TOP_PAGES, pages) === 1 ? '' : 's'}`;
    notes.push(`Lighthouse (${lighthouse === 'all' ? 'all categories' : 'performance'}) audits ${audited}, in Chromium, after the Firefox scan.`);
  }

  return {
    mode,
    urls,
    runner,
    runs,
    maxPages,
    ...(include ? { include } : {}),
    viewport,
    lighthouse,
    lighthouseScope,
    lighthouseRuns: 1,
    notScanned,
    estimatedMinutes: Math.round(minutes * 10) / 10,
    errors,
    notes,
  };
}
