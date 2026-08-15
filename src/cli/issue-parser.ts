/**
 * Parse a scan request from a GitHub issue body.
 *
 * This is untrusted public input. URLs are validated strictly: anything that is
 * not a public http(s) address is rejected, both because a hosted runner cannot
 * reach private hosts and because the scanner must not be usable to probe
 * internal networks.
 */

export interface ScanRequest {
  urls: string[];
  runner: 'macos' | 'linux';
  runs: number;
  errors: string[];
}

export const MAX_URLS = 20;
export const MAX_RUNS = 30;
export const DEFAULT_RUNS = 8;

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

  // Bare IPv6 loopback / link-local / unique-local.
  if (host.startsWith('[')) {
    const inner = host.slice(1, -1);
    if (inner === '::1' || inner.startsWith('fe80:') || inner.startsWith('fc') || inner.startsWith('fd')) {
      return false;
    }
  }

  // IPv4 private and reserved ranges.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 127 || a === 10) return false;
    if (a === 169 && b === 254) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a >= 224) return false; // multicast and reserved
  }

  // A hostname with no dot cannot be a public FQDN.
  if (!v4 && !host.startsWith('[') && !host.includes('.')) return false;

  return true;
}

/**
 * Extract a section from a GitHub issue-forms body.
 *
 * Issue forms render as `### Label` followed by the value.
 */
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
  // Issue forms write "_No response_" for skipped optional fields.
  return value === '_No response_' ? undefined : value;
}

export function parseScanRequest(body: string): ScanRequest {
  const errors: string[] = [];

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
  if (urls.length > MAX_URLS) {
    errors.push(`Too many URLs (${urls.length}); the limit is ${MAX_URLS}. Only the first ${MAX_URLS} will be scanned.`);
    urls.length = MAX_URLS;
  }

  const runnerRaw = (extractSection(body, 'Measurement type') ?? 'macos').toLowerCase();
  const runner: 'macos' | 'linux' = runnerRaw.includes('linux') ? 'linux' : 'macos';

  const runsRaw = extractSection(body, 'Measured runs per URL');
  let runs = DEFAULT_RUNS;
  if (runsRaw) {
    const parsed = Number.parseInt(runsRaw.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      runs = Math.min(parsed, MAX_RUNS);
      if (parsed > MAX_RUNS) errors.push(`Requested ${parsed} runs; capped at ${MAX_RUNS}.`);
    } else {
      errors.push(`Could not read a run count from "${runsRaw}"; using ${DEFAULT_RUNS}.`);
    }
  }

  return { urls, runner, runs, errors };
}
