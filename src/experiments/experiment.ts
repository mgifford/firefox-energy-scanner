/**
 * Energy experiments: the page as served (baseline) against the page with one
 * change (variant), measured with the same workload, interleaved, through the
 * existing benchmark runner.
 *
 * This is the only place a component's effect on energy is reported, and it
 * is reported as what it is: a measured difference between two scenarios, in
 * mWh, with both sides' spread, whether each resolved, and whether there
 * were enough runs. Nothing is converted from CPU time, bytes or scores.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Page } from 'playwright';
import type { JourneyDefinition } from '../core/journey.js';
import { defineJourney } from '../core/journey.js';
import type { StepResult } from '../core/types.js';
import { compare, median, resolution, summarize } from '../core/stats.js';
import { joulesToMilliwattHours } from '../core/baseline.js';
import { groupByStep } from '../report/csv.js';
import {
  VARIANT_KINDS,
  describeVariant,
  emptyCounts,
  installVariant,
  probeVariant,
  validateVariant,
  variantApplied,
  type VariantCounts,
  type VariantProbe,
  type VariantSpec,
} from './variants.js';

/** A semantic check that must hold on both sides: the change must not break the page. */
export interface Assertion {
  /** An ARIA role, with an optional accessible name. */
  role?: string;
  name?: string;
  /** Visible text. */
  text?: string;
  /** A form control's label. */
  label?: string;
}

const assertionSchema = z
  .object({ role: z.string().optional(), name: z.string().optional(), text: z.string().optional(), label: z.string().optional() })
  .strict()
  .refine((a) => !!(a.role || a.text || a.label), 'An assertion needs a role, text or label.');

export const experimentSpecSchema = z
  .object({
    name: z.string().min(1),
    url: z.string().url(),
    kind: z.enum(VARIANT_KINDS as [string, ...string[]]),
    selector: z.string().optional(),
    hosts: z.array(z.string()).optional(),
    urls: z.array(z.string()).optional(),
    keep_eager: z.number().int().min(0).optional(),
    /** The intentional idle window after load, in milliseconds. */
    idle_ms: z.number().int().min(0).max(120_000).default(10_000),
    /** A journey file, run on both sides instead of load-and-idle. */
    journey: z.string().optional(),
    assertions: z.array(assertionSchema).default([]),
    runs: z.number().int().min(1).max(60).optional(),
    warmups: z.number().int().min(0).max(20).optional(),
    seed: z.string().optional(),
  })
  .strict();

export type ExperimentSpec = z.infer<typeof experimentSpecSchema>;

export function variantOf(spec: ExperimentSpec): VariantSpec {
  return {
    kind: spec.kind as VariantSpec['kind'],
    ...(spec.selector ? { selector: spec.selector } : {}),
    ...(spec.hosts?.length ? { hosts: spec.hosts } : {}),
    ...(spec.urls?.length ? { urls: spec.urls } : {}),
    ...(spec.keep_eager !== undefined ? { keepEager: spec.keep_eager } : {}),
  };
}

/** Parse and check a spec; throws with every problem listed. */
export function parseSpec(input: unknown): ExperimentSpec {
  const parsed = experimentSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid experiment: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`).join('; ')}`);
  }
  const errors = validateVariant(variantOf(parsed.data));
  if (errors.length) throw new Error(`Invalid experiment: ${errors.join(' ')}`);
  return parsed.data;
}

export async function loadSpec(path: string): Promise<ExperimentSpec> {
  return parseSpec(parseYaml(await readFile(path, 'utf8')));
}

/** Per side: what the interception did, what the page showed, and the assertions. */
export interface SideState {
  counts: VariantCounts;
  probes: VariantProbe[];
  assertionFailures: string[];
  runs: number;
}

const emptySide = (): SideState => ({ counts: emptyCounts(), probes: [], assertionFailures: [], runs: 0 });

async function checkAssertions(page: Page, assertions: Assertion[]): Promise<string[]> {
  const failed: string[] = [];
  for (const a of assertions) {
    const what = a.role ? `role ${a.role}${a.name ? ` named "${a.name}"` : ''}` : a.label ? `label "${a.label}"` : `text "${a.text}"`;
    const locator = a.role
      ? page.getByRole(a.role as Parameters<Page['getByRole']>[0], a.name ? { name: a.name } : {})
      : a.label
        ? page.getByLabel(a.label)
        : page.getByText(a.text!);
    const visible = await locator.first().isVisible().catch(() => false);
    if (!visible) failed.push(`${what} not visible`);
  }
  return failed;
}

/**
 * The journey for one side: the variant installed in setup (outside every
 * measured window), the workload, then the probe and assertions after it.
 * Without a journey of its own, the workload is load-and-idle: the page
 * load, then an intentional idle window, where running animations and
 * timers show up.
 */
