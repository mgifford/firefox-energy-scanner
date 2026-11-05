/**
 * Page families: the measured pages grouped by shared structure.
 *
 * A family is a grouping for investigation, not a measurement. Its figures
 * are medians of the pages measured in it; nothing is extrapolated to pages
 * that were not measured. The grouping says pages are built alike, not that
 * they cost alike: two pages from one template can still differ in content,
 * media and behaviour after interaction.
 *
 * Method (`structure-v1`), deterministic for a given set of results:
 *
 * 1. Each page's features (see signature.ts) are compared group by group
 *    with a weighted Jaccard index. A feature's weight is ln(1 + N/df): one
 *    found on every page (the site header, the analytics tag) still counts,
 *    but less than one that sets a few pages apart.
 * 2. Group similarities are combined with fixed weights. A group missing from
 *    both pages (no Drupal template, say) drops out and the rest are rescaled.
 * 3. Average-linkage agglomerative clustering, pages in URL order, merging the
 *    most similar pair while it is at least the threshold.
 */

import type { StepResult } from '../core/types.js';
import { median } from '../core/stats.js';
import { pageFeatures, pageFingerprint, stableHash, structuralFeatures, type PageFeatures } from './signature.js';

export const FAMILY_METHOD = 'structure-v1';

/** Weights per feature group. Components and resources carry most of the signal. */
export const FAMILY_WEIGHTS = {
  components: 0.35,
  resources: 0.35,
  landmarks: 0.1,
  template: 0.1,
  url: 0.1,
} as const;

/** Pages at least this similar, on average, are one family. */
export const FAMILY_THRESHOLD = 0.6;

/** A feature found in at least this share of a family's pages is one of its signals. */
const CORE_SHARE = 0.8;

/** Within a family of at least three, a page this far from the median is listed as an outlier. */
const OUTLIER_RATIO = 2;

export interface FamilyMetric {
  median: number;
  min: number;
  max: number;
}

export interface FamilyOutlier {
  url: string;
  metric: 'domNodes' | 'transferBytes' | 'requests';
  value: number;
  median: number;
  /** value / median. */
  ratio: number;
}

export interface PageFamily {
  /** Stable while the family's shared structure is unchanged: a hash of its signals. */
  id: string;
  /** A readable name: the commonest URL pattern, and the template when known. */
  label: string;
  /** Measured pages in the family, in URL order. */
  pages: string[];
  /** The page most like the rest of its family: the one to look at first. */
  representative: string;
  urlPatterns: { pattern: string; pages: number }[];
  /** Structural features most of the family shares (components, landmarks, template, URL pattern). */
  signals: string[];
  /** Mean similarity between its pages, 0 to 1. 1 for a family of one. */
  cohesion: number;
  /** Medians of the measured pages. Not extrapolated to unmeasured ones. */
  metrics: {
    domNodes?: FamilyMetric;
    transferBytes?: FamilyMetric;
    requests?: FamilyMetric;
  };
  outliers: FamilyOutlier[];
}

export interface FamilyReport {
  method: typeof FAMILY_METHOD;
  threshold: number;
  weights: typeof FAMILY_WEIGHTS;
  /** Pages grouped: measured pages with page structure. */
  pagesGrouped: number;
  /** Largest first. */
  families: PageFamily[];
  /** URL -> family id. */
  pageFamily: Record<string, string>;
  /** URL -> page fingerprint. */
  pageFingerprint: Record<string, string>;
  /** URL -> URL pattern. */
  pagePattern: Record<string, string>;
  /** What the grouping cannot tell you. Plain sentences. */
  limitations: string[];
}

type Group = 'components' | 'resources' | 'landmarks' | 'template' | 'url';

function groupSets(f: PageFeatures): Record<Group, string[]> {
  return {
    components: f.components,
    resources: f.resources,
    landmarks: f.landmarks,
    template: f.template ? [f.template] : [],
    url: [f.pattern],
  };
}

/** Document frequency weights per group: ln(1 + N/df). */
function featureWeights(pages: PageFeatures[]): Record<Group, Map<string, number>> {
  const out = {} as Record<Group, Map<string, number>>;
  const n = pages.length;
  for (const g of Object.keys(FAMILY_WEIGHTS) as Group[]) {
    const df = new Map<string, number>();
    for (const p of pages) for (const f of groupSets(p)[g]) df.set(f, (df.get(f) ?? 0) + 1);
    out[g] = new Map([...df].map(([f, d]) => [f, Math.log(1 + n / d)]));
  }
  return out;
}

