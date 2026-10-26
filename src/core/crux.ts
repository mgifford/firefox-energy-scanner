import { localHostReason } from './addresses.js';

/**
 * Field data from the Chrome UX Report (CrUX).
 *
 * CrUX reports what real Chrome users experienced on an origin or URL over a
 * trailing 28-day window, as a 75th percentile plus the share of page views in
 * each experience band. It is the only indicator in this project that describes
 * the live site rather than a lab run or a model, and it is deliberately kept
 * separate from both: field p75 and a Lighthouse median are different
 * populations and are never combined, converted or averaged.
 *
 * It also cannot answer the question this tool mainly exists for. CrUX has no
 * data for previews, staging or authenticated URLs, and a 28-day window cannot
 * show that a change made today helped. See docs/crux.md.
 */

export type CruxMetricName = 'lcp' | 'inp' | 'cls' | 'fcp' | 'ttfb';
export type CruxScope = 'origin' | 'url';
export type CruxFormFactor = 'PHONE' | 'DESKTOP' | 'TABLET';
/** 'ALL' asks CrUX to aggregate every form factor into one record. */
export type CruxFormFactorFilter = CruxFormFactor | 'ALL';

export interface CruxBand {
  /** Share of page views in each band, 0–1. CrUX supplies these as a histogram. */
  good: number;
  needsImprovement: number;
  poor: number;
}

export interface CruxMetric {
  /** 75th percentile in the metric's own unit: milliseconds, or unitless for CLS. */
  p75: number;
  band: CruxBand;
}

export interface CruxRecord {
  scope: CruxScope;
  /** The origin or URL the record describes. */
  id: string;
  formFactor: CruxFormFactorFilter;
  /** The 28-day collection window, as ISO dates. */
  window: { start: string; end: string };
  metrics: Partial<Record<CruxMetricName, CruxMetric>>;
}

/**
 * What to report. `no-data` is a normal outcome, not a failure: CrUX only holds
 * records for URLs, origins and form factors that real Chrome traffic covers.
 */
export interface CruxResult {
  scope: CruxScope;
  target: string;
  formFactor: CruxFormFactorFilter;
  status: 'ok' | 'no-data' | 'error';
  /** Why there is no record. */
  detail?: string;
  record?: CruxRecord;
}

export interface CruxRequest {
  /** A URL. Origin scope queries its origin; url scope queries the URL itself. */
  target: string;
  scope?: CruxScope;
  formFactor?: CruxFormFactorFilter;
  apiKey: string;
  timeoutMs?: number;
  /** Injected by tests; never used to reach a different host in production. */
  fetchImpl?: typeof fetch;
}

const ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
const DEFAULT_TIMEOUT_MS = 15_000;

/** CrUX metric names, in report order. */
export const CRUX_METRICS: CruxMetricName[] = ['lcp', 'inp', 'cls', 'fcp', 'ttfb'];

export const CRUX_LABELS: Record<CruxMetricName, string> = {
  lcp: 'Largest Contentful Paint',
  inp: 'Interaction to Next Paint',
  cls: 'Cumulative Layout Shift',
  fcp: 'First Contentful Paint',
  ttfb: 'Time to First Byte',
};

const API_KEYS: Record<string, CruxMetricName> = {
  largest_contentful_paint: 'lcp',
  interaction_to_next_paint: 'inp',
  cumulative_layout_shift: 'cls',
  first_contentful_paint: 'fcp',
  experimental_time_to_first_byte: 'ttfb',
};

/**
 * Validate a CrUX target and return its origin.
 *
 * The query leaves this machine and carries the URL to Google, so a target that
 * is private, local or a development preview is refused here rather than sent.
 */
export function cruxTarget(target: string): { url: string; origin: string } {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error(`CrUX needs an absolute URL (got ${target})`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`CrUX only queries http(s) URLs (got ${parsed.protocol})`);
  }
  const reason = localHostReason(parsed.hostname);
  if (reason) {
    throw new Error(
      `Refusing to send ${parsed.hostname} to the Chrome UX Report API: ${reason}. ` +
        'Field data describes public origins, and this query leaves this machine.',
    );
  }
  return { url: parsed.toString(), origin: parsed.origin };
}

/** Resolve the API key from the flag or the environment, with an actionable error. */
export function cruxApiKey(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = flag?.trim() || env.CRUX_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'CrUX needs a Chrome UX Report API key: set CRUX_API_KEY or pass --crux-key. ' +
        'Enable the API and create a key at ' +
        'https://console.cloud.google.com/apis/library/chromeuxreport.googleapis.com',
    );
  }
  return key;
}

