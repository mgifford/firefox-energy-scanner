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
  DEFAULT_MAX_MATCHES,
  VARIANT_KINDS,
  describeVariant,
  emptyCounts,
  installVariant,
  isRemoval,
  probeVariant,
  validateVariant,
  variantApplied,
  type VariantCounts,
  type VariantProbe,
  type VariantSpec,
} from './variants.js';
import {
  activityBetween,
  checkpoint,
  describeContent,
  essentialContent,
  readActivity,
  removalProbe,
  type ActivityWindow,
  type RemovalCheckpoint,
  type RemovalProbe,
  type SubtreeContent,
  type SubtreeIdentity,
} from './dom-removal.js';
import { installPreloadRemoval } from './preload-removal.js';
import { RunInterrupted, duringRun, inputWatchInit, interference, readInput, watchNavigation } from '../collect/interference.js';

export { RunInterrupted };

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
    /** remove: refuse a selector that matches more elements than this. */
    max_matches: z.number().int().min(1).max(500).optional(),
    /** remove: time both sides wait after the checkpoint, before the idle window, ms. */
    settle_ms: z.number().int().min(0).max(60_000).default(2_000),
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
    ...(isRemoval(spec.kind) ? { maxMatches: spec.max_matches ?? DEFAULT_MAX_MATCHES } : spec.max_matches !== undefined ? { maxMatches: spec.max_matches } : {}),
  };
}

/** Parse and check a spec; throws with every problem listed. */
export function parseSpec(input: unknown): ExperimentSpec {
  const parsed = experimentSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid experiment: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`).join('; ')}`);
  }
  const errors = validateVariant(variantOf(parsed.data));
  if (isRemoval(parsed.data.kind)) {
    if (parsed.data.journey) {
      errors.push(`A ${parsed.data.kind} experiment runs its own workload (load, then the removal, then idle); a journey has no point at which to remove the element yet.`);
    }
    if (parsed.data.kind === 'remove' && parsed.data.idle_ms < 1_000) errors.push('A remove experiment measures its effect in the idle window, so idle_ms must be at least 1000.');
  }
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
  /** Removal kinds: each run's checkpoint, the probe after idle, and script activity between them. */
  removals?: RemovalCheckpoint[];
  removalProbes?: RemovalProbe[];
  activity?: ActivityWindow[];
  /** remove-before-load: the document's bytes as fetched and as served, per run. */
  snapshots?: { originalBytes: number; servedBytes: number }[];
}

/** Thrown from a run whose removal was refused; the experiment stops and reports it. */
export class RemovalRefused extends Error {
  override name = 'RemovalRefused';
}

