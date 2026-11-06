/**
 * The component graph: one canonical model of a scan, by stable id.
 *
 * - pages, each with its family and fingerprint;
 * - component types (a reusable component) and instances (one occurrence on
 *   one page), with parent and child links between instances;
 * - resources, with the pages, families and instances that load them, and
 *   their scope: site-wide, family-wide, shared or page-unique;
 * - findings, each with an explicit attribution target (an instance, a
 *   resource, a page, or nothing), its evidence class, and an energy status;
 * - sources, describing where each metric came from (browser, version, time).
 *
 * Owned counts never overlap: an element belongs to its nearest component,
 * so a wrapper is not credited with what its descendants hold. Inclusive
 * counts are kept beside them and are never summed.
 *
 * Built from a result's stored data, so it can be rebuilt for any result,
 * older ones included (their owned counts are estimated from inclusive ones,
 * and say so). Nothing here is an energy figure; a finding's energy is
 * "not-measured" until an experiment measures a difference.
 */

import type { BenchmarkResult, StepResult } from '../core/types.js';
import type { ComponentInstance, ComponentSignature, OwnCounts } from '../collect/page-anatomy.js';
import type { LighthouseNodeEvidence, LighthouseScriptEvidence } from '../lighthouse/evidence.js';
import { pageKey } from '../collect/urls.js';
import { median } from '../core/stats.js';
import { pagesOf } from '../analysis/families.js';
import { stableHash } from '../analysis/signature.js';

export const GRAPH_SCHEMA = 'component-graph/1';

/** Where a figure came from. Metrics name a source by id instead of repeating it. */
export interface Source {
  id: 'firefox-dom' | 'firefox-network' | 'firefox-energy' | 'lighthouse' | 'chromium-trace' | 'co2js' | 'webnrg';
  browser?: string;
  tool?: string;
  timestamp?: string;
  /** How the figure was produced, in plain words. */
  method: string;
  /** The boundary it covers. */
  boundary: string;
}

export type Unit = 'count' | 'bytes' | 'ms' | 'score' | 'ratio' | 'mWh';

export interface Metric {
  value: number;
  unit: Unit;
  source: Source['id'];
  /** What it covers: one instance's own elements, a page, one resource on one page, the median over pages. */
  scope: 'instance-own' | 'instance-inclusive' | 'page' | 'resource-per-page' | 'median-over-pages' | 'max-over-pages';
}

/** Level A to D of the identification hierarchy. */
export type Identification = 'explicit' | 'semantic' | 'structural' | 'inferred';

export interface GraphPage {
  id: string;
  url: string;
  family?: string;
  fingerprint?: string;
  sampleReason?: string;
  metrics: { domNodes?: Metric; transferBytes?: Metric; requests?: Metric };
  /** Elements in <body> that belong to no component. */
  unownedNodes?: number;
  instances: string[];
  resources: string[];
}

export interface ComponentType {
  /** Stable across pages and scans: a hash of signature, tag and role. */
  id: string;
  signature: string;
  method: ComponentSignature['method'];
  identification: Identification;
  confidence: 'high' | 'medium' | 'low';
  /** What instances were matched on. */
  matchedBy: string[];
  tag?: string;
  role?: string;
  /** A kind inferred from what instances contain (Level D), labelled as inferred. */
  inferredKind?: { kind: string; from: string[] };
  pages: number;
  families: string[];
  instances: number;
  /** Median over pages of the elements its instances own, and include. */
  ownNodes?: { median: number; max: number; estimated: boolean };
  inclusiveNodes: { median: number; max: number };
  /** Mostly a wrapper: it owns little of what it contains. */
  container: boolean;
  /** Distinct sets of child types among its instances. More than one means instances differ in structure. */
  variants: number;
  notes: string[];
}

export interface GraphInstance {
  id: string;
  type: string;
  page: string;
  /** Its occurrence among the type's instances on the page, in document order. */
  occurrence: number;
  parent?: string;
  children: string[];
  selector: string;
  tag?: string;
  role?: string;
  inclusiveNodes: number;
  /** Owned counts; zero counts are left out. */
  own: GraphOwn;
  /** True when own counts were estimated (older results: inclusive minus recorded children). */
  ownEstimated: boolean;
  /** Resources it loads directly. */
  resources: string[];
  /** Where to find the full record: scenario and instance index in this result. */
  ref: { scenario: number; instance: number };
}

