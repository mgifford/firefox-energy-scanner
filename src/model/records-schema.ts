/**
 * Schemas for the energy timeline (energy-timeline/1, with its intervals and
 * leads) and the evidence record (energy-finding/1), for validation here and
 * by other tools. `schema/energy-timeline.schema.json` and
 * `schema/energy-finding.schema.json` are generated from them (npm run
 * schema), and a test keeps them in step.
 *
 * The rules that matter are checked, not only the shapes: a bin without a
 * sample has null energy, never zero; a step that was not measured carries no
 * energy figure; a failed intervention reports no steps; no recommendation is
 * removal alone; no guideline mapping is asserted.
 */

import { z } from 'zod';

const nullableNonNeg = z.number().min(0).nullable();

const phaseSchema = z
  .object({
    kind: z.enum(['baseline', 'loading', 'stabilizing', 'idle', 'interaction', 'unmeasured']),
    step: z.string(),
    label: z.string(),
    run: z.number().int().min(0).optional(),
    warmup: z.boolean(),
    startMs: z.number(),
    endMs: z.number(),
  })
  .strict();

const binSchema = z
  .object({
    index: z.number().int().min(0),
    startMs: z.number(),
    endMs: z.number(),
    samples: z.number().int().min(0),
    energyJ: nullableNonNeg.describe('Energy read in the bin, J. Null when no sample was read: never zero for "not measured".'),
    averagePowerW: nullableNonNeg.describe('Energy over the bin width, W. Null when there is no energy, or it reaches back beyond the bin.'),
    phase: z.number().int().min(0).optional(),
    flags: z.array(z.enum(['no-samples', 'lumped', 'unit-missing', 'phase-boundary', 'first-sample'])).optional(),
  })
  .strict()
  .refine((b) => (b.samples === 0 ? b.energyJ === null && b.averagePowerW === null : true), { message: 'a bin with no sample has null energy and power, never zero' })
  .refine((b) => (b.energyJ === null ? b.averagePowerW === null : true), { message: 'power cannot be derived without energy' });

export const timelineSchema = z
  .object({
    schema: z.literal('energy-timeline/1'),
    originEpochMs: z.number(),
    durationMs: z.number().min(0),
    binMs: z.number().positive(),
    requestedBinMs: z.number().positive(),
    resolution: z
      .object({
        sampleIntervalMs: z.number().nullable(),
        counterUpdateMs: z.number().nullable(),
        minimumBinMs: z.number().positive(),
        supportedBinsMs: z.array(z.number().positive()),
      })
      .strict(),
    scope: z.enum(['process', 'cpu-package', 'system']),
    basis: z.string(),
    counters: z.number().int().min(0),
    samples: z.object({ used: z.number().int().min(0), excluded: z.record(z.string(), z.number().int().min(0)) }).strict(),
    gaps: z.array(z.object({ startMs: z.number(), endMs: z.number(), counter: z.number().int().min(0) }).strict()),
    phases: z.array(phaseSchema),
    bins: z.array(binSchema),
    profilerFeatures: z.array(z.string()),
    samplingIntervalMs: z.number().optional(),
    scenario: z.string().optional(),
    run: z.number().int().min(0).optional(),
    warnings: z.array(z.string()),
    method: z.string(),
  })
  .strict()
  .refine((t) => t.binMs >= t.resolution.minimumBinMs, { message: 'bins are never finer than the counters resolve' });

const intervalSchema = z
  .object({
    id: z.string().regex(/^spike-\d+$/),
    rank: z.number().int().min(1),
    startMs: z.number(),
    endMs: z.number(),
    durationMs: z.number().min(0),
    bins: z.number().int().min(1),
    peakPowerW: z.number().min(0),
    peakAtMs: z.number().optional(),
    meanPowerW: z.number().min(0),
    energyJ: z.number().min(0),
    excessEnergyJ: z.number().min(0),
    referenceW: z.number(),
    thresholdW: z.number(),
    shape: z.enum(['brief-peak', 'sustained']),
    phases: z.array(z.string()),
    steps: z.array(z.string()),
    flags: z.array(z.enum(['outside-measured-steps', 'crosses-phase-boundary', 'includes-lumped-bins', 'warmup', 'machine-wide-scope', 'during-baseline', 'whole-phase'])),
  })
  .strict();

