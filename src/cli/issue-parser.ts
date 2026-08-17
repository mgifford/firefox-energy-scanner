/**
 * Parse a scan request from a GitHub issue body.
 *
 * This is untrusted public input. URLs are validated strictly: anything that is
 * not a public http(s) address is rejected, both because a hosted runner cannot
 * reach private hosts and because the scanner must not be usable to probe
 * internal networks.
 */

export type ScanMode = 'measure' | 'crawl';

export type RunnerChoice = 'linux' | 'macos' | 'self-hosted';

export interface ScanRequest {
  mode: ScanMode;
  urls: string[];
  runner: RunnerChoice;
  runs: number;
  /** Crawl mode only. */
  maxPages: number;
  include?: string;
  viewport: { width: number; height: number };
  errors: string[];
  notes: string[];
}

export const MAX_URLS = 20;
export const MAX_RUNS = 30;
export const DEFAULT_RUNS = 8;

/**
 * Crawl page limits.
 *
 * A crawl measures each page once, so cost scales linearly with pages: 200
 * pages is roughly 15 minutes. A measure request repeats each URL `runs` times
 * plus warmups, so it scales far more steeply — 200 URLs at 8 runs each would
 * be about 2.5 hours. Crawls are therefore allowed many more pages.
 */
export const MAX_CRAWL_PAGES = 200;
export const DEFAULT_CRAWL_PAGES = 50;

/**
 * Wall-clock budget for one scan job.
 *
 * GitHub's hard ceiling is 360 minutes, but shared runners are billed and
 * noisy, and a multi-hour scan on one is poor value: the longer it runs, the
 * more thermal and neighbour drift it accumulates. 90 minutes leaves a full
 * 200-page crawl (~15 min) and the largest permitted measure request
 * (20 URLs x 30 runs, ~47 min) comfortably inside.
 */
export const JOB_BUDGET_MINUTES = 90;

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
 * Estimate wall-clock minutes for a request.
 *
 * Derived from observed timings: ~2.4 s per run plus ~2.0 s settle, with a
 * one-off idle baseline. Used to reject requests that cannot finish rather
 * than letting them hit the job timeout after an hour of work.
 */
export function estimateMinutes(request: {
  mode: ScanMode;
  urls: string[];
  runs: number;
  maxPages: number;
}): number {
  const perRunSeconds = 2.4 + 2.0;
  const baselineSeconds = 15;
  const pages = request.mode === 'crawl' ? request.maxPages : request.urls.length;
  const runsPerPage = request.mode === 'crawl' ? 1 : request.runs + 2; // + warmups
  return (baselineSeconds + pages * runsPerPage * perRunSeconds) / 60;
}

export function parseScanRequest(body: string): ScanRequest {
  const errors: string[] = [];
  const notes: string[] = [];

  const modeRaw = (extractSection(body, 'Scan mode') ?? 'measure').toLowerCase();
  const mode: ScanMode = modeRaw.includes('crawl') ? 'crawl' : 'measure';

  const urlBlock = extractSection(body, 'URLs') ?? '';
  const candidates = urlBlock
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean);

  const urls: string[] = [];
  const rejected: string[] = [];
  for (const c of candidates) {
    if (isPublicHttpUrl(c)) {
      if (!urls.includes(c)) urls.push(c);
    } else {
      rejected.push(c);
    }
  }

  if (urls.length === 0) errors.push('No valid public http(s) URLs were found in the request.');
  if (rejected.length > 0) {
    errors.push(
      `Rejected ${rejected.length} entr${rejected.length === 1 ? 'y' : 'ies'} that are not public web URLs: ` +
        rejected.slice(0, 5).join(', '),
    );
  }

  if (mode === 'crawl' && urls.length > 1) {
    notes.push(`Crawl mode uses a single start URL; using ${urls[0]} and ignoring the rest.`);
    urls.length = 1;
  }
  if (mode === 'measure' && urls.length > MAX_URLS) {
    errors.push(
      `Too many URLs (${urls.length}); the limit for measure mode is ${MAX_URLS}. ` +
        `Use crawl mode to cover more pages, or split the request.`,
    );
    urls.length = MAX_URLS;
  }

  // 'self-hosted' is the only option that can produce energy data, and only
  // when a physical Apple Silicon runner is actually registered.
  const runnerRaw = (extractSection(body, 'Measurement type') ?? 'linux').toLowerCase();
  const runner: RunnerChoice = runnerRaw.includes('self')
    ? 'self-hosted'
    : runnerRaw.includes('macos')
      ? 'macos'
      : 'linux';
  if (runner !== 'self-hosted') {
    notes.push(
      'Hosted runners have no power-measurement hardware, so this scan reports network, ' +
        'CO2e, timing and page structure only — no energy.',
    );
  }

  const runsRaw = extractSection(body, 'Measured runs per URL');
  let runs = DEFAULT_RUNS;
  if (runsRaw) {
    const parsed = Number.parseInt(runsRaw.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      runs = Math.min(parsed, MAX_RUNS);
      if (parsed > MAX_RUNS) notes.push(`Requested ${parsed} runs; capped at ${MAX_RUNS}.`);
    } else {
      notes.push(`Could not read a run count from "${runsRaw}"; using ${DEFAULT_RUNS}.`);
    }
  }

  const pagesRaw = extractSection(body, 'Maximum pages to crawl');
  let maxPages = DEFAULT_CRAWL_PAGES;
  if (pagesRaw) {
    const parsed = Number.parseInt(pagesRaw.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      maxPages = Math.min(parsed, MAX_CRAWL_PAGES);
      if (parsed > MAX_CRAWL_PAGES) {
        notes.push(`Requested ${parsed} pages; capped at ${MAX_CRAWL_PAGES}.`);
      }
    } else {
      notes.push(`Could not read a page limit from "${pagesRaw}"; using ${DEFAULT_CRAWL_PAGES}.`);
    }
  }

  const includeRaw = extractSection(body, 'Include pattern');
  const include = includeRaw ? includeRaw.trim() : undefined;
  if (include) {
    try {
      new RegExp(include);
    } catch {
      errors.push(`Include pattern is not a valid regular expression: ${include}`);
    }
  }

  const viewport = parseViewport(extractSection(body, 'Viewport'));

  // Reject work that cannot finish inside the job budget, with a concrete fix.
  const request = { mode, urls, runs, maxPages };
  const minutes = estimateMinutes(request);
  if (minutes > JOB_BUDGET_MINUTES) {
    if (mode === 'measure') {
      errors.push(
        `This request would take roughly ${Math.round(minutes)} minutes, over the ${JOB_BUDGET_MINUTES}-minute budget. ` +
          `Reduce the run count or the number of URLs, or use crawl mode (one run per page).`,
      );
    } else {
      errors.push(
        `A ${maxPages}-page crawl would take roughly ${Math.round(minutes)} minutes, over the ` +
          `${JOB_BUDGET_MINUTES}-minute budget. Lower the page limit.`,
      );
    }
  } else if (minutes > 60) {
    notes.push(`Estimated runtime is about ${Math.round(minutes)} minutes.`);
  }

  if (mode === 'crawl') {
    notes.push(
      'Crawl mode measures each page once. It is for discovery and ranking, not for ' +
        'regression comparison — single runs cannot separate a real difference from noise.',
    );
  }

  return { mode, urls, runner, runs, maxPages, ...(include ? { include } : {}), viewport, errors, notes };
}
