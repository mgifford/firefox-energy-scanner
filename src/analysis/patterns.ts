/**
 * Site-wide recurring patterns: what repeats across pages, and where to look.
 *
 * The graph already has pages, component types and instances, resources and
 * findings. This view groups findings by their mechanism and their target
 * identity: a component *type* (signature + tag + role), a resource, a page,
 * or an unattributed reason. It never merges two component types because they
 * share a landmark role or a class name, and it never turns a repeated
 * observation into a causal or energy claim.
 *
 * The two directions are both explicit:
 *   component type -> pages, families, resources, findings
 *   resource       -> component types, pages, families, findings
 */

import type { BenchmarkResult } from '../core/types.js';
import type { ComponentGraph, ComponentType, GraphFinding, GraphInstance, GraphResource } from '../model/graph.js';
import { stableHash } from './signature.js';

export const PATTERNS_METHOD = 'site-patterns/1';

const EVIDENCE_RANK: Record<string, number> = {
  'direct-node': 0,
  'direct-observation': 0,
  'trace-supported': 1,
  'resource-association': 2,
  'cross-page-correlation': 3,
  'structural-heuristic': 4,
};
const evidenceRank = (e: string): number => EVIDENCE_RANK[e] ?? 5;

export type PatternTarget =
  | { type: 'component-type'; id: string; label: string }
  | { type: 'resource'; id: string; label: string }
  | { type: 'page'; id: string; label: string }
  | { type: 'unattributed'; label: string };

export interface PatternFinding {
  id: string;
  rank: number;
  kind: string;
  title: string;
  target: PatternTarget;
  evidenceClass: string;
  pages: number;
  families: number;
  instances: number;
  representative: { page: string; selector?: string };
  findingIds: string[];
  resourceIds: string[];
  componentTypeIds: string[];
  /** Findings never carry measured energy; this is never a number. */
  energy: 'not-measured';
  limitations: string[];
}

export interface PatternComponent {
  id: string;
  signature: string;
  identification: string;
  confidence: string;
  container: boolean;
  pages: number;
  families: number;
  instances: number;
  resources: { id: string; key: string; kind: string; scope: string }[];
  findings: { id: string; kind: string; pages: number }[];
  representative: { page: string; selector: string };
}

export interface PatternResource {
  id: string;
  key: string;
  host: string;
  kind: string;
  thirdParty: boolean;
  pages: number;
  families: number;
  scope: string;
  componentTypes: { id: string; signature: string; confidence: string }[];
  findings: { id: string; kind: string; pages: number }[];
}

export interface SitePatterns {
  method: typeof PATTERNS_METHOD;
  pages: number;
  families: number;
  patterns: PatternFinding[];
  components: PatternComponent[];
  resources: PatternResource[];
  limitations: string[];
}

type TypeLike = ComponentType;

const familyOf = (graph: ComponentGraph, pageId: string): string | undefined => graph.pages.find((p) => p.id === pageId)?.family;

/**
 * Group a graph's findings into recurring patterns. Pure: the same graph gives
 * the same ids, order and counts.
 */
