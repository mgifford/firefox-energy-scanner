import { median } from '../core/stats.js';

/**
 * Reduce Lighthouse reports (LHRs) to what this tool publishes.
 *
 * Lighthouse is a third indicator class with its own boundary: lab metrics
 * from **Chromium**, under Lighthouse's simulated device and network
 * throttling. It is not Firefox, and it is not energy. It sits beside the
 * Firefox measurements and is never merged with them.
 *
 * A full LHR is several hundred kilobytes, mostly screenshots and traces.
 * Only scores, metrics and the failing recommendations are kept, so a scan
 * of twenty URLs adds kilobytes, not megabytes, to the published results.
 *
 * Everything here is pure, so it is tested against a stored LHR without
 * launching a browser.
 */

export type LighthouseCategory = 'performance' | 'accessibility' | 'best-practices' | 'seo';
export const LIGHTHOUSE_CATEGORIES: readonly LighthouseCategory[] = [
  'performance',
  'accessibility',
  'best-practices',
  'seo',
];

export type FormFactor = 'mobile' | 'desktop';

/** The subset of the Lighthouse result format this module reads. */
export interface Lhr {
  lighthouseVersion: string;
  requestedUrl?: string;
  finalDisplayedUrl?: string;
  userAgent?: string;
  fetchTime?: string;
  runWarnings?: string[];
  runtimeError?: { code: string; message: string };
  environment?: { benchmarkIndex?: number; hostUserAgent?: string };
  configSettings?: {
    formFactor?: FormFactor;
    throttlingMethod?: string;
    throttling?: { rttMs?: number; throughputKbps?: number; cpuSlowdownMultiplier?: number };
    screenEmulation?: { width?: number; height?: number };
  };
  categories: Record<
    string,
    { title: string; score: number | null; auditRefs: { id: string; group?: string; weight: number }[] }
  >;
  audits: Record<string, LhrAudit>;
}

export interface LhrAudit {
  id: string;
  title: string;
  description?: string;
  score: number | null;
  scoreDisplayMode: string;
  displayValue?: string;
  numericValue?: number;
  metricSavings?: Record<string, number>;
  details?: {
    type?: string;
    overallSavingsMs?: number;
    overallSavingsBytes?: number;
    /**
     * An array for table and list details, but an object for others (the
     * "checklist" type, e.g. document-latency-insight). Read through rows().
     */
    items?: unknown;
  };
}

export interface LighthouseMetrics {
  fcpMs?: number;
  lcpMs?: number;
  tbtMs?: number;
  cls?: number;
  speedIndexMs?: number;
}

export interface LighthouseRecommendation {
  id: string;
  title: string;
  /** Lighthouse's own group: 'insights' or 'diagnostics' in v13. */
  group?: string;
  /** 0–1. Lighthouse treats anything below 0.9 as not passed. */
  score: number | null;
  displayValue?: string;
  /** Largest estimated saving on LCP/FCP, in milliseconds. */
  savingsMs?: number;
  savingsBytes?: number;
  learnMore?: string;
}

/**
 * Lighthouse numbers that track CPU and transfer work rather than speed.
 * Main-thread time in particular is the closest Lighthouse comes to client
 * energy, which is why it is kept on hosts that cannot measure energy.
 */
export interface LighthouseWork {
  mainThreadMs?: number;
  /** Main-thread time by work category, largest first. */
  mainThreadByCategory?: { category: string; ms: number }[];
  jsExecutionMs?: number;
  totalBytes?: number;
  unusedJsBytes?: number;
  unusedCssBytes?: number;
  domElements?: number;
  thirdParties?: { entity: string; transferBytes?: number; mainThreadMs?: number }[];
}

/** One Lighthouse run, reduced. */
export interface LighthouseRunSummary {
  requestedUrl: string;
  finalUrl?: string;
  error?: string;
  scores: Partial<Record<LighthouseCategory, number>>;
  metrics: LighthouseMetrics;
  recommendations: LighthouseRecommendation[];
  /** Failing audits in the non-performance categories, by category. */
  failingAudits: Partial<Record<LighthouseCategory, { id: string; title: string }[]>>;
  work: LighthouseWork;
  benchmarkIndex?: number;
  warnings: string[];
}

