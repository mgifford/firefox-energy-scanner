import { formatCruxValue, type CruxMetricName, type CruxResult } from '../core/crux.js';
import type { CrawlSampling } from '../core/types.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const CORE: CruxMetricName[] = ['lcp', 'inp', 'cls', 'ttfb'];
const HEAD: Record<string, string> = { lcp: 'LCP p75', inp: 'INP p75', cls: 'CLS p75', ttfb: 'TTFB p75' };

/**
 * Field data for each measured page: what real Chrome users experienced over
 * 28 days, from the Chrome UX Report. Its own section, its own boundary: not
 * this scan's measurement, not a Lighthouse figure, not energy.
 */
export function cruxPagesSection(pages: CruxResult[] | undefined, sampling?: CrawlSampling): string {
  if (!pages?.length) return '';
  const withData = pages.filter((p) => p.status === 'ok' && p.record);
  const window = withData.find((p) => p.record!.window.start)?.record?.window;
  const rows = pages
    .map((p) => {
      const m = p.record?.metrics;
      const cells = p.status === 'ok' && m
        ? CORE.map((k) => `<td>${m[k] ? esc(formatCruxValue(k, m[k]!.p75)) : '—'}</td>`).join('')
        : `<td colspan="${CORE.length}" class="text">${p.status === 'no-data' ? 'No record: too little Chrome traffic, or not covered' : `Unavailable: ${esc(p.detail ?? '')}`}</td>`;
      return `<tr><th scope="row"><code>${esc(p.target)}</code></th>${cells}</tr>`;
    })
    .join('');
  const popular = sampling?.popularity;
  return `<section aria-labelledby="crux-pages-h">
  <h2 id="crux-pages-h">Field data for each page (CrUX)</h2>
  <p>${withData.length} of ${pages.length} measured page${pages.length === 1 ? '' : 's'} have a Chrome UX Report record: real Chrome users over 28 days${window?.start ? `, ${esc(window.start)} to ${esc(window.end)}` : ''}, all form factors unless stated.
  A page has a record only with enough real Chrome traffic, so a record is also a sign that people use the page.
  These are field figures for the live site. They are not this scan's measurement, and they are not combined with it.</p>
  ${popular ? `<p>The sample preferred such pages (<code>--popular</code>): of ${popular.checked} candidate pages checked, ${popular.withRecord} had a record, and those led their URL section's draw.</p>` : ''}
  <div class="scroll"><table>
    <caption>75th percentile, real Chrome users, by page</caption>
    <thead><tr><th scope="col">Page</th>${CORE.map((k) => `<th scope="col">${HEAD[k]}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</section>`;
}