export const emptySide = (): SideState => ({ counts: emptyCounts(), probes: [], assertionFailures: [], runs: 0, removals: [], removalProbes: [], activity: [] });

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
export function sideJourney(spec: ExperimentSpec, inner: JourneyDefinition | undefined, apply: boolean, state: SideState, warmups = 0): JourneyDefinition {
  const variant = variantOf(spec);
  // The runner calls run() for each warm-up, then the measured run: mark what each was.
  let calls = 0;
  // The built-in workloads send no input and navigate once, so anything else
  // is from outside the test (a click in the headed window) and the run is not
  // used. A journey acts on the page itself, so it is not checked.
  const builtIn = !inner || isRemoval(variant.kind);

  /** The load step; a page that did not load ends the experiment, since it will not load next time either. */
  async function load(args: Parameters<JourneyDefinition['run']>[0]) {
    let failed: Error | undefined;
    const nav = watchNavigation(args.page);
    await args.measure('load', async () => {
      try {
        await args.page.goto(spec.url, { waitUntil: 'load' });
        nav.arm();
      } catch (e) {
        failed = e as Error;
        throw e;
      }
    });
    if (failed) {
      nav.stop();
      throw new RunInterrupted('load-failed', `The page did not load: ${failed.message.split('\n')[0]}`);
    }
    // Left already, while the load step waited for it to settle: nothing after this is of the page.
    if (nav.visited().length) {
      const why = interference(nav.visited(), await readInput(args.page));
      nav.stop();
      throw new RunInterrupted('navigated', why ?? 'The page navigated away during the load step.');
    }
    return nav;
  }

  /** After the measured windows: was the page left alone? */
  async function clean(args: Parameters<JourneyDefinition['run']>[0], nav: ReturnType<typeof watchNavigation>) {
    nav.stop();
    const why = interference(nav.visited(), await readInput(args.page));
    if (why) throw new RunInterrupted(nav.visited().length ? 'navigated' : 'input', why);
  }

  return defineJourney({
    name: `${inner?.name ?? 'load-and-idle'} (${apply ? 'variant' : 'baseline'})`,
    async setup(args) {
      await inner?.setup?.(args);
      if (builtIn) await args.context.addInitScript(inputWatchInit);
      await installVariant(args.context, args.page, variant, apply, state.counts);
      if (variant.kind === 'remove-before-load') {
        // Outside every measured window: fetch, parse, check and (variant) strip; both sides get the snapshot.
        const snap = await installPreloadRemoval(args.context, args.page, spec.url, variant.selector!, apply, variant.maxMatches ?? DEFAULT_MAX_MATCHES, state.counts);
        (state.removals ??= []).push(snap.checkpoint);
        (state.snapshots ??= []).push({ originalBytes: snap.originalBytes, servedBytes: snap.bytes });
        if (snap.checkpoint.refused) throw new RemovalRefused(snap.checkpoint.refusedDetail ?? snap.checkpoint.refused);
      }
    },
    async run(args) {
      const warmup = calls++ < warmups;
      if (variant.kind === 'remove') {
        // Load, as on any experiment: the component is on both sides here.
        const nav = await load(args);
        // The checkpoint, outside every measured window: find the selector's
        // matches on both sides, remove them on the variant only.
        const before = await readActivity(args.page);
        const at = Date.now();
        const cp = { ...(await duringRun(() => checkpoint(args.page, variant.selector!, apply, variant.maxMatches ?? DEFAULT_MAX_MATCHES))), ...(warmup ? { warmup } : {}) };
        (state.removals ??= []).push(cp);
        // Refused here means refused on every run: end this one now rather than measure an unchanged page.
        if (cp.refused) throw new RemovalRefused(cp.refusedDetail ?? cp.refused);
        // The same settle on both sides, so neither measures the removal's own aftermath.
        if (spec.settle_ms > 0) await args.page.waitForTimeout(spec.settle_ms);
        await args.measure('idle', async () => {
          // Intentional idle window: the page left open, with or without the component.
          await args.page.waitForTimeout(spec.idle_ms);
        });
        await clean(args, nav);
        (state.removalProbes ??= []).push({ ...(await duringRun(() => removalProbe(args.page, variant.selector!))), ...(warmup ? { warmup } : {}) });
        const activity = activityBetween(before, await readActivity(args.page), Date.now() - at);
        if (activity) (state.activity ??= []).push({ ...activity, ...(warmup ? { warmup } : {}) });
      } else if (variant.kind === 'remove-before-load') {
        const nav = await load(args);
        const before = await readActivity(args.page);
        const at = Date.now();
        if (spec.idle_ms > 0) {
          await args.measure('idle', async () => {
            // Intentional idle window: the page left open, with or without the component.
            await args.page.waitForTimeout(spec.idle_ms);
          });
        }
        await clean(args, nav);
        (state.removalProbes ??= []).push({ ...(await duringRun(() => removalProbe(args.page, variant.selector!))), ...(warmup ? { warmup } : {}) });
        const activity = activityBetween(before, await readActivity(args.page), Date.now() - at);
        if (activity) (state.activity ??= []).push({ ...activity, ...(warmup ? { warmup } : {}) });
      } else if (inner) {
        await inner.run(args);
      } else {
        const nav = await load(args);
        if (spec.idle_ms > 0) {
          await args.measure('idle', async () => {
            // Intentional idle window: the workload under test is the page left open.
            await args.page.waitForTimeout(spec.idle_ms);
          });
        }
        await clean(args, nav);
      }
      // After the workload, outside every measured window.
      state.runs++;
      state.probes.push(await duringRun(() => probeVariant(args.page, variant)));
      state.assertionFailures.push(...(await checkAssertions(args.page, spec.assertions)));
    },
    async teardown(args) {
      await inner?.teardown?.(args);
    },
  });
}

