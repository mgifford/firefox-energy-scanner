/**
 * The bounded public-site pilot plan.
 *
 * This is structural discovery in Chromium, not a Firefox energy measurement.
 * It refuses private/local addresses and requires an explicit public-site
 * confirmation in the runner. It never clicks, submits a form, authenticates,
 * or runs an experiment.
 */

export const PILOT_SCHEMA = 'public-site-pilot/1';
export const DEFAULT_PILOT_PAGES = 20;
export const MAX_PILOT_PAGES = 50;

export interface PilotOptions {
  url: string;
  name?: string;
  maxPages?: number;
  outDir?: string;
}

export interface PilotPlan {
  schema: typeof PILOT_SCHEMA;
  site: { url: string; name: string };
  maxPages: number;
  outDir: string;
  resultPattern: string;
  structural: true;
  energy: 'not-measured';
  environment: { WEB_ENERGY_TEST_ENGINE: 'chromium' };
  crawl: string[];
  followUps: string[][];
  limitations: string[];
}

const PRIVATE_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.test|.*\.example|.*\.invalid|0\.0\.0\.0|\[?::1\]?|\[?f[cd][0-9a-f:]*\]?|\[?fe80:[0-9a-f:]*\]?)$/i;

/** Refuse anything that is not an explicit public HTTPS page. */
export function validatePilotUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new Error(`Not a URL: ${input}`);
  }
  if (u.protocol !== 'https:') throw new Error('The pilot requires a public https:// URL.');
  if (u.username || u.password) throw new Error('The pilot URL must not contain credentials.');
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host)) throw new Error(`Refusing a private/local host: ${host}`);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b! >= 64 && b! <= 127)
    ) {
      throw new Error(`Refusing a private/local address: ${host}`);
    }
  }
  u.hash = '';
  return u.toString();
}

export function pilotName(input: string): string {
  const raw = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return raw || 'site';
}

export function buildPilotPlan(options: PilotOptions): PilotPlan {
  const url = validatePilotUrl(options.url);
  const maxPages = options.maxPages ?? DEFAULT_PILOT_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PILOT_PAGES) {
    throw new Error(`--max-pages must be an integer from 1 to ${MAX_PILOT_PAGES}.`);
  }
  const host = new URL(url).hostname;
  const name = pilotName(options.name ?? host);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = options.outDir ?? `results/pilot-${name}-${stamp}`;
  const resultPattern = `${outDir}/crawl-*.json`;
  return {
    schema: PILOT_SCHEMA,
    site: { url, name },
    maxPages,
    outDir,
    resultPattern,
    structural: true,
    energy: 'not-measured',
    environment: { WEB_ENERGY_TEST_ENGINE: 'chromium' },
    crawl: [
      'node',
      'dist/cli/index.js',
      'crawl',
      url,
      '--max-pages',
      String(maxPages),
      '--max-depth',
      '3',
      '--no-energy',
      '--lighthouse',
      '--trace',
      '--out',
      outDir,
    ],
    followUps: [
      ['node', 'dist/cli/index.js', 'patterns', resultPattern, '--write'],
      ['node', 'dist/cli/index.js', 'investigate', resultPattern, '--write'],
    ],
    limitations: [
      'Structural Chromium run with --no-energy: not a Firefox energy measurement.',
      'The crawl respects robots.txt and is capped by --max-pages/--max-depth.',
      'No forms, authentication, purchases or user data; no clicks during measurement.',
      'One sample of one site; counts describe the measured pages, not the whole site.',
      'The pilot does not run an experiment. A human chooses one component and runs an energy experiment separately on a quiet host.',
      'Lighthouse, Chromium traces and Firefox energy are separate evidence; never add them into one score.',
    ],
  };
}
