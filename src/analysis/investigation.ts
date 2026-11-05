/**
 * The investigation queue: what to look at first, and why.
 *
 * Items are components, pages that stand out from their family, and scripts
 * that no component loads. They are put in order by four keys, one after the
 * other, each shown in its own column:
 *
 * 1. evidence: a structural fact and a Lighthouse finding inside it, then a
 *    Lighthouse finding alone, then a structural fact alone;
 * 2. reach: how many measured pages it is on;
 * 3. opportunity: whether a known remedy applies;
 * 4. workload: elements, or Chromium main-thread time for scripts.
 *
 * This is a sort order, not a score: no keys are added, weighted or merged,
 * and none is an energy figure. Whether a change saves energy is a measured
 * comparison, which each remedy names.
 */

import type { BenchmarkResult } from '../core/types.js';
import type { ComponentRecord, UnattributedEvidence } from './components.js';
import { REMEDIATIONS, remediationsFor, type Remediation } from './remediation.js';
import { stableHash } from './signature.js';

export const QUEUE_METHOD = 'queue-v1';

export type EvidenceTier = 'structure-and-lighthouse' | 'lighthouse' | 'structure';
const TIER_ORDER: Record<EvidenceTier, number> = { 'structure-and-lighthouse': 0, lighthouse: 1, structure: 2 };

export interface InvestigationItem {
  rank: number;
  kind: 'component' | 'region' | 'page' | 'script';
  /** cmp-… for components, the page fingerprint for pages, script-… for scripts. */
  id: string;
  title: string;
  evidence: EvidenceTier;
  /** What the evidence is, in plain words. */
  because: string[];
  reach: { pages: number; of: number; families: number };
  /** Separate indicators, in their own units. Never combined. */
  workload: {
    elements?: number;
    shareOfPage?: number;
    endlessAnimations?: number;
    /** Chromium main-thread time, from Lighthouse: not Firefox energy. */
    chromiumMainThreadMs?: number;
    transferBytes?: number;
  };
  remediation: Remediation[];
  confidence: 'high' | 'medium' | 'low';
  /** Where to find it: up to three pages, with a selector and position. */
  where: { page: string; selector?: string; rect?: { x: number; y: number; width: number; height: number }; belowFold?: boolean }[];
  /** Lighthouse audits behind it. */
  audits: string[];
  /** Scripts: the full script URL (the title may be shortened). */
  url?: string;
}

export interface InvestigationQueue {
  method: typeof QUEUE_METHOD;
  /** The sort keys, in order. Stated so the order can be checked. */
  order: string[];
  items: InvestigationItem[];
  limitations: string[];
}

const MAX_ITEMS = 25;

/** A structural fact worth acting on: anything that triggers a remedy, or a large share of the page. */
function structural(r: ComponentRecord): string[] {
  const out: string[] = [];
  if (r.animations?.infinite) out.push(`${r.animations.infinite} endless animation${r.animations.infinite === 1 ? '' : 's'}`);
  if (r.media?.autoplayVideos) out.push(`${r.media.autoplayVideos} video${r.media.autoplayVideos === 1 ? '' : 's'} playing on load`);
  if (r.media?.iframes) out.push(`${r.media.iframes} iframe${r.media.iframes === 1 ? '' : 's'}`);
  if (r.media?.eagerOffscreenImages) out.push(`${r.media.eagerOffscreenImages} eager image${r.media.eagerOffscreenImages === 1 ? '' : 's'} below the first screen`);
  if ((r.shareOfPage !== undefined && r.shareOfPage >= 0.25) || r.nodes.median >= 800) {
    out.push(`${r.nodes.median} elements${r.shareOfPage !== undefined ? ` (${Math.round(r.shareOfPage * 100)}% of the page)` : ''}`);
  }
  return out;
}

function componentItem(r: ComponentRecord, of: number): Omit<InvestigationItem, 'rank'> | undefined {
  const facts = structural(r);
  const findings = r.evidence.filter((e) => e.kind === 'finding');
  const lighthouse = [...new Set(findings.map((e) => e.detail ?? e.title))];
  const holdsLcp = r.evidence.some((e) => e.audit.startsWith('lcp-'));
  if (!facts.length && !lighthouse.length) return undefined;
  // A region (<main>, the banner) repeats the facts of the components inside
  // it; it is queued only for a Lighthouse finding that landed on it directly.
  if (r.kind === 'region' && !lighthouse.length) return undefined;
  const scriptMs = findings.filter((e) => e.unit === 'ms').reduce((m, e) => Math.max(m, e.value ?? 0), 0);
  return {
    kind: r.kind,
    id: r.id,
    title: r.signature,
    evidence: facts.length && lighthouse.length ? 'structure-and-lighthouse' : lighthouse.length ? 'lighthouse' : 'structure',
    because: [
      ...facts,
      ...lighthouse.map((l) => `Lighthouse (Chromium): ${l}`),
      ...(holdsLcp ? ['Holds the largest contentful paint element: keep that element’s image eager.'] : []),
    ],
    reach: { pages: r.pages, of, families: r.families.length },
    workload: {
      elements: r.nodes.median,
      ...(r.shareOfPage !== undefined ? { shareOfPage: r.shareOfPage } : {}),
      ...(r.animations?.infinite ? { endlessAnimations: r.animations.infinite } : {}),
      ...(scriptMs ? { chromiumMainThreadMs: scriptMs } : {}),
      ...(r.resources.some((x) => x.transferBytes !== undefined)
        ? { transferBytes: r.resources.reduce((t, x) => t + (x.transferBytes ?? 0), 0) }
        : {}),
    },
    remediation: remediationsFor(r),
    confidence: r.confidence,
    where: r.examples.map((e) => ({ page: e.page, selector: e.selector, rect: e.rect, belowFold: e.belowFold })),
    audits: [...new Set(findings.map((e) => e.audit))],
  };
}