export type Verdict = 'lower' | 'higher' | 'within-spread' | 'below-resolution' | 'not-measured';

/**
 * attributable: the change was in place for this step, so a difference here
 * can be its effect. negative-control: the change could not have acted yet
 * (a post-load removal, during load), so a difference here is drift or noise.
 */
export type StepRole = 'attributable' | 'negative-control';

export interface StepDifference {
  step: string;
  /** Absent in results made before roles were recorded: read as attributable. */
  role?: StepRole;
  runs: [number, number];
  /**
   * Observed energy, mWh: median and IQR per side, on the basis named.
   * incremental: the window's energy minus the idle baseline's (the default).
   * window: the window's energy, with no baseline subtracted. Used when the
   * baseline exceeded what the step drew, which makes incremental energy
   * unusable; valid for an A/B because both sides measure the same window.
   * Absent `basis` in older results: incremental.
   */
  energy?: {
    basis?: 'incremental' | 'window';
    medianMwh: [number, number];
    iqrMwh: [number, number];
    differenceMwh: number;
    percent?: number;
    resolved: [boolean, boolean];
    /** Window energy, as a cross-check beside incremental energy. */
    window?: { medianMwh: [number, number]; iqrMwh: [number, number]; differenceMwh: number; verdict: Verdict };
    /** The idle baseline subtracted, mW: median over runs, per side, and how it was found. */
    baselineMw?: [number, number];
    baselineMethod?: 'median-of-bins' | 'mean';
  };
  verdict: Verdict;
  /** Plain words for the verdict. */
  reading: string;
  /** Fewer than 10 runs per side: indicative only. */
  indicative: boolean;
  /** Median power-counter samples per run in this step, per side: few samples, little resolution. */
  samples?: [number, number];
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
/** Medians, spreads and a verdict for one basis of energy. */
function readSeries(ja: number[], jb: number[]) {
  const A = ja.map(mwh);
  const B = jb.map(mwh);
  const cmp = compare(A, B);
  const ra = resolution(A);
  const rb = resolution(B);
  const sumA = summarize(A);
  const sumB = summarize(B);
  const diff = cmp.medianDifference;
  const spread = Math.max(sumA.iqr, sumB.iqr);
  const verdict: Verdict = !ra.resolved || !rb.resolved ? 'below-resolution' : Math.abs(diff) <= spread ? 'within-spread' : diff < 0 ? 'lower' : 'higher';
  const pct = Number.isFinite(cmp.percentDifference) ? Math.round(cmp.percentDifference * 10) / 10 : undefined;
  return { cmp, ra, rb, sumA, sumB, diff, verdict, pct, nonPositive: sumA.median <= 0 || sumB.median <= 0 };
}

const READING = (verdict: Verdict, diff: number, pct: number | undefined) =>
  ({
    lower: `The variant used ${Math.abs(diff).toFixed(3)} mWh less (${pct}%), more than either side's run-to-run spread.`,
    higher: `The variant used ${diff.toFixed(3)} mWh more (+${pct}%), more than either side's run-to-run spread.`,
    'within-spread': `The difference (${diff.toFixed(3)} mWh) is within the run-to-run spread: no difference shown.`,
    'below-resolution': 'At least one side is below the resolution of this setup (its median does not exceed its spread, or is at or below idle): no difference can be read.',
    'not-measured': '',
  })[verdict];

export function summarizeExperiment(baseline: StepResult[], variant: StepResult[], roles: Record<string, StepRole> = {}): StepDifference[] {
  const a = groupByStep(baseline);
  const b = groupByStep(variant);
  const out: StepDifference[] = [];
  for (const [step, runsA] of a) {
    const runsB = b.get(step) ?? [];
    if (!runsB.length) continue;
    const ja = runsA.map((r) => r.energy?.incrementalJoules).filter((v): v is number => v !== undefined);
    const jb = runsB.map((r) => r.energy?.incrementalJoules).filter((v): v is number => v !== undefined);
    const wa = runsA.map((r) => r.energy?.raw.totalJoules).filter((v): v is number => v !== undefined);
    const wb = runsB.map((r) => r.energy?.raw.totalJoules).filter((v): v is number => v !== undefined);
    const durationMs: [number, number] = [median(runsA.map((r) => r.timing.durationMs)), median(runsB.map((r) => r.timing.durationMs))];
    const ta = runsA.flatMap((r) => (r.network ? [r.network.transferBytes] : []));
    const tb = runsB.flatMap((r) => (r.network ? [r.network.transferBytes] : []));
    const transferBytes: [number, number] | undefined = ta.length && tb.length ? [median(ta), median(tb)] : undefined;
    const role = roles[step] ?? 'attributable';
    const control = role === 'negative-control' ? 'Negative control (the change was not yet in place during this step): ' : '';
    const sa = runsA.map((r) => r.energy?.raw.sampleCount).filter((v): v is number => v !== undefined);
    const sb = runsB.map((r) => r.energy?.raw.sampleCount).filter((v): v is number => v !== undefined);
    const samples: [number, number] | undefined = sa.length && sb.length ? [median(sa), median(sb)] : undefined;
    const base = { step, role, runs: [runsA.length, runsB.length] as [number, number], ...(samples ? { samples } : {}), durationMs, ...(transferBytes ? { transferBytes } : {}) };

    if ((!ja.length || !jb.length) && (!wa.length || !wb.length)) {
      out.push({ ...base, verdict: 'not-measured', reading: `${control}Energy was not measured on this machine, so there is no energy difference to report.`, indicative: true });
      continue;
    }
    const ba = runsA.map((r) => r.energy?.baselineWatts).filter((v): v is number => v !== undefined);
    const bb = runsB.map((r) => r.energy?.baselineWatts).filter((v): v is number => v !== undefined);
    const baselineMw: [number, number] | undefined = ba.length && bb.length ? [median(ba) * 1000, median(bb) * 1000] : undefined;
    const method = runsA.find((r) => r.energy?.baselineMethod)?.energy?.baselineMethod ?? (baselineMw ? 'mean' : undefined);
    const inc = ja.length && jb.length ? readSeries(ja, jb) : undefined;
    const win = wa.length && wb.length ? readSeries(wa, wb) : undefined;
    // The baseline exceeded what the step drew, so incremental energy says nothing;
    // window energy needs no baseline, and both sides measured the same window.
    const useWindow = !!win && (!inc || (inc.verdict === 'below-resolution' && inc.nonPositive && win.verdict !== 'below-resolution'));
    const r = useWindow ? win! : inc!;
    const machineWide = runsA.some((x) => x.energy?.raw.measurementScope && x.energy.raw.measurementScope !== 'process');
    const unequal = Math.abs(durationMs[0] - durationMs[1]) > 0.05 * Math.max(durationMs[0], durationMs[1]);
    let reading = READING(r.verdict, r.diff, r.pct);
    if (useWindow) {
      reading =
        `On window energy, with no baseline subtracted: ${reading} ` +
        `(The idle baseline subtracted${baselineMw ? `, ${baselineMw[0].toFixed(1)} mW on the baseline side` : ''}, was more than this step drew, so incremental energy could not be read.)` +
        (machineWide && unequal ? ' These counters cover the whole machine and the sides took different times, so part of this difference is the idle floor over that time.' : '');
    }
    out.push({
      ...base,
      energy: {
        basis: useWindow ? 'window' : 'incremental',
        medianMwh: [r.sumA.median, r.sumB.median],
        iqrMwh: [r.sumA.iqr, r.sumB.iqr],
        differenceMwh: r.diff,
        ...(r.pct !== undefined ? { percent: r.pct } : {}),
        resolved: [r.ra.resolved, r.rb.resolved],
        ...(win ? { window: { medianMwh: [win.sumA.median, win.sumB.median] as [number, number], iqrMwh: [win.sumA.iqr, win.sumB.iqr] as [number, number], differenceMwh: win.diff, verdict: win.verdict } } : {}),
        ...(baselineMw ? { baselineMw } : {}),
        ...(method ? { baselineMethod: method } : {}),
      },
      verdict: r.verdict,
      reading: `${control}${r.cmp.sufficientSamples ? reading : `${reading} Indicative: fewer than 10 runs per side.`}`,
      indicative: !r.cmp.sufficientSamples,
    });
  }
  return out;
}

/**
 * The differences again, from a stored result's own runs, with the current
 * rules. Differences are derived data, as the component graph is; the runs
 * are not changed.
 */
export function refreshDifferences(result: { scenarios: StepResult[]; experiment?: ExperimentReport }): void {
  const x = result.experiment;
  if (!x || !x.applied.ok) return;
  const roles: Record<string, StepRole> = Object.fromEntries((x.workload?.steps ?? []).map((s) => [s.name, s.role]));
  if (!x.workload && x.variant.kind === 'remove') Object.assign(roles, { load: 'negative-control', idle: 'attributable' });
  x.differences = summarizeExperiment(
    result.scenarios.filter((s) => s.scenario === 'baseline'),
    result.scenarios.filter((s) => s.scenario === 'variant'),
    roles,
  );
}

export interface ExperimentProtocol {
  design: 'interleaved A/B, seeded order, a fresh browser per run';
  runsPerSide: number;
  /** Warm-ups before each side's first run, discarded. */
  warmupsPerSide: number;
  /** The idle baseline (about:blank) measured in every run before the workload, ms; null when off. */
  idleBaselineMs: number | null;
  cacheMode: string;
  viewport: { width: number; height: number };
  headed: boolean;
  network: string;
  profilerFeatures: string[];
  profilerIntervalMs: number;
  /** A label for the build measured, when given (--release). */
  release?: string;
  /** Runs that were not used because something outside the test acted on the page, and why. */
  runsNotUsed?: { run: number; side: string; reason: string }[];
  /** Seeds and order are in the report itself. */
}

/** One side of a removal: what the checkpoint found and did, run by run, and what followed. */
export interface RemovalSideSummary {
  /** Elements the selector matched at each run's checkpoint. */
  matched: number[];
  roots: number;
  nested: number;
  /** Subtrees removed per run: zeros on the baseline. */
  removed: number[];
  /** Matches right after the removal, per run. */
  remaining: number[];
  /** Matches after the idle window, per run. */
  matchesAfterIdle: number[];
  reinsertions: number[];
  /** What the matched subtrees held (removed on the variant, kept on the baseline). */
  content?: SubtreeContent;
  identities: SubtreeIdentity[];
  refused?: string;
  /** Script callbacks between the checkpoint and the end of idle: median over runs. */
  activity?: ActivityWindow;
}

export interface RemovalSummary {
  /** post-load: detached after the load step. pre-load: removed from the markup before parsing. */
  mode: 'post-load' | 'pre-load';
  /** pre-load: the snapshot both sides were served (bytes as fetched, and as served per side). */
  snapshot?: { originalBytes: number; servedBytes: [number, number] };
  selector: string;
  maxMatches: number;
  /** When the removal happens, in words. */
  checkpoint: string;
  settleMs: number;
  idleMs: number;
  baseline: RemovalSideSummary;
  variant: RemovalSideSummary;
  /** Removed in every variant run, none left behind. */
  verified: boolean;
  /** The selector matched the same number of elements on both sides at every checkpoint: comparable page states. */
  comparable: boolean;
  /** The page put a matching element back in at least one run. */
  reinserted: boolean;
  /** What the callback counters show about script work after the removal. Evidence, not energy. */
  activity: { continued: string[]; fell: string[]; note: string };
  /** Headings, landmarks, controls and other content people use that the removal took away. */
  removedEssential: string[];
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
  /** Removal kinds: the checkpoint, what was removed, whether it stayed removed, and script activity after it. */
  removal?: RemovalSummary;
  /**
   * Whether a saving would be like-for-like: false when the change broke a
   * check, or took away content people use. Absent in older results.
   */
  likeForLike?: { ok: boolean; reasons: string[] };
  /**
   * How the comparison was run: what was controlled, and what was only
   * recorded. Absent in older results.
   */
  protocol?: ExperimentProtocol;
  /** The workload, and which steps the change could have affected. Absent in older results. */
  workload?: { kind: 'load-and-idle' | 'journey' | 'load-checkpoint-idle'; steps: { name: string; role: StepRole }[]; idleMs?: number; settleMs?: number };
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
    ['interactive', 'interactive controls and links'],
    ['formControls', 'form controls'],
    ['liveRegions', 'live regions'],
  ];
  // A count missing on either side (an older result) is not a change.
  for (const [k, label] of keys) if (a[k] !== undefined && b[k] !== undefined && a[k] !== b[k]) out.push(`${label}: ${a[k]} → ${b[k]}`);
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
  const applied = variantApplied(
    variant,
    { probe: pa, counts: state.a.counts, removals: state.a.removals, removalProbes: state.a.removalProbes },
    { probe: pb, counts: state.b.counts, removals: state.b.removals, removalProbes: state.b.removalProbes },
  );
  const changed = accessibilityChanges(pa, pb);
  const removalKind = isRemoval(variant.kind);
  const roles: Record<string, StepRole> = variant.kind === 'remove' ? { load: 'negative-control', idle: 'attributable' } : {};
  const differences = applied.ok ? summarizeExperiment(steps.a, steps.b, roles) : [];
  const failedA = [...new Set(state.a.assertionFailures)];
  const failedB = [...new Set(state.b.assertionFailures)];
  const removal = removalKind ? summarizeRemoval(spec, variant, state, applied.ok) : undefined;
  const brokeChecks = failedB.length > 0 && failedA.length === 0;
  const fewer = pa && pb ? (['headings', 'landmarks', 'interactive', 'formControls'] as const).filter((k) => (pb[k] ?? 0) < (pa[k] ?? 0)) : [];
  const likeForLike = {
    ok: !brokeChecks && !(removal?.removedEssential.length) && !(variant.kind === 'hide' && fewer.length),
    reasons: [
      ...(brokeChecks ? [`The variant failed checks the baseline passed: ${failedB.join('; ')}.`] : []),
      ...(removal?.removedEssential.length ? [`The removal took away ${removal.removedEssential.join(', ')}.`] : []),
      ...(variant.kind === 'hide' && fewer.length ? [`Hiding left fewer ${fewer.join(', ')} in the page.`] : []),
    ],
  };
  const controlMoved = differences.find((d) => d.role === 'negative-control' && (d.verdict === 'lower' || d.verdict === 'higher'));
  const workload: ExperimentReport['workload'] = variant.kind === 'remove'
    ? { kind: 'load-checkpoint-idle', steps: [{ name: 'load', role: 'negative-control' }, { name: 'idle', role: 'attributable' }], idleMs: spec.idle_ms, settleMs: spec.settle_ms }
    : spec.journey
      ? { kind: 'journey', steps: [] }
      : { kind: 'load-and-idle', steps: [{ name: 'load', role: 'attributable' }, ...(spec.idle_ms > 0 ? [{ name: 'idle', role: 'attributable' as const }] : [])], idleMs: spec.idle_ms };
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
    ...(removal ? { removal } : {}),
    likeForLike,
    workload,
    seed,
    order,
    ...(from ? { from } : {}),
    limitations: [
      ...(variant.kind === 'remove' ? REMOVAL_LIMITATIONS : variant.kind === 'remove-before-load' ? PRELOAD_LIMITATIONS : []),
      ...(removal?.variant.content?.iframes ? ['Removing an iframe element unloads its document, which stops that document’s scripts; removing any other element does not stop the scripts that drive it.'] : []),
      ...(controlMoved ? [`The negative control differed (${controlMoved.step}: ${controlMoved.verdict}): the sides were not alike before the removal, so read the idle difference with caution and repeat the experiment.`] : []),
      'A difference here is a measured difference between two scenarios on this machine, not an energy figure for the component. It holds for this page, workload, browser and machine.',
      'The change is made in the browser (CSS, attributes, refused requests), as a stand-in for the fix. A fix in the code can cost or save more than its stand-in.',
      ...(variant.kind === 'hide' ? ['Hiding an element removes its layout, paint and animation, but its markup is still parsed: an upper bound for rendering fewer of them, not for removing them.'] : []),
      ...(variant.kind === 'pause-animations' ? ['Only CSS animations and transitions are paused; script-driven animation (requestAnimationFrame, timers) keeps running.'] : []),
      ...(['lazy-images', 'no-autoplay', 'pause-animations', 'hide'].includes(variant.kind)
        ? ['The document is fetched through the browser automation on both sides, so its own transfer and timing differ from an ordinary visit; both sides are affected alike.']
        : []),
      ...(failedB.length && !failedA.length ? ['The variant failed checks the baseline passed: it broke something, so its saving is not a like-for-like one.'] : []),
      ...(removal?.removedEssential.length ? ['The removed content included things people use. A saving from removing it shows what the component costs; it is not a design change that keeps its function.'] : []),
      ...(changed.length === 0 && (removalKind || variant.kind === 'hide') ? ['Unchanged element counts do not show the page works as before; the checks, and a person, do.'] : []),
    ],
  };
}

