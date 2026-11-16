/**
 * The evidence record: an experiment's result as a finding another developer
 * can read, reproduce and act on, as JSON and as a Markdown issue draft.
 *
 * It keeps four things apart, in this order, and never lets one stand in for
 * another:
 *
 * 1. observed activity: what was measured or seen (profiling, the probes);
 * 2. suspected cause: why the component was tested;
 * 3. experimentally supported outcome: what the controlled comparison showed,
 *    with its confidence, or that it showed nothing;
 * 4. recommended production change: what to investigate next. Never "remove
 *    it" on this evidence alone.
 *
 * Machine-readable, for import elsewhere. The `topics` are plain tags for
 * mapping to the W3C Web Sustainability Guidelines later; no guideline
 * number is asserted here.
 */

import { stringify as toYaml } from 'yaml';
import type { BenchmarkResult } from '../core/types.js';
import type { ExperimentReport, StepDifference } from '../experiments/experiment.js';
import { stableHash } from '../analysis/signature.js';
import type { ComponentLead, ScriptLead, SpikeLead, TimelineAnalysis } from '../energy/spike-analysis.js';

export const FINDING_SCHEMA = 'energy-finding/1';

export type FindingStatus =
  | 'reduction-shown'
  | 'reduction-not-like-for-like'
  | 'increase-shown'
  | 'no-difference-shown'
  | 'below-resolution'
  | 'not-measured'
  | 'intervention-failed';

export interface FindingStep {
  step: string;
  role: 'attributable' | 'negative-control';
  verdict: StepDifference['verdict'];
  runs: [number, number];
  /** Median power samples per run in the step, per side. */
  samples?: [number, number];
  /** Median and IQR per side, mWh; absent when energy was not measured. */
  baseline?: { medianMwh: number; iqrMwh: number };
  variant?: { medianMwh: number; iqrMwh: number };
  differenceMwh?: number;
  percent?: number;
  durationMs: [number, number];
  transferBytes?: [number, number];
  reading: string;
}

export interface EvidenceRecord {
  schema: typeof FINDING_SCHEMA;
  id: string;
  generatedAt: string;
  title: string;
  target: {
    page: string;
    component?: { selector?: string; componentIds?: string[]; signature?: string };
    /** Scripts and functions tied to the component by profiling, when known. Empty when unknown. */
    sourceFiles: { url: string; functions: string[]; how: string }[];
  };
  /** 1. What was measured or seen. */
  observed: { statements: string[]; evidence: { class: string; source: string; detail: string }[] };
  /** 2. Why it was tested. */
  suspected: { statement: string; basis: string[] };
  /** 3. What the controlled comparison showed. */
  outcome: { status: FindingStatus; statement: string; confidence: 'confirmatory' | 'indicative' | 'none'; steps: FindingStep[] };
  /** 4. What to investigate next. */
  recommendation: { statement: string; options: ('optimize' | 'defer' | 'redesign' | 'replace' | 'remove')[]; caution: string };
  experiment: {
    name: string;
    kind: string;
    description: string;
    mode?: 'post-load' | 'pre-load';
    workload?: ExperimentReport['workload'];
    seed: string;
    order: string[];
    runs: [number, number];
    warmups?: number;
    command: string;
    spec: Record<string, unknown>;
  };
  environment: Record<string, string | number | boolean | undefined>;
  accessibility: {
    structureChanged: string[];
    removedContent: string[];
    assertions: ExperimentReport['assertions'];
    likeForLike: { ok: boolean; reasons: string[] };
  };
  limitations: string[];
  artifacts: Record<string, string>;
  topics: string[];
  wsg: { mapping: 'not-asserted'; note: string };
}

