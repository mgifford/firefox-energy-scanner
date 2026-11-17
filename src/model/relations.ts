/**
 * Evidence-backed relationships between graph entities.
 *
 * The graph's entities (pages, instances, resources) already say what exists.
 * A relation says how two of them are connected and how strongly:
 *
 * - declares-resource: an element inside the component loads the resource;
 * - resource-used-on-page: Firefox recorded the resource on the page;
 * - script-observed-with-component: the script's source names an element the
 *   component contains, and the same run's profile has the script on the
 *   stack. This is an observed relationship, not ownership;
 * - suspected-association: the static reference exists but the script was not
 *   seen running in this result. A lead, not an observation.
 *
 * It never emits `script-modifies-component` without a DOM write observation,
 * and never credits a page-level script to the component whose id it reads.
 */
import type { BenchmarkResult } from '../core/types.js';
import type { ComponentGraph, GraphInstance, GraphRelation, GraphResource, RelationKind } from './graph.js';
import { resourceIdentity } from './resource-identity.js';
import { pageKey } from '../collect/urls.js';
import { stableHash } from '../analysis/signature.js';

type GraphParties = Pick<ComponentGraph, 'pages' | 'instances' | 'resources' | 'types'>;

const KIND_RANK: Record<RelationKind, number> = {
  'script-modifies-component': 5,
  'script-observed-with-component': 4,
  'declares-resource': 3,
  'uses-template': 3,
  'contains-dom': 2,
  'resource-used-on-page': 2,
  'suspected-association': 1,
};