/** Query CrUX. Never throws for a missing record or a refused request; returns a status. */
export async function fetchCrux(request: CruxRequest): Promise<CruxResult> {
  const scope: CruxScope = request.scope ?? 'origin';
  const formFactor: CruxFormFactorFilter = request.formFactor ?? 'ALL';
  const { url, origin } = cruxTarget(request.target);
  const target = scope === 'origin' ? origin : url;

  const body: Record<string, unknown> = scope === 'origin' ? { origin } : { url };
  if (formFactor !== 'ALL') body.formFactor = formFactor;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const doFetch = request.fetchImpl ?? fetch;

  try {
    const response = await doFetch(`${ENDPOINT}?key=${encodeURIComponent(request.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (response.status === 404) {
      return {
        scope,
        target,
        formFactor,
        status: 'no-data',
        detail:
          'CrUX holds no record for this ' +
          scope +
          '. It only covers origins, URLs and form factors with enough real Chrome traffic; ' +
          'previews, staging sites and low-traffic pages are usually absent.',
      };
    }

    if (!response.ok) {
      return {
        scope,
        target,
        formFactor,
        status: 'error',
        detail: `Chrome UX Report API returned HTTP ${response.status}${await apiMessage(response)}`,
      };
    }

    const payload = (await response.json()) as unknown;
    const record = parseRecord(payload, scope, formFactor);
    if (!record) {
      return {
        scope,
        target,
        formFactor,
        status: 'error',
        detail: 'Chrome UX Report API returned a response with no metrics.',
      };
    }
    return { scope, target, formFactor, status: 'ok', record };
  } catch (err) {
    const e = err as Error;
    const detail =
      e.name === 'AbortError'
        ? 'the Chrome UX Report API did not respond in time'
        : `could not reach the Chrome UX Report API (${e.message})`;
    return { scope, target, formFactor, status: 'error', detail };
  } finally {
    clearTimeout(timer);
  }
}

/** The API's own message, when it sends one. Never includes the request URL or key. */
async function apiMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    const message = body.error?.message;
    return message ? `: ${message}` : '';
  } catch {
    return '';
  }
}

function parseRecord(
  payload: unknown,
  scope: CruxScope,
  formFactor: CruxFormFactorFilter,
): CruxRecord | undefined {
  const record = (payload as { record?: unknown }).record;
  if (!record || typeof record !== 'object') return undefined;
  const raw = record as {
    key?: { origin?: string; url?: string; formFactor?: string };
    metrics?: Record<string, unknown>;
    collectionPeriod?: { firstDate?: DateParts; lastDate?: DateParts };
  };
  if (!raw.metrics) return undefined;

  const metrics: Partial<Record<CruxMetricName, CruxMetric>> = {};
  for (const [apiName, name] of Object.entries(API_KEYS)) {
    const metric = parseMetric(raw.metrics[apiName]);
    if (metric) metrics[name] = metric;
  }
  if (Object.keys(metrics).length === 0) return undefined;

  const start = isoDate(raw.collectionPeriod?.firstDate);
  const end = isoDate(raw.collectionPeriod?.lastDate);

  return {
    scope,
    id: raw.key?.origin ?? raw.key?.url ?? '',
    formFactor: (raw.key?.formFactor as CruxFormFactor) ?? formFactor,
    window: { start: start ?? '', end: end ?? '' },
    metrics,
  };
}

interface DateParts {
  year?: number;
  month?: number;
  day?: number;
}

function isoDate(parts: DateParts | undefined): string | undefined {
  if (!parts?.year || !parts.month || !parts.day) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function parseMetric(value: unknown): CruxMetric | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as {
    histogram?: { density?: number }[];
    percentiles?: { p75?: string | number };
  };
  const p75 = Number(raw.percentiles?.p75);
  if (!Number.isFinite(p75)) return undefined;

  // CrUX supplies the bands already bucketed and already ordered: the first
  // bucket is "good". Taking them as given avoids inventing thresholds that
  // could drift from Google's.
  const densities = (raw.histogram ?? [])
    .map((b) => Number(b.density))
    .filter((n) => Number.isFinite(n));
  if (densities.length < 3) return undefined;

  return {
    p75,
    band: {
      good: densities[0]!,
      needsImprovement: densities[1]!,
      poor: densities.slice(2).reduce((a, b) => a + b, 0),
    },
  };
}

const TIME_METRICS = new Set<CruxMetricName>(['lcp', 'inp', 'fcp', 'ttfb']);

/** Render a metric in its natural unit: seconds, milliseconds, or unitless. */
export function formatCruxValue(name: CruxMetricName, value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (!TIME_METRICS.has(name)) return value.toFixed(2);
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

/** Share of page views as a whole percentage. */
export function formatCruxShare(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}

/**
 * One line stating exactly what a record describes: scope, target, form factor
 * and window. Every field figure in a report is read next to this.
 */
export function describeCrux(crux: CruxResult): string {
  const kind = crux.scope === 'origin' ? 'Origin' : 'URL';
  const record = crux.record;
  // The record's own key states what the data covers; the requested filter is
  // only a fallback, so a 'PHONE' query is never labelled 'all form factors'.
  const covers = record?.formFactor ?? crux.formFactor;
  const factor = covers === 'ALL' ? 'all form factors' : covers.toLowerCase();
  if (!record) return `${kind} ${crux.target}, ${factor}`;
  const window = record.window.start && record.window.end
    ? `28 days, ${record.window.start} to ${record.window.end}`
    : 'trailing 28 days';
  return `${kind} ${crux.target}, ${factor}, ${window}`;
}

/** True when the record has at least one Core Web Vital. */
export function hasCoreWebVitals(record: CruxRecord): boolean {
  return Boolean(record.metrics.lcp || record.metrics.inp || record.metrics.cls);
}