const q = (s: string) => (/^[\w./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The command that repeats the experiment, seed included. */
export function experimentCommand(x: ExperimentReport, spec: Record<string, unknown>, warmups?: number): string {
  const v = x.variant;
  const parts = ['web-energy', 'experiment', q(x.url), '--kind', v.kind];
  if (v.selector) parts.push('--selector', q(v.selector));
  for (const h of v.hosts ?? []) parts.push('--host', q(h));
  for (const u of v.urls ?? []) parts.push('--block-url', q(u));
  if (v.keepEager !== undefined) parts.push('--keep-eager', String(v.keepEager));
  if (spec['idle_ms'] !== undefined) parts.push('--idle', String(spec['idle_ms']));
  if ((v.kind === 'remove') && spec['settle_ms'] !== undefined) parts.push('--settle', String(spec['settle_ms']));
  if (v.maxMatches !== undefined && v.maxMatches !== 24) parts.push('--max-matches', String(v.maxMatches));
  const runs = Math.max(...x.differences.map((d) => d.runs[0]), x.order.filter((o) => o === 'a').length);
  if (runs) parts.push('--runs', String(runs));
  if (warmups !== undefined) parts.push('--warmups', String(warmups));
  parts.push('--seed', q(x.seed));
  return parts.join(' ');
}

function topicsFor(x: ExperimentReport): string[] {
  const t = new Set<string>();
  const k = x.variant.kind;
  if (k === 'remove' || k === 'remove-before-load' || k === 'hide') t.add('dom-components');
  if (k === 'pause-animations' || k === 'reduced-motion') t.add('animation');
  if (k === 'reduced-motion') t.add('user-preferences');
  if (k === 'block') t.add('scripts-and-third-parties');
  if (k === 'lazy-images') t.add('images');
  if (k === 'no-autoplay') t.add('media-autoplay');
  if (x.workload?.steps.some((s) => s.name === 'idle' && s.role === 'attributable')) t.add('idle-work');
  if (x.removal?.activity.continued.length) t.add('timers-and-loops');
  if (x.likeForLike && !x.likeForLike.ok) t.add('accessibility-and-function');
  return [...t];
}

function outcomeOf(x: ExperimentReport): EvidenceRecord['outcome'] {
  const steps: FindingStep[] = x.differences.map((d) => ({
    step: d.step,
    role: d.role ?? 'attributable',
    verdict: d.verdict,
    runs: d.runs,
    ...(d.samples ? { samples: d.samples } : {}),
    ...(d.energy ? { baseline: { medianMwh: d.energy.medianMwh[0], iqrMwh: d.energy.iqrMwh[0] }, variant: { medianMwh: d.energy.medianMwh[1], iqrMwh: d.energy.iqrMwh[1] }, differenceMwh: d.energy.differenceMwh, ...(d.energy.percent !== undefined ? { percent: d.energy.percent } : {}) } : {}),
    durationMs: d.durationMs,
    ...(d.transferBytes ? { transferBytes: d.transferBytes } : {}),
    reading: d.reading,
  }));
  if (!x.applied.ok) {
    return { status: 'intervention-failed', confidence: 'none', steps, statement: `The change did not take effect, so nothing was compared: ${x.applied.note} This is not evidence that the change saves nothing.` };
  }
  const attributable = x.differences.filter((d) => (d.role ?? 'attributable') === 'attributable');
  const control = x.differences.find((d) => d.role === 'negative-control' && (d.verdict === 'lower' || d.verdict === 'higher'));
  // Not equivalent: a side lost runs, or the page was in a different state at the checkpoint.
  const unequal = attributable.filter((d) => d.runs[0] !== d.runs[1]);
  const incomparable = x.removal && x.removal.comparable === false;
  const caveat = [
    ...(control ? ['The negative control moved too, so treat this as indicative.'] : []),
    ...(unequal.length ? [`The sides had unequal valid runs (${unequal.map((d) => `${d.step}: ${d.runs[0]} and ${d.runs[1]}`).join('; ')}).`] : []),
    ...(incomparable ? ['The selector matched different numbers of elements on the two sides at the checkpoint: the page states were not the same.'] : []),
  ].join(' ');
  const lower = attributable.filter((d) => d.verdict === 'lower');
  const higher = attributable.filter((d) => d.verdict === 'higher');
  const confidence = (ds: StepDifference[]): EvidenceRecord['outcome']['confidence'] => (ds.some((d) => d.indicative) || caveat ? 'indicative' : 'confirmatory');
  const where = (ds: StepDifference[]) => ds.map((d) => `${d.step}: ${d.reading}`).join(' ');
  if (attributable.length && attributable.every((d) => d.verdict === 'not-measured')) {
    return { status: 'not-measured', confidence: 'none', steps, statement: 'Energy was not measured on this machine. The change applied; timing and transfer are shown, and the energy comparison needs hardware that measures it.' };
  }
  if (lower.length && !higher.length) {
    const lfl = x.likeForLike?.ok !== false;
    return {
      status: lfl ? 'reduction-shown' : 'reduction-not-like-for-like',
      confidence: confidence(lower),
      steps,
      statement: `With the change, this page used less energy on this machine, by more than either side’s run-to-run spread. ${where(lower)}${lfl ? '' : ` But the change also took away function or content: ${x.likeForLike!.reasons.join(' ')}`}${caveat ? ` ${caveat}` : ''}`,
    };
  }
  if (higher.length && !lower.length) {
    return { status: 'increase-shown', confidence: confidence(higher), steps, statement: `With the change, this page used more energy on this machine. ${where(higher)}${caveat ? ` ${caveat}` : ''}` };
  }
  if (attributable.some((d) => d.verdict === 'within-spread') || (lower.length && higher.length)) {
    return { status: 'no-difference-shown', confidence: 'none', steps, statement: 'No difference was shown: the measured difference is within the run-to-run spread. That is not proof of no effect; a smaller effect than this setup resolves may remain.' };
  }
  return { status: 'below-resolution', confidence: 'none', steps, statement: 'At least one side is below the resolution of this setup, so no difference can be read. Longer idle windows or more runs may resolve it.' };
}

function recommendationOf(x: ExperimentReport, status: FindingStatus): EvidenceRecord['recommendation'] {
  const caution =
    'This experiment shows what the component costs in this scenario, on this machine. It does not show the component should be removed from production: removing it is one option, and only if it serves no one.';
  const scripts = x.removal?.activity.continued.length
    ? ' Its scripts kept working after its markup was gone: look at their timers and loops (stop them when the component is not on screen, or not in the page), not only at the markup.'
    : '';
  switch (status) {
    case 'reduction-shown':
      return { statement: `Investigate a production change that keeps what the component is for while doing less work: optimise it, defer it until it is needed, redesign or replace it.${scripts} Confirm the real change against production with compare.`, options: ['optimize', 'defer', 'redesign', 'replace', 'remove'], caution };
    case 'reduction-not-like-for-like':
      return { statement: `The saving came with lost function or content, so it is not a design change to ship. Look for a version that keeps what people use (optimise, redesign or defer) and test that.${scripts}`, options: ['optimize', 'redesign', 'defer'], caution };
    case 'increase-shown':
      return { statement: 'The change cost more energy here. Keep the component as it is, or test a different change.', options: [], caution };
    case 'no-difference-shown':
    case 'below-resolution':
      return { statement: `No energy case for changing it on this page and workload. Other reasons (performance, accessibility, maintenance) may still apply; a longer idle window, more runs or a heavier workload may resolve a smaller effect.${scripts}`, options: [], caution };
    case 'not-measured':
      return { statement: 'Repeat on hardware that measures energy (web-energy doctor says whether a machine can), with the command below.', options: [], caution };
    case 'intervention-failed':
      return { statement: 'Fix the experiment before reading anything from it: the change did not take effect, or did not hold. A component the page puts back needs its code changed, or a different kind of experiment.', options: [], caution };
  }
}

function envOf(r: BenchmarkResult): EvidenceRecord['environment'] {
  const e = r.environment;
  const c = r.configuration as { benchmark?: { cache_mode?: string; warmups?: number; settle_ms?: number }; energy?: { baseline?: boolean; baseline_duration_ms?: number; profiler_interval_ms?: number }; network?: { public_only?: boolean } } | undefined;
  return {
    timestamp: e.timestamp,
    firefox: e.firefoxVersion,
    playwright: e.playwrightVersion,
    os: e.os,
    osVersion: e.osVersion,
    architecture: e.architecture,
    cpuModel: e.cpuModel,
    machineModel: e.machineModel,
    cpuCount: e.cpuCount,
    memoryBytes: e.totalMemoryBytes,
    viewport: `${e.viewport.width}x${e.viewport.height}`,
    headed: e.headed,
    onBattery: e.onBattery,
    lowPowerMode: e.lowPowerMode,
    energyAdapter: e.energyAdapter,
    energyScope: r.capabilities?.energyCheck?.scope,
    tier: r.capabilities?.tier,
    cacheMode: c?.benchmark?.cache_mode,
    warmups: c?.benchmark?.warmups,
    idleBaseline: c?.energy?.baseline ? `${c.energy.baseline_duration_ms} ms` : 'none',
    profilerIntervalMs: c?.energy?.profiler_interval_ms,
    network: c?.network?.public_only ? 'public addresses only, unthrottled' : 'unthrottled',
    release: r.experiment?.protocol?.release ?? r.target?.commit ?? r.targets?.[0]?.commit,
    design: r.experiment?.protocol?.design,
    runsPerSide: r.experiment?.protocol?.runsPerSide,
    profilerFeatures: r.experiment?.protocol?.profilerFeatures.join(', '),
  };
}

/** The lead in a diagnose result for this component, if any. */
export function leadFor(evidence: BenchmarkResult | undefined, selector: string | undefined): { lead: SpikeLead; component?: ComponentLead; timeline: TimelineAnalysis } | undefined {
  for (const t of evidence?.timelines ?? []) {
    for (const lead of Object.values(t.leads ?? {})) {
      const component = selector ? lead.components.find((c) => c.selector === selector) : undefined;
      if (component) return { lead, component, timeline: t };
    }
  }
  return undefined;
}

export interface RecordOptions {
  /** File names of the result's artifacts, relative to the record. */
  artifacts?: Record<string, string>;
  /** A diagnose result whose leads name this component: its profiling evidence is the observed activity. */
  evidence?: BenchmarkResult;
  evidenceFile?: string;
  now?: string;
}

export function buildEvidenceRecord(result: BenchmarkResult, options: RecordOptions = {}): EvidenceRecord | undefined {
  const x = result.experiment;
  if (!x) return undefined;
  const spec = { name: x.name, url: x.url, kind: x.variant.kind, ...(x.variant.selector ? { selector: x.variant.selector } : {}), ...(x.variant.hosts ? { hosts: x.variant.hosts } : {}), ...(x.variant.urls ? { urls: x.variant.urls } : {}), ...(x.workload?.idleMs !== undefined ? { idle_ms: x.workload.idleMs } : {}), ...(x.workload?.settleMs !== undefined && x.variant.kind === 'remove' ? { settle_ms: x.workload.settleMs } : {}), ...(x.variant.maxMatches !== undefined ? { max_matches: x.variant.maxMatches } : {}), seed: x.seed };
  const warmups = (result.configuration as { benchmark?: { warmups?: number } } | undefined)?.benchmark?.warmups;
  const outcome = outcomeOf(x);
  const found = leadFor(options.evidence, x.variant.selector);
  const ids = x.removal?.variant.identities.map((i) => i.componentId).filter((c): c is string => !!c) ?? [];

  const observed: EvidenceRecord['observed'] = { statements: [], evidence: [] };
  if (found) {
    observed.statements.push(`Profiling (${options.evidenceFile ?? 'a diagnose result'}): ${found.lead.observed}`);
    observed.statements.push(...found.lead.activity.map((a) => `Same-run browser activity: ${a}`));
    observed.evidence.push(...(found.component?.evidence ?? []).map((e) => ({ class: e.class, source: e.source, detail: e.detail })));
  }
  if (x.removal) {
    const r = x.removal;
    if (r.baseline.content) observed.statements.push(`The component, as found on the baseline: ${r.baseline.identities.map((i) => `<${i.tag}>${i.componentId ? ` ${i.componentId}` : ''}`).join(', ')} (${r.baseline.matched[0] ?? 0} match${r.baseline.matched[0] === 1 ? '' : 'es'}).`);
    observed.statements.push(`Script work around the removal: ${r.activity.note}`);
    observed.statements.push(...[...r.activity.continued, ...r.activity.fell]);
  }
  if (x.from) observed.statements.push(`Investigation queue item ${x.from.rank} of ${x.from.file}: ${x.from.title}.`);
  if (!observed.statements.length) observed.statements.push('No profiling evidence was attached to this experiment (pass --evidence <diagnose result> to include it).');

  const basis = [
    ...(found ? found.component!.classes.map((c) => `evidence class: ${c}`) : []),
    ...(x.from ? [`queued for investigation (${x.from.title})`] : []),
  ];
  const sourceFiles = [
    // Scripts seen during the interval that this component loads.
    ...(found?.lead.scripts ?? [])
      .filter((s: ScriptLead) => !!found?.component && s.loadedBy.includes(found.component.instance))
      .map((s) => ({ url: s.url, functions: s.functions.map((f) => `${f.name ?? '(anonymous)'}${f.line !== undefined ? `:${f.line}` : ''}`), how: 'on the stack during the interval (same run)' })),
    ...(found?.component?.scripts ?? []).map((k) => ({ url: k, functions: [], how: 'loaded by the component (component graph)' })),
  ];

  const title = `${x.description} on ${x.url}: ${outcome.status.replace(/-/g, ' ')}`;
  return {
    schema: FINDING_SCHEMA,
    id: `fr-${stableHash(`${x.url}|${x.variant.kind}|${x.variant.selector ?? ''}|${x.seed}`)}`,
    generatedAt: options.now ?? new Date().toISOString(),
    title,
    target: {
      page: x.url,
      ...(x.variant.selector || ids.length ? { component: { ...(x.variant.selector ? { selector: x.variant.selector } : {}), ...(ids.length ? { componentIds: [...new Set(ids)] } : {}), ...(found?.component ? { signature: found.component.signature } : {}) } } : {}),
      sourceFiles: dedupe(sourceFiles, (s) => s.url),
    },
    observed,
    suspected: {
      statement: found
        ? `This component was active, or loaded something that was, while power was elevated (${found.component!.classes.join(', ')}). That made it worth testing; it did not show it was the cause.`
        : x.from
          ? `It was queued for investigation: ${x.from.title}.`
          : `It was chosen for testing: ${x.description}.`,
      basis,
    },
    outcome,
    recommendation: recommendationOf(x, outcome.status),
    experiment: {
      name: x.name,
      kind: x.variant.kind,
      description: x.description,
      ...(x.removal ? { mode: x.removal.mode } : {}),
      ...(x.workload ? { workload: x.workload } : {}),
      seed: x.seed,
      order: x.order,
      runs: [x.order.filter((o) => o === 'a').length, x.order.filter((o) => o === 'b').length],
      ...(warmups !== undefined ? { warmups } : {}),
      command: experimentCommand(x, spec, warmups),
      spec,
    },
    environment: envOf(result),
    accessibility: {
      structureChanged: x.accessibility.changed,
      removedContent: x.removal?.removedEssential ?? [],
      assertions: x.assertions,
      likeForLike: x.likeForLike ?? { ok: !(x.assertions.variant.length && !x.assertions.baseline.length), reasons: [] },
    },
    limitations: x.limitations,
    artifacts: { ...(options.artifacts ?? {}), ...(options.evidenceFile ? { profiling: options.evidenceFile } : {}) },
    topics: topicsFor(x),
    wsg: { mapping: 'not-asserted', note: 'Topics are plain tags for mapping to the W3C Web Sustainability Guidelines in the importing system; no guideline or success criterion is asserted here.' },
  };
}

function dedupe<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

const mwh = (n: number | undefined) => (n === undefined ? '—' : n.toFixed(3));

/** The record as an issue draft, in Markdown. Plain text only: no HTML, no images. */
export function findingMarkdown(r: EvidenceRecord): string {
  const md = (s: string) => s.replace(/([\\`*_[\]<>|])/g, '\\$1');
  const lines: string[] = [];
  lines.push(`# ${md(r.title)}`, '');
  lines.push(`**Outcome:** ${r.outcome.status.replace(/-/g, ' ')} (confidence: ${r.outcome.confidence}). **Page:** ${md(r.target.page)}${r.target.component?.selector ? `. **Selector:** \`${r.target.component.selector.replace(/`/g, "'")}\`` : ''}`, '');
  lines.push('## 1. Observed activity', '');
  for (const s of r.observed.statements) lines.push(`- ${md(s)}`);
  for (const e of r.observed.evidence) lines.push(`- (${e.class}, ${e.source}) ${md(e.detail)}`);
  lines.push('', '## 2. Suspected cause', '', md(r.suspected.statement), '');
  if (r.target.sourceFiles.length) {
    lines.push('Source files:', '');
    for (const f of r.target.sourceFiles) lines.push(`- ${md(f.url)}${f.functions.length ? ` (${md(f.functions.join(', '))})` : ''}: ${md(f.how)}`);
    lines.push('');
  }
  lines.push('## 3. Experimentally supported outcome', '', md(r.outcome.statement), '');
  if (r.outcome.steps.length) {
    lines.push('| Step | Role | Runs | Baseline median mWh (IQR) | With the change (IQR) | Difference mWh | Reading |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const s of r.outcome.steps) {
      lines.push(`| ${md(s.step)} | ${s.role} | ${s.runs[0]} / ${s.runs[1]} | ${s.baseline ? `${mwh(s.baseline.medianMwh)} (${mwh(s.baseline.iqrMwh)})` : 'not measured'} | ${s.variant ? `${mwh(s.variant.medianMwh)} (${mwh(s.variant.iqrMwh)})` : 'not measured'} | ${s.differenceMwh !== undefined ? `${s.differenceMwh >= 0 ? '+' : ''}${mwh(s.differenceMwh)}${s.percent !== undefined ? ` (${s.percent}%)` : ''}` : '—'} | ${s.verdict} |`);
    }
    lines.push('');
  }
  lines.push('## 4. Recommended production change', '', md(r.recommendation.statement), '', `> ${md(r.recommendation.caution)}`, '');
  lines.push('## Reproduce', '', '```sh', r.experiment.command, '```', '', '```yaml', toYaml(r.experiment.spec).trim(), '```', '');
  lines.push(`Interleaved order (seed \`${r.experiment.seed.replace(/`/g, "'")}\`): ${r.experiment.order.join(' ')}`, '');
  lines.push('## Measurement environment', '');
  for (const [k, v] of Object.entries(r.environment)) if (v !== undefined && v !== '') lines.push(`- ${k}: ${md(String(v))}`);
  lines.push('', '## Accessibility and functionality', '');
  lines.push(`- Like-for-like: ${r.accessibility.likeForLike.ok ? 'yes' : `no. ${md(r.accessibility.likeForLike.reasons.join(' '))}`}`);
  lines.push(`- Checks (${r.accessibility.assertions.checked}): baseline ${r.accessibility.assertions.baseline.length ? `failed ${md(r.accessibility.assertions.baseline.join('; '))}` : 'passed'}; with the change ${r.accessibility.assertions.variant.length ? `failed ${md(r.accessibility.assertions.variant.join('; '))}` : 'passed'}.`);
  if (r.accessibility.structureChanged.length) lines.push(`- Structure changed: ${md(r.accessibility.structureChanged.join('; '))}`);
  if (r.accessibility.removedContent.length) lines.push(`- Removed: ${md(r.accessibility.removedContent.join(', '))}`);
  lines.push('- Unchanged counts do not show the page works as before; a person should check.', '');
  lines.push('## Limitations', '');
  for (const l of r.limitations) lines.push(`- ${md(l)}`);
  if (Object.keys(r.artifacts).length) {
    lines.push('', '## Artifacts', '');
    for (const [k, v] of Object.entries(r.artifacts)) lines.push(`- ${k}: ${md(v)}`);
  }
  lines.push('', `Record \`${r.id}\`, schema \`${r.schema}\`, generated ${r.generatedAt}. Topics: ${r.topics.join(', ') || 'none'}.`, '');
  return lines.join('\n');
}
