/**
 * Component inventory: the components a scan's pages are built from, which of
 * them recur, what each holds, and the Lighthouse evidence tied to them.
 *
 * Nothing here measures a component's energy. Firefox's power counters cover
 * whole processes, and its profile carries no DOM references, so no figure in
 * a record is an energy figure. Records say where to look and why; whether a
 * change to a component saves energy is a measured comparison (`compare`).
 *
 * Lighthouse evidence comes from Chromium under throttling: a different
 * browser and a different boundary. It is tied to a component when the
 * element Lighthouse names sits inside one of the component's recorded
 * occurrences, matched by DevTools node path, and recorded as unattributed
 * otherwise. Ambiguity is kept, never resolved by guessing.
 */

import type { StepResult } from '../core/types.js';
import type { ComponentInstance, ComponentSignature } from '../collect/page-anatomy.js';
import type { LighthouseSummary } from '../lighthouse/summary.js';
import type { LighthouseNodeEvidence, LighthouseScriptEvidence } from '../lighthouse/evidence.js';
import type { FamilyReport } from './families.js';
import { median } from '../core/stats.js';
import { pageKey } from '../collect/urls.js';
import { pagesOf } from './families.js';
import { stableHash } from './signature.js';
import type { ComponentGraph } from '../model/graph.js';

export const INVENTORY_METHOD = 'inventory-v1';

/** How an element or script finding was tied to a component. */
export type EvidenceMatch =
  /** The element's node path starts with the component occurrence's path. */
  | 'node-path'
  /** Only the element names along the path match (positions differ), and one occurrence fits. */
  | 'tag-path'
  /** The script, or the iframe's host, is loaded by an element inside the component. */
  | 'script-in-component';

export interface ComponentEvidence {
  source: 'lighthouse';
  /** Chromium under Lighthouse's throttling: not the Firefox measurement. */
  boundary: 'chromium-lab';
  audit: string;
  title: string;
  /** A problem Lighthouse reports, or context it reports either way (the LCP element). */
  kind: 'finding' | 'context';
  page: string;
  detail?: string;
  value?: number;
  unit?: 'ms' | 'bytes' | 'score' | 'count';
  matchedBy: EvidenceMatch;
  /** Lighthouse's selector for the element, or the script URL. */
  target?: string;
}

export interface UnattributedEvidence {
  page: string;
  audit: string;
  title: string;
  kind: 'finding' | 'context';
  detail?: string;
  value?: number;
  unit?: 'ms' | 'bytes' | 'score' | 'count';
  target?: string;
  /** Why no component took it. */
  reason: string;
}

export interface ComponentRecord {
  /** Stable across pages and scans: a hash of the signature. */
  id: string;
  signature: string;
  method: ComponentSignature['method'];
  /** A landmark region of the page, or a component inside one. */
  kind: 'component' | 'region';
  /** How sure the identification is: high for annotations, frameworks and Drupal classes, low for a class-name guess. */
  confidence: 'high' | 'medium' | 'low';
  /** Pages it appears on. */
  pages: number;
  /** Share of the pages with structure that it appears on, 0 to 1. */
  reach: number;
  families: string[];
  /** Occurrences across all pages. */
  occurrences: number;
  /**
   * Elements on a page (all occurrences), across pages: owned (each element
   * counted once, in its nearest component) when the graph gives them,
   * otherwise inclusive. See `counted`.
   */
  nodes: { median: number; max: number };
  /** Whether `nodes` and `shareOfPage` are owned or inclusive counts. */
  counted: 'own' | 'inclusive';
  /** Elements inside it, nested components included: never add these up. */
  inclusiveNodes: { median: number; max: number };
  /** Median share of the page's elements, counted as `counted` says. */
  shareOfPage?: number;
  /** Mostly a wrapper around other components: it owns little of what it contains. */
  container: boolean;
  roles: string[];
  names: string[];
  /** The most found on any one page, over its recorded occurrences. */
  media?: { images: number; eagerOffscreenImages: number; videos: number; autoplayVideos: number; iframes: number; canvases: number };
  animations?: { running: number; infinite: number; names: string[] };
  liveRegion?: boolean;
  /** Images, video, iframes and scripts inside it, with transfer where the scan recorded it. */
  resources: { url: string; kind: string; transferBytes?: number; thirdParty?: boolean }[];
  thirdPartyHosts: string[];
  evidence: ComponentEvidence[];
  /** Up to three occurrences on different pages, for finding it. */
  examples: { page: string; selector: string; nodePath: string; rect: ComponentInstance['rect']; belowFold: boolean }[];
  /** Plain statements of why it may be worth a look. Facts, not a score. */
  signals: string[];
  limitations: string[];
}