/** All runs of one URL, combined. */
export interface LighthouseUrlResult {
  requestedUrl: string;
  finalUrl?: string;
  /** Runs that produced a report. */
  runs: number;
  /** Set when no run produced a report. */
  error?: string;
  /** Median score per category, 0–100. */
  scores: Partial<Record<LighthouseCategory, number>>;
  /** Lowest and highest performance score across runs. */
  performanceRange?: [number, number];
  metrics: LighthouseMetrics;
  /** From the median run, so they match a report someone could reproduce. */
  recommendations: LighthouseRecommendation[];
  failingAudits: Partial<Record<LighthouseCategory, { id: string; title: string }[]>>;
  work: LighthouseWork;
  warnings: string[];
}

export interface LighthouseSummary {
  tool: 'lighthouse';
  version: string;
  /** Chromium build Lighthouse drove; differs from the Firefox under test. */
  browser?: string;
  formFactor: FormFactor;
  throttling: string;
  categories: LighthouseCategory[];
  runsPerUrl: number;
  /** Lighthouse's CPU benchmark of the host; low values mean a slow runner. */
  benchmarkIndex?: number;
  results: LighthouseUrlResult[];
}

/** Audits Lighthouse never shows as recommendations. */
const NOT_RECOMMENDATIONS = new Set(['metrics', 'hidden', 'budgets']);
const PASS_THRESHOLD = 0.9;

const score100 = (s: number | null | undefined): number | undefined =>
  typeof s === 'number' && Number.isFinite(s) ? Math.round(s * 100) : undefined;

const finite = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** An audit's detail rows, or none when its details are not a table. */
function rows(audit: LhrAudit | undefined): Record<string, unknown>[] {
  const items = audit?.details?.items;
  return Array.isArray(items) ? items.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
}

/** First markdown link in an audit description: Lighthouse's "Learn more". */
function learnMoreLink(description: string | undefined): string | undefined {
  const m = /\]\((https:\/\/[^)\s]+)\)/.exec(description ?? '');
  return m?.[1];
}

/** Bytes an audit says could be saved, from whichever field it reports. */
function savedBytes(audit: LhrAudit): number | undefined {
  const overall = finite(audit.details?.overallSavingsBytes);
  if (overall !== undefined) return overall > 0 ? overall : undefined;
  const items = rows(audit);
  const sum = items.reduce((acc, it) => acc + (finite(it['wastedBytes']) ?? 0), 0);
  return sum > 0 ? sum : undefined;
}

function savedMs(audit: LhrAudit): number | undefined {
  const fromMetrics = Object.entries(audit.metricSavings ?? {})
    .filter(([k]) => k === 'LCP' || k === 'FCP')
    .map(([, v]) => v);
  const candidates = [...fromMetrics, finite(audit.details?.overallSavingsMs) ?? 0];
  const best = Math.max(...candidates);
  return best > 0 ? best : undefined;
}

/**
 * Recommendations, as the Lighthouse report would list them under
 * "Insights" and "Diagnostics": scored audits that did not pass.
 *
 * Sorted worst-first, then by estimated time saved, then by bytes saved, so
 * the head of the list is what to fix first.
 */
