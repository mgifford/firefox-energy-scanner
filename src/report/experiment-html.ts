import type { ExperimentReport, StepDifference } from '../experiments/experiment.js';

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
      return `<tr><th scope="row">${esc(d.step)}</th><td>${d.runs[0]} / ${d.runs[1]}</td>
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
  </dl>
  <p class="${x.applied.ok ? '' : 'warning'}"><strong>Applied: ${x.applied.ok ? 'yes' : 'no'}.</strong> ${esc(x.applied.note)}${x.applied.ok ? '' : ' No difference is reported, because there was none to measure.'}</p>
  ${checks}
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