function weightedJaccard(a: string[], b: string[], w: Map<string, number>): number | undefined {
  if (a.length === 0 && b.length === 0) return undefined;
  const sb = new Set(b);
  let inter = 0;
  let union = 0;
  for (const f of a) {
    const x = w.get(f) ?? 1;
    union += x;
    if (sb.has(f)) inter += x;
  }
  const sa = new Set(a);
  for (const f of b) if (!sa.has(f)) union += w.get(f) ?? 1;
  return union === 0 ? undefined : inter / union;
}

/** Similarity of two pages, 0 to 1. Exported for tests. */
export function similarity(a: PageFeatures, b: PageFeatures, weights = featureWeights([a, b])): number {
  const ga = groupSets(a);
  const gb = groupSets(b);
  let total = 0;
  let weight = 0;
  for (const g of Object.keys(FAMILY_WEIGHTS) as Group[]) {
    // A template on one page and not the other is a difference; on neither, no evidence.
    const s = weightedJaccard(ga[g], gb[g], weights[g]);
    if (s === undefined) continue;
    total += FAMILY_WEIGHTS[g] * s;
    weight += FAMILY_WEIGHTS[g];
  }
  return weight === 0 ? 0 : total / weight;
}

/** Average-linkage clustering. Returns clusters as lists of page indexes, each sorted. */
function cluster(sim: number[][], threshold: number): number[][] {
  let clusters = sim.map((_, i) => [i]);
  // Cluster-to-cluster similarity, updated by the Lance–Williams rule for average linkage.
  const s = sim.map((row) => [...row]);
  let alive = clusters.map(() => true);
  for (;;) {
    let best = -1;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < clusters.length; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < clusters.length; j++) {
        if (!alive[j]) continue;
        // Strictly greater: the first pair in index order wins a tie.
        if (s[i]![j]! > best) {
          best = s[i]![j]!;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0 || best < threshold) break;
    const ni = clusters[bi]!.length;
    const nj = clusters[bj]!.length;
    for (let k = 0; k < clusters.length; k++) {
      if (!alive[k] || k === bi || k === bj) continue;
      const v = (ni * s[bi]![k]! + nj * s[bj]![k]!) / (ni + nj);
      s[bi]![k] = v;
      s[k]![bi] = v;
    }
    clusters[bi] = [...clusters[bi]!, ...clusters[bj]!].sort((x, y) => x - y);
    alive[bj] = false;
  }
  clusters = clusters.filter((_, i) => alive[i]);
  alive = [];
  return clusters;
}

const metricOf = (values: number[]): FamilyMetric | undefined =>
  values.length ? { median: median(values), min: Math.min(...values), max: Math.max(...values) } : undefined;

/** One step per page: the last valid, measured (not warm-up) run that recorded structure. */
export function pagesOf(steps: StepResult[]): StepResult[] {
  const byUrl = new Map<string, StepResult>();
  for (const s of steps) {
    if (s.warmup || !s.valid || !s.url || !s.anatomy) continue;
    byUrl.set(s.url, s);
  }
  return [...byUrl.values()].sort((a, b) => (a.url! < b.url! ? -1 : a.url! > b.url! ? 1 : 0));
}

/**
 * Group measured pages into families. Undefined when fewer than two pages
 * have page structure, since one page is not a grouping.
 */