export function extractRecommendations(lhr: Lhr): LighthouseRecommendation[] {
  const perf = lhr.categories['performance'];
  if (!perf) return [];
  const out: LighthouseRecommendation[] = [];
  for (const ref of perf.auditRefs) {
    if (ref.group && NOT_RECOMMENDATIONS.has(ref.group)) continue;
    const audit = lhr.audits[ref.id];
    if (!audit) continue;
    if (typeof audit.score !== 'number' || audit.score >= PASS_THRESHOLD) continue;
    if (['notApplicable', 'manual', 'error', 'informative'].includes(audit.scoreDisplayMode)) continue;

    // One unexpected audit shape must cost that audit's savings figures,
    // not the whole Lighthouse result.
    let ms: number | undefined;
    let bytes: number | undefined;
    try {
      ms = savedMs(audit);
      bytes = savedBytes(audit);
    } catch {
      ms = bytes = undefined;
    }
    const learnMore = learnMoreLink(audit.description);
    out.push({
      id: audit.id,
      title: audit.title,
      ...(ref.group ? { group: ref.group } : {}),
      score: audit.score,
      ...(audit.displayValue ? { displayValue: clean(audit.displayValue) } : {}),
      ...(ms !== undefined ? { savingsMs: Math.round(ms) } : {}),
      ...(bytes !== undefined ? { savingsBytes: Math.round(bytes) } : {}),
      ...(learnMore ? { learnMore } : {}),
    });
  }
  return out.sort(
    (a, b) =>
      (a.score ?? 1) - (b.score ?? 1) ||
      (b.savingsMs ?? 0) - (a.savingsMs ?? 0) ||
      (b.savingsBytes ?? 0) - (a.savingsBytes ?? 0),
  );
}

/** Lighthouse uses non-breaking spaces in display values. */
function clean(s: string): string {
  return s.replace(/ /g, ' ');
}

function extractWork(lhr: Lhr): LighthouseWork {
  const a = lhr.audits;
  const breakdown = rows(a['mainthread-work-breakdown'])
    .map((it) => ({
      category: String(it['groupLabel'] ?? it['group'] ?? 'Other'),
      ms: Math.round(finite(it['duration']) ?? 0),
    }))
    .filter((x) => x.ms > 0)
    .sort((x, y) => y.ms - x.ms);

  const thirdParties = rows(a['third-parties-insight'])
    .map((it) => {
      const entity = it['entity'];
      const name =
        typeof entity === 'string'
          ? entity
          : typeof entity === 'object' && entity && 'text' in entity
            ? String((entity as { text: unknown }).text)
            : undefined;
      const transferBytes = finite(it['transferSize']);
      const mainThreadMs = finite(it['mainThreadTime']);
      return name
        ? {
            entity: name,
            ...(transferBytes !== undefined ? { transferBytes: Math.round(transferBytes) } : {}),
            ...(mainThreadMs !== undefined ? { mainThreadMs: Math.round(mainThreadMs) } : {}),
          }
        : undefined;
    })
    .filter((x): x is NonNullable<typeof x> => x !== undefined)
    .slice(0, 8);

  const domElements = rows(a['dom-size-insight']).find(
    (it) => it['statistic'] === 'Total elements',
  );
  const domValue = domElements?.['value'];
  const dom =
    finite(a['dom-size-insight']?.numericValue) ??
    (typeof domValue === 'object' && domValue ? finite((domValue as { value?: unknown }).value) : undefined);

  const work: LighthouseWork = {};
  const set = <K extends keyof LighthouseWork>(k: K, v: LighthouseWork[K] | undefined) => {
    if (v !== undefined) work[k] = v;
  };
  set('mainThreadMs', round(finite(a['mainthread-work-breakdown']?.numericValue)));
  if (breakdown.length) set('mainThreadByCategory', breakdown);
  set('jsExecutionMs', round(finite(a['bootup-time']?.numericValue)));
  set('totalBytes', round(finite(a['total-byte-weight']?.numericValue)));
  set('unusedJsBytes', a['unused-javascript'] ? savedBytes(a['unused-javascript']) : undefined);
  set('unusedCssBytes', a['unused-css-rules'] ? savedBytes(a['unused-css-rules']) : undefined);
  set('domElements', round(dom));
  if (thirdParties.length) set('thirdParties', thirdParties);
  return work;
}

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const round = (v: number | undefined): number | undefined =>
  v === undefined ? undefined : Math.round(v);

