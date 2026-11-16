/**
 * From an interval of elevated power to what might explain it: an
 * investigation shortlist, never an energy figure for a component.
 *
 * Each lead says how it is tied to the interval, by evidence class:
 *
 * - observed-window: the interval itself, measured by Firefox's counters;
 * - profiler-correlation: the same run's profile shows this script on the
 *   stack, or this request on the network, during the interval;
 * - resource-association: the component graph says which component loads
 *   that script or resource (on this page);
 * - cross-run-trace: a Chromium trace of the same page, in a separate run in
 *   another browser, saw this work in the same phase (load or idle). It is
 *   matched by page and phase, never by time;
 * - direct-node: that trace named an element inside the component;
 * - inferred: the component has something that usually works in this phase
 *   (an endless animation, an autoplaying video, an iframe), with nothing
 *   tying it to the interval in time;
 * - unattributed: work the evidence cannot tie to any component, with why.
 *
 * Proximity in the DOM is never used: a global script that affects many
 * components belongs to none of them, and is listed as a script.
 */

import type { BenchmarkResult } from '../core/types.js';
import type { ComponentGraph, GraphFinding, GraphInstance } from '../model/graph.js';
import { resourceIdentity } from '../model/graph.js';
import { pageKey } from '../collect/urls.js';
import type { EnergyTimeline } from './timeline.js';
import type { SpikeInterval, SpikeReport } from './spikes.js';
import type { GeckoEvidence } from './gecko-evidence.js';

export type LeadClass =
  | 'observed-window'
  | 'profiler-correlation'
  | 'resource-association'
  | 'cross-run-trace'
  | 'direct-node'
  | 'inferred'
  | 'unattributed';

/** Strongest first: same run and time, then another run's trace, then structure alone. */
export const LEAD_CLASS_ORDER: LeadClass[] = ['profiler-correlation', 'direct-node', 'cross-run-trace', 'resource-association', 'inferred'];

export interface LeadEvidence {
  class: LeadClass;
  source: 'same-run-gecko' | 'chromium-trace' | 'firefox-dom' | 'component-graph' | 'lighthouse';
  detail: string;
}

export interface ExperimentOption {
  kind: 'remove' | 'remove-before-load' | 'hide' | 'pause-animations' | 'block' | 'no-autoplay' | 'reduced-motion';
  available: boolean;
  why: string;
}

export interface ComponentLead {
  instance: string;
  type: string;
  signature: string;
  selector: string;
  page: string;
  /** Pages and families the component's type is on, in this scan. */
  reach: { pages: number; families: number };
  /** Scripts and other resources the component loads (graph keys). */
  scripts: string[];
  resources: string[];
  evidence: LeadEvidence[];
  /** The classes above, strongest first. */
  classes: LeadClass[];
  /** Lighthouse findings on the component or what it loads, by title. */
  lighthouse: string[];
  /** When a screenshot was taken: how many elements the selector matched then. One is unambiguous. */
  selectorMatches?: number;
  experiments: ExperimentOption[];
}

export interface ScriptLead {
  url: string;
  /** The page's own document: an inline script, or an event handler in its HTML. */
  inline?: boolean;
  /** The graph resource, when Firefox recorded the file on this page. */
  resource?: string;
  /** Components that load it; empty for a script loaded from the head or by another script. */
  loadedBy: string[];
  functions: { name?: string; line?: number; samples: number }[];
  evidence: LeadEvidence[];
}

export interface SpikeLead {
  spike: string;
  /** What was measured, in words. */
  observed: string;
  /** Browser activity during the interval (same-run markers), in words. Not tied to components. */
  activity: string[];
  components: ComponentLead[];
  scripts: ScriptLead[];
  unattributed: { what: string; reason: string }[];
  caveats: string[];
}

export interface TimelineAnalysis {
  timeline: EnergyTimeline;
  spikes: SpikeReport;
  /** Same-run Gecko evidence per interval id, when the profile was read. */
  evidence?: Record<string, GeckoEvidence>;
  /** Leads per interval id, once the result's graph (and traces) are known. */
  leads?: Record<string, SpikeLead>;
  /** The page the timeline is of, when it is one page. */
  page?: string;
  /** Per selector, how many elements matched when the page was captured. */
  selectorMatches?: Record<string, number>;
  /**
   * Per interval id: energy read by each kind of Firefox process (page, browser,
   * gpu, other). Measured, since each process has its own counter; only on
   * per-process counters (Apple Silicon), never apportioned.
   */
  processEnergy?: Record<string, { role: string; energyJ: number; counters: number }[]>;
}