/** Owned counts with zeros left out: always the element count, then whatever is not zero. */
export type GraphOwn = { nodes: number } & Partial<Omit<OwnCounts, 'nodes'>>;

export type ResourceScope = 'site-wide' | 'family-wide' | 'shared' | 'page-unique';

export interface GraphResource {
  id: string;
  /** host + path, with per-page query values (page URLs, timestamps) removed. */
  key: string;
  host: string;
  kind: string;
  thirdParty: boolean;
  pages: number;
  families: string[];
  scope: ResourceScope;
  /** Bytes transferred per page that loaded it (firefox-network): median and maximum over those pages. */
  transferBytes: { median: number; max: number };
  /**
   * Instances whose own elements load it, on pages where it was transferred.
   * Empty for scripts and styles in <head>, CSS backgrounds and resources
   * loaded by script.
   */
  loadedBy: string[];
  /**
   * Pages whose recorded components reference it (an <img>, a <script>) but
   * did not transfer it during the measured load: lazy, hidden or cached.
   */
  referencedWithoutTransfer?: number;
}

export type EvidenceClass =
  /** Seen directly in the page by Firefox (an endless animation, an eager offscreen image). */
  | 'direct-observation'
  /** A Lighthouse finding tied to a DOM node inside the component. */
  | 'direct-node'
  /** Tied through a resource the component, or the page, loads. */
  | 'resource-association'
  /** Supported by Chromium trace events (PR B). */
  | 'trace-supported'
  /** Seen across pages, not tested (PR C). */
  | 'cross-page-correlation'
  /** A size or structure threshold: a reason to look, not a cause. */
  | 'structural-heuristic';

export interface GraphFinding {
  id: string;
  kind: string;
  title: string;
  page: string;
  target: { type: 'instance' | 'resource' | 'page' | 'unattributed'; id?: string; reason?: string };
  evidenceClass: EvidenceClass;
  /** A problem, or context (the LCP element): context ranks nothing. */
  role: 'finding' | 'context';
  evidence: { source: Source['id']; ref: string; detail?: string }[];
  metric?: Metric;
  /** Energy is only ever a measured workload difference; never a zero for "not measured". */
  energy: { status: 'not-measured' | 'measured-difference'; measuredWorkloadDeltaMwh: number | null };
}

export interface ComponentGraph {
  schema: typeof GRAPH_SCHEMA;
  sources: Source[];
  pages: GraphPage[];
  types: ComponentType[];
  instances: GraphInstance[];
  resources: GraphResource[];
  findings: GraphFinding[];
  limitations: string[];
}

const IDENT: Record<ComponentSignature['method'], Identification> = {
  annotation: 'explicit',
  framework: 'explicit',
  drupal: 'explicit',
  landmark: 'semantic',
  'class-heuristic': 'structural',
};
const CONFIDENCE: Record<ComponentSignature['method'], ComponentType['confidence']> = {
  annotation: 'high',
  framework: 'high',
  drupal: 'high',
  landmark: 'medium',
  'class-heuristic': 'low',
};

const keyOfPage = (url: string) => pageKey(url, { queryStrategy: 'keep' });

/**
 * A resource's identity: host and path, keeping query values that name the
 * asset, dropping those that vary per page or per load (a page URL passed
 * along, a timestamp), so one script loaded on every page is one resource.
 * Third-party beacons and pings (anything but scripts, styles, fonts and
 * documents) are identified by endpoint alone: each hit's query differs.
 */
