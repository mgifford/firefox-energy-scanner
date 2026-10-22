import {
  scoreRating,
  sitewideRecommendations,
  type LighthouseSummary,
} from '../lighthouse/summary.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const sec = (ms: number | undefined): string =>
  ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`;

const kb = (bytes: number | undefined): string =>
  bytes === undefined ? '—' : `${Math.round(bytes / 1024)} KB`;

/** Only Lighthouse's own documentation links are rendered as links. */
const safeHref = (url: string | undefined): string | undefined =>
  url && /^https:\/\//.test(url) ? url : undefined;

/**
 * Lighthouse section of the static report.
 *
 * Kept in its own section with its own boundary statement: it is Chromium
 * lab data, so it must not read as another column of the Firefox results.
 * Scores carry a written rating so nothing depends on colour.
 */
export function lighthouseSection(lh: LighthouseSummary | undefined): string {
  if (!lh) return '';
  const ok = lh.results.filter((r) => r.runs > 0);
  const extra = lh.categories.filter((c) => c !== 'performance');
  const common = sitewideRecommendations(ok).slice(0, 12);

  const rows = lh.results
    .map((r) => {
      if (r.runs === 0) {
        return `<tr><th scope="row">${esc(r.requestedUrl)}</th><td colspan="${6 + extra.length}">Failed: ${esc(r.error)}</td></tr>`;
      }
      const perf = r.scores.performance;
      const range =
        r.performanceRange && r.performanceRange[0] !== r.performanceRange[1]
          ? ` <span class="note">(${r.performanceRange[0]}–${r.performanceRange[1]})</span>`
          : '';
      return `<tr>
        <th scope="row">${esc(r.requestedUrl)}</th>
        <td>${perf ?? '—'}${range}<br><span class="note">${esc(scoreRating(perf))}</span></td>
        <td>${sec(r.metrics.lcpMs)}</td>
        <td>${r.metrics.tbtMs ?? '—'} ms</td>
        <td>${r.metrics.cls ?? '—'}</td>
        <td>${sec(r.work.mainThreadMs)}</td>
        <td>${kb(r.work.totalBytes)}</td>
        ${extra.map((c) => `<td>${r.scores[c] ?? '—'}</td>`).join('')}
      </tr>`;
    })
    .join('');

  const perUrl = ok
    .map((r) => {
      const recs = r.recommendations
        .map((x) => {
          const href = safeHref(x.learnMore);
          const title = href ? `<a href="${esc(href)}">${esc(x.title)}</a>` : esc(x.title);
          return `<li>${title}${x.displayValue ? ` — ${esc(x.displayValue)}` : ''}</li>`;
        })
        .join('');
      const work = (r.work.mainThreadByCategory ?? [])
        .slice(0, 5)
        .map((w) => `${esc(w.category)} ${sec(w.ms)}`)
        .join(' · ');
      const failing = extra
        .map((c) => {
          const list = r.failingAudits[c] ?? [];
          return list.length
            ? `<p><strong>${esc(c)}</strong>: ${list.map((a) => esc(a.title)).join('; ')}</p>`
            : '';
        })
        .join('');
      return `<details>
  <summary>${esc(r.requestedUrl)} — ${r.recommendations.length} recommendation${r.recommendations.length === 1 ? '' : 's'}</summary>
  ${recs ? `<ol>${recs}</ol>` : '<p>No failing performance audits.</p>'}
  ${work ? `<p class="note">Main-thread work by category: ${work}</p>` : ''}
  ${failing}
</details>`;
    })
    .join('');

  return `<section aria-labelledby="lh-h">
  <h2 id="lh-h">Lighthouse (Chromium lab data)</h2>
  <p class="boundary">
    Lighthouse ${esc(lh.version)} in ${esc(lh.browser ?? 'Chromium')}, ${esc(lh.formFactor)} profile,
    ${esc(lh.throttling)}. Median of ${lh.runsPerUrl} run${lh.runsPerUrl === 1 ? '' : 's'} per URL.
    This is a different browser engine under simulated throttling: it describes lab load
    performance, not Firefox and not energy, and is never combined with the results above.
    Main-thread work is the figure closest to client energy, since it counts CPU time.
  </p>
  <div class="scroll">
  <table>
    <caption>Lighthouse scores and lab metrics per URL (performance range across runs in brackets)</caption>
    <thead><tr>
      <th scope="col">URL</th><th scope="col">Performance</th><th scope="col">LCP</th>
      <th scope="col">TBT</th><th scope="col">CLS</th><th scope="col">Main-thread work</th>
      <th scope="col">Total bytes</th>${extra.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
  ${
    common.length
      ? `<h3>Recommendations shared across pages</h3>
  <p class="note">A failure on most pages usually comes from the theme or a shared asset: one fix lands everywhere.</p>
  <div class="scroll"><table>
    <caption>Failing performance audits, by number of pages affected</caption>
    <thead><tr><th scope="col">Recommendation</th><th scope="col">Pages</th>
      <th scope="col">Median est. time saved</th><th scope="col">Median est. bytes saved</th></tr></thead>
    <tbody>${common
      .map(
        (c) => `<tr><th scope="row">${esc(c.title)}</th><td>${c.pages} of ${ok.length}</td>
      <td>${c.medianSavingsMs ? sec(c.medianSavingsMs) : '—'}</td><td>${c.medianSavingsBytes ? kb(c.medianSavingsBytes) : '—'}</td></tr>`,
      )
      .join('')}</tbody>
  </table></div>`
      : ''
  }
  ${perUrl ? `<h3>Per-URL recommendations</h3>${perUrl}` : ''}
</section>`;
}
