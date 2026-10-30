import type { WebnrgSummary } from '../webnrg/run.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const num = (v: number | undefined, digits: number, unit: string) => (v === undefined ? '—' : `${v.toFixed(digits)} ${unit}`);

/** Only green-coding.io links are rendered as links. */
const href = (url: string | undefined) =>
  url && /^https:\/\/(website-tester|metrics)\.green-coding\.io\//.test(url) ? url : undefined;

const STATUS: Record<string, string> = {
  reused: 'reused',
  measured: 'measured for this scan',
  submitted: 'requested, not finished yet',
  'not-requested': 'no result in the last 30 days',
  failed: 'failed',
};

/**
 * webNRG section of the static report. Its own section and boundary
 * statement: lab data from other hardware, never another column of ours.
 */
export function webnrgSection(summary: WebnrgSummary | undefined): string {
  if (!summary || summary.pages.length === 0) return '';
  const rows = summary.pages
    .map((p) => {
      const m = p.metrics;
      const link = href(p.statsUrl) ?? href(p.detailsUrl);
      const status = `${STATUS[p.status] ?? p.status}${p.measuredAt ? ` (${esc(p.measuredAt.slice(0, 10))})` : ''}` +
        (p.error ? `: ${esc(p.error)}` : '');
      return `<tr><th scope="row">${link ? `<a href="${esc(link)}">${esc(p.page)}</a>` : esc(p.page)}</th>
        <td>${num(m?.cpuEnergyMwh, 2, 'mWh')}</td><td>${num(m?.cpuPowerW, 2, 'W')}</td>
        <td>${num(m?.transferKb, 0, 'kB')}</td>
        <td>${m ? `rendering ${esc(m.renderingGrade ?? '—')}, transfer ${esc(m.transferGrade ?? '—')}` : '—'}</td>
        <td>${status}</td></tr>`;
    })
    .join('');
  return `<section aria-labelledby="webnrg-h">
  <h2 id="webnrg-h">Lab check: webNRG</h2>
  <p>${esc(summary.boundary)}${summary.machine ? ` Machine: ${esc(summary.machine)}.` : ''}
    Every webNRG result is public on <a href="https://metrics.green-coding.io/">metrics.green-coding.io</a>.</p>
  <div class="scroll">
  <table>
    <caption>webNRG figures for the ${esc(summary.phase)} phase</caption>
    <thead><tr><th scope="col">Page</th><th scope="col">CPU energy</th><th scope="col">CPU power</th>
      <th scope="col">Transfer</th><th scope="col">webNRG grades</th><th scope="col">Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
</section>`;
}
