/**
 * Opt-in DOM validation for the Open Scans accessibility join.
 *
 * A published/inferred CSS or XPath selector is resolved once on the FES page.
 * If it resolves to one element, the nearest recorded component instance that
 * contains it is a candidate ancestor. This is a DOM relationship, not a claim
 * that the component caused the finding. The page is opened at the FES
 * viewport; a different source viewport is recorded and lowers confidence.
 */
import type { Browser } from 'playwright';
import type { BenchmarkResult } from '../core/types.js';
import type { AccessibilityJoin, AccessibilityMatch } from '../model/accessibility-join.js';
import type { GraphInstance } from '../model/graph.js';

export interface DomValidationOptions {
  browser: Browser;
  maxObservations?: number;
  /** Include structural class-heuristic components (default true). */
  includeStructural?: boolean;
  /** Require this many owned nodes, so page containers/wrappers are skipped. */
  minOwnNodes?: number;
  /** Permit ancestor matching when source/FES viewports differ or are unknown. */
  allowDifferentViewport?: boolean;
  pageTimeoutMs?: number;
  settleMs?: number;
}

interface DomObservation {
  id: string;
  selector: string;
  selectorType: 'css' | 'xpath';
}

interface DomInstance {
  id: string;
  selector: string;
}

interface DomResult {
  id: string;
  instance?: string;
  self?: boolean;
  reason?: string;
}

const viewportOfScan = (join: AccessibilityJoin): { width: number; height: number } | undefined => {
  const scan = join.sourceContext.scan?.scanContext;
  if (!scan || typeof scan !== 'object' || !('viewport' in scan)) return undefined;
  const v = (scan as { viewport?: { width?: unknown; height?: unknown } }).viewport;
  return v && typeof v.width === 'number' && typeof v.height === 'number' ? { width: v.width, height: v.height } : undefined;
};