export function buildSitePatterns(result: BenchmarkResult): SitePatterns | undefined {
  const graph = result.graph;
  if (!graph) return undefined;
  const instances = new Map(graph.instances.map((i) => [i.id, i]));
  const types = new Map<string, TypeLike>(graph.types.map((t) => [t.id, t]));
  const resources = new Map(graph.resources.map((r) => [r.id, r]));
  const pages = new Map(graph.pages.map((p) => [p.id, p]));
  const typeOfInstance = (id: string) => instances.get(id)?.type;

  interface Acc {
    key: string;
    kind: string;
    title: string;
    target: PatternTarget;
    evidence: Set<string>;
    pages: Set<string>;
    instances: Set<string>;
    findings: string[];
    resourceIds: Set<string>;
    componentTypeIds: Set<string>;
    representative: { page: string; selector?: string };
  }
  const groups = new Map<string, Acc>();

  for (const f of graph.findings as GraphFinding[]) {
    if (f.role !== 'finding') continue;
    const page = pages.get(f.page);
    const key = (() => {
      if (f.target.type === 'instance' && f.target.id) {
        const type = typeOfInstance(f.target.id);
        return type ? `component-type|${type}|${f.kind}` : `unattributed|${f.kind}|${f.target.reason ?? 'unknown instance'}`;
      }
      if (f.target.type === 'resource' && f.target.id) return `resource|${f.target.id}|${f.kind}`;
      if (f.target.type === 'page') return `page|${f.page}|${f.kind}`;
      return `unattributed|${f.kind}|${f.target.reason ?? 'no target'}`;
    })();
    const acc = groups.get(key) ?? {
      key,
      kind: f.kind,
      title: f.title,
      target:
        f.target.type === 'instance' && f.target.id && typeOfInstance(f.target.id)
          ? { type: 'component-type', id: typeOfInstance(f.target.id)!, label: types.get(typeOfInstance(f.target.id)!)?.signature ?? f.target.id }
          : f.target.type === 'resource' && f.target.id
            ? { type: 'resource', id: f.target.id, label: resources.get(f.target.id)?.key ?? f.target.id }
            : f.target.type === 'page'
              ? { type: 'page', id: f.page, label: page?.url ?? f.page }
              : { type: 'unattributed', label: f.target.reason ?? 'No target recorded' },
      evidence: new Set<string>(),
      pages: new Set<string>(),
      instances: new Set<string>(),
      findings: [],
      resourceIds: new Set<string>(),
      componentTypeIds: new Set<string>(),
      representative: { page: page?.url ?? f.page },
    };
    acc.evidence.add(f.evidenceClass);
    acc.pages.add(f.page);
    acc.findings.push(f.id);
    if (f.target.type === 'instance' && f.target.id) {
      acc.instances.add(f.target.id);
      const type = typeOfInstance(f.target.id);
      if (type) acc.componentTypeIds.add(type);
      const inst = instances.get(f.target.id);
      if (inst && !acc.representative.selector) acc.representative.selector = inst.selector;
    } else if (f.target.type === 'resource' && f.target.id) {
      // resourceIds names the resource a finding is ABOUT. A component's
      // resources are listed on the component entry, not here: the reverse
      // view must not read a component finding as a resource finding.
      acc.resourceIds.add(f.target.id);
      const resource = resources.get(f.target.id);
      for (const ci of resource?.loadedBy ?? []) {
        acc.instances.add(ci);
        const type = typeOfInstance(ci);
        if (type) acc.componentTypeIds.add(type);
      }
    }
    groups.set(key, acc);
  }

  const patterns: PatternFinding[] = [...groups.values()].map((a) => {
    const evidenceClass = [...a.evidence].sort((x, y) => evidenceRank(x) - evidenceRank(y))[0] ?? 'structural-heuristic';
    return {
      id: `ptn-${stableHash(a.key)}`,
      rank: 0,
      kind: a.kind,
      title: a.title,
      target: a.target,
      evidenceClass,
      pages: a.pages.size,
      families: new Set([...a.pages].map((p) => familyOf(graph, p)).filter((f): f is string => !!f)).size,
      instances: a.instances.size,
      representative: a.representative,
      findingIds: [...new Set(a.findings)].sort(),
      resourceIds: [...a.resourceIds].sort(),
      componentTypeIds: [...a.componentTypeIds].sort(),
      energy: 'not-measured',
      limitations: [
        'A repeated finding is a pattern of observations, not proof of a shared implementation, a cause or a cost.',
        'Page counts are the measured pages where the finding was observed, never whole-site prevalence.',
        'No energy is measured by this view; a controlled experiment is needed for any energy claim.',
      ],
    };
  });
  patterns.sort(
    (a, b) =>
      evidenceRank(a.evidenceClass) - evidenceRank(b.evidenceClass) ||
      b.pages - a.pages ||
      b.instances - a.instances ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : 1),
  );
  patterns.forEach((p, i) => (p.rank = i + 1));

  const components: PatternComponent[] = graph.types.map((t) => {
    const own = graph.instances.filter((i) => i.type === t.id);
    const pageIds = [...new Set(own.map((i) => i.page))];
    const resourceIds = [...new Set(own.flatMap((i: GraphInstance) => i.resources))];
    const findings = patterns.filter((p) => p.componentTypeIds.includes(t.id)).map((p) => ({ id: p.id, kind: p.kind, pages: p.pages }));
    const first = own[0];
    return {
      id: t.id,
      signature: t.signature,
      identification: t.identification,
      confidence: t.confidence,
      container: t.container,
      pages: pageIds.length,
      families: new Set(pageIds.map((p) => familyOf(graph, p)).filter((f): f is string => !!f)).size,
      instances: own.length,
      resources: resourceIds
        .map((id) => resources.get(id))
        .filter((r): r is GraphResource => !!r)
        .map((r) => ({ id: r.id, key: r.key, kind: r.kind, scope: r.scope }))
        .sort((a, b) => (a.key < b.key ? -1 : 1)),
      findings,
      representative: first ? { page: pages.get(first.page)?.url ?? first.page, selector: first.selector } : { page: '', selector: '' },
    };
  });
  components.sort((a, b) => b.findings.length - a.findings.length || b.pages - a.pages || (a.signature < b.signature ? -1 : 1));

  const patternResources: PatternResource[] = graph.resources.map((r) => {
    const componentTypeIds = [...new Set(r.loadedBy.map((ci) => typeOfInstance(ci)).filter((x): x is string => !!x))];
    const pageIds = graph.pages.filter((p) => p.resources.includes(r.id)).map((p) => p.id);
    return {
      id: r.id,
      key: r.key,
      host: r.host,
      kind: r.kind,
      thirdParty: r.thirdParty,
      pages: pageIds.length,
      families: new Set(pageIds.map((p) => familyOf(graph, p)).filter((f): f is string => !!f)).size,
      scope: r.scope,
      componentTypes: componentTypeIds.map((id) => {
        const t = types.get(id);
        return { id, signature: t?.signature ?? id, confidence: t?.confidence ?? 'low' };
      }),
      findings: patterns.filter((p) => p.resourceIds.includes(r.id)).map((p) => ({ id: p.id, kind: p.kind, pages: p.pages })),
    };
  });
  patternResources.sort((a, b) => b.findings.length - a.findings.length || b.pages - a.pages || (a.key < b.key ? -1 : 1));

  return {
    method: PATTERNS_METHOD,
    pages: graph.pages.length,
    families: new Set(graph.pages.map((p) => p.family).filter((f): f is string => !!f)).size,
    patterns,
    components,
    resources: patternResources,
    limitations: [
      'Component identity is the graph’s type (signature, tag and role): two navigation regions with different structure are kept apart.',
      'A resource used by several components is one pattern with several component edges, not owned by each.',
      'A role or class name alone is not a shared implementation; confidence is the graph type’s own.',
      'Sampled pages only: no count is extrapolated to the whole site.',
      'No energy figure is present; missing measurements are not zero.',
    ],
  };
}
