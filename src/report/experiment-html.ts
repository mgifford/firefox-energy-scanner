import type { ExperimentReport, RemovalSummary, StepDifference } from '../experiments/experiment.js';
import { describeContent } from '../experiments/dom-removal.js';
import type { EvidenceRecord } from './evidence-record.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const VERDICT: Record<StepDifference['verdict'], string> = {
  lower: 'lower with the change',
  higher: 'higher with the change',
  'within-spread': 'no difference shown (within spread)',
  'below-resolution': 'below resolution',
  'not-measured': 'not measured',
};

const kb = (b: number) => (b < 1024 ? `${Math.round(b)} B` : `${Math.round(b / 1024)} KB`);

const perRun = (xs: number[]) => (xs.length ? (new Set(xs).size === 1 ? `${xs[0]} in each run` : xs.join(', ')) : '—');
const perSecond = (n: number, ms: number) => (ms > 0 ? ((n / ms) * 1000).toFixed(1) : '—');

/** The removal: what was found and removed, whether it stayed removed, and script work after it. */
function removalBlock(r: RemovalSummary): string {
  const a = r.baseline;
  const b = r.variant;
  const act = (s: RemovalSummary['baseline']) =>
    s.activity
      ? `<td>${perSecond(s.activity.timeouts + s.activity.intervals, s.activity.ms)}</td><td>${perSecond(s.activity.animationFrames, s.activity.ms)}</td><td>${s.activity.runningAnimations[0]} → ${s.activity.runningAnimations[1]}</td>`
      : '<td>—</td><td>—</td><td>—</td>';
  const ids = b.identities.length ? b.identities : a.identities;
  const pre = r.mode === 'pre-load';
  return `<h3 id="removal-h">The removal (${pre ? 'before the page is parsed' : 'after the page loaded'})</h3>
  <p><strong>Selector:</strong> <code>${esc(r.selector)}</code> (at most ${r.maxMatches} matches). <strong>When:</strong> ${esc(r.checkpoint)}</p>
  ${r.snapshot ? `<p class="note">The document as fetched: ${kb(r.snapshot.originalBytes)}; as served, after the browser’s parser and serialiser: ${kb(r.snapshot.servedBytes[0])} on the baseline, ${kb(r.snapshot.servedBytes[1])} with the change.</p>` : ''}
  ${b.refused ? `<p class="warning"><strong>Refused:</strong> ${esc(b.refused)} Nothing was removed, and no difference is reported.</p>` : ''}
  <div class="scroll"><table>
    <caption>What the selector found, and what happened to it, per side</caption>
    <thead><tr><th scope="col">Side</th><th scope="col">${pre ? 'Matched in the markup' : 'Matched at checkpoint'}</th><th scope="col">Subtrees removed</th><th scope="col">Left right after</th><th scope="col">Matching after idle</th><th scope="col">${pre ? 'Insertions seen (the parser’s, on the baseline)' : 'Re-insertions seen'}</th></tr></thead>
    <tbody>
      <tr><th scope="row">Baseline</th><td>${perRun(a.matched)}</td><td>${perRun(a.removed)}</td><td>${perRun(a.remaining)}</td><td>${perRun(a.matchesAfterIdle)}</td><td>${perRun(a.reinsertions)}</td></tr>
      <tr><th scope="row">Variant</th><td>${perRun(b.matched)}</td><td>${perRun(b.removed)}</td><td>${perRun(b.remaining)}</td><td>${perRun(b.matchesAfterIdle)}</td><td>${perRun(b.reinsertions)}</td></tr>
    </tbody></table></div>
  ${b.nested ? `<p class="note">${b.nested} match${b.nested === 1 ? '' : 'es'} sat inside another match: removed with it, counted once.</p>` : ''}
  ${b.content ? `<p><strong>The removed subtrees held:</strong> ${esc(describeContent(b.content))}.</p>` : a.content ? `<p><strong>The matched subtrees hold:</strong> ${esc(describeContent(a.content))}.</p>` : ''}
  ${ids.length ? `<ul>${ids.map((i) => `<li><code>&lt;${esc(i.tag)}&gt;</code>${i.componentId ? ` data-component-id <code>${esc(i.componentId)}</code>` : ''}${i.id ? ` id <code>${esc(i.id)}</code>` : ''}${i.role ? ` role ${esc(i.role)}` : ''}${i.label ? `, “${esc(i.label)}”` : ''}: ${i.nodes} element${i.nodes === 1 ? '' : 's'}</li>`).join('')}</ul>` : ''}
  ${r.removedEssential.length ? `<p class="warning"><strong>It took away content people use:</strong> ${esc(r.removedEssential.join(', '))}. A saving from this removal is diagnostic, not like-for-like.</p>` : ''}
  <div class="scroll"><table>
    <caption>Script work from ${pre ? 'the end of load' : 'the checkpoint'} to the end of idle (median over runs; evidence of work, not energy)</caption>
    <thead><tr><th scope="col">Side</th><th scope="col">Timer callbacks a second</th><th scope="col">Animation-frame callbacks a second</th><th scope="col">Running animations, checkpoint → after idle</th></tr></thead>
    <tbody><tr><th scope="row">Baseline</th>${act(a)}</tr><tr><th scope="row">Variant</th>${act(b)}</tr></tbody></table></div>
  <p class="${r.activity.continued.length ? 'warning' : 'note'}">${esc(r.activity.note)}</p>
  ${r.activity.continued.length || r.activity.fell.length ? `<ul>${[...r.activity.continued, ...r.activity.fell].map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}`;
}

/**
 * The experiment section: what changed, whether it applied, whether the
 * page still worked, and the measured difference per step. The difference
 * is the only energy figure, and it is labelled as a difference.
 */
export function experimentSection(x: ExperimentReport | undefined): string {
  if (!x) return '';
  const rows = x.differences
    .map((d) => {
      const e = d.energy;
      return `<tr><th scope="row">${esc(d.step)}${d.role === 'negative-control' ? ' <span class="note">(negative control)</span>' : ''}</th><td>${d.runs[0]} / ${d.runs[1]}</td>
        <td>${e ? `${e.medianMwh[0].toFixed(3)} (IQR ${e.iqrMwh[0].toFixed(3)})` : '—'}</td>
        <td>${e ? `${e.medianMwh[1].toFixed(3)} (IQR ${e.iqrMwh[1].toFixed(3)})` : '—'}</td>
        <td>${e ? `${e.differenceMwh >= 0 ? '+' : ''}${e.differenceMwh.toFixed(3)}${e.percent !== undefined ? ` (${e.percent >= 0 ? '+' : ''}${e.percent}%)` : ''}` : '—'}</td>
        <td class="text">${esc(VERDICT[d.verdict])}${d.indicative ? ' <span class="note">(indicative)</span>' : ''}</td>
        <td>${Math.round(d.durationMs[0])} → ${Math.round(d.durationMs[1])}</td>
        <td>${d.transferBytes ? `${kb(d.transferBytes[0])} → ${kb(d.transferBytes[1])}` : '—'}</td></tr>`;
    })
    .join('');
  const checks = x.assertions.checked
    ? `<p><strong>Checks</strong> (${x.assertions.checked}, on both sides): baseline ${x.assertions.baseline.length ? `failed: ${x.assertions.baseline.map(esc).join('; ')}` : 'passed'};
       with the change ${x.assertions.variant.length ? `failed: ${x.assertions.variant.map(esc).join('; ')}` : 'passed'}.</p>`
    : '<p class="note">No checks were declared; add assertions to the experiment so a change that breaks the page is caught.</p>';
  return `<section aria-labelledby="experiment-h">
  <h2 id="experiment-h">Experiment: ${esc(x.name)}</h2>
  <dl class="meta">
    <dt>Page</dt><dd>${/^https?:\/\//.test(x.url) ? `<a href="${esc(x.url)}">${esc(x.url)}</a>` : esc(x.url)}</dd>
    <dt>Baseline</dt><dd>${esc(x.sides.baseline)}</dd>
    <dt>Change</dt><dd>${esc(x.description)}</dd>
    ${x.from ? `<dt>From</dt><dd>item ${x.from.rank} of the investigation queue in <code>${esc(x.from.file)}</code>: <code>${esc(x.from.title)}</code></dd>` : ''}
    <dt>Order</dt><dd>interleaved, seed <code>${esc(x.seed)}</code>: <code>${esc(x.order.join(' '))}</code></dd>
    ${
      x.protocol
        ? `<dt>Protocol</dt><dd>${esc(x.protocol.design)}; ${x.protocol.runsPerSide} runs a side after ${x.protocol.warmupsPerSide} warm-up${x.protocol.warmupsPerSide === 1 ? '' : 's'}; idle baseline ${x.protocol.idleBaselineMs === null ? 'off' : `${x.protocol.idleBaselineMs} ms`} in every run; cache ${esc(x.protocol.cacheMode)}; viewport ${x.protocol.viewport.width}×${x.protocol.viewport.height}${x.protocol.headed ? ', headed' : ', headless'}; network ${esc(x.protocol.network)}; profiler ${esc(x.protocol.profilerFeatures.join(', ') || 'off')} every ${x.protocol.profilerIntervalMs} ms${x.protocol.release ? `; build <code>${esc(x.protocol.release)}</code>` : ''}</dd>`
        : ''
    }
  </dl>
  <p class="${x.applied.ok ? '' : 'warning'}"><strong>Applied: ${x.applied.ok ? 'yes' : 'no'}.</strong> ${esc(x.applied.note)}${x.applied.ok ? '' : ' No difference is reported, because there was none to measure. This is not a finding of “no saving”.'}</p>
  ${x.workload?.kind === 'load-checkpoint-idle' ? `<p><strong>Workload:</strong> the page loads (<code>load</code>, a negative control: the component is on both sides), then the change is made outside every measured window, both sides wait ${x.workload.settleMs ?? 0} ms, and the idle window (<code>idle</code>, ${x.workload.idleMs ?? 0} ms) is measured. Only the idle window can show the change’s effect.</p>` : ''}
  ${x.removal ? removalBlock(x.removal) : ''}
  ${checks}
  ${x.likeForLike && !x.likeForLike.ok ? `<p class="warning"><strong>Not like-for-like:</strong> ${x.likeForLike.reasons.map(esc).join(' ')}</p>` : ''}
  ${x.accessibility.changed.length ? `<p class="warning"><strong>Accessibility structure changed:</strong> ${x.accessibility.changed.map(esc).join('; ')}. Check the change keeps the page usable.</p>` : ''}
  ${
    rows
      ? `<div class="scroll"><table>
    <caption>Measured difference per step: observed incremental energy in mWh (baseline → with the change)</caption>
    <thead><tr><th scope="col">Step</th><th scope="col">Runs</th><th scope="col">Baseline, median</th><th scope="col">With the change, median</th>
      <th scope="col">Difference</th><th scope="col" class="text">Reading</th><th scope="col">Duration, ms</th><th scope="col">Transfer</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
  <ul>${x.differences.map((d) => `<li><strong>${esc(d.step)}:</strong> ${esc(d.reading)}</li>`).join('')}</ul>`
      : ''
  }
  <ul class="note">${x.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
</section>`;
}

const STATUS: Record<EvidenceRecord['outcome']['status'], string> = {
  'reduction-shown': 'Reduction shown',
  'reduction-not-like-for-like': 'Reduction shown, but not like-for-like',
  'increase-shown': 'Increase shown',
  'no-difference-shown': 'No difference shown',
  'below-resolution': 'Below the resolution of this setup',
  'not-measured': 'Energy not measured',
  'intervention-failed': 'The change did not take effect: nothing compared',
};

/**
 * The finding, as a development issue would carry it: observed activity,
 * suspected cause, the experimentally supported outcome and the
 * recommended change, each under its own heading, never merged.
 */
export function findingSection(r: EvidenceRecord | undefined): string {
  if (!r) return '';
  return `<section aria-labelledby="finding-h" class="boundary">
  <h2 id="finding-h">Finding: ${esc(STATUS[r.outcome.status])} <span class="note">(confidence: ${esc(r.outcome.confidence)})</span></h2>
  <h3>1. Observed activity</h3>
  <ul>${r.observed.statements.map((s) => `<li>${esc(s)}</li>`).join('')}${r.observed.evidence.map((e) => `<li><span class="note">${esc(e.class)}, ${esc(e.source)}:</span> ${esc(e.detail)}</li>`).join('')}</ul>
  <h3>2. Suspected cause</h3>
  <p>${esc(r.suspected.statement)}</p>
  ${r.target.sourceFiles.length ? `<ul>${r.target.sourceFiles.map((f) => `<li><code>${esc(f.url)}</code>${f.functions.length ? ` (${esc(f.functions.join(', '))})` : ''}: ${esc(f.how)}</li>`).join('')}</ul>` : '<p class="note">Source files: unknown (no profiling evidence was attached).</p>'}
  <h3>3. Experimentally supported outcome</h3>
  <p>${esc(r.outcome.statement)}</p>
  <h3>4. Recommended production change</h3>
  <p>${esc(r.recommendation.statement)}</p>
  <p class="note">${esc(r.recommendation.caution)}</p>
  <h3>Reproduce</h3>
  <pre class="cmd"><code>${esc(r.experiment.command)}</code></pre>
  <p class="note">Record <code>${esc(r.id)}</code> (<code>${esc(r.schema)}</code>). ${r.artifacts['issueDraft'] ? `Issue draft: <a href="${esc(r.artifacts['issueDraft'])}">${esc(r.artifacts['issueDraft'])}</a>.` : ''} Topics for mapping to the Web Sustainability Guidelines: ${esc(r.topics.join(', ') || 'none')}; no guideline is asserted.</p>
</section>`;
}