export const spikeReportSchema = z
  .object({
    method: z.literal('robust-threshold-v1'),
    statement: z.string(),
    settings: z
      .object({
        reference: z.enum(['auto', 'baseline', 'quiet', 'rolling']),
        k: z.number().positive(),
        minDurationMs: z.number().min(0),
        mergeGapMs: z.number().min(0),
        sustainedMs: z.number().min(0),
        quietFraction: z.number().gt(0).max(1),
        rollingWindowMs: z.number().positive(),
        minRiseW: z.number().min(0),
        minReferenceBins: z.number().int().min(1),
        binMs: z.number().positive(),
      })
      .strict(),
    reference: z
      .object({
        kind: z.enum(['baseline-window', 'quiet-bins', 'rolling-median']),
        powerW: z.number(),
        spreadW: z.number().min(0),
        spreadFrom: z.enum(['mad', 'quantum', 'none']),
        bins: z.number().int().min(0),
      })
      .strict(),
    intervals: z.array(intervalSchema),
    topBins: z.array(z.object({ index: z.number().int(), startMs: z.number(), powerW: z.number(), phase: z.string().optional() }).strict()),
    warnings: z.array(z.string()),
  })
  .strict();

const leadClass = z.enum(['observed-window', 'profiler-correlation', 'resource-association', 'cross-run-trace', 'direct-node', 'inferred', 'unattributed']);
const leadEvidence = z.object({ class: leadClass, source: z.enum(['same-run-gecko', 'chromium-trace', 'firefox-dom', 'component-graph', 'lighthouse']), detail: z.string() }).strict();

const processRole = z.enum(['browser', 'page', 'gpu', 'other', 'unknown']);

const geckoSchema = z
  .object({
    source: z.literal('same-run-gecko'),
    available: z.object({ markers: z.boolean(), stacks: z.boolean(), cpuTime: z.boolean() }).strict(),
    activity: z.array(
      z
        .object({
          kind: z.string(),
          process: processRole.optional(),
          count: z.number().int().min(0),
          ms: z.number().min(0).describe('Time within the interval covered by at least one such marker: overlaps counted once.'),
          names: z.array(z.string()),
        })
        .strict(),
    ),
    scripts: z.array(z.object({ url: z.string(), functionName: z.string().optional(), line: z.number().optional(), samples: z.number().int().min(1), process: processRole.optional() }).strict()),
    requests: z.array(z.object({ url: z.string(), count: z.number().int().min(1) }).strict()),
    domEvents: z.array(z.object({ type: z.string(), count: z.number().int().min(1) }).strict()),
    categories: z.array(z.object({ category: z.string(), cpuMs: z.number(), share: z.number().min(0).max(1), sessionShare: z.number().min(0).max(1).optional() }).strict()),
    categoryBasis: z.enum(['cpu-time', 'sample-count']).optional(),
    notes: z.array(z.string()),
  })
  .strict();

const componentLead = z
  .object({
    instance: z.string(),
    type: z.string(),
    signature: z.string(),
    selector: z.string(),
    page: z.string(),
    reach: z.object({ pages: z.number().int().min(0), families: z.number().int().min(0) }).strict(),
    scripts: z.array(z.string()),
    resources: z.array(z.string()),
    evidence: z.array(leadEvidence).min(1),
    classes: z.array(leadClass),
    lighthouse: z.array(z.string()),
    selectorMatches: z.number().int().optional(),
    experiments: z.array(z.object({ kind: z.string(), available: z.boolean(), why: z.string() }).strict()),
  })
  .strict();

const leadSchema = z
  .object({
    spike: z.string(),
    observed: z.string(),
    activity: z.array(z.string()),
    components: z.array(componentLead),
    scripts: z.array(
      z
        .object({
          url: z.string(),
          inline: z.boolean().optional(),
          resource: z.string().optional(),
          loadedBy: z.array(z.string()),
          functions: z.array(z.object({ name: z.string().optional(), line: z.number().optional(), samples: z.number().int().min(0) }).strict()),
          evidence: z.array(leadEvidence),
        })
        .strict(),
    ),
    unattributed: z.array(z.object({ what: z.string(), reason: z.string().min(1) }).strict()),
    caveats: z.array(z.string()).min(1),
  })
  .strict();

export const timelineAnalysisSchema = z
  .object({
    timeline: timelineSchema,
    spikes: spikeReportSchema,
    evidence: z.record(z.string(), geckoSchema).optional(),
    leads: z.record(z.string(), leadSchema).optional(),
    page: z.string().optional(),
    selectorMatches: z.record(z.string(), z.number().int()).optional(),
    processEnergy: z
      .record(z.string(), z.array(z.object({ role: processRole, energyJ: z.number().min(0), counters: z.number().int().min(1) }).strict()))
      .optional()
      .describe('Per interval: energy read by each kind of Firefox process. Measured per process (Apple Silicon), never apportioned.'),
  })
  .strict()
  .refine((a) => !a.processEnergy || Object.keys(a.processEnergy).length === 0 || a.timeline.scope === 'process', { message: 'energy by process exists only for per-process counters' });