const REMOVAL_LIMITATIONS = [
  'Removing an element does not stop the timers, animation-frame loops, workers, event listeners or network requests its scripts started. A component can leave the page and keep working; the callback counts show whether script work carried on.',
  'Only the idle window can show an effect of a post-load removal: the component was on both sides while the page loaded. The load step is a negative control, never a saving.',
  'The selector is matched in the top document only: elements in other frames and inside shadow roots are not matched.',
  'A removal is a diagnostic stand-in. It shows what the component costs while the page sits idle on this machine; it does not show the component should be removed.',
];

const PRELOAD_LIMITATIONS = [
  'The component was removed from the markup before the browser parsed it, so its parsing, resources, inline scripts, layout and paint did not happen on the variant. Both load and idle can show its effect. This is a different experiment from a post-load removal, and the two are never combined.',
  'Both sides were served a snapshot of the document, fetched once per run before measurement and parsed and re-serialised by the browser on both sides. The server’s response time is part of neither side, and anything the server varies per request (tokens, nonces) is frozen for the run.',
  'Scripts loaded from elsewhere in the page (the head, a bundle) still run on the variant and find no component: a script that fails, or keeps working without it, is part of what is measured.',
  'The selector is matched in the top document only, as the parser builds it with scripting off: content inside <noscript> can match, elements created later by script cannot.',
  'A removal is a diagnostic stand-in. It shows what the component costs on this machine; it does not show the component should be removed.',
];