export function sideJourney(spec: ExperimentSpec, inner: JourneyDefinition | undefined, apply: boolean, state: SideState): JourneyDefinition {
  const variant = variantOf(spec);
  return defineJourney({
    name: `${inner?.name ?? 'load-and-idle'} (${apply ? 'variant' : 'baseline'})`,
    async setup(args) {
      await inner?.setup?.(args);
      await installVariant(args.context, args.page, variant, apply, state.counts);
    },
    async run(args) {
      if (inner) {
        await inner.run(args);
      } else {
        await args.measure('load', async () => {
          await args.page.goto(spec.url, { waitUntil: 'load' });
        });
        if (spec.idle_ms > 0) {
          await args.measure('idle', async () => {
            // Intentional idle window: the workload under test is the page left open.
            await args.page.waitForTimeout(spec.idle_ms);
          });
        }
      }
      // After the workload, outside every measured window.
      state.runs++;
      state.probes.push(await probeVariant(args.page, variant));
      state.assertionFailures.push(...(await checkAssertions(args.page, spec.assertions)));
    },
    async teardown(args) {
      await inner?.teardown?.(args);
    },
  });
}

export type Verdict = 'lower' | 'higher' | 'within-spread' | 'below-resolution' | 'not-measured';

export interface StepDifference {
  step: string;
  runs: [number, number];
  /** Observed incremental energy, mWh: median and IQR per side. */
  energy?: {
    medianMwh: [number, number];
    iqrMwh: [number, number];
    differenceMwh: number;
    percent?: number;
    resolved: [boolean, boolean];
  };
  verdict: Verdict;
  /** Plain words for the verdict. */
  reading: string;
  /** Fewer than 10 runs per side: indicative only. */
  indicative: boolean;
  /** Other indicators, in their own units, never combined with energy. */
  durationMs: [number, number];
  transferBytes?: [number, number];
}

const mwh = (j: number) => joulesToMilliwattHours(j);

/**
 * The difference per measured step. Pure, so it is tested directly.
 *
 * - not-measured: no energy on one side or both (a virtual machine, say);
 * - below-resolution: a side's median does not exceed its own spread, or is
 *   at or below idle, so no difference can be read from it;
 * - within-spread: both resolve, but the difference of medians is no larger
 *   than the larger of the two IQRs;
 * - lower / higher: the variant's median is below or above the baseline's
 *   by more than that.
 */
export function summarizeExperiment(baseline: StepResult[], variant: StepResult[]): StepDifference[] {
  const a = groupByStep(baseline);
  const b = groupByStep(variant);
  const out: StepDifference[] = [];
  for (const [step, runsA] of a) {
    const runsB = b.get(step) ?? [];
    if (!runsB.length) continue;
    const ja = runsA.map((r) => r.energy?.incrementalJoules).filter((v): v is number => v !== undefined);
    const jb = runsB.map((r) => r.energy?.incrementalJoules).filter((v): v is number => v !== undefined);
    const durationMs: [number, number] = [median(runsA.map((r) => r.timing.durationMs)), median(runsB.map((r) => r.timing.durationMs))];
    const ta = runsA.flatMap((r) => (r.network ? [r.network.transferBytes] : []));
    const tb = runsB.flatMap((r) => (r.network ? [r.network.transferBytes] : []));
    const transferBytes: [number, number] | undefined = ta.length && tb.length ? [median(ta), median(tb)] : undefined;
    const base = { step, runs: [runsA.length, runsB.length] as [number, number], durationMs, ...(transferBytes ? { transferBytes } : {}) };

    if (!ja.length || !jb.length) {
      out.push({ ...base, verdict: 'not-measured', reading: 'Energy was not measured on this machine, so there is no energy difference to report.', indicative: true });
      continue;
    }
    const cmp = compare(ja.map(mwh), jb.map(mwh));
    const ra = resolution(ja.map(mwh));
    const rb = resolution(jb.map(mwh));
    const sa = summarize(ja.map(mwh));
    const sb = summarize(jb.map(mwh));
    const diff = cmp.medianDifference;
    const spread = Math.max(sa.iqr, sb.iqr);
    let verdict: Verdict;
    if (!ra.resolved || !rb.resolved) verdict = 'below-resolution';
    else if (Math.abs(diff) <= spread) verdict = 'within-spread';
    else verdict = diff < 0 ? 'lower' : 'higher';
    const pct = Number.isFinite(cmp.percentDifference) ? Math.round(cmp.percentDifference * 10) / 10 : undefined;
    const reading = {
      lower: `The variant used ${Math.abs(diff).toFixed(3)} mWh less (${pct}%), more than either side's run-to-run spread.`,
      higher: `The variant used ${diff.toFixed(3)} mWh more (+${pct}%), more than either side's run-to-run spread.`,
      'within-spread': `The difference (${diff.toFixed(3)} mWh) is within the run-to-run spread: no difference shown.`,
      'below-resolution': 'At least one side is below the resolution of this setup (its median does not exceed its spread, or is at or below idle): no difference can be read.',
      'not-measured': '',
    }[verdict];
    out.push({
      ...base,
      energy: {
        medianMwh: [sa.median, sb.median],
        iqrMwh: [sa.iqr, sb.iqr],
        differenceMwh: diff,
        ...(pct !== undefined ? { percent: pct } : {}),
        resolved: [ra.resolved, rb.resolved],
      },
      verdict,
      reading: cmp.sufficientSamples ? reading : `${reading} Indicative: fewer than 10 runs per side.`,
      indicative: !cmp.sufficientSamples,
    });
  }
  return out;
}