export async function validateAccessibilityJoinDom(
  result: BenchmarkResult,
  join: AccessibilityJoin,
  options: DomValidationOptions,
): Promise<AccessibilityJoin> {
  const graph = result.graph;
  if (!graph) throw new Error('DOM validation needs a result with a component graph.');
  const next = JSON.parse(JSON.stringify(join)) as AccessibilityJoin;
  const max = options.maxObservations ?? 5_000;
  const minOwnNodes = options.minOwnNodes ?? 2;
  const includeStructural = options.includeStructural ?? true;
  const timeout = options.pageTimeoutMs ?? 30_000;
  const settle = options.settleMs ?? 500;
  const sourceViewport = viewportOfScan(next);
  const fesViewport = result.environment.viewport;
  const viewportMatch = sourceViewport
    ? sourceViewport.width === fesViewport.width && sourceViewport.height === fesViewport.height
      ? 'same'
      : 'different'
    : 'unknown';
  const confidence = viewportMatch === 'same' ? 'medium' : 'low';
  if (viewportMatch !== 'same' && !options.allowDifferentViewport) {
    next.limitations = [
      ...next.limitations,
      `DOM ancestor matching skipped: source viewport ${sourceViewport ? `${sourceViewport.width}×${sourceViewport.height}` : 'not published'} vs FES ${fesViewport.width}×${fesViewport.height} (${viewportMatch}). Exact CSS matches remain; use --dom-allow-different-viewport only for explicitly low-confidence broad association.`,
    ];
    return next;
  }
  const graphPages = new Map(graph.pages.map((p) => [p.id, p]));
  const instances = new Map(graph.instances.map((i) => [i.id, i]));
  const types = new Map(graph.types.map((t) => [t.id, t]));
  const byPage = new Map<string, AccessibilityMatch[]>();
  for (const m of next.matches) {
    if (!m.page || m.component || (m.match.selectorType !== 'css' && m.match.selectorType !== 'xpath') || !m.observation.selector) continue;
    byPage.set(m.page.url, [...(byPage.get(m.page.url) ?? []), m]);
  }
  let processed = 0;
  for (const [url, observations] of byPage) {
    const pageId = observations[0]!.page!.id;
    const graphPage = graphPages.get(pageId);
    if (!graphPage) continue;
    if (processed >= max) {
      for (const m of observations) m.match.reason = 'dom-observation-limit: the DOM-validation cap was reached.';
      continue;
    }
    const pageInstances: DomInstance[] = graph.instances
      .filter((i) => i.page === graphPage.id)
      .filter((i) => includeStructural || types.get(i.type)?.identification !== 'structural')
      .filter((i) => (types.get(i.type)?.ownNodes?.median ?? 0) >= minOwnNodes)
      .map((i) => ({ id: i.id, selector: i.selector }));
    const toCheck: DomObservation[] = observations
      .slice(0, Math.max(0, max - processed))
      .map((m) => ({ id: m.observation.observationId, selector: m.observation.selector!, selectorType: m.match.selectorType as 'css' | 'xpath' }));
    processed += toCheck.length;
    const context = await options.browser.newContext({ viewport: fesViewport });
    let results: DomResult[] = [];
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      if (settle) await page.waitForTimeout(settle);
      results = (await page.evaluate(
        ({ instances, observations }) => {
          const MARK = 'data-fes-dom-instance';
          for (const inst of instances) {
            try {
              const els = document.querySelectorAll(inst.selector);
              if (els.length === 1) (els[0] as Element).setAttribute(MARK, inst.id);
            } catch {
              // An invalid recorded selector is skipped, not fatal for the page.
            }
          }
          return observations.map((o) => {
            let count = 0;
            let el: Element | null = null;
            try {
              if (o.selectorType === 'xpath') {
                const snapshot = document.evaluate(o.selector, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                count = snapshot.snapshotLength;
                el = snapshot.snapshotItem(0) as Element | null;
              } else {
                const nodes = document.querySelectorAll(o.selector);
                count = nodes.length;
                el = nodes[0] as Element | null;
              }
            } catch {
              return { id: o.id, reason: 'invalid-selector' };
            }
            if (count === 0 || !el) return { id: o.id, reason: 'not-found' };
            if (count > 1) return { id: o.id, reason: 'ambiguous-selector' };
            let node: Element | null = el;
            while (node) {
              const value = node.getAttribute?.(MARK);
              if (value) return { id: o.id, instance: value, self: node === el };
              node = node.parentElement;
            }
            return { id: o.id, reason: 'no-ancestor' };
          });
        },
        { instances: pageInstances, observations: toCheck },
      )) as DomResult[];
    } catch (e) {
      const reason = `dom-page-load-failed: ${(e as Error).message.slice(0, 200)}`;
      for (const m of observations) if (!m.component) m.match.reason = reason;
      await context.close().catch(() => {});
      continue;
    }
    await context.close().catch(() => {});
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const m of observations) {
      const r = byId.get(m.observation.observationId);
      if (!r) continue;
      if (r.reason) {
        m.match.reason = `dom-${r.reason}: no component ancestor was assigned.`;
        continue;
      }
      if (!r.instance || r.self) {
        m.match.reason = 'dom-same-element: the selector resolves to a recorded component element, but not by exact selector text.';
        continue;
      }
      const instance = instances.get(r.instance);
      const type = instance ? types.get(instance.type) : undefined;
      if (!instance || !type) continue;
      m.component = { instance: instance.id, type: instance.type, signature: type.signature, selector: instance.selector };
      m.match = {
        ...m.match,
        basis: 'ancestor-selector',
        confidence,
        domValidated: true,
        reason: `DOM-validated nearest recorded ancestor (${instance.selector}); source viewport ${sourceViewport ? `${sourceViewport.width}×${sourceViewport.height}` : 'not published'} vs FES ${fesViewport.width}×${fesViewport.height} (${viewportMatch}).`,
      };
    }
  }
  const componentMatched = next.matches.filter((m) => m.component).length;
  const byBasis: Record<string, number> = {};
  const byEngine: Record<string, number> = {};
  for (const m of [...next.matches, ...next.unmatched]) {
    byBasis[m.match.basis] = (byBasis[m.match.basis] ?? 0) + 1;
    byEngine[m.observation.engine] = (byEngine[m.observation.engine] ?? 0) + 1;
  }
  next.summary = {
    ...next.summary,
    componentMatched,
    pageLevel: next.matches.length - componentMatched,
    byBasis,
    byEngine,
  };
  next.limitations = [
    ...next.limitations,
    `DOM validation opened the FES page at ${fesViewport.width}×${fesViewport.height} and matched the nearest ${includeStructural ? 'recorded' : 'semantic or explicit'} ancestor with at least ${minOwnNodes} owned node(s) for single CSS/XPath elements; source viewport match: ${viewportMatch}.`, 
    includeStructural
      ? 'Structural class-heuristic components were included by default; they are low-confidence guesses, not ownership. Use --dom-semantic-only to exclude them.'
      : 'Only semantic/explicit components were considered; structural class heuristics were excluded on request.',
    'A DOM-validated ancestor is a relationship in the page, not proof that the component caused the finding or used energy.',
  ];
  return next;
}
