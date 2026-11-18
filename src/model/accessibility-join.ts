/**
 * The optional Open Scans accessibility join: a sidecar, never energy evidence.
 *
 * Open Scans supplies occurrence-level accessibility observations. This
 * artifact records how each one was matched to a FES page and, only when the
 * selector language is confidently CSS and the text matches exactly, to a FES
 * component instance. Everything else stays page-level or unmatched and is
 * kept visible.
 */
import { z } from 'zod';

export const ACCESSIBILITY_JOIN_SCHEMA = 'fes-accessibility-join/1';
export const ACCESSIBILITY_CONTEXT_SCHEMA = 'a11y-accessibility-context/1';

const containerSchema = z
  .object({
    category: z.string().nullable().optional(),
    label: z.string().nullable().optional(),
    element: z.string().nullable().optional(),
    basis: z.string().nullable().optional(),
    confidence: z.string().nullable().optional(),
    /** Explicit Open Scans ids, if a future scan carries them. Never a FES id. */
    componentId: z.string().nullable().optional(),
    componentTypeId: z.string().nullable().optional(),
    componentLabel: z.string().nullable().optional(),
    /** Open Scans never establishes ownership; FES must not promote this. */
    ownershipEstablished: z.literal(false),
  })
  .strict();

const observationSchema = z
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
    pageUrl: z.string(),
    selector: z.string().nullable().optional(),
    /** Published by Open Scans once available; absent means FES inferred it from the engine. */
    selectorType: z.string().nullable().optional(),
    locator: z.string().optional(),
    locatorSource: z.enum(['selector', 'html', 'none']),
    container: containerSchema.optional(),
    sourceRef: z.string().nullable().optional(),
  })
  .strict();

const pageSchema = z.object({ id: z.string(), url: z.string() }).strict();
const componentSchema = z.object({ instance: z.string(), type: z.string(), signature: z.string(), selector: z.string() }).strict();

const matchSchema = z
  .object({
    observation: observationSchema,
    page: pageSchema.optional(),
    component: componentSchema.optional(),
    match: z
      .object({
        basis: z.enum(['page', 'exact-selector', 'ancestor-selector', 'component-id', 'none']),
        /** How the selector was read, or why it was not compared. */
        selectorType: z.enum(['css', 'xpath', 'html', 'none', 'unknown']),
        /** Whether selectorType came from Open Scans or was inferred from the engine. */
        selectorTypeSource: z.enum(['published', 'inferred']).optional(),
        /** True only when the ancestor relationship was checked in a live DOM. */
        domValidated: z.boolean().optional(),
        confidence: z.enum(['high', 'medium', 'low', 'none']),
        reason: z.string().optional(),
      })
      .strict(),
  })
  .strict();

const sourceContextSchema = z
  .object({
    schema: z.literal(ACCESSIBILITY_CONTEXT_SCHEMA),
    generatedAt: z.string().optional(),
    site: z.object({ origin: z.string().nullable(), host: z.string().nullable() }).strict().optional(),
    scan: z
      .object({
        issueNumber: z.number().int().nullable().optional(),
        issueUrl: z.string().nullable().optional(),
        reportUrl: z.string().nullable().optional(),
        scanTitle: z.string().nullable().optional(),
        scannedAt: z.string().nullable().optional(),
        engines: z.array(z.string()).optional(),
        scanContext: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    summary: z.unknown().optional(),
    categoryLabels: z.record(z.string(), z.string()).optional(),
    limitations: z.array(z.string()).optional(),
  })
  .strict();

export const accessibilityJoinSchema = z
  .object({
    schema: z.literal(ACCESSIBILITY_JOIN_SCHEMA),
    sourceContext: sourceContextSchema,
    matches: z.array(matchSchema),
    unmatched: z.array(matchSchema),
    summary: z
      .object({
        observations: z.number().int().min(0),
        pageMatched: z.number().int().min(0),
        componentMatched: z.number().int().min(0),
        pageLevel: z.number().int().min(0),
        unmatched: z.number().int().min(0),
        byBasis: z.record(z.string(), z.number().int().min(0)),
        byEngine: z.record(z.string(), z.number().int().min(0)),
      })
      .strict(),
    limitations: z.array(z.string()).min(1),
  })
  .strict();

export type AccessibilityJoin = z.infer<typeof accessibilityJoinSchema>;
export type AccessibilityMatch = z.infer<typeof matchSchema>;
export type AccessibilityObservation = z.infer<typeof observationSchema>;

export function validateAccessibilityJoin(x: unknown): string[] {
  const r = accessibilityJoinSchema.safeParse(x);
  return r.success ? [] : r.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || 'join'}: ${i.message}`);
}

export function accessibilityJoinJsonSchema(): unknown {
  return {
    $id: 'https://github.com/mgifford/firefox-energy-scanner/schema/fes-accessibility-join.schema.json',
    title: 'FES Open Scans accessibility join',
    ...(z.toJSONSchema(accessibilityJoinSchema, { unrepresentable: 'any' }) as Record<string, unknown>),
  };
}
