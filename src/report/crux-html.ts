import {
  CRUX_LABELS,
  CRUX_METRICS,
  describeCrux,
  formatCruxShare,
  formatCruxValue,
  type CruxMetricName,
  type CruxResult,
} from '../core/crux.js';
import type { LighthouseSummary } from '../lighthouse/summary.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const sec = (ms: number | undefined): string =>
  ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`;

/**
 * Field data section of the static report.
 *
 * CrUX describes the live site as real Chrome users experienced it. It is not
 * this session's measurement, not a Lighthouse score, and not an energy figure,
 * so it gets its own section, its own provenance line and no shared column with
 * anything else.
 */
export function cruxSection(
  crux: CruxResult | undefined,
  lh: LighthouseSummary | undefined,
): string {
  if (!crux) return '';

  if (crux.status !== 'ok' || !crux.record) {
    const heading = crux.status === 'no-data' ? 'No field data' : 'Field data unavailable';
    return `<section aria-labelledby="crux-h">
  <h2 id="crux-h">Field data (CrUX)</h2>
  <p class="note">${esc(describeCrux(crux))}</p>
  <p>${esc(heading)}: ${esc(crux.detail ?? 'the Chrome UX Report returned no record')}</p>
</section>`;
  }

  const record = crux.record;
  const rows = CRUX_METRICS.filter((name) => record.metrics[name])
    .map((name) => {
      const metric = record.metrics[name]!;
      return `<tr>
        <th scope="row">${esc(CRUX_LABELS[name])}</th>
        <td>${formatCruxValue(name, metric.p75)}</td>
        <td>${formatCruxShare(metric.band.good)}</td>
        <td>${formatCruxShare(metric.band.needsImprovement)}</td>
        <td>${formatCruxShare(metric.band.poor)}</td>
      </tr>`;
    })
    .join('');

  return `<section aria-labelledby="crux-h">
  <h2 id="crux-h">Field data (CrUX)</h2>
  <p class="note">
    ${esc(describeCrux(crux))}. Real Chrome users, aggregated by Google. The 75th
    percentile is the headline: 75% of page views were faster than this value.
    Bands are CrUX's own histogram, not thresholds applied here.
  </p>
  <div class="scroll">
  <table>
    <caption>Field measurements over the last 28 days</caption>
    <thead>
      <tr>
        <th scope="col">Metric</th>
        <th scope="col">75th percentile</th>
        <th scope="col">Good</th>
        <th scope="col">Needs improvement</th>
        <th scope="col">Poor</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
  <p class="note">
    Field data describes the live site over a trailing 28-day window. It cannot show that a
    change made today helped, and it does not cover previews, staging or authenticated URLs.
  </p>
${fieldVersusLab(crux, lh)}
</section>`;
}

/**
 * Field against lab, side by side.
 *
 * Only rendered when exactly one URL was audited: a CrUX origin record covers
 * every page of a site, so pairing it with a per-page Lighthouse table would
 * invite a comparison the data cannot support.
 */
function fieldVersusLab(crux: CruxResult, lh: LighthouseSummary | undefined): string {
  if (!lh) return '';
  const audited = lh.results.filter((r) => r.runs > 0);
  if (audited.length !== 1) {
    if (audited.length > 1) {
      return `  <p class="note">
    Not compared with the Lighthouse results above: this field record covers the whole
    ${esc(crux.scope)}, while Lighthouse audited ${audited.length} individual pages.
  </p>
`;
    }
    return '';
  }

  const lab = audited[0]!;
  const metrics = crux.record?.metrics ?? {};
  const comparable: { name: CruxMetricName; labValue: number | undefined; digits: number }[] = [
    { name: 'lcp', labValue: lab.metrics.lcpMs, digits: 1 },
    { name: 'fcp', labValue: lab.metrics.fcpMs, digits: 1 },
    { name: 'cls', labValue: lab.metrics.cls, digits: 2 },
  ];

  const rows = comparable
    .filter((m) => metrics[m.name])
    .map((m) => {
      const field = metrics[m.name]!;
      const labText =
        m.name === 'cls'
          ? (m.labValue === undefined ? '—' : m.labValue.toFixed(2))
          : sec(m.labValue);
      return `<tr>
        <th scope="row">${esc(CRUX_LABELS[m.name])}</th>
        <td>${formatCruxValue(m.name, field.p75)}</td>
        <td>${labText}</td>
      </tr>`;
    })
    .join('');

  if (!rows) return '';

  return `  <h3>Field against lab</h3>
  <p class="note">
    Two populations, not two attempts at the same number: the field column is the 75th
    percentile of real users over 28 days; the lab column is one throttled synthetic load.
    They are shown together because disagreement is informative, and are never combined,
    converted or averaged.
  </p>
  <div class="scroll">
  <table>
    <caption>Field p75 and the median Lighthouse run for ${esc(lab.requestedUrl)}</caption>
    <thead>
      <tr>
        <th scope="col">Metric</th>
        <th scope="col">Field p75 (CrUX)</th>
        <th scope="col">Lab (Lighthouse, median run)</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
  <p class="note">
    Interaction to Next Paint has no lab counterpart here: Lighthouse reports Total
    Blocking Time, which is a different metric and is not shown as an equivalent.
  </p>
`;
}
