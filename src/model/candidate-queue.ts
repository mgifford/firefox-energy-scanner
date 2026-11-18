/**
 * A bounded candidate queue: what may be tested next, why it is allowed, and
 * what it would cost. It is a plan, not a run and not an energy result.
 */
import { z } from 'zod';
import { experimentSpecSchema } from '../experiments/experiment.js';

export const CANDIDATE_QUEUE_SCHEMA = 'candidate-queue/1';

const allowRuleSchema = z
  .object({
    kind: z.enum(['host', 'url', 'prefix']),
    value: z.string().min(1),
  })
  .strict();

const policySchema = z
  .object({
    allowlist: z.array(allowRuleSchema).min(1),
    maxCandidates: z.number().int().min(1).max(100),
    maxPages: z.number().int().min(1).max(100),
    maxEnergyRuns: z.number().int().min(0).max(10_000),
    requireRemedy: z.boolean(),
  })
  .strict();

const sourceSchema = z
  .object({
    file: z.string(),
    sha256: z.string().optional(),
    schemaVersion: z.number().int(),
    sessionId: z.string(),
    startedAt: z.string(),
    mode: z.string(),
    targetUrl: z.string().nullable(),
    viewport: z.object({ width: z.number().int(), height: z.number().int() }).strict(),
    energyAdapter: z.string(),
    energyTier: z.enum(['full', 'structural', 'unknown']),
  })
  .strict();

const reachSchema = z.object({ pages: z.number().int().min(0), of: z.number().int().min(0), families: z.number().int().min(0) }).strict();
const workloadSchema = z
  .object({
    elements: z.number().min(0).optional(),
    shareOfPage: z.number().min(0).optional(),
    endlessAnimations: z.number().min(0).optional(),
    chromiumMainThreadMs: z.number().min(0).optional(),
    transferBytes: z.number().min(0).optional(),
  })
  .strict();

const targetSchema = z
  .object({
    kind: z.enum(['component', 'region', 'page', 'script', 'resource']),
    id: z.string(),
    title: z.string(),
    page: z.string().optional(),
    selector: z.string().optional(),
  })
  .strict();

const pairingSchema = z
  .object({
    key: z.string(),
    page: z.string(),
    siteOrigin: z.string().nullable(),
    viewport: z.object({ width: z.number().int(), height: z.number().int() }).strict(),
    run: z.object({ sessionId: z.string(), startedAt: z.string() }).strict(),
    source: z.literal('fes-investigation'),
  })
  .strict();

const provenanceSchema = z
  .object({
    sourceFile: z.string(),
    sourceSha256: z.string().optional(),
    investigationMethod: z.string(),
    rank: z.number().int().min(1),
  })
  .strict();

const candidateSchema = z
  .object({
    status: z.enum(['selected', 'rejected']),
    id: z.string(),
    rank: z.number().int().min(1),
    kind: z.enum(['component', 'region', 'page', 'script', 'resource']),
    title: z.string(),
    evidence: z.string(),
    because: z.array(z.string()),
    reach: reachSchema,
    workload: workloadSchema,
    target: targetSchema,
    pairing: pairingSchema,
    provenance: provenanceSchema,
    experiment: experimentSpecSchema.optional(),
    experimentNote: z.string().optional(),
    estimatedEnergyRuns: z.number().int().min(0),
    reason: z.string().optional(),
  })
  .strict();

export const candidateQueueSchema = z
  .object({
    schema: z.literal(CANDIDATE_QUEUE_SCHEMA),
    queueId: z.string(),
    generatedAt: z.string(),
    source: sourceSchema,
    policy: policySchema,
    selected: z.array(candidateSchema),
    rejected: z.array(candidateSchema),
    summary: z
      .object({
        candidates: z.number().int().min(0),
        selected: z.number().int().min(0),
        rejected: z.number().int().min(0),
        uniquePages: z.number().int().min(0),
        estimatedEnergyRuns: z.number().int().min(0),
      })
      .strict(),
    limitations: z.array(z.string()).min(1),
  })
  .strict();

export type CandidateQueue = z.infer<typeof candidateQueueSchema>;
export type QueueCandidate = z.infer<typeof candidateSchema>;
export type AllowRule = z.infer<typeof allowRuleSchema>;

export function validateCandidateQueue(x: unknown): string[] {
  const r = candidateQueueSchema.safeParse(x);
  return r.success ? [] : r.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || 'queue'}: ${i.message}`);
}

export function candidateQueueJsonSchema(): unknown {
  return {
    $id: 'https://github.com/mgifford/firefox-energy-scanner/schema/candidate-queue.schema.json',
    title: 'FES bounded candidate queue',
    ...(z.toJSONSchema(candidateQueueSchema, { unrepresentable: 'any' }) as Record<string, unknown>),
  };
}