const IDLE_TRACE = new Set(['trace:continuous-animation-frames', 'trace:repeating-timer', 'trace:running-animation', 'trace:iframe-idle-work', 'trace:idle-main-thread-work', 'trace:idle-request']);
const LOAD_TRACE = new Set(['trace:long-task', 'trace:forced-layout']);
const IDLE_DOM = new Set(['endless-animation', 'autoplay-video', 'iframe']);

const fmtW = (w: number) => (w >= 1 ? `${w.toFixed(2)} W` : `${(w * 1000).toFixed(0)} mW`);
const fmtJ = (j: number) => (j >= 1 ? `${j.toFixed(2)} J` : `${(j * 1000).toFixed(1)} mJ`);

export const PROCESS_LABEL: Record<string, string> = {
  page: 'the page (web content)',
  browser: 'Firefox itself (parent process)',
  gpu: 'GPU process',
  other: 'other Firefox processes',
  unknown: 'an undescribed process',
};

export function describeInterval(i: SpikeInterval): string {
  return (
    `${(i.durationMs / 1000).toFixed(2)} s (${i.shape === 'sustained' ? 'sustained' : 'a brief peak'}) from ${(i.startMs / 1000).toFixed(2)} s, ` +
    `during ${i.phases.join(', ')}${i.flags.includes('warmup') ? ' of the warm-up run' : ''}: up to ${fmtW(i.peakPowerW)}${i.peakAtMs !== undefined ? ` (at ${(i.peakAtMs / 1000).toFixed(2)} s)` : ''}, ${fmtW(i.meanPowerW)} on average, against a reference of ${fmtW(i.referenceW)}; ` +
    `${fmtJ(i.energyJ)} measured in it, ${fmtJ(i.excessEnergyJ)} above the reference.`
  );
}

/** What each experiment kind can do for a component, given what it holds. */
export function experimentOptions(inst: GraphInstance, scripts: string[], thirdPartyHosts: string[]): ExperimentOption[] {
  const sel = inst.selector;
  const structural = /^(html|body|head)$/i.test(inst.tag ?? '') || /^(html|body|head)$/i.test(sel.trim());
  const usable = !!sel && !structural;
  return [
    { kind: 'remove', available: usable, why: usable ? 'Detach it after load and measure the idle window.' : 'Its selector names the document itself.' },
    { kind: 'remove-before-load', available: usable, why: usable ? 'Remove it from the markup and measure load and idle.' : 'Its selector names the document itself.' },
    { kind: 'hide', available: usable, why: usable ? 'Stop rendering it (display: none); its markup and scripts stay.' : 'Its selector names the document itself.' },
    { kind: 'pause-animations', available: !!inst.own.animations || !!inst.own.infiniteAnimations, why: inst.own.animations || inst.own.infiniteAnimations ? 'It runs CSS animations.' : 'No CSS animation was recorded in it.' },
    { kind: 'block', available: scripts.length > 0 || thirdPartyHosts.length > 0, why: scripts.length || thirdPartyHosts.length ? 'Refuse the scripts or hosts it loads (an upper bound).' : 'It loads no script of its own.' },
    { kind: 'no-autoplay', available: !!inst.own.autoplayVideos, why: inst.own.autoplayVideos ? 'It holds a video that plays on load.' : 'No autoplaying video.' },
  ];
}

function pageIdOf(graph: ComponentGraph, url: string): string | undefined {
  const k = pageKey(url, { queryStrategy: 'keep' });
  return graph.pages.find((p) => pageKey(p.url, { queryStrategy: 'keep' }) === k)?.id;
}

/**
 * Leads for each interval of a page's timeline, from the result's graph and
 * traces and the interval's same-run evidence.
 */
