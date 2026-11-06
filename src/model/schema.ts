/**
 * The component graph's schema, for validation. `schema/component-graph.schema.json`
 * is generated from it (npm run schema), so other tools can validate results
 * without this code, and a test keeps the two in step.
 *
 * Units and sources: a `Metric` names its unit, source and scope; plain
 * numbers in the graph have the unit and source their field's description
 * states. Energy is never zero for "not measured": it is null with a status.
 */

import { z } from 'zod';

const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}-[0-9a-f]{8}$`), `an id starting ${prefix}-`);

const sourceId = z.enum(['firefox-dom', 'firefox-network', 'firefox-energy', 'lighthouse', 'chromium-trace', 'co2js', 'webnrg']);

export const metricSchema = z
  .object({
    value: z.number(),
    unit: z.enum(['count', 'bytes', 'ms', 'score', 'ratio', 'mWh', 'per-second']),
    source: sourceId,
    scope: z.enum(['instance-own', 'instance-inclusive', 'page', 'resource-per-page', 'median-over-pages', 'max-over-pages']),
  })
  .strict();

const ownSchema = z
  .object({
    nodes: z.number().int().min(0).describe('Elements owned: those whose nearest component is this one.'),
    images: z.number().int().min(0).optional(),
    eagerOffscreenImages: z.number().int().min(0).optional(),
    videos: z.number().int().min(0).optional(),
    autoplayVideos: z.number().int().min(0).optional(),
    iframes: z.number().int().min(0).optional(),
    canvases: z.number().int().min(0).optional(),
    animations: z.number().int().min(0).optional(),
    infiniteAnimations: z.number().int().min(0).optional(),
  })
  .strict()
  .describe('Owned counts (firefox-dom); zero counts are left out. They never overlap between components.');

export const graphSchema = z
  .object({
    schema: z.literal('component-graph/1'),
    sources: z.array(
      z
        .object({
          id: sourceId,
          browser: z.string().optional(),
          tool: z.string().optional(),
          timestamp: z.string().optional(),
          method: z.string(),
          boundary: z.string(),
        })
        .strict(),
    ),
    pages: z.array(
      z
        .object({
          id: id('pg'),
          url: z.string(),
          family: id('pf').optional(),
          fingerprint: id('fp').optional(),
          sampleReason: z.string().optional(),
          metrics: z
            .object({ domNodes: metricSchema.optional(), transferBytes: metricSchema.optional(), requests: metricSchema.optional() })
            .strict(),
          unownedNodes: z.number().int().min(0).optional().describe('Elements in <body> that belong to no component (firefox-dom).'),
          instances: z.array(id('ci')),
          resources: z.array(id('rs')),
        })
        .strict(),
    ),
    types: z.array(
      z
        .object({
          id: id('ct'),
          signature: z.string(),
          method: z.enum(['annotation', 'framework', 'drupal', 'landmark', 'class-heuristic']),
          identification: z.enum(['explicit', 'semantic', 'structural', 'inferred']),
          confidence: z.enum(['high', 'medium', 'low']),
          matchedBy: z.array(z.string()),
          tag: z.string().optional(),
          role: z.string().optional(),
          inferredKind: z.object({ kind: z.string(), from: z.array(z.string()) }).strict().optional(),
          pages: z.number().int().min(1),
          families: z.array(id('pf')),
          instances: z.number().int().min(1),
          ownNodes: z.object({ median: z.number(), max: z.number(), estimated: z.boolean() }).strict().optional(),
          inclusiveNodes: z.object({ median: z.number(), max: z.number() }).strict(),
          container: z.boolean(),
          variants: z.number().int().min(1),
          notes: z.array(z.string()),
        })
        .strict(),
    ),
    instances: z.array(
      z
        .object({
          id: id('ci'),
          type: id('ct'),
          page: id('pg'),
          occurrence: z.number().int().min(0),
          parent: id('ci').optional(),
          children: z.array(id('ci')),
          selector: z.string(),
          tag: z.string().optional(),
          role: z.string().optional(),
          inclusiveNodes: z.number().int().min(0),
          own: ownSchema,
          ownEstimated: z.boolean(),
          resources: z.array(id('rs')),
          ref: z.object({ scenario: z.number().int(), instance: z.number().int() }).strict(),
        })
        .strict(),
    ),
    resources: z.array(
      z
        .object({
          id: id('rs'),
          key: z.string(),
          host: z.string(),
          kind: z.string(),
          thirdParty: z.boolean(),
          pages: z.number().int().min(1),
          families: z.array(id('pf')),
          scope: z.enum(['site-wide', 'family-wide', 'shared', 'page-unique']),
          transferBytes: z
            .object({ median: z.number().min(0), max: z.number().min(0) })
            .strict()
            .describe('Bytes transferred per page that loaded it (firefox-network).'),
          loadedBy: z.array(id('ci')),
          referencedWithoutTransfer: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Pages whose components reference it without transferring it during the measured load (lazy, hidden or cached).'),
        })
        .strict(),
    ),
    findings: z.array(
      z
        .object({
          id: id('fd'),
          kind: z.string(),
          title: z.string(),
          page: id('pg'),
          target: z
            .object({ type: z.enum(['instance', 'resource', 'page', 'unattributed']), id: z.string().optional(), reason: z.string().optional() })
            .strict()
            .refine((t) => (t.type === 'instance' || t.type === 'resource' ? !!t.id : true), 'an instance or resource target names its id')
            .refine((t) => (t.type === 'unattributed' ? !!t.reason : true), 'an unattributed finding says why'),
          evidenceClass: z.enum(['direct-observation', 'direct-node', 'resource-association', 'trace-supported', 'cross-page-correlation', 'structural-heuristic']),
          role: z.enum(['finding', 'context']),
          evidence: z.array(z.object({ source: sourceId, ref: z.string(), detail: z.string().optional() }).strict()).min(1),
          metric: metricSchema.optional(),
          energy: z
            .object({
              status: z.enum(['not-measured', 'measured-difference']),
              measuredWorkloadDeltaMwh: z.number().nullable(),
            })
            .strict()
            .refine((e) => (e.status === 'not-measured' ? e.measuredWorkloadDeltaMwh === null : e.measuredWorkloadDeltaMwh !== null), {
              message: 'not-measured energy is null, never a number; a measured difference is a number',
            }),
        })
        .strict(),
    ),
    limitations: z.array(z.string()),
  })
  .strict()
  .superRefine((g, ctx) => {
    // Every reference resolves.
    const ids = new Set([...g.pages.map((p) => p.id), ...g.types.map((t) => t.id), ...g.instances.map((i) => i.id), ...g.resources.map((r) => r.id)]);
    const check = (ref: string | undefined, path: (string | number)[]) => {
      if (ref && !ids.has(ref)) ctx.addIssue({ code: 'custom', message: `unresolved reference ${ref}`, path });
    };
    g.instances.forEach((i, n) => {
      check(i.type, ['instances', n, 'type']);
      check(i.page, ['instances', n, 'page']);
      check(i.parent, ['instances', n, 'parent']);
      i.children.forEach((c, k) => check(c, ['instances', n, 'children', k]));
    });
    g.findings.forEach((f, n) => {
      check(f.page, ['findings', n, 'page']);
      if (f.target.id) check(f.target.id, ['findings', n, 'target', 'id']);
    });
    g.resources.forEach((r, n) => r.loadedBy.forEach((c, k) => check(c, ['resources', n, 'loadedBy', k])));
  });

export type GraphSchema = z.infer<typeof graphSchema>;

/** Validate a graph; returns the problems as readable lines, none when valid. */
export function validateGraph(graph: unknown): string[] {
  const r = graphSchema.safeParse(graph);
  return r.success ? [] : r.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || 'graph'}: ${i.message}`);
}

/** The JSON Schema published beside the code. */
export function graphJsonSchema(): unknown {
  return {
    $id: 'https://github.com/mgifford/firefox-energy-scanner/schema/component-graph.schema.json',
    title: 'Firefox Energy Scanner component graph',
    ...(z.toJSONSchema(graphSchema, { unrepresentable: 'any' }) as Record<string, unknown>),
  };
}