const mwhPair = z.object({ medianMwh: z.number(), iqrMwh: z.number().min(0) }).strict();
const findingStep = z
  .object({
    step: z.string(),
    role: z.enum(['attributable', 'negative-control']),
    verdict: z.enum(['lower', 'higher', 'within-spread', 'below-resolution', 'not-measured']),
    runs: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
    samples: z.tuple([z.number(), z.number()]).optional(),
    basis: z.enum(['incremental', 'window']).optional(),
    baselineMw: z.tuple([z.number(), z.number()]).optional(),
    baseline: mwhPair.optional(),
    variant: mwhPair.optional(),
    differenceMwh: z.number().optional(),
    percent: z.number().optional(),
    durationMs: z.tuple([z.number(), z.number()]),
    transferBytes: z.tuple([z.number(), z.number()]).optional(),
    reading: z.string(),
  })
  .strict()
  .refine((s) => (s.verdict === 'not-measured' ? s.baseline === undefined && s.variant === undefined && s.differenceMwh === undefined : true), {
    message: 'a step that was not measured carries no energy figure',
  });

export const findingSchema = z
  .object({
    schema: z.literal('energy-finding/1'),
    id: z.string().regex(/^fr-[0-9a-f]{8}$/),
    generatedAt: z.string(),
    title: z.string(),
    target: z
      .object({
        page: z.string(),
        component: z.object({ selector: z.string().optional(), componentIds: z.array(z.string()).optional(), signature: z.string().optional() }).strict().optional(),
        sourceFiles: z.array(z.object({ url: z.string(), functions: z.array(z.string()), how: z.string() }).strict()),
      })
      .strict(),
    observed: z.object({ statements: z.array(z.string()).min(1), evidence: z.array(z.object({ class: z.string(), source: z.string(), detail: z.string() }).strict()) }).strict(),
    suspected: z.object({ statement: z.string().min(1), basis: z.array(z.string()) }).strict(),
    outcome: z
      .object({
        status: z.enum(['reduction-shown', 'reduction-not-like-for-like', 'increase-shown', 'no-difference-shown', 'below-resolution', 'not-measured', 'intervention-failed']),
        statement: z.string().min(1),
        confidence: z.enum(['confirmatory', 'indicative', 'none']),
        steps: z.array(findingStep),
      })
      .strict()
      .refine((o) => (o.status === 'intervention-failed' ? o.steps.length === 0 && o.confidence === 'none' : true), {
        message: 'a failed intervention compares nothing and claims no confidence',
      }),
    recommendation: z
      .object({
        statement: z.string().min(1),
        options: z.array(z.enum(['optimize', 'defer', 'redesign', 'replace', 'remove'])),
        caution: z.string().min(1),
      })
      .strict()
      .refine((r) => !(r.options.length === 1 && r.options[0] === 'remove'), { message: 'removal is never the only recommendation' }),
    experiment: z
      .object({
        name: z.string(),
        kind: z.string(),
        description: z.string(),
        mode: z.enum(['post-load', 'pre-load']).optional(),
        workload: z.unknown().optional(),
        seed: z.string(),
        order: z.array(z.string()),
        runs: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
        warmups: z.number().int().min(0).optional(),
        command: z.string().startsWith('web-energy experiment '),
        spec: z.record(z.string(), z.unknown()),
      })
      .strict(),
    environment: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).optional()),
    accessibility: z
      .object({
        structureChanged: z.array(z.string()),
        removedContent: z.array(z.string()),
        assertions: z.object({ checked: z.number().int().min(0), baseline: z.array(z.string()), variant: z.array(z.string()) }).strict(),
        likeForLike: z.object({ ok: z.boolean(), reasons: z.array(z.string()) }).strict(),
      })
      .strict(),
    limitations: z.array(z.string()).min(1),
    artifacts: z.record(z.string(), z.string()),
    topics: z.array(z.string()),
    wsg: z.object({ mapping: z.literal('not-asserted'), note: z.string() }).strict(),
  })
  .strict();

const problems = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }, what: string) =>
  r.success ? [] : (r.error?.issues ?? []).slice(0, 20).map((i) => `${i.path.map(String).join('.') || what}: ${i.message}`);

export function validateTimelineAnalysis(x: unknown): string[] {
  return problems(timelineAnalysisSchema.safeParse(x), 'timeline');
}

export function validateFinding(x: unknown): string[] {
  return problems(findingSchema.safeParse(x), 'finding');
}

const BASE = 'https://github.com/mgifford/firefox-energy-scanner/schema';

export function timelineJsonSchema(): unknown {
  return { $id: `${BASE}/energy-timeline.schema.json`, title: 'Firefox Energy Scanner energy timeline, intervals and leads', ...(z.toJSONSchema(timelineAnalysisSchema, { unrepresentable: 'any' }) as Record<string, unknown>) };
}

export function findingJsonSchema(): unknown {
  return { $id: `${BASE}/energy-finding.schema.json`, title: 'Firefox Energy Scanner evidence record (finding)', ...(z.toJSONSchema(findingSchema, { unrepresentable: 'any' }) as Record<string, unknown>) };
}