/** Reduce one LHR. */
export function summarizeLhr(lhr: Lhr, requestedUrl: string): LighthouseRunSummary {
  const scores: Partial<Record<LighthouseCategory, number>> = {};
  const failingAudits: LighthouseRunSummary['failingAudits'] = {};
  for (const cat of LIGHTHOUSE_CATEGORIES) {
    const c = lhr.categories[cat];
    if (!c) continue;
    const s = score100(c.score);
    if (s !== undefined) scores[cat] = s;
    if (cat === 'performance') continue;
    const failing = c.auditRefs
      .map((r) => lhr.audits[r.id])
      .filter(
        (au): au is LhrAudit =>
          !!au &&
          typeof au.score === 'number' &&
          au.score < PASS_THRESHOLD &&
          au.scoreDisplayMode !== 'informative' &&
          au.scoreDisplayMode !== 'notApplicable' &&
          au.scoreDisplayMode !== 'manual',
      )
      .map((au) => ({ id: au.id, title: au.title }));
    failingAudits[cat] = failing;
  }

  const m = (id: string) => finite(lhr.audits[id]?.numericValue);
  const metrics: LighthouseMetrics = {};
  const fcp = m('first-contentful-paint');
  const lcp = m('largest-contentful-paint');
  const tbt = m('total-blocking-time');
  const cls = m('cumulative-layout-shift');
  const si = m('speed-index');
  if (fcp !== undefined) metrics.fcpMs = Math.round(fcp);
  if (lcp !== undefined) metrics.lcpMs = Math.round(lcp);
  if (tbt !== undefined) metrics.tbtMs = Math.round(tbt);
  if (cls !== undefined) metrics.cls = Math.round(cls * 1000) / 1000;
  if (si !== undefined) metrics.speedIndexMs = Math.round(si);

  const benchmarkIndex = finite(lhr.environment?.benchmarkIndex);
  return {
    requestedUrl,
    ...(lhr.finalDisplayedUrl ? { finalUrl: lhr.finalDisplayedUrl } : {}),
    ...(lhr.runtimeError ? { error: `${lhr.runtimeError.code}: ${lhr.runtimeError.message}` } : {}),
    scores,
    metrics,
    recommendations: lhr.runtimeError ? [] : extractRecommendations(lhr),
    failingAudits,
    work: lhr.runtimeError ? {} : safely(() => extractWork(lhr), {}),
    ...(benchmarkIndex !== undefined ? { benchmarkIndex: Math.round(benchmarkIndex) } : {}),
    warnings: (lhr.runWarnings ?? []).map(clean),
  };
}

/**
 * Pick the run to report details from.
 *
 * The run whose performance score is closest to the median, ties broken by
 * LCP closest to the median LCP. Medians of each metric are reported
 * separately; the recommendations come from one real run rather than being
 * stitched together from several.
 */
export function medianRunIndex(runs: LighthouseRunSummary[]): number {
  if (runs.length === 0) return -1;
  const perf = runs.map((r) => r.scores.performance ?? Number.NaN);
  const lcp = runs.map((r) => r.metrics.lcpMs ?? Number.NaN);
  const mp = median(perf.filter(Number.isFinite));
  const ml = median(lcp.filter(Number.isFinite));
  let best = 0;
  let bestKey: [number, number] = [Infinity, Infinity];
  runs.forEach((_, i) => {
    const key: [number, number] = [
      Number.isFinite(perf[i]!) ? Math.abs(perf[i]! - mp) : Infinity,
      Number.isFinite(lcp[i]!) ? Math.abs(lcp[i]! - ml) : Infinity,
    ];
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = i;
      bestKey = key;
    }
  });
  return best;
}