const sansHash = (u: string) => u.replace(/#.*$/, '');
const pairKey = (r: GraphRelation) => `${r.from.type}:${r.from.id}|${r.to.type}:${r.to.id}`;

interface StackHit {
  ref: string;
  samples: number;
  functionName?: string;
  line?: number;
}

/** The same run's profile, if it has this script on the stack in a page interval. */
function stackEvidence(result: BenchmarkResult, pageUrl: string, scriptUrl: string): StackHit | undefined {
  const target = sansHash(scriptUrl);
  for (let ti = 0; ti < (result.timelines?.length ?? 0); ti++) {
    const t = result.timelines![ti]!;
    if (!t.page || pageKey(t.page, { queryStrategy: 'keep' }) !== pageKey(pageUrl, { queryStrategy: 'keep' })) continue;
    for (const [intervalId, ev] of Object.entries(t.evidence ?? {})) {
      const hit = ev.scripts.find(
        (s) => sansHash(s.url) === target && s.samples > 0 && (!s.process || s.process === 'page' || s.process === 'unknown'),
      );
      if (hit) {
        return {
          ref: `timelines[${ti}].evidence[${intervalId}].scripts`,
          samples: hit.samples,
          ...(hit.functionName ? { functionName: hit.functionName } : {}),
          ...(hit.line !== undefined ? { line: hit.line } : {}),
        };
      }
    }
  }
  return undefined;
}

const describedRefs = (refs: { kind: 'id' | 'selector'; value: string }[]) =>
  refs.map((r) => (r.kind === 'id' ? `#${r.value}` : r.value)).join(', ');

/**
 * Derive the relations from what the result actually recorded. Pure: the same
 * result and graph give the same relation ids and order.
 */
export function buildRelations(result: BenchmarkResult, graph: GraphParties): GraphRelation[] {
  const observedAt = result.environment?.timestamp;
  const byId = new Map<string, GraphResource>(graph.resources.map((r) => [r.id, r]));
  const byKey = new Map<string, GraphResource>(graph.resources.map((r) => [r.key, r]));
  const types = new Map(graph.types.map((t) => [t.id, t]));
  const instancesByPage = new Map<string, GraphInstance[]>();
  for (const i of graph.instances) instancesByPage.set(i.page, [...(instancesByPage.get(i.page) ?? []), i]);

  // A page's full resource reach is already pages[].resources. Relations are
  // emitted only for resources the diagnostic inspected, so a crawl's graph
  // does not grow by one redundant edge per page and resource.
  const inspected = new Set<string>();
  for (const record of result.scriptReferences ?? []) {
    const r = byKey.get(resourceIdentity(record.url, 'script'));
    if (r && (record.inline || record.refs.length || record.status === 'scanned')) inspected.add(r.id);
  }

  const relations: GraphRelation[] = [];
  const add = (rel: Omit<GraphRelation, 'id'>) => {
    relations.push({ id: `rel-${stableHash(`${rel.kind}|${rel.from.type}:${rel.from.id}|${rel.to.type}:${rel.to.id}`)}`, ...rel });
  };

  // An element inside the component loads the resource.
  for (const i of graph.instances) {
    for (const rid of i.resources) {
      if (!byId.has(rid) || !inspected.has(rid)) continue;
      add({
        kind: 'declares-resource',
        from: { type: 'instance', id: i.id },
        to: { type: 'resource', id: rid },
        source: 'firefox-dom',
        evidenceClass: 'resource-association',
        ...(observedAt ? { observedAt } : {}),
        artifactRef: `instances[${i.id}].resources`,
        method: 'A script, image, iframe or video element inside the component loads this resource.',
        confidence: 'high',
        attributionStatus: 'owned',
        limitations: ['A component declaring a resource does not show that the resource costs energy or that its work belongs to the component.'],
      });
    }
  }

  // Firefox saw the resource on the page. This is page-level reach, not use.
  for (const p of graph.pages) {
    for (const rid of p.resources) {
      if (!byId.has(rid) || !inspected.has(rid)) continue;
      add({
        kind: 'resource-used-on-page',
        from: { type: 'page', id: p.id },
        to: { type: 'resource', id: rid },
        source: 'firefox-network',
        evidenceClass: 'resource-association',
        ...(observedAt ? { observedAt } : {}),
        artifactRef: `pages[${p.id}].resources`,
        method: 'Firefox recorded this resource transferred while the page loaded.',
        confidence: 'high',
        attributionStatus: 'page-level',
        limitations: ['A transfer shows the page used the resource, not which component, if any, caused its work.'],
      });
    }
  }

  // A script's static DOM references, matched to the component that contains
  // the element. A same-run stack hit is the stronger, observed relationship.
  const refs = result.scriptReferences ?? [];
  for (let ri = 0; ri < refs.length; ri++) {
    const record = refs[ri]!;
    if (record.inline || !record.refs.length) continue;
    const resource = byKey.get(resourceIdentity(record.url, 'script'));
    if (!resource) continue;
    for (const page of graph.pages) {
      if (!page.resources.includes(resource.id)) continue;
      // The scan read this page's script; do not apply its references to
      // another page that happens to load the same script path.
      if (pageKey(record.page, { queryStrategy: 'keep' }) !== pageKey(page.url, { queryStrategy: 'keep' })) continue;
      const instances = instancesByPage.get(page.id) ?? [];
      // For each referenced element, the most specific recorded component that
      // contains it; a page wrapper that also contains the element is not the
      // component the reference is about.
      const matchesById = new Map<string, GraphInstance>();
      for (const ref of record.refs) {
        const candidates = instances.filter((i) =>
          ref.kind === 'id' ? (i.domIds ?? []).includes(ref.value) : ref.value === i.selector,
        );
        if (!candidates.length) continue;
        const best = candidates.reduce((a, b) => (b.inclusiveNodes < a.inclusiveNodes ? b : a));
        matchesById.set(best.id, best);
      }
      const matches = [...matchesById.values()];
      if (!matches.length) continue;
      const stack = stackEvidence(result, page.url, record.url);
      const refText = describedRefs(record.refs.filter((ref) => matches.some((i) => (ref.kind === 'id' ? (i.domIds ?? []).includes(ref.value) : ref.value === i.selector))));
      for (const i of matches) {
        const declared = i.resources.includes(resource.id);
        const type = types.get(i.type);
        const container = !!type?.container;
        const containerLimit = container ? ['The component is a container: the reference may be to an element of a nested component.'] : [];
        if (stack) {
          add({
            kind: 'script-observed-with-component',
            from: { type: 'resource', id: resource.id },
            to: { type: 'instance', id: i.id },
            source: 'same-run-gecko',
            evidenceClass: 'profiler-correlation',
            ...(observedAt ? { observedAt } : {}),
            artifactRef: stack.ref,
            method:
              `The script was on the stack in this run (${stack.samples} sample${stack.samples === 1 ? '' : 's'}` +
              `${stack.functionName ? `, ${stack.functionName}` : ''}${stack.line !== undefined ? `:${stack.line}` : ''}) ` +
              `and its source names ${refText}, which is inside the component.`,
            confidence: container ? 'low' : declared ? 'high' : 'medium',
            attributionStatus: container ? 'suspected' : 'supported',
            limitations: [
              ...containerLimit,
              'This is an observed relationship between a page-level script and the component, not ownership of the script.',
              'Same-run stack samples and a static DOM reference do not show which DOM writes happened or that the component caused the energy.',
              'The static scan reads same-origin script text; minified or dynamically composed selectors, shadow DOM and frames may be missed.',
            ],
          });
        } else {
          add({
            kind: 'suspected-association',
            from: { type: 'resource', id: resource.id },
            to: { type: 'instance', id: i.id },
            source: 'script-source',
            evidenceClass: 'structural-heuristic',
            ...(observedAt ? { observedAt } : {}),
            artifactRef: `scriptReferences[${ri}]`,
            method: `The script's source names ${refText}, which is inside the component; it was not seen on the stack in this result.`,
            confidence: 'low',
            attributionStatus: 'suspected',
            limitations: [
              ...containerLimit,
              'A static DOM reference is a lead to test, not a runtime relationship.',
              'The static scan reads same-origin script text; minified or dynamically composed selectors, shadow DOM and frames may be missed.',
            ],
          });
        }
      }
    }
  }

  // One relation per pair and kind; an observed script relation supersedes the
  // static suspicion for the same pair.
  const keep = new Map<string, GraphRelation>();
  for (const r of relations) {
    const key = `${r.kind}|${pairKey(r)}`;
    if (!keep.has(key)) keep.set(key, r);
  }
  const observedPairs = new Set([...keep.values()].filter((r) => r.kind === 'script-observed-with-component').map(pairKey));
  return [...keep.values()]
    .filter((r) => !(r.kind === 'suspected-association' && observedPairs.has(pairKey(r))))
    .sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind] || (a.id < b.id ? -1 : 1));
}

/** Relations that name a resource, strongest first. */
export function relationsOfResource(graph: ComponentGraph, resourceId: string): GraphRelation[] {
  return (graph.relations ?? []).filter((r) => (r.from.type === 'resource' && r.from.id === resourceId) || (r.to.type === 'resource' && r.to.id === resourceId));
}