const med = (xs: number[]) => (xs.length ? median(xs) : 0);

function activityMedian(ws: ActivityWindow[] | undefined): ActivityWindow | undefined {
  if (!ws?.length) return undefined;
  return {
    ms: Math.round(med(ws.map((w) => w.ms))),
    timeouts: med(ws.map((w) => w.timeouts)),
    intervals: med(ws.map((w) => w.intervals)),
    animationFrames: med(ws.map((w) => w.animationFrames)),
    runningAnimations: [med(ws.map((w) => w.runningAnimations[0])), med(ws.map((w) => w.runningAnimations[1]))],
  };
}

/**
 * What the callback counts say about script work after a removal. Callbacks
 * per second on each side: a rate that holds when the component is gone means
 * its scripts (or something else on the page) kept running. Evidence of work,
 * never of energy.
 */
export function activityFindings(a: ActivityWindow | undefined, b: ActivityWindow | undefined): RemovalSummary['activity'] {
  if (!a || !b) return { continued: [], fell: [], note: 'Script callbacks were not counted on both sides.' };
  const rate = (n: number, ms: number) => (ms > 0 ? (n / ms) * 1000 : 0);
  const continued: string[] = [];
  const fell: string[] = [];
  const one = (label: string, na: number, nb: number) => {
    const ra = rate(na, a.ms);
    const rb = rate(nb, b.ms);
    if (ra < 0.5 && rb < 0.5) return;
    const text = `${label}: ${ra.toFixed(1)} a second with the component, ${rb.toFixed(1)} without`;
    if (rb >= ra * 0.5) continued.push(text);
    else fell.push(text);
  };
  one('timer callbacks', a.timeouts + a.intervals, b.timeouts + b.intervals);
  one('animation-frame callbacks', a.animationFrames, b.animationFrames);
  if (a.runningAnimations[1] > 0 || b.runningAnimations[1] > 0) {
    const t = `running CSS and Web Animations after idle: ${a.runningAnimations[1]} with the component, ${b.runningAnimations[1]} without`;
    (b.runningAnimations[1] >= a.runningAnimations[1] ? continued : fell).push(t);
  }
  const note = continued.length
    ? 'Script work carried on after the removal at a similar rate. Either the removed component’s scripts kept running without their markup, or the work belongs to something else on the page: the removal did not stop it.'
    : fell.length
      ? 'Script work fell after the removal: the work stopped with the component, or its code checks for its markup.'
      : 'Little script work on either side.';
  return { continued, fell, note };
}