/** Combine every run of one URL. Failed runs are dropped, not averaged in. */
export function combineRuns(requestedUrl: string, all: LighthouseRunSummary[]): LighthouseUrlResult {
  const runs = all.filter((r) => !r.error);
  if (runs.length === 0) {
    return {
      requestedUrl,
      runs: 0,
      error: all[0]?.error ?? 'Lighthouse produced no report.',
      scores: {},
      metrics: {},
      recommendations: [],
      failingAudits: {},
      work: {},
      warnings: [...new Set(all.flatMap((r) => r.warnings))],
    };
  }

  const pick = runs[medianRunIndex(runs)]!;
  const med = (vals: (number | undefined)[]): number | undefined => {
    const v = vals.filter((x): x is number => x !== undefined && Number.isFinite(x));
    return v.length ? median(v) : undefined;
  };

  const scores: Partial<Record<LighthouseCategory, number>> = {};
  for (const cat of LIGHTHOUSE_CATEGORIES) {
    const v = med(runs.map((r) => r.scores[cat]));
    if (v !== undefined) scores[cat] = Math.round(v);
  }
  const perfScores = runs
    .map((r) => r.scores.performance)
    .filter((x): x is number => x !== undefined);

  const metrics: LighthouseMetrics = {};
  for (const key of ['fcpMs', 'lcpMs', 'tbtMs', 'speedIndexMs'] as const) {
    const v = med(runs.map((r) => r.metrics[key]));
    if (v !== undefined) metrics[key] = Math.round(v);
  }
  const cls = med(runs.map((r) => r.metrics.cls));
  if (cls !== undefined) metrics.cls = Math.round(cls * 1000) / 1000;

  return {
    requestedUrl,
    ...(pick.finalUrl ? { finalUrl: pick.finalUrl } : {}),
    runs: runs.length,
    scores,
    ...(perfScores.length > 1
      ? { performanceRange: [Math.min(...perfScores), Math.max(...perfScores)] as [number, number] }
      : {}),
    metrics,
    recommendations: pick.recommendations,
    failingAudits: pick.failingAudits,
    work: pick.work,
    warnings: [...new Set(runs.flatMap((r) => r.warnings))],
  };
}

export interface SitewideRecommendation {
  id: string;
  title: string;
  /** How many of the scanned pages fail this audit. */
  pages: number;
  /** Median estimated saving across the pages that fail it. */
  medianSavingsMs?: number;
  medianSavingsBytes?: number;
  learnMore?: string;
}

/**
 * Recommendations that recur across pages.
 *
 * Pages on one site usually share a theme, so the same failure on most pages
 * points at a template or a shared asset: one fix that lands everywhere.
 */
export function sitewideRecommendations(results: LighthouseUrlResult[]): SitewideRecommendation[] {
  const byId = new Map<string, { rec: LighthouseRecommendation; ms: number[]; bytes: number[]; pages: number }>();
  for (const r of results) {
    for (const rec of r.recommendations) {
      const e = byId.get(rec.id) ?? { rec, ms: [], bytes: [], pages: 0 };
      e.pages++;
      if (rec.savingsMs !== undefined) e.ms.push(rec.savingsMs);
      if (rec.savingsBytes !== undefined) e.bytes.push(rec.savingsBytes);
      byId.set(rec.id, e);
    }
  }
  return [...byId.values()]
    .map((e) => ({
      id: e.rec.id,
      title: e.rec.title,
      pages: e.pages,
      ...(e.ms.length ? { medianSavingsMs: Math.round(median(e.ms)) } : {}),
      ...(e.bytes.length ? { medianSavingsBytes: Math.round(median(e.bytes)) } : {}),
      ...(e.rec.learnMore ? { learnMore: e.rec.learnMore } : {}),
    }))
    .sort(
      (a, b) =>
        b.pages - a.pages ||
        (b.medianSavingsMs ?? 0) - (a.medianSavingsMs ?? 0) ||
        (b.medianSavingsBytes ?? 0) - (a.medianSavingsBytes ?? 0),
    );
}

/** Lighthouse's own rating bands, so a score is never conveyed by colour alone. */
export function scoreRating(score: number | undefined): string {
  if (score === undefined) return 'no score';
  if (score >= 90) return 'good';
  if (score >= 50) return 'needs improvement';
  return 'poor';
}

/** Human description of the throttling a run used. */
export function describeThrottling(lhr: Pick<Lhr, 'configSettings'>): string {
  const s = lhr.configSettings;
  if (!s) return 'unknown';
  const t = s.throttling ?? {};
  const method = s.throttlingMethod ?? 'unknown';
  if (method === 'provided') return 'none (provided)';
  const parts = [`${method}`];
  if (t.rttMs !== undefined) parts.push(`${t.rttMs} ms RTT`);
  if (t.throughputKbps !== undefined) parts.push(`${(t.throughputKbps / 1024).toFixed(1)} Mbps`);
  if (t.cpuSlowdownMultiplier !== undefined) parts.push(`${t.cpuSlowdownMultiplier}× CPU slowdown`);
  return parts.join(', ');
}