export function buildFamilies(
  steps: StepResult[],
  options: { threshold?: number; listed?: number } = {},
): FamilyReport | undefined {
  const threshold = options.threshold ?? FAMILY_THRESHOLD;
  const pageSteps = pagesOf(steps);
  const features = pageSteps.map(pageFeatures).filter((f): f is PageFeatures => !!f);
  if (features.length < 2) return undefined;

  const weights = featureWeights(features);
  const n = features.length;
  const sim = Array.from({ length: n }, () => new Array<number>(n).fill(1));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = similarity(features[i]!, features[j]!, weights);
      sim[i]![j] = v;
      sim[j]![i] = v;
    }
  }

  const stepByUrl = new Map(pageSteps.map((s) => [s.url!, s]));
  const families: PageFamily[] = cluster(sim, threshold).map((members) => {
    const pages = members.map((i) => features[i]!);
    // Representative: the medoid, the page most similar to the rest (first in URL order on a tie).
    let representative = members[0]!;
    let bestMean = -1;
    for (const i of members) {
      const mean = members.length === 1 ? 1 : members.filter((j) => j !== i).reduce((t, j) => t + sim[i]![j]!, 0) / (members.length - 1);
      if (mean > bestMean) {
        bestMean = mean;
        representative = i;
      }
    }
    let pairs = 0;
    let pairSum = 0;
    for (const [x, i] of members.entries()) {
      for (const j of members.slice(x + 1)) {
        pairs++;
        pairSum += sim[i]![j]!;
      }
    }

    // Signals: structural features most of the family shares.
    const counts = new Map<string, number>();
    for (const p of pages) for (const f of structuralFeatures(p)) counts.set(f, (counts.get(f) ?? 0) + 1);
    const signals = [...counts]
      .filter(([, c]) => c >= Math.ceil(pages.length * CORE_SHARE))
      .map(([f]) => f)
      .sort();

    const patterns = new Map<string, number>();
    for (const p of pages) patterns.set(p.pattern, (patterns.get(p.pattern) ?? 0) + 1);
    const urlPatterns = [...patterns]
      .map(([pattern, c]) => ({ pattern, pages: c }))
      .sort((a, b) => b.pages - a.pages || (a.pattern < b.pattern ? -1 : 1));

    const memberSteps = pages.map((p) => stepByUrl.get(p.url)!);
    const series = {
      domNodes: memberSteps.map((s) => s.anatomy!.domNodes),
      transferBytes: memberSteps.flatMap((s) => (s.network ? [s.network.transferBytes] : [])),
      requests: memberSteps.flatMap((s) => (s.network ? [s.network.requests] : [])),
    };
    const metrics = {
      ...(metricOf(series.domNodes) ? { domNodes: metricOf(series.domNodes)! } : {}),
      ...(metricOf(series.transferBytes) ? { transferBytes: metricOf(series.transferBytes)! } : {}),
      ...(metricOf(series.requests) ? { requests: metricOf(series.requests)! } : {}),
    };

    const outliers: FamilyOutlier[] = [];
    if (pages.length >= 3) {
      for (const metric of ['domNodes', 'transferBytes', 'requests'] as const) {
        const m = metrics[metric]?.median;
        if (!m) continue;
        for (const s of memberSteps) {
          const value = metric === 'domNodes' ? s.anatomy!.domNodes : s.network?.[metric];
          if (value === undefined) continue;
          const ratio = value / m;
          if (ratio >= OUTLIER_RATIO || ratio <= 1 / OUTLIER_RATIO) {
            outliers.push({ url: s.url!, metric, value, median: m, ratio: Math.round(ratio * 100) / 100 });
          }
        }
      }
    }

    const template = signals.find((f) => f.startsWith('t:'))?.slice(2);
    const top = urlPatterns[0]!.pattern;
    return {
      id: `pf-${stableHash(signals.join('\n'))}`,
      label: template ? `${top} (${template})` : urlPatterns.length > 1 ? `${top} and ${urlPatterns.length - 1} other URL pattern${urlPatterns.length > 2 ? 's' : ''}` : top,
      pages: pages.map((p) => p.url),
      representative: features[representative]!.url,
      urlPatterns,
      signals,
      cohesion: pairs ? Math.round((pairSum / pairs) * 1000) / 1000 : 1,
      metrics,
      outliers,
    };
  });

  families.sort((a, b) => b.pages.length - a.pages.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Two families can share signals (they differ only in resources); keep ids unique, in order.
  const seen = new Map<string, number>();
  for (const f of families) {
    const k = (seen.get(f.id) ?? 0) + 1;
    seen.set(f.id, k);
    if (k > 1) f.id = `${f.id}-${k}`;
  }

  const pageFamily: Record<string, string> = {};
  for (const f of families) for (const u of f.pages) pageFamily[u] = f.id;
  const fingerprints: Record<string, string> = {};
  const patterns: Record<string, string> = {};
  for (const p of features) {
    fingerprints[p.url] = pageFingerprint(p);
    patterns[p.url] = p.pattern;
  }

  const legacy = features.filter((f) => !f.structured).length;
  const limitations = [
    `Families group the ${n} pages measured in this scan` +
      (options.listed && options.listed > n ? ` out of ${options.listed} the sitemap lists` : '') +
      '. Their figures are medians of those pages and are not extrapolated to pages that were not measured.',
    'Pages are grouped by how they are built (components, landmarks, scripts and stylesheets, template, URL pattern), not by what they cost. Pages in one family can still differ in content, media and behaviour after interaction.',
    ...(legacy
      ? [`${legacy} of ${n} pages were scanned before page structure was recorded, so they are grouped by URL, scripts, stylesheets and their heaviest subtrees only.`]
      : []),
  ];

  return {
    method: FAMILY_METHOD,
    threshold,
    weights: FAMILY_WEIGHTS,
    pagesGrouped: n,
    families,
    pageFamily,
    pageFingerprint: fingerprints,
    pagePattern: patterns,
    limitations,
  };
}