export function resourceIdentity(url: string, kind?: string, thirdParty?: boolean): string {
  try {
    const u = new URL(url);
    const base = `${u.hostname.toLowerCase()}${u.pathname}`;
    if (thirdParty && kind && !['script', 'stylesheet', 'font', 'document'].includes(kind)) return base;
    const kept = [...u.searchParams.entries()].filter(([, v]) => !/^https?:|%3A%2F%2F|^\d{10,}$/i.test(v) && !/^https?:\/\//i.test(decodeURIComponent(v)));
    const q = kept.length ? `?${kept.map(([k, v]) => `${k}=${v}`).sort().join('&')}` : '';
    const key = `${base}${q}`;
    return key.length > 240 ? `${key.slice(0, 200)}…#${stableHash(key)}` : key;
  } catch {
    return url;
  }
}

const tagFromPath = (path: string) => path.split(',').at(-1)?.toLowerCase();
const isPrefix = (outer: string, inner: string) => inner.startsWith(`${outer},`);
/** Document order of DevTools node paths. */
function comparePaths(a: string, b: string): number {
  const pa = a.split(',');
  const pb = b.split(',');
  for (let i = 0; i < Math.min(pa.length, pb.length); i += 2) {
    const x = Number(pa[i]);
    const y = Number(pb[i]);
    if (x !== y) return Number.isNaN(x) || Number.isNaN(y) ? (pa[i]! < pb[i]! ? -1 : 1) : x - y;
  }
  return pa.length - pb.length;
}

const ZERO = (): OwnCounts => ({ nodes: 0, images: 0, eagerOffscreenImages: 0, videos: 0, autoplayVideos: 0, iframes: 0, canvases: 0, animations: 0, infiniteAnimations: 0 });

/** Owned counts from inclusive ones, for results that predate own accounting. */
function estimateOwn(i: ComponentInstance, children: ComponentInstance[]): OwnCounts {
  const media = (x: ComponentInstance) => x.media ?? { images: 0, eagerOffscreenImages: 0, videos: 0, autoplayVideos: 0, iframes: 0, canvases: 0 };
  const m = media(i);
  const sub = (k: keyof NonNullable<ComponentInstance['media']>) => Math.max(0, m[k] - children.reduce((t, c) => t + media(c)[k], 0));
  return {
    nodes: Math.max(1, i.nodes - children.reduce((t, c) => t + c.nodes, 0)),
    images: sub('images'),
    eagerOffscreenImages: sub('eagerOffscreenImages'),
    videos: sub('videos'),
    autoplayVideos: sub('autoplayVideos'),
    iframes: sub('iframes'),
    canvases: sub('canvases'),
    animations: Math.max(0, (i.animations?.running ?? 0) - children.reduce((t, c) => t + (c.animations?.running ?? 0), 0)),
    infiniteAnimations: Math.max(0, (i.animations?.infinite ?? 0) - children.reduce((t, c) => t + (c.animations?.infinite ?? 0), 0)),
  };
}

/** Level D: a kind inferred from what instances contain and are called. Never a framework identity. */
export function inferKind(signature: string, tag: string | undefined, role: string | undefined, own: OwnCounts): { kind: string; from: string[] } | undefined {
  const s = signature.toLowerCase();
  const rules: [RegExp | ((x: string) => boolean), string][] = [
    [/cookie|consent|gdpr|privacy-banner/, 'cookie management'],
    [/carousel|slider|swiper|slick|splide|glide/, 'carousel'],
    [/accordion/, 'accordion'],
    [/megamenu|mega-menu|menu|navbar|nav\b|navigation/, 'navigation menu'],
    [/search/, 'search'],
    [/modal|popup|lightbox/, 'modal dialog'],
    [/chart|graph|highcharts|plotly|d3-|vega/, 'chart'],
    [/map\b|leaflet|mapbox|esri|gmap/, 'map'],
    [/video|player|youtube|vimeo/, 'media player'],
    [/card|teaser|tile/, 'card'],
    [/table|datatable|grid-view/, 'data table'],
    [/footer/, 'footer'],
    [/header|masthead|banner/, 'header'],
    [/form|webform/, 'form'],
    [/share|social/, 'social sharing'],
    [/ad-|advert|sponsor/, 'advertising'],
  ];
  for (const [re, kind] of rules) if (typeof re !== 'function' && re.test(s)) return { kind, from: [`name "${signature}"`] };
  if (role === 'navigation') return { kind: 'navigation menu', from: ['role navigation'] };
  if (role === 'search') return { kind: 'search', from: ['role search'] };
  if (role === 'dialog' || tag === 'dialog') return { kind: 'modal dialog', from: [role === 'dialog' ? 'role dialog' : '<dialog>'] };
  if (tag === 'form' || role === 'form') return { kind: 'form', from: ['<form>'] };
  if (tag === 'table') return { kind: 'data table', from: ['<table>'] };
  if (own.videos > 0) return { kind: 'media player', from: ['holds video'] };
  if (own.canvases > 0) return { kind: 'chart or drawing', from: ['holds canvas'] };
  if (own.iframes > 0) return { kind: 'embed', from: ['holds an iframe'] };
  return undefined;
}

function sourcesOf(result: BenchmarkResult): Source[] {
  const env = result.environment;
  const ff = env?.firefoxVersion ? `Firefox ${env.firefoxVersion}` : 'Firefox';
  const out: Source[] = [
    { id: 'firefox-dom', browser: ff, timestamp: env?.timestamp, method: 'Read from the rendered DOM after the measured window', boundary: 'the page as Firefox rendered it' },
    { id: 'firefox-network', browser: ff, timestamp: env?.timestamp, method: 'Network events during the measured page load', boundary: 'transfer to this browser' },
  ];
  if (result.lighthouse) {
    out.push({
      id: 'lighthouse',
      browser: result.lighthouse.browser ?? 'Chromium',
      tool: `Lighthouse ${result.lighthouse.version}`,
      method: `${result.lighthouse.formFactor} form factor, ${result.lighthouse.throttling}`,
      boundary: 'Chromium lab, not the Firefox measurement',
    });
  }
  return out;
}

function nodeMatch(instances: { i: ComponentInstance; id: string }[], path: string): { id: string; by: 'node-path' | 'tag-path' } | undefined {
  const exact = instances.filter((x) => x.i.nodePath === path || isPrefix(x.i.nodePath, path));
  if (exact.length) return { id: exact.reduce((a, b) => (b.i.nodePath.length > a.i.nodePath.length ? b : a)).id, by: 'node-path' };
  const tags = (p: string) => p.split(',').filter((_, k) => k % 2 === 1).join(',');
  const t = tags(path);
  const loose = instances.filter((x) => t === tags(x.i.nodePath) || t.startsWith(`${tags(x.i.nodePath)},`));
  if (!loose.length) return undefined;
  const depth = Math.max(...loose.map((x) => tags(x.i.nodePath).length));
  const deepest = loose.filter((x) => tags(x.i.nodePath).length === depth);
  return deepest.length === 1 ? { id: deepest[0]!.id, by: 'tag-path' } : undefined;
}

/** Build the graph from a result. Undefined when no page recorded structure. */
export function buildGraph(result: BenchmarkResult): ComponentGraph | undefined {
  const steps = pagesOf(result.scenarios).filter((s) => s.anatomy?.structure);
  if (!steps.length) return undefined;
  const scenarioIndex = new Map<StepResult, number>(result.scenarios.map((s, i) => [s, i]));
  const families = result.families;
  const N = steps.length;
  const sources = sourcesOf(result);

  const pages: GraphPage[] = [];
  // Elements that reference a resource, resolved once every page's network is known.
  const pendingRefs: { instance: string; page: string; url: string; key: string; resIds: string[] }[] = [];
  const instances: GraphInstance[] = [];
  const findings: GraphFinding[] = [];
  const typeAcc = new Map<string, { signature: string; method: ComponentSignature['method']; tag?: string; role?: string; pages: Set<string>; families: Set<string>; instances: GraphInstance[]; own: number[]; inclusive: number[]; shapes: Set<string>; anyEstimated: boolean }>();
  const resAcc = new Map<string, { url: string; host: string; kind: string; thirdParty: boolean; pages: Map<string, number>; families: Set<string>; loadedBy: Set<string>; referencedOn: Set<string> }>();
  let legacy = 0;

  const typeIdOf = (signature: string, tag: string | undefined, role: string | undefined) => `ct-${stableHash(`${signature}|${tag ?? ''}|${role ?? ''}`)}`;

  for (const step of steps) {
    const url = step.url!;
    const pid = `pg-${stableHash(keyOfPage(url))}`;
    const structure = step.anatomy!.structure!;
    const family = families?.pageFamily[url];
    const recorded = [...(structure.instances ?? [])].map((i, idx) => ({ i, idx })).sort((a, b) => comparePaths(a.i.nodePath, b.i.nodePath));
    if (recorded.length && !recorded[0]!.i.own) legacy++;

    // Ids: type from signature, tag and role; instance from page, type and occurrence.
    const occurrences = new Map<string, number>();
    const withIds = recorded.map(({ i, idx }) => {
      const tag = i.tag ?? tagFromPath(i.nodePath);
      const type = typeIdOf(i.signature, tag, i.role);
      const occurrence = occurrences.get(type) ?? 0;
      occurrences.set(type, occurrence + 1);
      return { i, idx, tag, type, occurrence, id: `ci-${stableHash(`${keyOfPage(url)}|${type}|${occurrence}`)}` };
    });
    // Parents: the nearest recorded ancestor.
    const parentOf = new Map<string, string>();
    for (const x of withIds) {
      const anc = withIds.filter((y) => y !== x && isPrefix(y.i.nodePath, x.i.nodePath));
      if (anc.length) parentOf.set(x.id, anc.reduce((a, b) => (b.i.nodePath.length > a.i.nodePath.length ? b : a)).id);
    }
    const childrenOf = (id: string) => withIds.filter((y) => parentOf.get(y.id) === id);

    // Resources of the page.
    const pageResources = new Map<string, number>();
    // A resource's kind and party, for identity and for matching the elements that load it.
    const kindOf = new Map<string, { kind: string; thirdParty: boolean }>();
    for (const r of step.network?.resources ?? []) kindOf.set(r.url, { kind: r.resourceType, thirdParty: r.thirdParty });
    const identity = (u: string) => resourceIdentity(u, kindOf.get(u)?.kind, kindOf.get(u)?.thirdParty);
    for (const r of step.network?.resources ?? []) {
      const key = identity(r.url);
      pageResources.set(key, Math.max(pageResources.get(key) ?? 0, r.transferBytes));
      const acc = resAcc.get(key) ?? { url: r.url, host: r.domain, kind: r.resourceType, thirdParty: r.thirdParty, pages: new Map(), families: new Set<string>(), loadedBy: new Set<string>(), referencedOn: new Set<string>() };
      acc.pages.set(pid, Math.max(acc.pages.get(pid) ?? 0, r.transferBytes));
      if (family) acc.families.add(family);
      resAcc.set(key, acc);
    }

    const pageInstanceIds: string[] = [];
    for (const x of withIds) {
      const kids = childrenOf(x.id);
      const own = x.i.own ?? estimateOwn(x.i, kids.map((k) => k.i));
      // Direct resources: owned when recorded; otherwise those no recorded child lists.
      const childUrls = new Set(kids.flatMap((k) => (k.i.resources ?? []).map((r) => r.url)));
      const direct = x.i.ownResources ?? (x.i.resources ?? []).filter((r) => !childUrls.has(r.url));
      const resIds: string[] = [];
      // Deferred: a resource transferred on another page may be recorded later.
      for (const r of direct) pendingRefs.push({ instance: x.id, page: pid, url: r.url, key: identity(r.url), resIds });
      const compactOwn: GraphOwn = { nodes: own.nodes };
      for (const [k, v] of Object.entries(own) as [keyof OwnCounts, number][]) if (k !== 'nodes' && v) (compactOwn as Record<string, number>)[k] = v;
      const inst: GraphInstance = {
        id: x.id,
        type: x.type,
        page: pid,
        occurrence: x.occurrence,
        ...(parentOf.get(x.id) ? { parent: parentOf.get(x.id) } : {}),
        children: kids.map((k) => k.id),
        selector: x.i.selector,
        ...(x.tag ? { tag: x.tag } : {}),
        ...(x.i.role ? { role: x.i.role } : {}),
        inclusiveNodes: x.i.nodes,
        own: compactOwn,
        ownEstimated: !x.i.own,
        resources: resIds,
        ref: { scenario: scenarioIndex.get(step) ?? -1, instance: x.idx },
      };
      instances.push(inst);
      pageInstanceIds.push(inst.id);
      const t = typeAcc.get(x.type) ?? { signature: x.i.signature, method: x.i.method, tag: x.tag, role: x.i.role, pages: new Set<string>(), families: new Set<string>(), instances: [], own: [], inclusive: [], shapes: new Set<string>(), anyEstimated: false };
      t.pages.add(pid);
      if (family) t.families.add(family);
      t.instances.push(inst);
      t.own.push(own.nodes);
      t.inclusive.push(x.i.nodes);
      t.shapes.add(kids.map((k) => k.type).sort().join(','));
      if (!x.i.own) t.anyEstimated = true;
      typeAcc.set(x.type, t);

      // Findings the page shows directly, on what the instance owns.
      const f = (kind: string, title: string, evidenceClass: EvidenceClass, detail: string, metric?: Metric) =>
        findings.push({
          id: `fd-${stableHash(`${inst.id}|${kind}`)}`,
          kind,
          title,
          page: pid,
          target: { type: 'instance', id: inst.id },
          evidenceClass,
          role: 'finding',
          evidence: [{ source: 'firefox-dom', ref: `scenarios[${inst.ref.scenario}].anatomy.structure.instances[${inst.ref.instance}]`, detail }],
          ...(metric ? { metric } : {}),
          energy: { status: 'not-measured', measuredWorkloadDeltaMwh: null },
        });
      if (own.infiniteAnimations) f('endless-animation', 'Animation that never stops', 'direct-observation', `${own.infiniteAnimations} animation(s) with infinite iterations`, { value: own.infiniteAnimations, unit: 'count', source: 'firefox-dom', scope: 'instance-own' });
      if (own.autoplayVideos) f('autoplay-video', 'Video playing on load', 'direct-observation', `${own.autoplayVideos} video(s)`, { value: own.autoplayVideos, unit: 'count', source: 'firefox-dom', scope: 'instance-own' });
      if (own.iframes) f('iframe', 'Embedded document', 'direct-observation', `${own.iframes} iframe(s)`, { value: own.iframes, unit: 'count', source: 'firefox-dom', scope: 'instance-own' });
      if (own.eagerOffscreenImages) f('eager-offscreen-images', 'Images below the first screen load eagerly', 'direct-observation', `${own.eagerOffscreenImages} image(s) without loading="lazy"`, { value: own.eagerOffscreenImages, unit: 'count', source: 'firefox-dom', scope: 'instance-own' });
      const dom = step.anatomy!.domNodes;
      if (own.nodes >= 800 || (dom > 0 && own.nodes / dom >= 0.25 && own.nodes >= 100)) {
        f('large-own-dom', 'Many elements of its own', 'structural-heuristic', `${own.nodes} of ${dom} elements on the page`, { value: own.nodes, unit: 'count', source: 'firefox-dom', scope: 'instance-own' });
      }
    }

    // Lighthouse evidence for this page, attributed to the most specific target it supports.
    const lh = result.lighthouse?.results.find((r) => [r.requestedUrl, r.finalUrl].some((u) => u && keyOfPage(u) === keyOfPage(url)) || keyOfPage(r.requestedUrl) === keyOfPage(step.step));
    if (lh?.evidence) {
      const cands = withIds.map((x) => ({ i: x.i, id: x.id }));
      for (const e of lh.evidence.nodes as LighthouseNodeEvidence[]) {
        const m = nodeMatch(cands, e.path);
        findings.push({
          id: `fd-${stableHash(`${pid}|${e.audit}|${e.path}|${e.detail ?? ''}`)}`,
          kind: `lighthouse:${e.audit}`,
          title: e.detail ?? e.title,
          page: pid,
          target: m ? { type: 'instance', id: m.id } : { type: 'unattributed', reason: 'The element is not inside a recorded component, or its position differs between Chromium and Firefox.' },
          evidenceClass: 'direct-node',
          // Older results lack the split: the LCP element and DOM statistics are context.
          role: e.kind ?? (e.audit.startsWith('lcp-') || e.audit === 'dom-size-insight' ? 'context' : 'finding'),
          evidence: [{ source: 'lighthouse', ref: `${e.audit} ${e.path}${m ? ` (matched by ${m.by})` : ''}`, ...(e.selector ? { detail: e.selector } : {}) }],
          ...(e.value !== undefined && e.unit ? { metric: { value: e.value, unit: e.unit === 'count' ? 'count' : e.unit, source: 'lighthouse', scope: 'page' } as Metric } : {}),
          energy: { status: 'not-measured', measuredWorkloadDeltaMwh: null },
        });
      }
      for (const s of lh.evidence.scripts as LighthouseScriptEvidence[]) {
        const key = s.url === 'Unattributable' ? undefined : identity(s.url);
        const isPage = key !== undefined && keyOfPage(s.url) === keyOfPage(url);
        const resource = key && resAcc.has(key) && !isPage ? `rs-${stableHash(key)}` : undefined;
        findings.push({
          id: `fd-${stableHash(`${pid}|${s.audit}|${s.url}|${s.source?.line ?? ''}`)}`,
          kind: `lighthouse:${s.audit}`,
          title: s.detail ?? s.title,
          page: pid,
          target: resource
            ? { type: 'resource', id: resource }
            : isPage
              ? { type: 'page', reason: 'Work in the page’s own inline scripts and parsing.' }
              : { type: 'unattributed', reason: s.url === 'Unattributable' ? 'Chromium could not name the script.' : 'The script was not among the resources this scan recorded for the page.' },
          evidenceClass: resource ? 'resource-association' : 'direct-node',
          role: s.kind ?? 'finding',
          evidence: [{ source: 'lighthouse', ref: `${s.audit} ${s.url}`, ...(s.source ? { detail: `${s.source.url}:${s.source.line ?? ''}` } : {}) }],
          metric: { value: s.value, unit: s.unit, source: 'lighthouse', scope: 'resource-per-page' },
          energy: { status: 'not-measured', measuredWorkloadDeltaMwh: null },
        });
      }
    }

    pages.push({
      id: pid,
      url,
      ...(family ? { family } : {}),
      ...(families?.pageFingerprint[url] ? { fingerprint: families.pageFingerprint[url] } : {}),
      ...(result.sampling?.reasons?.[step.step] ? { sampleReason: result.sampling.reasons[step.step] } : {}),
      metrics: {
        domNodes: { value: step.anatomy!.domNodes, unit: 'count', source: 'firefox-dom', scope: 'page' },
        ...(step.network ? { transferBytes: { value: step.network.transferBytes, unit: 'bytes', source: 'firefox-network', scope: 'page' } as Metric } : {}),
        ...(step.network ? { requests: { value: step.network.requests, unit: 'count', source: 'firefox-network', scope: 'page' } as Metric } : {}),
      },
      ...(structure.unowned ? { unownedNodes: structure.unowned.nodes } : {}),
      instances: pageInstanceIds,
      resources: [...pageResources.keys()].map((k) => `rs-${stableHash(k)}`),
    });
  }

  // An element loads a resource only where the page transferred it; elsewhere
  // the reference is counted, not credited.
  for (const ref of pendingRefs) {
    const acc = resAcc.get(ref.key);
    if (!acc) continue;
    if (acc.pages.has(ref.page)) {
      acc.loadedBy.add(ref.instance);
      if (!ref.resIds.includes(`rs-${stableHash(ref.key)}`)) ref.resIds.push(`rs-${stableHash(ref.key)}`);
    } else acc.referencedOn.add(ref.page);
  }
  for (const i of instances) i.resources = [...new Set(i.resources)].sort();

  // Resource scope: on most pages of the site, of a family, of several pages, or one.
  const familyPages = new Map<string, number>();
  for (const p of pages) if (p.family) familyPages.set(p.family, (familyPages.get(p.family) ?? 0) + 1);
  const pageFamily = new Map(pages.map((p) => [p.id, p.family]));
  const resources: GraphResource[] = [...resAcc].map(([key, r]) => {
    const n = r.pages.size;
    const perFamily = new Map<string, number>();
    for (const pid of r.pages.keys()) {
      const fam = pageFamily.get(pid);
      if (fam) perFamily.set(fam, (perFamily.get(fam) ?? 0) + 1);
    }
    const familyWide = [...perFamily].some(([fam, c]) => (familyPages.get(fam) ?? 0) >= 2 && c >= Math.ceil(0.8 * (familyPages.get(fam) ?? 0)));
    const scope: ResourceScope = N >= 2 && n >= Math.max(2, Math.ceil(0.8 * N)) ? 'site-wide' : familyWide ? 'family-wide' : n >= 2 ? 'shared' : 'page-unique';
    const bytes = [...r.pages.values()];
    return {
      id: `rs-${stableHash(key)}`,
      key,
      host: r.host,
      kind: r.kind,
      thirdParty: r.thirdParty,
      pages: n,
      families: [...r.families].sort(),
      scope,
      transferBytes: { median: Math.round(median(bytes)), max: Math.max(...bytes) },
      loadedBy: [...r.loadedBy].sort(),
      ...(r.referencedOn.size ? { referencedWithoutTransfer: r.referencedOn.size } : {}),
    };
  });
  resources.sort((a, b) => b.pages - a.pages || b.transferBytes.median - a.transferBytes.median || (a.id < b.id ? -1 : 1));

  const types: ComponentType[] = [...typeAcc].map(([id, t]) => {
    const ownMed = median(t.own);
    const incMed = median(t.inclusive);
    const sample = t.instances[0]!;
    const container = incMed >= 50 && ownMed <= 0.05 * incMed;
    // A wrapper's name says little about what it is; only leaf-ish structural matches are inferred.
    const inferred = IDENT[t.method] === 'structural' && !container ? inferKind(t.signature, t.tag, t.role, { ...ZERO(), ...sample.own }) : undefined;
    const notes: string[] = [];
    if (t.shapes.size > 1) notes.push(`Instances differ in the components they contain (${t.shapes.size} variants); check they are one implementation.`);
    if (t.method === 'class-heuristic') notes.push('Recognised from a class name only.');
    if (t.anyEstimated) notes.push('Owned counts estimated from inclusive ones (a result made before they were recorded).');
    return {
      id,
      signature: t.signature,
      method: t.method,
      identification: inferred ? 'inferred' : IDENT[t.method],
      confidence: CONFIDENCE[t.method],
      matchedBy: ['signature', 'tag', 'role'],
      ...(t.tag ? { tag: t.tag } : {}),
      ...(t.role ? { role: t.role } : {}),
      ...(inferred ? { inferredKind: inferred } : {}),
      pages: t.pages.size,
      families: [...t.families].sort(),
      instances: t.instances.length,
      ownNodes: { median: Math.round(ownMed), max: Math.max(...t.own), estimated: t.anyEstimated },
      inclusiveNodes: { median: Math.round(incMed), max: Math.max(...t.inclusive) },
      container,
      variants: t.shapes.size,
      notes,
    };
  });
  types.sort((a, b) => b.pages - a.pages || (b.ownNodes?.median ?? 0) - (a.ownNodes?.median ?? 0) || (a.id < b.id ? -1 : 1));

  const limitations = [
    'Owned counts give each element to its nearest component; inclusive counts include nested components and must not be added up.',
    'Scripts and stylesheets in the document head, and resources loaded by script, belong to no component: they are page-level, and listed by the pages and families that load them.',
    'Up to 24 component occurrences are recorded per page; others are counted in their parents’ owned figures only when the result predates own accounting.',
    'Nothing here is an energy figure. A finding’s energy is "not-measured" until a controlled experiment measures a workload difference.',
    ...(legacy ? [`${legacy} of ${N} pages were scanned before owned counts were recorded: their owned figures are estimated from inclusive ones.`] : []),
  ];

  return { schema: GRAPH_SCHEMA, sources, pages, types, instances, resources, findings, limitations };
}
