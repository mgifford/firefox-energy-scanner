/**
 * The energy timeline, its intervals, and the components worth testing, in
 * the static report. No script: the chart is SVG with native tooltips and
 * links, and every value it draws is also in a table. Intervals are where to
 * look; leads are what to test; neither is an energy figure for a component.
 */

import type { BenchmarkResult } from '../core/types.js';
import { PROCESS_LABEL, type ComponentLead, type ExperimentOption, type SpikeLead, type TimelineAnalysis } from '../energy/spike-analysis.js';
import type { SpikeInterval } from '../energy/spikes.js';
import type { GeckoEvidence } from '../energy/gecko-evidence.js';
import type { TimelinePhase } from '../energy/timeline.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const sec = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const watts = (w: number | null | undefined) => (w === null || w === undefined ? '—' : w >= 1 ? `${w.toFixed(2)} W` : `${(w * 1000).toFixed(0)} mW`);
const joules = (j: number | null | undefined) => (j === null || j === undefined ? '—' : j >= 1 ? `${j.toFixed(3)} J` : `${(j * 1000).toFixed(1)} mJ`);
const sq = (s: string) => (/^[\w./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const PHASE_LABEL: Record<TimelinePhase['kind'], string> = {
  baseline: 'idle baseline',
  loading: 'loading',
  stabilizing: 'settling',
  idle: 'idle',
  interaction: 'interaction',
  unmeasured: 'between steps',
};

/** Styles for this section, in the report's own light and dark tokens. */
export const TIMELINE_CSS = `
  .viz, .shot { --series-1:#2a78d6; --band:#ececea; --band-2:#f5f5f3; --spike:#eb6834; --spike-fill:color-mix(in srgb, #eb6834 14%, transparent); --axis:#d0d0d0; }
  @media (prefers-color-scheme: dark) { .viz, .shot { --series-1:#3987e5; --band:#262625; --band-2:#1f1f1e; --spike:#d95926; --spike-fill:color-mix(in srgb, #d95926 15%, transparent); --axis:#3a3a3a; } }
  .viz svg { display:block; max-width:100%; height:auto; font: 11px system-ui, sans-serif; }
  .viz .line { fill:none; stroke:var(--series-1); stroke-width:2; stroke-linejoin:round; stroke-linecap:round; }
  .viz .grid line, .viz .axis line { stroke:var(--axis); stroke-width:1; }
  .viz .ref { stroke:var(--muted); stroke-width:1; }
  .viz text { fill:var(--muted); }
  .viz text.phase { fill:var(--fg); }
  .viz .band-a { fill:var(--band); } .viz .band-b { fill:var(--band-2); }
  .viz .spike rect { fill:var(--spike-fill); stroke:var(--spike); stroke-width:2; }
  .viz .spike text { fill:var(--fg); font-weight:600; }
  .viz a.spike:focus-visible rect { stroke:var(--accent); stroke-width:3; }
  .viz .hit { fill:transparent; }
  .viz .hit:hover { fill:color-mix(in srgb, var(--fg) 8%, transparent); }
  .shot svg { display:block; max-width:100%; height:auto; border:1px solid var(--line); }
  .shot .outline { fill:none; stroke:var(--spike); stroke-width:4; }
  .shot .outline-ring { fill:none; stroke:var(--bg); stroke-width:8; }
  .lead-table td, .lead-table th { vertical-align: top; }
  pre.cmd { overflow-x:auto; padding:.5rem .75rem; border:1px solid var(--line); }
  @media (forced-colors: active) {
    .viz .line { stroke:CanvasText; } .viz .spike rect, .shot .outline { stroke:Highlight; fill:none; }
    .viz .band-a, .viz .band-b { fill:Canvas; stroke:GrayText; } .viz text { fill:CanvasText; }
  }
`;

const W = 960;
const H = 260;
const PAD = { left: 56, right: 12, top: 26, bottom: 34 };

/** The chart: phases as bands, power as a stepped line, intervals as numbered links. */
function chart(a: TimelineAnalysis, n: number): string {
  const t = a.timeline;
  const powered = t.bins.filter((b) => b.averagePowerW !== null);
  if (!powered.length) return '';
  const maxW = Math.max(...powered.map((b) => b.averagePowerW!), a.spikes.reference.powerW) * 1.1 || 1;
  const pw = W - PAD.left - PAD.right;
  const ph = H - PAD.top - PAD.bottom;
  const x = (ms: number) => PAD.left + (ms / Math.max(1, t.durationMs)) * pw;
  const y = (w: number) => PAD.top + ph - (w / maxW) * ph;
  const r = (v: number) => Math.round(v * 10) / 10;

  const bands = t.phases
    .map((p, i) => `<rect class="${i % 2 ? 'band-b' : 'band-a'}" x="${r(x(p.startMs))}" y="${PAD.top}" width="${r(Math.max(1, x(p.endMs) - x(p.startMs)))}" height="${ph}"></rect>`)
    .join('');
  // Phase names above the plot, skipped where they would overlap.
  let lastEnd = -Infinity;
  const phaseLabels = t.phases
    .map((p) => {
      const label = `${PHASE_LABEL[p.kind]}${p.warmup ? ' (warm-up)' : ''}`;
      const at = x(p.startMs) + 2;
      if (at < lastEnd + 4 || x(p.endMs) - x(p.startMs) < label.length * 5.5) return '';
      lastEnd = at + label.length * 6;
      return `<text class="phase" x="${r(at)}" y="${PAD.top - 8}">${esc(label)}</text>`;
    })
    .join('');

  // A stepped line, broken where a bin has no power.
  const segments: string[] = [];
  let current: string[] = [];
  for (const b of t.bins) {
    if (b.averagePowerW === null) {
      if (current.length) segments.push(current.join(' '));
      current = [];
      continue;
    }
    current.push(`${r(x(b.startMs))},${r(y(b.averagePowerW))}`, `${r(x(b.endMs))},${r(y(b.averagePowerW))}`);
  }
  if (current.length) segments.push(current.join(' '));

  const ticks = [0, maxW / 3, (2 * maxW) / 3, maxW];
  const grid = ticks.map((w) => `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${r(y(w))}" y2="${r(y(w))}"></line>`).join('');
  const yLabels = ticks.map((w) => `<text x="${PAD.left - 6}" y="${r(y(w)) + 4}" text-anchor="end">${esc(watts(w))}</text>`).join('');
  const step = t.durationMs > 30_000 ? 10_000 : t.durationMs > 10_000 ? 5_000 : 1_000;
  const xLabels = Array.from({ length: Math.floor(t.durationMs / step) + 1 }, (_, i) => i * step)
    .map((ms) => `<text x="${r(x(ms))}" y="${H - PAD.bottom + 16}" text-anchor="middle">${ms / 1000} s</text>`)
    .join('');
  const ref = a.spikes.reference.powerW;
  const hits = t.bins
    .map((b) => {
      const p = b.phase !== undefined ? t.phases[b.phase] : undefined;
      return `<rect class="hit" x="${r(x(b.startMs))}" y="${PAD.top}" width="${r(Math.max(1, x(b.endMs) - x(b.startMs)))}" height="${ph}"><title>${esc(`${sec(b.startMs)}–${sec(b.endMs)}: ${watts(b.averagePowerW)}${b.energyJ === null ? ', no sample' : ''}, ${p ? PHASE_LABEL[p.kind] : 'between steps'}`)}</title></rect>`;
    })
    .join('');
  const spikes = a.spikes.intervals
    .slice(0, 12)
    .map(
      (i) => `<a class="spike" href="#${esc(spikeAnchor(n, i.id))}" aria-label="${esc(`Interval ${i.rank}: ${sec(i.startMs)} to ${sec(i.endMs)}, up to ${watts(i.peakPowerW)}, ${i.shape === 'sustained' ? 'sustained' : 'brief peak'}`)}">
        <rect x="${r(x(i.startMs))}" y="${PAD.top}" width="${r(Math.max(3, x(i.endMs) - x(i.startMs)))}" height="${ph}"></rect>
        <text x="${r(x(i.startMs)) + 3}" y="${PAD.top + 13}">${i.rank}</text><title>${esc(`Interval ${i.rank}: ${sec(i.startMs)}–${sec(i.endMs)}, peak ${watts(i.peakPowerW)}`)}</title></a>`,
    )
    .join('');
  const id = `tl-chart-${n}`;
  return `<figure class="viz" aria-labelledby="${id}">
    <svg role="group" aria-labelledby="${id}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <g aria-hidden="true">${bands}${phaseLabels}<g class="grid">${grid}</g>${yLabels}${xLabels}
        <line class="ref" x1="${PAD.left}" x2="${W - PAD.right}" y1="${r(y(ref))}" y2="${r(y(ref))}"></line>
        <text x="${W - PAD.right - 4}" y="${r(y(ref)) - 4}" text-anchor="end">reference ${esc(watts(ref))}</text>
        ${segments.map((p) => `<polyline class="line" points="${p}"></polyline>`).join('')}
        <g>${hits}</g></g>
      ${spikes}
    </svg>
    <figcaption id="${id}">Average power per ${t.binMs} ms bin (${esc(t.scope === 'process' ? 'Firefox’s processes' : t.scope === 'cpu-package' ? 'the whole CPU package' : 'the whole platform')}), over time, with the measured steps behind it and numbered intervals of elevated power. Gaps are bins without a power value. The tables below give the same values.</figcaption>
  </figure>`;
}

const spikeAnchor = (n: number, id: string) => `tl${n}-${id}`;

function phaseTable(a: TimelineAnalysis, n: number): string {
  const t = a.timeline;
  const rows = t.phases
    .map((p, k) => {
      const bins = t.bins.filter((b) => b.phase === k);
      const withEnergy = bins.filter((b) => b.energyJ !== null);
      const energy = withEnergy.length ? withEnergy.reduce((s, b) => s + b.energyJ!, 0) : null;
      const span = (p.endMs - p.startMs) / 1000;
      return `<tr><th scope="row">${esc(PHASE_LABEL[p.kind])}${p.warmup ? ' (warm-up)' : ''}</th><td class="text"><code>${esc(p.label)}</code></td><td>${sec(p.startMs)}</td><td>${sec(p.endMs)}</td><td>${joules(energy)}</td><td>${energy !== null && span > 0 ? watts(energy / span) : '—'}</td><td>${bins.reduce((s, b) => s + b.samples, 0)}</td></tr>`;
    })
    .join('');
  return `<div class="scroll"><table id="tl${n}-phases">
    <caption>Measured steps on the timeline (energy is the whole measurement scope’s; — means not measured)</caption>
    <thead><tr><th scope="col">Phase</th><th scope="col" class="text">Step</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Energy read</th><th scope="col">Average power</th><th scope="col">Samples</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function intervalTable(a: TimelineAnalysis, n: number): string {
  const s = a.spikes;
  if (!s.intervals.length) return '<p>No interval of elevated power was found with these settings. That is not a finding that the page does no work: see the settings and warnings above.</p>';
  const rows = s.intervals
    .map(
      (i) => `<tr><th scope="row"><a href="#${esc(spikeAnchor(n, i.id))}">${i.rank}</a></th><td>${sec(i.startMs)}–${sec(i.endMs)}</td><td>${sec(i.durationMs)}</td><td class="text">${i.shape === 'sustained' ? 'sustained' : 'brief peak'}</td>
      <td>${watts(i.peakPowerW)}</td><td>${watts(i.meanPowerW)}</td><td>${joules(i.energyJ)}</td><td>${joules(i.excessEnergyJ)}</td><td class="text">${esc(i.phases.map((p) => PHASE_LABEL[p as TimelinePhase['kind']] ?? p).join(', '))}</td><td class="text">${esc(i.flags.join(', ') || '—')}</td></tr>`,
    )
    .join('');
  return `<div class="scroll"><table>
    <caption>Intervals of elevated power, by energy above the reference (where to look, not defects)</caption>
    <thead><tr><th scope="col">Rank</th><th scope="col">When</th><th scope="col">Length</th><th scope="col" class="text">Shape</th><th scope="col">Peak</th><th scope="col">Mean</th><th scope="col">Energy read</th><th scope="col">Above reference</th><th scope="col" class="text">During</th><th scope="col" class="text">Flags</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function binTable(a: TimelineAnalysis): string {
  const t = a.timeline;
  const shown = t.bins.slice(0, 600);
  const rows = shown
    .map((b) => {
      const p = b.phase !== undefined ? t.phases[b.phase] : undefined;
      return `<tr><td>${sec(b.startMs)}–${sec(b.endMs)}</td><td>${b.samples}</td><td>${joules(b.energyJ)}</td><td>${watts(b.averagePowerW)}</td><td class="text">${esc(p ? PHASE_LABEL[p.kind] : 'between steps')}</td><td class="text">${esc((b.flags ?? []).join(', '))}</td></tr>`;
    })
    .join('');
  return `<details><summary>Every bin (${t.bins.length}${t.bins.length > shown.length ? `, the first ${shown.length} shown; the timeline CSV has all` : ''})</summary>
    <div class="scroll"><table><caption>Energy and power per ${t.binMs} ms bin; — is not measured, never zero</caption>
    <thead><tr><th scope="col">Bin</th><th scope="col">Samples</th><th scope="col">Energy</th><th scope="col">Power</th><th scope="col" class="text">Phase</th><th scope="col" class="text">Flags</th></tr></thead>
    <tbody>${rows}</tbody></table></div></details>`;
}

function geckoBlock(e: GeckoEvidence | undefined): string {
  if (!e) return '<p class="note">This run’s profile was not read for evidence (only its power counters). Run <code>diagnose</code> for markers and script stacks.</p>';
  const acts = e.activity.filter((x) => x.kind !== 'other');
  return `<h5>Same run: what Firefox’s profile shows during the interval</h5>
    ${acts.length ? `<div class="scroll"><table><caption>Markers during the interval, by the process that recorded them (covered time counts overlaps once)</caption>
      <thead><tr><th scope="col" class="text">Process</th><th scope="col" class="text">Activity</th><th scope="col">Markers</th><th scope="col">Covered ms</th><th scope="col" class="text">Examples</th></tr></thead>
      <tbody>${acts.map((x) => `<tr><td class="text">${esc(x.process ? (PROCESS_LABEL[x.process] ?? x.process) : '—')}</td><th scope="row" class="text">${esc(x.kind.replace(/-/g, ' '))}</th><td>${x.count}</td><td>${x.ms}</td><td class="text"><span class="note">${esc(x.names.slice(0, 3).join(', '))}</span></td></tr>`).join('')}</tbody></table></div>` : ''}
    ${e.scripts.length ? `<p><strong>Scripts on the stack:</strong></p><ul>${e.scripts.slice(0, 6).map((s) => `<li><code>${esc(s.url)}</code>${s.functionName ? ` <code>${esc(s.functionName)}</code>` : ''}${s.line !== undefined ? ` line ${s.line}` : ''}: ${s.samples} sample${s.samples === 1 ? '' : 's'}</li>`).join('')}</ul>` : ''}
    ${e.categories.length ? `<div class="scroll"><table><caption>CPU time by category in the interval, and over the whole run (${esc(e.categoryBasis ?? '')}; apportioning energy by it is a model, not a measurement)</caption><thead><tr><th scope="col">Category</th><th scope="col">CPU ms</th><th scope="col">Share here</th><th scope="col">Share over the run</th></tr></thead><tbody>${e.categories.slice(0, 8).map((c) => `<tr><th scope="row">${esc(c.category)}</th><td>${c.cpuMs}</td><td>${Math.round(c.share * 100)}%</td><td>${c.sessionShare !== undefined ? `${Math.round(c.sessionShare * 100)}%` : '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${e.notes.length ? `<ul class="note">${e.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
}

/** The CLI command for one kind of experiment on one component. Nothing runs from the report. */
export function commandFor(kind: ExperimentOption['kind'], c: ComponentLead, evidenceFile?: string): string {
  const base = ['web-energy', 'experiment', sq(c.page), '--kind', kind];
  if (kind === 'block') {
    // Graph keys are host and path; the page's origin (scheme and port) makes a same-host key a URL again.
    let page: URL | undefined;
    try {
      page = new URL(c.page);
    } catch {
      page = undefined;
    }
    for (const s of c.scripts.slice(0, 5)) {
      const host = s.split('/')[0]!;
      const url = page && host === page.hostname ? `${page.origin}${s.slice(host.length)}` : `${page?.protocol ?? 'https:'}//${s}`;
      base.push('--block-url', sq(url));
    }
  } else if (kind !== 'reduced-motion' && kind !== 'no-autoplay') base.push('--selector', sq(c.selector));
  base.push('--idle', '10000', '--runs', '10', '--warmups', '2', '--assert-role', 'main');
  if (evidenceFile) base.push('--evidence', sq(evidenceFile));
  return base.join(' ');
}

function componentRow(c: ComponentLead, verified: string): string {
  return `<tr><th scope="row" class="text"><code>${esc(c.signature)}</code></th>
    <td class="text"><code>${esc(c.selector)}</code><br><span class="note">${esc(verified)}</span></td>
    <td>${c.reach.pages} page${c.reach.pages === 1 ? '' : 's'}</td>
    <td class="text">${esc(c.classes.join(', ') || '—')}</td>
    <td class="text">${c.scripts.length ? c.scripts.slice(0, 4).map((s) => `<code>${esc(s.split('/').pop())}</code>`).join(', ') : '—'}</td>
    <td class="text"><ul>${c.evidence.slice(0, 5).map((e) => `<li>${esc(e.detail)}</li>`).join('')}</ul>${c.lighthouse.length ? `<p class="note">Lighthouse (Chromium): ${esc(c.lighthouse.join('; '))}</p>` : ''}</td></tr>`;
}

const verifiedText = (result: BenchmarkResult, c: ComponentLead): string => {
  const m = result.capture?.selectorMatches[c.selector] ?? c.selectorMatches;
  if (m === undefined) return 'Selector not checked against the captured page: not verified.';
  if (m === 1) return 'Matched one element when the page was captured.';
  if (m === -1) return 'The browser could not parse the selector: not usable.';
  return `Matched ${m} elements when the page was captured: ambiguous, not verified.`;
};

function leadBlock(result: BenchmarkResult, lead: SpikeLead | undefined, evidenceFile: string | undefined): string {
  if (!lead) return '';
  return `<h5>Leads: what to test</h5>
    ${lead.components.length ? `<div class="scroll"><table class="lead-table"><caption>Components tied to the interval, strongest evidence first</caption>
      <thead><tr><th scope="col" class="text">Component</th><th scope="col" class="text">Selector</th><th scope="col">Reach</th><th scope="col" class="text">Evidence classes</th><th scope="col" class="text">Its scripts</th><th scope="col" class="text">Evidence</th></tr></thead>
      <tbody>${lead.components.map((c) => componentRow(c, verifiedText(result, c))).join('')}</tbody></table></div>` : '<p>No component is tied to this interval.</p>'}
    ${lead.scripts.length ? `<p><strong>Scripts:</strong></p><ul>${lead.scripts.map((s) => `<li><code>${esc(s.url)}</code>${s.functions.length ? `: ${esc(s.functions.map((f) => `${f.name ?? '(anonymous)'}${f.line !== undefined ? `:${f.line}` : ''}`).join(', '))}` : ''}${s.inline ? ' <span class="note">(inline, in the page’s HTML: no component owns it)</span>' : s.loadedBy.length ? '' : ' <span class="note">(no component loads it: a page-wide script)</span>'}<br><span class="note">${esc(s.evidence.map((e) => e.class).join(', '))}</span></li>`).join('')}</ul>` : ''}
    ${lead.unattributed.length ? `<p><strong>Unattributed:</strong></p><ul>${lead.unattributed.map((u) => `<li>${esc(u.what)}: ${esc(u.reason)}</li>`).join('')}</ul>` : ''}
    <ul class="note">${lead.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
    ${lead.components.length ? experimentConfig(lead.components.slice(0, 3), evidenceFile) : ''}`;
}

/** Experiment configuration: the commands to run, per component and kind. Nothing is changed by the report. */
function experimentConfig(components: ComponentLead[], evidenceFile: string | undefined): string {
  return `<details><summary>Set up an experiment for ${components.length === 1 ? 'this component' : 'these components'}</summary>
    <p class="note">These commands run the page in an isolated test browser, with and without one change, interleaved. They change nothing on the live site. Each kind tests a different thing: <strong>hide</strong> stops rendering (markup and scripts stay), <strong>remove</strong> detaches it after load (its scripts may keep running; only the idle window can show an effect), <strong>remove-before-load</strong> takes it out of the markup (load and idle), <strong>block</strong> refuses its scripts (an upper bound).</p>
    ${components
      .map(
        (c) => `<h6><code>${esc(c.signature)}</code></h6><ul>${c.experiments
          .map((e) => `<li><strong>${esc(e.kind)}</strong>: ${esc(e.why)}${e.available ? `<pre class="cmd"><code>${esc(commandFor(e.kind, c, evidenceFile))}</code></pre>` : ' <span class="note">(not available)</span>'}</li>`)
          .join('')}</ul>`,
      )
      .join('')}
  </details>`;
}

function intervalDetails(result: BenchmarkResult, a: TimelineAnalysis, n: number, i: SpikeInterval, evidenceFile: string | undefined): string {
  const lead = a.leads?.[i.id];
  const split = a.processEnergy?.[i.id] ?? [];
  const total = split.reduce((t, p) => t + p.energyJ, 0);
  return `<section id="${esc(spikeAnchor(n, i.id))}" aria-labelledby="${esc(spikeAnchor(n, i.id))}-h" class="boundary">
    <h4 id="${esc(spikeAnchor(n, i.id))}-h">Interval ${i.rank}: ${sec(i.startMs)}–${sec(i.endMs)}${i.flags.includes('warmup') ? ' (warm-up run)' : ''}</h4>
    <p><strong>Observed (measured):</strong> ${esc(lead?.observed ?? `${sec(i.durationMs)} up to ${watts(i.peakPowerW)}`)}</p>
    ${split.length ? `<div class="scroll"><table><caption>Energy in the interval by Firefox process (each process has its own counter: measured, not apportioned)</caption>
      <thead><tr><th scope="col" class="text">Process</th><th scope="col">Energy</th><th scope="col">Share</th><th scope="col">Counters</th></tr></thead>
      <tbody>${split.map((p) => `<tr><th scope="row" class="text">${esc(PROCESS_LABEL[p.role] ?? p.role)}</th><td>${joules(p.energyJ)}</td><td>${total > 0 ? `${Math.round((p.energyJ / total) * 100)}%` : '—'}</td><td>${p.counters}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${geckoBlock(a.evidence?.[i.id])}
    ${leadBlock(result, lead, evidenceFile)}
  </section>`;
}

/** The screenshot with one component outlined, from its recorded position. */
function outlined(result: BenchmarkResult, c: ComponentLead, k: number): string {
  const shot = result.capture?.screenshot;
  const inst = result.graph?.instances.find((x) => x.id === c.instance);
  const rec = inst ? result.scenarios[inst.ref.scenario]?.anatomy?.structure?.instances?.[inst.ref.instance] : undefined;
  if (!shot || !rec?.rect) return '';
  const { x, y, width, height } = rec.rect;
  if (y > shot.height) return `<p class="note">Its recorded position (${Math.round(y)} px down) is below the captured part of the page.</p>`;
  const scale = Math.min(1, 480 / shot.width);
  const sw = Math.round(shot.width * scale);
  const sh = Math.round(shot.height * scale);
  const id = `shot-${k}`;
  return `<figure class="shot" aria-labelledby="${id}">
    <svg role="img" aria-labelledby="${id}" width="${sw}" height="${sh}" viewBox="0 0 ${shot.width} ${shot.height}">
      <image href="${esc(shot.file)}" x="0" y="0" width="${shot.width}" height="${shot.height}"></image>
      <rect class="outline-ring" x="${x}" y="${y}" width="${Math.max(4, width)}" height="${Math.max(4, Math.min(height, shot.height - y))}"></rect>
      <rect class="outline" x="${x}" y="${y}" width="${Math.max(4, width)}" height="${Math.max(4, Math.min(height, shot.height - y))}"></rect>
    </svg>
    <figcaption id="${id}">The captured page with <code>${esc(c.signature)}</code> outlined at its recorded position: ${Math.round(x)} px from the left, ${Math.round(y)} px down, ${Math.round(width)} × ${Math.round(height)} px. ${esc(verifiedText(result, c))}</figcaption>
  </figure>`;
}

/** Every component any interval names, once, with where it is and what can be tested. */
function explorer(result: BenchmarkResult, evidenceFile: string | undefined): string {
  const all = new Map<string, { c: ComponentLead; intervals: string[] }>();
  for (const a of result.timelines ?? []) {
    for (const [id, lead] of Object.entries(a.leads ?? {})) {
      for (const c of lead.components) {
        const x = all.get(c.instance) ?? { c, intervals: [] };
        x.intervals.push(id.replace('spike-', ''));
        all.set(c.instance, x);
      }
    }
  }
  if (!all.size) return '';
  const previous = result.relatedExperiments ?? [];
  const items = [...all.values()].slice(0, 12);
  return `<h3 id="explorer-h">Component explorer</h3>
  <p class="note">Components the intervals point to, with where they are on the page and what can be tested. An outline shows the position Firefox recorded; it is only treated as verified when the selector matched exactly one element when the page was captured.</p>
  ${items
    .map(({ c, intervals }, k) => {
      const prior = previous.filter((p) => p.selector === c.selector);
      return `<details${k < 3 ? ' open' : ''}><summary><code>${esc(c.signature)}</code>: interval${intervals.length === 1 ? '' : 's'} ${esc(intervals.join(', '))}; ${esc(c.classes.join(', '))}</summary>
      <dl class="meta"><dt>Selector</dt><dd><code>${esc(c.selector)}</code> (${esc(verifiedText(result, c))})</dd>
        <dt>Page</dt><dd>${/^https?:\/\//.test(c.page) ? `<a href="${esc(c.page)}">${esc(c.page)}</a>` : esc(c.page)}</dd>
        <dt>Pages sharing it</dt><dd>${c.reach.pages}${c.reach.families ? ` (${c.reach.families} famil${c.reach.families === 1 ? 'y' : 'ies'})` : ''}</dd>
        <dt>Scripts</dt><dd>${c.scripts.length ? c.scripts.map((s) => `<code>${esc(s)}</code>`).join(', ') : 'none of its own'}</dd>
        <dt>Other resources</dt><dd>${c.resources.length ? c.resources.slice(0, 5).map((s) => `<code>${esc(s)}</code>`).join(', ') : '—'}</dd>
        <dt>Lighthouse</dt><dd>${c.lighthouse.length ? esc(c.lighthouse.join('; ')) : '—'}</dd>
        <dt>Experiments available</dt><dd>${esc(c.experiments.filter((e) => e.available).map((e) => e.kind).join(', ') || 'none')}</dd>
        <dt>Previous experiments</dt><dd>${prior.length ? prior.map((p) => `${esc(p.kind)} (${esc(p.file)}): ${esc(p.status)}`).join('; ') : 'none recorded with this result'}</dd></dl>
      ${outlined(result, c, k)}
    </details>`;
    })
    .join('')}`;
}

export function timelineSection(result: BenchmarkResult): string {
  const list = result.timelines ?? [];
  if (!list.length) return '';
  const evidenceFile = result.capture?.resultFile;
  // An experiment's timelines: the first run of each side; the CSVs have them all.
  const shown = result.experiment
    ? [list.find((t) => t.timeline.scenario === 'baseline'), list.find((t) => t.timeline.scenario === 'variant')].filter((t): t is TimelineAnalysis => !!t)
    : list.slice(0, 4);
  return `<style>${TIMELINE_CSS}</style>
<section aria-labelledby="timeline-h">
  <h2 id="timeline-h">Energy timeline</h2>
  <p>When the measured power was high, and what ran then. <strong>Intervals are where to look, not defects</strong>, and the power in them is the whole measurement scope’s: Firefox has no counter for an element, a script or a component. Leads are what to test with an experiment; only an experiment measures a difference.</p>
  ${shown
    .map((a, n) => {
      const t = a.timeline;
      const s = a.spikes;
      return `<h3 id="tl${n}-h">${esc(t.scenario ? `${t.scenario}${t.run !== undefined ? `, run ${t.run + 1}` : ''}` : 'Timeline')}${a.page ? `: ${esc(a.page)}` : ''}</h3>
  <dl class="meta">
    <dt>Measured</dt><dd>${esc(t.basis)}</dd>
    <dt>Resolution</dt><dd>${t.binMs} ms bins (asked for ${t.requestedBinMs}); samples every ${t.resolution.sampleIntervalMs ?? '?'} ms, counters moving every ${t.resolution.counterUpdateMs ?? '?'} ms; ${t.resolution.supportedBinsMs.length ? `${t.resolution.supportedBinsMs.join(', ')} ms bins are supported` : 'none of 100–1000 ms is supported'}</dd>
    <dt>Samples</dt><dd>${t.samples.used} used${Object.keys(t.samples.excluded).length ? `; left out: ${esc(Object.entries(t.samples.excluded).map(([k, v]) => `${v} ${k.replace(/-/g, ' ')}`).join(', '))}` : ''}${t.gaps.length ? `; ${t.gaps.length} gap${t.gaps.length === 1 ? '' : 's'}` : ''}</dd>
    <dt>Profiler</dt><dd>${esc(t.profilerFeatures.join(', '))}${t.profilerFeatures.length > 1 ? ' (diagnostic: stack sampling adds work)' : ' (power only)'}</dd>
    <dt>Detection</dt><dd>${esc(s.statement)} Reference: ${esc(s.reference.kind.replace(/-/g, ' '))}, ${esc(watts(s.reference.powerW))} (spread ${esc(watts(s.reference.spreadW))}, from ${s.reference.bins} bins). Method <code>${esc(s.method)}</code>, k ${s.settings.k}, at least ${s.settings.minDurationMs} ms, sustained from ${s.settings.sustainedMs} ms.</dd>
  </dl>
  ${[...t.warnings, ...s.warnings].filter((w, k, arr) => arr.indexOf(w) === k).map((w) => `<p class="warning">${esc(w)}</p>`).join('')}
  ${chart(a, n)}
  ${phaseTable(a, n)}
  ${intervalTable(a, n)}
  ${binTable(a)}
  ${s.intervals.slice(0, 8).map((i) => intervalDetails(result, a, n, i, evidenceFile)).join('')}`;
    })
    .join('')}
  ${explorer(result, evidenceFile)}
</section>`;
}