function sideSummary(s: SideState): RemovalSideSummary {
  // Per-run figures are for the measured runs; warm-ups are checked, not reported.
  const cps = (s.removals ?? []).filter((c) => !c.warmup);
  const probes = (s.removalProbes ?? []).filter((p) => !p.warmup);
  const first = cps[0];
  const refused = cps.find((c) => c.refused);
  const activity = activityMedian((s.activity ?? []).filter((a) => !a.warmup));
  return {
    matched: cps.map((c) => c.matched),
    roots: first?.roots ?? 0,
    nested: first?.nested ?? 0,
    removed: cps.map((c) => c.removed),
    remaining: cps.map((c) => c.remaining),
    matchesAfterIdle: probes.map((p) => p.matchesNow),
    reinsertions: probes.map((p) => p.reinsertions),
    ...(first && !first.refused ? { content: first.content } : {}),
    identities: first?.identities ?? [],
    ...(refused ? { refused: refused.refusedDetail ?? refused.refused } : {}),
    ...(activity ? { activity } : {}),
  };
}

export function summarizeRemoval(spec: ExperimentSpec, variant: VariantSpec, state: { a: SideState; b: SideState }, verified: boolean): RemovalSummary {
  const baseline = sideSummary(state.a);
  const v = sideSummary(state.b);
  const pre = variant.kind === 'remove-before-load';
  const sa = state.a.snapshots?.[0];
  const sb = state.b.snapshots?.[0];
  return {
    mode: pre ? 'pre-load' : 'post-load',
    ...(pre && sa && sb ? { snapshot: { originalBytes: sa.originalBytes, servedBytes: [sa.servedBytes, sb.servedBytes] as [number, number] } } : {}),
    selector: variant.selector ?? '',
    maxMatches: variant.maxMatches ?? DEFAULT_MAX_MATCHES,
    checkpoint: pre
      ? 'Before the page is parsed: in each run’s setup, outside every measured window, the document is fetched, parsed by the browser’s own HTML parser, stripped of the matches on the variant, and serialised again on both sides. Both sides are served that snapshot.'
      : `After the load step and the page settling, outside every measured window; then ${spec.settle_ms} ms for both sides to settle before the ${spec.idle_ms} ms idle window.`,
    settleMs: pre ? 0 : spec.settle_ms,
    idleMs: spec.idle_ms,
    baseline,
    variant: v,
    verified,
    comparable: baseline.matched.length > 0 && v.matched.length > 0 && new Set([...baseline.matched, ...v.matched]).size === 1,
    reinserted: (state.b.removalProbes ?? []).some((p) => p.reinsertions > 0 || p.matchesNow > 0 || p.rootsReconnected > 0),
    activity: activityFindings(baseline.activity, v.activity),
    removedEssential: v.content && v.removed.some((n) => n > 0) ? essentialContent(v.content) : [],
  };
}

export { describeContent };