/** Scripts no component loads, summed across pages: the page-wide work. */
function scriptItems(unattributed: UnattributedEvidence[], of: number): Omit<InvestigationItem, 'rank'>[] {
  const byScript = new Map<string, { pages: Set<string>; ms: number; audits: Set<string>; third: boolean; target: string }>();
  for (const u of unattributed) {
    if (u.kind !== 'finding' || u.unit !== 'ms' || !u.target || /could not name|own inline scripts/.test(u.reason)) continue;
    const key = u.target.replace(/[?#].*$/, '');
    const s = byScript.get(key) ?? { pages: new Set(), ms: 0, audits: new Set(), third: false, target: u.target };
    s.pages.add(u.page);
    s.ms = Math.max(s.ms, u.value ?? 0);
    s.audits.add(u.audit);
    if (u.audit === 'third-parties-insight') s.third = true;
    byScript.set(key, s);
  }
  return [...byScript].map(([key, s]) => ({
    url: /\((https?:[^)]+)\)$/.exec(s.target)?.[1] ?? s.target,
    kind: 'script' as const,
    id: `script-${stableHash(key)}`,
    title: s.target.length > 90 ? `…${s.target.slice(-89)}` : s.target,
    evidence: 'lighthouse' as const,
    because: [`Lighthouse (Chromium): up to ${Math.round(s.ms)} ms of main-thread time on a page${s.third ? ', from a third party' : ''}`],
    reach: { pages: s.pages.size, of, families: 0 },
    workload: { chromiumMainThreadMs: Math.round(s.ms) },
    remediation: [REMEDIATIONS['audit-global-script']!],
    confidence: 'medium' as const,
    where: [...s.pages].slice(0, 3).map((page) => ({ page })),
    audits: [...s.audits],
  }));
}

/** Pages far from their family's median: something extra on them. */
function pageItems(result: BenchmarkResult, of: number): Omit<InvestigationItem, 'rank'>[] {
  const out: Omit<InvestigationItem, 'rank'>[] = [];
  for (const f of result.families?.families ?? []) {
    const byPage = new Map<string, typeof f.outliers>();
    for (const o of f.outliers) byPage.set(o.url, [...(byPage.get(o.url) ?? []), o]);
    for (const [url, os] of byPage) {
      const high = os.filter((o) => o.ratio >= 1);
      if (!high.length) continue;
      const dom = high.find((o) => o.metric === 'domNodes');
      const bytes = high.find((o) => o.metric === 'transferBytes');
      out.push({
        kind: 'page',
        id: result.families!.pageFingerprint[url] ?? `page-${stableHash(url)}`,
        title: url,
        evidence: 'structure',
        because: high.map((o) => `${o.metric === 'domNodes' ? 'elements' : o.metric === 'transferBytes' ? 'transfer' : 'requests'} ${o.ratio}× its family’s median (${f.label})`),
        reach: { pages: 1, of, families: 1 },
        workload: { ...(dom ? { elements: dom.value } : {}), ...(bytes ? { transferBytes: bytes.value } : {}) },
        remediation: [REMEDIATIONS['compare-with-family']!],
        confidence: 'high',
        where: [{ page: url }],
        audits: [],
      });
    }
  }
  return out;
}

/** Build the queue from a result's inventory and families. Undefined when there is nothing to queue. */
export function buildInvestigation(result: BenchmarkResult): InvestigationQueue | undefined {
  const inv = result.components;
  const of = inv?.pages ?? result.families?.pagesGrouped ?? 0;
  const candidates = [
    ...(inv?.components ?? []).map((r) => componentItem(r, of)).filter((x): x is NonNullable<typeof x> => !!x),
    ...scriptItems(inv?.unattributed ?? [], of),
    ...pageItems(result, of),
  ];
  if (!candidates.length) return undefined;

  const work = (i: Omit<InvestigationItem, 'rank'>) => (i.kind === 'script' ? (i.workload.chromiumMainThreadMs ?? 0) : (i.workload.elements ?? 0));
  candidates.sort(
    (a, b) =>
      TIER_ORDER[a.evidence] - TIER_ORDER[b.evidence] ||
      b.reach.pages - a.reach.pages ||
      (b.remediation.length > 0 ? 1 : 0) - (a.remediation.length > 0 ? 1 : 0) ||
      work(b) - work(a) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return {
    method: QUEUE_METHOD,
    order: [
      'evidence: a structural fact and a Lighthouse finding, then a Lighthouse finding, then a structural fact',
      'reach: pages it is on',
      'opportunity: a known remedy applies',
      'workload: elements, or Chromium main-thread time for scripts',
    ],
    items: candidates.slice(0, MAX_ITEMS).map((c, i) => ({ rank: i + 1, ...c })),
    limitations: [
      'The order is a sort on the keys above, one after another. It is not a score, and nothing in it is an energy figure.',
      'A remedy is a lead until a measured comparison (with and without the change) shows its effect on this site.',
      ...(inv?.lighthousePages ? [] : ['Without Lighthouse, only structural facts are available; add --lighthouse for element and script findings.']),
    ],
  };
}