export interface ExperimentReport {
  name: string;
  url: string;
  variant: VariantSpec;
  description: string;
  sides: { baseline: string; variant: string };
  /** Did the change take effect? A difference is only reported when it did. */
  applied: { ok: boolean; note: string };
  /** Semantic checks that failed, per side. Empty when all held. */
  assertions: { checked: number; baseline: string[]; variant: string[] };
  /** Accessibility structure that differs between the sides (landmarks, headings, images without alt, focusable elements). */
  accessibility: { baseline?: Omit<VariantProbe, 'matched' | 'runningAnimations' | 'hidden' | 'reducedMotion' | 'lazyImages' | 'playingVideos'>; variant?: VariantProbe; changed: string[] };
  differences: StepDifference[];
  seed: string;
  order: ('a' | 'b')[];
  /** Where the experiment came from, when built from an investigation queue item. */
  from?: { file: string; rank: number; id: string; title: string };
  limitations: string[];
}

/** The accessibility structure that differs, as readable lines. */
export function accessibilityChanges(a: VariantProbe | undefined, b: VariantProbe | undefined): string[] {
  if (!a || !b) return [];
  const out: string[] = [];
  const keys: [keyof VariantProbe, string][] = [
    ['landmarks', 'landmarks'],
    ['headings', 'headings'],
    ['imagesWithoutAlt', 'images without alt'],
    ['focusable', 'focusable elements'],
  ];
  for (const [k, label] of keys) if (a[k] !== b[k]) out.push(`${label}: ${a[k]} → ${b[k]}`);
  return out;
}

export function buildReport(
  spec: ExperimentSpec,
  state: { a: SideState; b: SideState },
  steps: { a: StepResult[]; b: StepResult[] },
  seed: string,
  order: ('a' | 'b')[],
  from?: ExperimentReport['from'],
): ExperimentReport {
  const variant = variantOf(spec);
  const pa = state.a.probes.at(-1);
  const pb = state.b.probes.at(-1);
  const applied = variantApplied(variant, { probe: pa, counts: state.a.counts }, { probe: pb, counts: state.b.counts });
  const changed = accessibilityChanges(pa, pb);
  const differences = applied.ok ? summarizeExperiment(steps.a, steps.b) : [];
  const failedA = [...new Set(state.a.assertionFailures)];
  const failedB = [...new Set(state.b.assertionFailures)];
  return {
    name: spec.name,
    url: spec.url,
    variant,
    description: describeVariant(variant),
    sides: { baseline: 'the page as served', variant: describeVariant(variant) },
    applied,
    assertions: { checked: spec.assertions.length, baseline: failedA, variant: failedB },
    accessibility: {
      ...(pa ? { baseline: { landmarks: pa.landmarks, headings: pa.headings, imagesWithoutAlt: pa.imagesWithoutAlt, focusable: pa.focusable } } : {}),
      ...(pb ? { variant: pb } : {}),
      changed,
    },
    differences,
    seed,
    order,
    ...(from ? { from } : {}),
    limitations: [
      'A difference here is a measured difference between two scenarios on this machine, not an energy figure for the component. It holds for this page, workload, browser and machine.',
      'The change is made in the browser (CSS, attributes, refused requests), as a stand-in for the fix. A fix in the code can cost or save more than its stand-in.',
      ...(variant.kind === 'hide' ? ['Hiding an element removes its layout, paint and animation, but its markup is still parsed: an upper bound for rendering fewer of them, not for removing them.'] : []),
      ...(variant.kind === 'pause-animations' ? ['Only CSS animations and transitions are paused; script-driven animation (requestAnimationFrame, timers) keeps running.'] : []),
      ...(['lazy-images', 'no-autoplay', 'pause-animations', 'hide'].includes(variant.kind)
        ? ['The document is fetched through the browser automation on both sides, so its own transfer and timing differ from an ordinary visit; both sides are affected alike.']
        : []),
      ...(failedB.length && !failedA.length ? ['The variant failed checks the baseline passed: it broke something, so its saving is not a like-for-like one.'] : []),
    ],
  };
}