export interface ComponentInventory {
  method: typeof INVENTORY_METHOD;
  /** Pages with recorded component occurrences. */
  pages: number;
  /** Pages Lighthouse evidence was available for. */
  lighthousePages: number;
  /** Recurring components first, then by size. */
  components: ComponentRecord[];
  unattributed: UnattributedEvidence[];
  limitations: string[];
}

const CONFIDENCE: Record<ComponentSignature['method'], ComponentRecord['confidence']> = {
  annotation: 'high',
  framework: 'high',
  drupal: 'high',
  landmark: 'medium',
  'class-heuristic': 'low',
};

const MAX_RECORDS = 60;
const MAX_EVIDENCE = 12;
const MAX_UNATTRIBUTED = 40;

const isPrefixPath = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer},`);
/** "1,HTML,1,BODY,0,DIV" -> "HTML,BODY,DIV". */
const tagsOf = (path: string) =>
  path
    .split(',')
    .filter((_, i) => i % 2 === 1)
    .join(',');
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};
const withoutQuery = (url: string) => url.replace(/[?#].*$/, '');
/** Lighthouse results are per URL, query included: ?page=2 is another page. */
const keyOf = (url: string) => pageKey(url, { queryStrategy: 'keep' });

/**
 * The recorded occurrence an element falls in: the deepest one whose node
 * path contains the element's, else, by element names alone, the deepest
 * when exactly one fits. Undefined when none does.
 */
export function matchNode(
  instances: ComponentInstance[],
  path: string,
): { instance: ComponentInstance; matchedBy: 'node-path' | 'tag-path' } | undefined {
  const exact = instances.filter((i) => isPrefixPath(i.nodePath, path));
  if (exact.length) {
    const deepest = exact.reduce((a, b) => (b.nodePath.length > a.nodePath.length ? b : a));
    return { instance: deepest, matchedBy: 'node-path' };
  }
  // Positions can differ between Chromium's DOM and Firefox's (a banner a
  // script inserted, say). Element names alone are a weaker match, so only
  // an unambiguous one counts.
  const tags = tagsOf(path);
  const loose = instances.filter((i) => isPrefixPath(tagsOf(i.nodePath), tags));
  if (!loose.length) return undefined;
  const depth = Math.max(...loose.map((i) => tagsOf(i.nodePath).length));
  const deepest = loose.filter((i) => tagsOf(i.nodePath).length === depth);
  return deepest.length === 1 ? { instance: deepest[0]!, matchedBy: 'tag-path' } : undefined;
}

/** The occurrence that loads a script, or an iframe on the script's host. */
function matchScript(instances: ComponentInstance[], url: string): ComponentInstance | undefined {
  const bare = withoutQuery(url);
  const byScript = instances.filter((i) => i.resources?.some((r) => r.kind === 'script' && withoutQuery(r.url) === bare));
  const host = hostOf(url);
  const byFrame = host ? instances.filter((i) => i.resources?.some((r) => r.kind === 'iframe' && hostOf(r.url) === host)) : [];
  const found = byScript.length ? byScript : byFrame;
  return found.length ? found.reduce((a, b) => (b.nodePath.length > a.nodePath.length ? b : a)) : undefined;
}

interface PageEvidence {
  nodes: LighthouseNodeEvidence[];
  scripts: LighthouseScriptEvidence[];
}

function evidenceByPage(lighthouse: LighthouseSummary | undefined): Map<string, PageEvidence> {
  const out = new Map<string, PageEvidence>();
  for (const r of lighthouse?.results ?? []) {
    if (!r.evidence) continue;
    for (const u of [r.requestedUrl, r.finalUrl]) if (u) out.set(keyOf(u), r.evidence);
  }
  return out;
}

/**
 * Build the inventory from a scan's pages, its families and, when it ran,
 * Lighthouse. Undefined when no page recorded component occurrences (results
 * made before they were).
 */
export function buildInventory(
  steps: StepResult[],
  options: { families?: FamilyReport; lighthouse?: LighthouseSummary; graph?: ComponentGraph } = {},
): ComponentInventory | undefined {
  const pages = pagesOf(steps).filter((s) => s.anatomy?.structure);
  const withInstances = pages.filter((s) => s.anatomy!.structure!.instances?.length);
  if (withInstances.length === 0) return undefined;

  const lhByPage = evidenceByPage(options.lighthouse);
  const n = pages.length;

  interface Acc {
    signature: string;
    method: ComponentSignature['method'];
    pages: Set<string>;
    families: Set<string>;
    occurrences: number;
    nodesPerPage: number[];
    inclusivePerPage: number[];
    sharePerPage: number[];
    countPerPage: number[];
    instances: { page: string; i: ComponentInstance }[];
    evidence: ComponentEvidence[];
  }
  const acc = new Map<string, Acc>();
  const get = (signature: string, method: ComponentSignature['method']) => {
    let a = acc.get(signature);
    if (!a) {
      a = { signature, method, pages: new Set(), families: new Set(), occurrences: 0, nodesPerPage: [], inclusivePerPage: [], sharePerPage: [], countPerPage: [], instances: [], evidence: [] };
      acc.set(signature, a);
    }
    return a;
  };

  const unattributed: UnattributedEvidence[] = [];
  let lighthousePages = 0;

  // Owned counts from the graph: an element counted once, in its nearest
  // component, so a wrapper is not credited with its descendants' media.
  const graph = options.graph;
  const graphInstance = new Map((graph?.instances ?? []).map((g) => [`${g.ref.scenario}:${g.ref.instance}`, g]));
  const counted: 'own' | 'inclusive' = graph ? 'own' : 'inclusive';
  const ownView = (scenario: number, idx: number, i: ComponentInstance): ComponentInstance => {
    const g = graphInstance.get(`${scenario}:${idx}`);
    if (!g) return i;
    const o = g.own;
    const media = {
      images: o.images ?? 0, eagerOffscreenImages: o.eagerOffscreenImages ?? 0, videos: o.videos ?? 0,
      autoplayVideos: o.autoplayVideos ?? 0, iframes: o.iframes ?? 0, canvases: o.canvases ?? 0,
    };
    const { media: _m, animations: _a, ...rest } = i;
    return {
      ...rest,
      ...(Object.values(media).some((v) => v > 0) ? { media } : {}),
      ...(o.animations || o.infiniteAnimations
        ? { animations: { running: o.animations ?? 0, infinite: o.infiniteAnimations ?? 0, names: i.animations?.names ?? [] } }
        : {}),
      ...(i.ownResources ? { resources: i.ownResources } : {}),
    };
  };
  const containerSignatures = new Set(
    [...new Set((graph?.types ?? []).map((t) => t.signature))].filter((sig) => (graph?.types ?? []).filter((t) => t.signature === sig).every((t) => t.container)),
  );

  for (const step of pages) {
    const url = step.url!;
    const structure = step.anatomy!.structure!;
    const family = options.families?.pageFamily[url];
    const scenario = steps.indexOf(step);
    const instances = (structure.instances ?? []).map((i, idx) => ownView(scenario, idx, i));
    // Owned elements per signature on this page: recorded when available,
    // else the sum over its recorded occurrences in the graph (older results).
    const ownOnPage = new Map<string, number>();
    for (const g of graph?.instances ?? []) {
      if (g.ref.scenario !== scenario) continue;
      const sig = structure.instances?.[g.ref.instance]?.signature;
      if (sig) ownOnPage.set(sig, (ownOnPage.get(sig) ?? 0) + g.own.nodes);
    }
    for (const c of structure.components) {
      const a = get(c.signature, c.method);
      a.pages.add(url);
      if (family) a.families.add(family);
      a.occurrences += c.count;
      const nodes = graph ? (c.ownNodes ?? ownOnPage.get(c.signature) ?? 0) : c.nodes;
      a.nodesPerPage.push(nodes);
      a.inclusivePerPage.push(c.nodes);
      a.countPerPage.push(c.count);
      if (step.anatomy!.domNodes > 0) a.sharePerPage.push(nodes / step.anatomy!.domNodes);
    }
    for (const i of instances) get(i.signature, i.method).instances.push({ page: url, i });

    const ev = lhByPage.get(keyOf(url)) ?? lhByPage.get(keyOf(step.step));
    if (!ev) continue;
    lighthousePages++;
    for (const e of ev.nodes) {
      const m = matchNode(instances, e.path);
      const base = {
        audit: e.audit,
        title: e.title,
        kind: e.kind,
        ...(e.detail ? { detail: e.detail } : {}),
        ...(e.value !== undefined ? { value: e.value } : {}),
        ...(e.unit ? { unit: e.unit } : {}),
        ...(e.selector ? { target: e.selector } : {}),
      };
      if (m) {
        get(m.instance.signature, m.instance.method).evidence.push({ source: 'lighthouse', boundary: 'chromium-lab', page: url, matchedBy: m.matchedBy, ...base });
      } else {
        unattributed.push({ page: url, ...base, reason: 'The element is not inside any recorded component occurrence, or its position differs between Chromium and Firefox.' });
      }
    }
    for (const s of ev.scripts) {
      const base = {
        audit: s.audit,
        title: s.title,
        kind: s.kind,
        ...(s.detail ? { detail: s.detail } : {}),
        value: s.value,
        unit: s.unit,
        target: s.source ? `${s.source.url}${s.source.line !== undefined ? `:${s.source.line}` : ''}` : s.entity ? `${s.entity} (${s.url})` : s.url,
      };
      const i = s.url === 'Unattributable' ? undefined : matchScript(instances, s.url);
      if (i) {
        get(i.signature, i.method).evidence.push({ source: 'lighthouse', boundary: 'chromium-lab', page: url, matchedBy: 'script-in-component', ...base });
      } else {
        unattributed.push({
          page: url,
          ...base,
          reason:
            s.url === 'Unattributable'
              ? 'Chromium could not name the script.'
              : s.url === url || withoutQuery(s.url) === withoutQuery(url)
                ? 'Work in the page’s own inline scripts and parsing, which no component element loads.'
                : 'No recorded component loads this script: bundled and global scripts serve the whole page.',
        });
      }
    }
  }

  const transferOf = new Map<string, { bytes: number; thirdParty: boolean }>();
  for (const s of pages) {
    for (const r of s.network?.resources ?? []) {
      const k = withoutQuery(r.url);
      const prev = transferOf.get(k);
      transferOf.set(k, { bytes: Math.max(prev?.bytes ?? 0, r.transferBytes), thirdParty: r.thirdParty });
    }
  }

  const records: ComponentRecord[] = [...acc.values()].map((a) => {
    const id = `cmp-${stableHash(a.signature)}`;
    const kind: ComponentRecord['kind'] = a.method === 'landmark' ? 'region' : 'component';
    const instances = a.instances.map((x) => x.i);
    // Media and animation: the most on any one page, over its recorded occurrences.
    const perPage = new Map<string, ComponentInstance[]>();
    for (const x of a.instances) perPage.set(x.page, [...(perPage.get(x.page) ?? []), x.i]);
    const maxOver = (f: (list: ComponentInstance[]) => number) => Math.max(0, ...[...perPage.values()].map(f));
    const sum = (list: ComponentInstance[], k: keyof NonNullable<ComponentInstance['media']>) => list.reduce((t, i) => t + (i.media?.[k] ?? 0), 0);
    const media = {
      images: maxOver((l) => sum(l, 'images')),
      eagerOffscreenImages: maxOver((l) => sum(l, 'eagerOffscreenImages')),
      videos: maxOver((l) => sum(l, 'videos')),
      autoplayVideos: maxOver((l) => sum(l, 'autoplayVideos')),
      iframes: maxOver((l) => sum(l, 'iframes')),
      canvases: maxOver((l) => sum(l, 'canvases')),
    };
    const running = maxOver((l) => l.reduce((t, i) => t + (i.animations?.running ?? 0), 0));
    const infinite = maxOver((l) => l.reduce((t, i) => t + (i.animations?.infinite ?? 0), 0));
    const animationNames = [...new Set(instances.flatMap((i) => i.animations?.names ?? []))].slice(0, 5);

    const resources = new Map<string, ComponentRecord['resources'][number]>();
    for (const i of instances) {
      for (const r of i.resources ?? []) {
        const k = withoutQuery(r.url);
        if (resources.has(k)) continue;
        const t = transferOf.get(k);
        resources.set(k, { url: r.url, kind: r.kind, ...(t ? { transferBytes: t.bytes, thirdParty: t.thirdParty } : {}) });
      }
    }
    const resourceList = [...resources.values()].sort((x, y) => (y.transferBytes ?? 0) - (x.transferBytes ?? 0)).slice(0, 8);
    const thirdPartyHosts = [...new Set(resourceList.filter((r) => r.thirdParty).map((r) => hostOf(r.url)).filter(Boolean))].sort();

    const nodes = { median: Math.round(median(a.nodesPerPage)), max: Math.max(...a.nodesPerPage) };
    const inclusiveNodes = { median: Math.round(median(a.inclusivePerPage)), max: Math.max(...a.inclusivePerPage) };
    const container = containerSignatures.has(a.signature);
    const shareOfPage = a.sharePerPage.length ? Math.round(median(a.sharePerPage) * 1000) / 1000 : undefined;

    const examples: ComponentRecord['examples'] = [];
    for (const x of a.instances) {
      if (examples.length >= 3) break;
      if (examples.some((e) => e.page === x.page)) continue;
      examples.push({ page: x.page, selector: x.i.selector, nodePath: x.i.nodePath, rect: x.i.rect, belowFold: x.i.belowFold });
    }

    const evidence = a.evidence.slice(0, MAX_EVIDENCE);
    const signals: string[] = [];
    if (a.pages.size >= 2) signals.push(`On ${a.pages.size} of ${n} pages${a.families.size > 1 ? `, in ${a.families.size} page families` : ''}.`);
    if (shareOfPage !== undefined && (shareOfPage >= 0.25 || nodes.median >= 800)) {
      const perPage = Math.round(median(a.countPerPage));
      signals.push(
        perPage > 1
          ? `Its ${perPage} occurrences on a page hold ${Math.round(shareOfPage * 100)}% of the page’s elements (median ${nodes.median}).`
          : `Holds ${Math.round(shareOfPage * 100)}% of a page’s elements (median ${nodes.median}).`,
      );
    }
    if (infinite) signals.push(`${infinite} animation${infinite === 1 ? '' : 's'} that never stop${infinite === 1 ? 's' : ''} (${animationNames.join(', ') || 'unnamed'}).`);
    if (media.autoplayVideos) signals.push(`${media.autoplayVideos} video${media.autoplayVideos === 1 ? '' : 's'} playing on load.`);
    if (media.iframes) signals.push(`${media.iframes} iframe${media.iframes === 1 ? '' : 's'}${thirdPartyHosts.length ? ` (${thirdPartyHosts.slice(0, 3).join(', ')})` : ''}.`);
    if (media.eagerOffscreenImages) signals.push(`${media.eagerOffscreenImages} image${media.eagerOffscreenImages === 1 ? '' : 's'} below the first screen without loading="lazy".`);
    if (media.canvases) signals.push(`${media.canvases} canvas element${media.canvases === 1 ? '' : 's'}.`);
    if (a.evidence.some((e) => e.audit.startsWith('lcp-'))) {
      signals.push('Holds the largest contentful paint element (Lighthouse, Chromium): keep that element’s image eager, never lazy.');
    }
    const byAudit = new Map<string, { title: string; pages: Set<string> }>();
    for (const e of a.evidence.filter((x) => x.kind === 'finding')) {
      const k = e.detail ?? e.title;
      const b = byAudit.get(k) ?? { title: k, pages: new Set<string>() };
      b.pages.add(e.page);
      byAudit.set(k, b);
    }
    for (const b of byAudit.values()) signals.push(`Lighthouse (Chromium): ${b.title}, on ${b.pages.size} page${b.pages.size === 1 ? '' : 's'}.`);

    const limitations: string[] = [];
    if (a.method === 'class-heuristic') limitations.push('Recognised from a class name only; check that it is one component.');
    if (a.evidence.some((e) => e.matchedBy === 'tag-path')) {
      limitations.push('Some Lighthouse findings were matched by element names alone, because positions differ between Chromium’s DOM and Firefox’s.');
    }
    if (instances.length === 0) limitations.push('No occurrence was among the largest recorded on its pages, so there is no position, media or evidence for it.');

    const roles = [...new Set(instances.map((i) => i.role).filter((r): r is string => !!r))].slice(0, 3);
    const names = [...new Set(instances.map((i) => i.name).filter((x): x is string => !!x))].slice(0, 3);
    return {
      id,
      signature: a.signature,
      method: a.method,
      kind,
      confidence: CONFIDENCE[a.method],
      pages: a.pages.size,
      reach: n ? Math.round((a.pages.size / n) * 1000) / 1000 : 0,
      families: [...a.families].sort(),
      occurrences: a.occurrences,
      nodes,
      counted,
      inclusiveNodes,
      container,
      ...(shareOfPage !== undefined ? { shareOfPage } : {}),
      roles,
      names,
      ...(Object.values(media).some((v) => v > 0) ? { media } : {}),
      ...(running || infinite ? { animations: { running, infinite, names: animationNames } } : {}),
      ...(instances.some((i) => i.liveRegion) ? { liveRegion: true } : {}),
      resources: resourceList,
      thirdPartyHosts,
      evidence,
      examples,
      signals,
      limitations,
    };
  });

  // Components before regions; then by reach, size and id, so the order is stable.
  records.sort(
    (x, y) =>
      (x.kind === 'region' ? 1 : 0) - (y.kind === 'region' ? 1 : 0) ||
      y.pages - x.pages ||
      y.nodes.median - x.nodes.median ||
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );

  const limitations = [
    'Components are recognised from the markup. No figure here is a component’s energy: Firefox’s power counters cover whole processes. Whether changing a component saves energy is for a measured comparison (compare), run with and without the change.',
    'Stylesheets, web fonts and CSS background images are not tied to components. Scripts are tied to one only when the element that loads them sits inside it; bundled and global scripts stay unattributed.',
    'Firefox CPU categories are page-level. web-energy diagnose <url> shows them for one representative page.',
    'At most 24 occurrences are recorded per page (the largest, plus smaller ones holding media or animations); counts and sizes cover every occurrence.',
    ...(options.lighthouse
      ? [
          'Lighthouse evidence comes from Chromium under throttling, a different browser and boundary from the Firefox measurement. It says where Chromium spent main-thread time or found a problem, not what Firefox used.',
        ]
      : ['Lighthouse did not run, so there is no element or script evidence. Add --lighthouse to a crawl for it.']),
  ];

  return {
    method: INVENTORY_METHOD,
    pages: withInstances.length,
    lighthousePages,
    components: records.slice(0, MAX_RECORDS),
    unattributed: unattributed.slice(0, MAX_UNATTRIBUTED),
    limitations,
  };
}
