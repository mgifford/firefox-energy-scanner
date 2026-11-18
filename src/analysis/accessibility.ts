/**
 * Join an Open Scans accessibility context to a FES result, conservatively.
 *
 * Page matching uses FES's own pageKey (the same normalization the graph
 * uses). Component matching is attempted only where the selector language is
 * confidently CSS and the selector text matches a recorded instance exactly.
 * Ancestor/descendant matching is not attempted: it needs DOM validation, and
 * the context does not publish a selector type. XPath, HTML-only and unknown
 * selectors stay page-level and visible with their reason.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { BenchmarkResult } from '../core/types.js';
import { pageKey } from '../collect/urls.js';
import type { AccessibilityJoin, AccessibilityMatch, AccessibilityObservation } from '../model/accessibility-join.js';
import { ACCESSIBILITY_CONTEXT_SCHEMA, ACCESSIBILITY_JOIN_SCHEMA } from '../model/accessibility-join.js';

export const MAX_CONTEXT_BYTES = 10 * 1024 * 1024;

export class AccessibilityJoinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessibilityJoinError';
  }
}

const containerSchema = z
  .object({
    category: z.string().nullable().optional(),
    label: z.string().nullable().optional(),
    element: z.string().nullable().optional(),
    basis: z.string().nullable().optional(),
    confidence: z.string().nullable().optional(),
    componentId: z.string().nullable().optional(),
    componentTypeId: z.string().nullable().optional(),
    componentLabel: z.string().nullable().optional(),
    ownershipEstablished: z.literal(false).optional(),
  })
  .passthrough();

const inputObservation = z
  .object({
    observationId: z.string().min(1),
    patternId: z.string().optional(),
    patternDisplayId: z.string().optional(),
    identitySource: z.string().optional(),
    rule: z.string(),
    engine: z.string(),
    wcagSc: z.array(z.string()),
    actRuleIds: z.array(z.string()),
    impact: z.string().nullable().optional(),
    pageUrl: z.string().min(1),
    selector: z.string().nullable().optional(),
    locator: z.string().optional(),
    locatorSource: z.enum(['selector', 'html', 'none']),
    container: containerSchema.optional(),
    sourceRef: z.string().nullable().optional(),
  })
  .passthrough();

const contextSchema = z
  .object({
    schema: z.literal(ACCESSIBILITY_CONTEXT_SCHEMA),
    generatedAt: z.string().optional(),
    site: z.object({ origin: z.string().nullable(), host: z.string().nullable() }).passthrough().optional(),
    scan: z
      .object({
        issueNumber: z.number().int().nullable().optional(),
        issueUrl: z.string().nullable().optional(),
        scanTitle: z.string().nullable().optional(),
        scannedAt: z.string().nullable().optional(),
        engines: z.array(z.string()).optional(),
        scanContext: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    summary: z.unknown().optional(),
    categoryLabels: z.record(z.string(), z.string()).optional(),
    observations: z.array(inputObservation),
    limitations: z.array(z.string()).optional(),
  })
  .passthrough();

export type AccessibilityContext = z.infer<typeof contextSchema>;

/** Parse and validate the untrusted context file. */
export function parseAccessibilityContext(raw: unknown): AccessibilityContext {
  const parsed = contextSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AccessibilityJoinError(
      `Invalid Open Scans accessibility context: ${parsed.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join('.') || 'context'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  if (parsed.data.observations.length > 20_000) {
    throw new AccessibilityJoinError('The accessibility context has more than 20,000 observations; refusing it.');
  }
  return parsed.data;
}

/** Read a saved context. No network access by design. */
export async function loadAccessibilityContext(path: string, maxBytes = MAX_CONTEXT_BYTES): Promise<AccessibilityContext> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new AccessibilityJoinError(code === 'ENOENT' ? `No accessibility context at ${path}.` : `Could not read ${path}: ${(e as Error).message}`);
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new AccessibilityJoinError(`${path} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB; refusing it.`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new AccessibilityJoinError(`${path} is not JSON: ${(e as Error).message}`);
  }
  return parseAccessibilityContext(raw);
}

const CSS_ENGINES = new Set(['axe', 'axe-core', 'accesslint', 'alfa', 'qualweb', 'htmlcs', 'ibm', 'wave']);
const XPATH_ENGINES = new Set(['equalaccess']);

/**
 * Selector language from the engine, because the context does not publish a
 * selectorType. This is an inference, recorded on every match; unknown engines
 * never reach selector matching.
 */
export function selectorTypeOf(observation: AccessibilityObservation): AccessibilityMatch['match']['selectorType'] {
  if (observation.locatorSource === 'html') return 'html';
  if (observation.locatorSource !== 'selector' || !observation.selector) return 'none';
  const engine = observation.engine.toLowerCase();
  if (XPATH_ENGINES.has(engine) || engine.includes('equalaccess')) return 'xpath';
  if (CSS_ENGINES.has(engine)) return 'css';
  return 'unknown';
}

const same = (a: string, b: string) => a.trim() === b.trim();

/** Build the sidecar join. It never runs a page or an accessibility engine. */
export function buildAccessibilityJoin(result: BenchmarkResult, context: AccessibilityContext): AccessibilityJoin {
  const graph = result.graph;
  if (!graph) {
    throw new AccessibilityJoinError('This result has no component graph; join the accessibility context to a crawl/measure/diagnose result that recorded page structure.');
  }
  const pages = new Map(graph.pages.map((p) => [pageKey(p.url, { queryStrategy: 'keep' }), p]));
  const types = new Map(graph.types.map((t) => [t.id, t]));
  const byPage = new Map<string, typeof graph.instances>();
  for (const i of graph.instances) byPage.set(i.page, [...(byPage.get(i.page) ?? []), i]);

  const matches: AccessibilityMatch[] = [];
  const unmatched: AccessibilityMatch[] = [];

  for (const input of context.observations) {
    // Rebuild only the fields the join schema knows, so an unknown field in a
    // future context cannot leak into (or fail) the sidecar.
    const observation: AccessibilityObservation = {
      observationId: input.observationId,
      ...(input.patternId !== undefined ? { patternId: input.patternId } : {}),
      ...(input.patternDisplayId !== undefined ? { patternDisplayId: input.patternDisplayId } : {}),
      ...(input.identitySource !== undefined ? { identitySource: input.identitySource } : {}),
      rule: input.rule,
      engine: input.engine,
      wcagSc: input.wcagSc,
      actRuleIds: input.actRuleIds,
      ...(input.impact !== undefined ? { impact: input.impact } : {}),
      pageUrl: input.pageUrl,
      ...(input.selector !== undefined ? { selector: input.selector } : {}),
      ...(input.locator !== undefined ? { locator: input.locator } : {}),
      locatorSource: input.locatorSource,
      ...(input.container
        ? {
            container: {
              ...(input.container.category !== undefined ? { category: input.container.category } : {}),
              ...(input.container.label !== undefined ? { label: input.container.label } : {}),
              ...(input.container.element !== undefined ? { element: input.container.element } : {}),
              ...(input.container.basis !== undefined ? { basis: input.container.basis } : {}),
              ...(input.container.confidence !== undefined ? { confidence: input.container.confidence } : {}),
              ...(input.container.componentId !== undefined ? { componentId: input.container.componentId } : {}),
              ...(input.container.componentTypeId !== undefined ? { componentTypeId: input.container.componentTypeId } : {}),
              ...(input.container.componentLabel !== undefined ? { componentLabel: input.container.componentLabel } : {}),
              ownershipEstablished: false as const,
            },
          }
        : {}),
      ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
    };
    const page = pages.get(pageKey(observation.pageUrl, { queryStrategy: 'keep' }));
    const selectorType = selectorTypeOf(observation);
    if (!page) {
      unmatched.push({
        observation,
        match: { basis: 'none', selectorType, confidence: 'none', reason: 'page-not-in-scan' },
      });
      continue;
    }

    let component: AccessibilityMatch['component'];
    let basis: AccessibilityMatch['match']['basis'] = 'page';
    let confidence: AccessibilityMatch['match']['confidence'] = 'low';
    let reason: string | undefined;

    if (selectorType === 'css') {
      const selector = observation.selector?.trim();
      const found = selector ? (byPage.get(page.id) ?? []).filter((i) => same(i.selector, selector)) : [];
      if (found.length === 1) {
        const instance = found[0]!;
        const type = types.get(instance.type);
        component = { instance: instance.id, type: instance.type, signature: type?.signature ?? instance.type, selector: instance.selector };
        basis = 'exact-selector';
        confidence = 'medium';
        reason = 'exact CSS selector text matched one recorded component instance; not an ownership claim.';
      } else if (found.length > 1) {
        reason = `ambiguous-exact-selector: ${found.length} recorded instances share this selector.`;
      } else {
        reason = 'selector-not-matched: ancestor/descendant matching needs DOM validation and is not attempted.';
      }
    } else if (selectorType === 'xpath') {
      confidence = 'none';
      reason = 'xpath-selector-not-compared: the context does not publish a selector type, and an XPath selector is not compared with CSS.';
    } else if (selectorType === 'unknown') {
      confidence = 'none';
      reason = 'selector-language-unknown: the engine is not known to use CSS, so no selector comparison is made.';
    } else if (selectorType === 'html') {
      reason = 'html-only-observation: the locator is HTML, not a selector.';
    } else {
      reason = 'no-selector: the observation has no selector.';
    }

    matches.push({
      observation,
      page: { id: page.id, url: page.url },
      ...(component ? { component } : {}),
      match: {
        basis,
        selectorType,
        confidence,
        ...(reason ? { reason } : {}),
      },
    });
  }

  matches.sort((a, b) => (a.page!.url < b.page!.url ? -1 : a.page!.url > b.page!.url ? 1 : (a.component?.signature ?? '').localeCompare(b.component?.signature ?? '') || a.observation.observationId.localeCompare(b.observation.observationId)));
  unmatched.sort((a, b) => a.observation.pageUrl.localeCompare(b.observation.pageUrl) || a.observation.observationId.localeCompare(b.observation.observationId));
  const componentMatched = matches.filter((m) => m.component).length;
  const byBasis: Record<string, number> = {};
  const byEngine: Record<string, number> = {};
  for (const m of [...matches, ...unmatched]) {
    byBasis[m.match.basis] = (byBasis[m.match.basis] ?? 0) + 1;
    const e = m.observation.engine;
    byEngine[e] = (byEngine[e] ?? 0) + 1;
  }

  const sourceContext: AccessibilityJoin['sourceContext'] = {
    schema: ACCESSIBILITY_CONTEXT_SCHEMA,
    ...(context.generatedAt ? { generatedAt: context.generatedAt } : {}),
    ...(context.site ? { site: context.site } : {}),
    ...(context.scan ? { scan: context.scan } : {}),
    ...(context.summary !== undefined ? { summary: context.summary } : {}),
    ...(context.categoryLabels ? { categoryLabels: context.categoryLabels } : {}),
    ...(context.limitations ? { limitations: context.limitations } : {}),
  };

  return {
    schema: ACCESSIBILITY_JOIN_SCHEMA,
    sourceContext,
    matches,
    unmatched,
    summary: {
      observations: context.observations.length,
      pageMatched: matches.length,
      componentMatched,
      pageLevel: matches.length - componentMatched,
      unmatched: unmatched.length,
      byBasis,
      byEngine,
    },
    limitations: [
      'Selector type is not published by Open Scans. It is inferred from the engine name; only exact CSS text matches are attempted, and an unknown engine is never compared.',
      'Ancestor/descendant selector matching is not attempted without validating the actual DOM. Unmatched selectors stay page-level.',
      'A page-level match does not establish component ownership, and a container candidate is never promoted to one.',
      'This is accessibility evidence from Open Scans, not an energy finding and not a WCAG conformance claim.',
      ...(context.limitations ?? []),
    ],
  };
}