export function linkSpikes(result: BenchmarkResult, analysis: TimelineAnalysis, pageUrl: string): Record<string, SpikeLead> {
  const graph = result.graph;
  const out: Record<string, SpikeLead> = {};
  const pid = graph ? pageIdOf(graph, pageUrl) : undefined;
  const instances = new Map((graph?.instances ?? []).map((i) => [i.id, i]));
  const types = new Map((graph?.types ?? []).map((t) => [t.id, t]));
  const resources = new Map((graph?.resources ?? []).map((r) => [r.id, r]));
  const byKey = new Map((graph?.resources ?? []).map((r) => [r.key, r]));
  const pageResources = new Set(graph?.pages.find((p) => p.id === pid)?.resources ?? []);
  const pageFindings = (graph?.findings ?? []).filter((f) => f.page === pid);
  const lighthouseOn = (id: string) => pageFindings.filter((f) => f.kind.startsWith('lighthouse:') && f.target.id === id).map((f) => f.title);
  const hasTrace = (result.traces ?? []).some((t) => t.analysis && pageKey(t.url, { queryStrategy: 'keep' }) === pageKey(pageUrl, { queryStrategy: 'keep' }));

  for (const i of analysis.spikes.intervals) {
    const ev = analysis.evidence?.[i.id];
    const comps = new Map<string, LeadEvidence[]>();
    const scripts = new Map<string, ScriptLead>();
    const unattributed: SpikeLead['unattributed'] = [];
    const addComp = (id: string, e: LeadEvidence) => comps.set(id, [...(comps.get(id) ?? []), e]);
    const resourceFor = (url: string) => {
      const r = byKey.get(resourceIdentity(url, 'script')) ?? byKey.get(resourceIdentity(url));
      return r && pageResources.has(r.id) ? r : undefined;
    };
    const onPage = (ids: string[]) => ids.filter((id) => instances.get(id)?.page === pid);

    // Same run: scripts on the stack and requests on the network during the interval.
    const sansHash = (u: string) => u.replace(/#.*$/, '');
    for (const s of ev?.scripts ?? []) {
      // Firefox's own processes do not run the page's scripts: an http(s) script there is not the page's.
      if (s.process && s.process !== 'page' && s.process !== 'unknown') {
        unattributed.push({ what: s.url, reason: `On the stack in Firefox’s ${s.process} process, not the page’s.` });
        continue;
      }
      if (sansHash(s.url) === sansHash(pageUrl)) {
        // The document itself: an inline script or an event handler attribute. No component owns it.
        const lead: ScriptLead = scripts.get('inline') ?? { url: s.url, inline: true, loadedBy: [], functions: [], evidence: [{ class: 'profiler-correlation', source: 'same-run-gecko', detail: 'Inline script in the page’s HTML, on the stack during the interval.' }] };
        lead.functions.push({ ...(s.functionName ? { name: s.functionName } : {}), ...(s.line !== undefined ? { line: s.line } : {}), samples: s.samples });
        scripts.set('inline', lead);
        continue;
      }
      const r = resourceFor(s.url);
      // One lead per resource: the same script named by the profile and by the trace is one script.
      const k = r?.id ?? s.url;
      const lead: ScriptLead = scripts.get(k) ?? { url: s.url, ...(r ? { resource: r.id } : {}), loadedBy: r ? onPage(r.loadedBy) : [], functions: [], evidence: [] };
      lead.functions.push({ ...(s.functionName ? { name: s.functionName } : {}), ...(s.line !== undefined ? { line: s.line } : {}), samples: s.samples });
      if (!lead.evidence.length) lead.evidence.push({ class: 'profiler-correlation', source: 'same-run-gecko', detail: `On the stack in this run’s samples during the interval.` });
      scripts.set(k, lead);
      if (!r) unattributed.push({ what: s.url, reason: 'Not among the resources Firefox recorded for this page: inline, evaluated, or loaded by another frame.' });
      for (const c of lead.loadedBy) {
        addComp(c, { class: 'profiler-correlation', source: 'same-run-gecko', detail: `Its script ${s.url.split('/').pop()}${s.functionName ? ` (${s.functionName})` : ''} was on the stack in ${s.samples} sample${s.samples === 1 ? '' : 's'} during the interval.` });
        addComp(c, { class: 'resource-association', source: 'component-graph', detail: `It loads ${s.url.split('/').pop()}.` });
      }
    }
    const notThePage: string[] = [];
    for (const q of ev?.requests ?? []) {
      const r = byKey.get(resourceIdentity(q.url));
      const mine = !!r && pageResources.has(r.id);
      if (!mine && graph && sansHash(q.url) !== sansHash(pageUrl)) notThePage.push(q.url);
      for (const c of mine ? onPage(r!.loadedBy) : []) {
        addComp(c, { class: 'profiler-correlation', source: 'same-run-gecko', detail: `A request it makes (${q.url.split('/').pop()}) was on the network during the interval.` });
      }
    }
    const hostsOf = (urls: string[]) => [...new Set(urls.map((u) => { try { return new URL(u).host; } catch { return u.slice(0, 60); } }))];
    if (notThePage.length) {
      unattributed.push({
        what: `Requests that are not the page’s: ${hostsOf(notThePage).slice(0, 5).join(', ')}`,
        reason: 'Not among the resources Firefox recorded for this page: Firefox’s own background requests (updates, remote settings, telemetry), or another document’s.',
      });
    }

    // Another run, another browser: the trace's findings for the same phase of the same page.
    const phases = new Set(i.phases);
    const traceKinds = new Set([...(phases.has('idle') ? IDLE_TRACE : []), ...(phases.has('loading') || phases.has('stabilizing') ? LOAD_TRACE : [])]);
    for (const f of pageFindings.filter((x) => traceKinds.has(x.kind))) {
      const detail = `Chromium trace, separate run (${f.title}): ${f.evidence[0]?.detail ?? ''}`.trim();
      if (f.target.type === 'instance' && f.target.id) addComp(f.target.id, { class: 'cross-run-trace', source: 'chromium-trace', detail });
      else if (f.target.type === 'resource' && f.target.id) {
        const r = resources.get(f.target.id);
        if (r) {
          // A graph resource keeps host and path; the page's origin (with its port) makes it a URL again.
          const page = new URL(pageUrl);
          const path = r.key.slice(r.host.length);
          const url = `${page.protocol}//${r.host === page.hostname ? page.host : r.host}${path}`;
          const lead: ScriptLead = scripts.get(r.id) ?? { url, resource: r.id, loadedBy: onPage(r.loadedBy), functions: [], evidence: [] };
          lead.evidence.push({ class: 'cross-run-trace', source: 'chromium-trace', detail });
          scripts.set(r.id, lead);
          for (const c of lead.loadedBy) addComp(c, { class: 'cross-run-trace', source: 'chromium-trace', detail: `Through the script it loads: ${detail}` });
        }
      } else if (f.target.type === 'unattributed') unattributed.push({ what: `${f.title} (Chromium trace)`, reason: f.target.reason ?? 'The trace names no element or script.' });
    }

    // Structure: things that usually work in this phase, with nothing tying them to it in time.
    if (phases.has('idle')) {
      for (const f of pageFindings.filter((x) => IDLE_DOM.has(x.kind) && x.target.type === 'instance' && x.target.id)) {
        addComp(f.target.id!, { class: 'inferred', source: 'firefox-dom', detail: `${f.title} (${f.evidence[0]?.detail ?? ''}): consistent with idle work, not tied to this interval.` });
      }
    }

    const components: ComponentLead[] = [...comps].flatMap(([id, evidence]) => {
      const inst = instances.get(id);
      if (!inst) return [];
      const type = types.get(inst.type);
      const loads = inst.resources.map((r) => resources.get(r)).filter((r): r is NonNullable<typeof r> => !!r);
      const scriptKeys = loads.filter((r) => r.kind === 'script').map((r) => r.key);
      const classes = LEAD_CLASS_ORDER.filter((c) => evidence.some((e) => e.class === c));
      const thirdParty = [...new Set(loads.filter((r) => r.thirdParty).map((r) => r.host))];
      return [{
        instance: id,
        type: inst.type,
        signature: type?.signature ?? inst.selector,
        selector: inst.selector,
        page: pageUrl,
        reach: { pages: type?.pages ?? 1, families: type?.families.length ?? 0 },
        scripts: scriptKeys,
        resources: loads.filter((r) => r.kind !== 'script').map((r) => r.key).slice(0, 10),
        evidence: dedupe(evidence),
        classes,
        lighthouse: [...new Set([...lighthouseOn(id), ...loads.flatMap((r) => lighthouseOn(r.id))])].slice(0, 5),
        ...(analysis.selectorMatches?.[inst.selector] !== undefined ? { selectorMatches: analysis.selectorMatches[inst.selector] } : {}),
        experiments: experimentOptions(inst, scriptKeys, thirdParty),
      }];
    });
    components.sort((a, b) => rankOf(a.classes) - rankOf(b.classes) || b.evidence.length - a.evidence.length || (a.instance < b.instance ? -1 : 1));

    const activity = (ev?.activity ?? [])
      .filter((a) => a.kind !== 'other')
      .map((a) => `${a.process ? `${PROCESS_LABEL[a.process] ?? a.process}: ` : ''}${a.kind.replace(/-/g, ' ')}, ${a.count} marker${a.count === 1 ? '' : 's'} covering ${a.ms} ms${a.names.length ? ` (${a.names.slice(0, 3).join(', ')})` : ''}`);
    const browserWork = (ev?.activity ?? []).filter((a) => a.process === 'browser' && ['script', 'network', 'dom-event'].includes(a.kind) && a.ms > 0);
    const split = analysis.processEnergy?.[i.id];
    const splitText = split?.length
      ? ` By process (each has its own counter): ${split.map((p) => `${PROCESS_LABEL[p.role as keyof typeof PROCESS_LABEL] ?? p.role} ${fmtJ(p.energyJ)}`).join(', ')}.`
      : '';
    if (ev?.activity.some((a) => ['style', 'layout', 'paint', 'composite', 'garbage-collection'].includes(a.kind))) {
      unattributed.push({ what: 'Style, layout, paint and garbage collection', reason: 'Firefox’s markers for this work do not name the elements or scripts that caused it.' });
    }
    if (!ev) unattributed.push({ what: 'Everything in the interval', reason: 'This run’s profile was not read for evidence (only the power counters were): run diagnose for markers and script stacks.' });
    if (!components.length && !scripts.size) unattributed.push({ what: 'The interval as a whole', reason: graph ? 'Nothing in the profile, the trace or the page structure ties it to a component.' : 'No component graph: the page’s structure was not recorded.' });

    out[i.id] = {
      spike: i.id,
      observed: `${describeInterval(i)}${splitText}`,
      activity,
      components: components.slice(0, 12),
      scripts: [...scripts.values()].slice(0, 12),
      unattributed: dedupeBy(unattributed, (u) => u.what),
      caveats: [
        'A lead was active, or loaded something that was, around a time of higher power. That is a reason to test it with an experiment, not a measurement of its energy.',
        ...(hasTrace ? ['Chromium trace evidence comes from a separate run in another browser, matched by page and phase (load or idle), never by time.'] : []),
        ...(i.flags.includes('machine-wide-scope') ? ['These counters cover the whole machine: work in other processes shows in the interval too.'] : []),
        ...(i.flags.includes('outside-measured-steps') ? ['Part of the interval falls between measured steps (setup, a checkpoint, settling).'] : []),
        ...(i.flags.includes('warmup') ? ['This interval is in a warm-up run, with a colder cache than the measured run: compare it with the measured run’s intervals before acting on it.'] : []),
        ...(browserWork.length || notThePage.length
          ? [`Firefox’s own work ran during this interval (${[...browserWork.map((a) => `${a.kind.replace(/-/g, ' ')} in the parent process`), ...(notThePage.length ? [`requests to ${hostsOf(notThePage).slice(0, 3).join(', ')}`] : [])].join('; ')}): part of its energy may be the browser’s, not the page’s.`]
          : []),
      ],
    };
  }
  return out;
}

const rankOf = (classes: LeadClass[]) => (classes.length ? LEAD_CLASS_ORDER.indexOf(classes[0]!) : LEAD_CLASS_ORDER.length);

function dedupe(es: LeadEvidence[]): LeadEvidence[] {
  return dedupeBy(es, (e) => `${e.class}|${e.detail}`);
}
function dedupeBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
}

export type { GraphFinding };
