import type { CrawlSampling } from '../core/types.js';
import type { FamilyReport } from '../analysis/families.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const kb = (bytes: number) => (bytes / 1024).toFixed(0);

/** A page link; only http(s) URLs become links. */
const link = (url: string, text = url) => (/^https?:\/\//i.test(url) ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));

/** A URL's path, shortened from the left, for a narrow table cell. */
function shortPath(url: string): string {
  let path = url;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    /* keep it whole */
  }
  return path.length > 48 ? `…${path.slice(-47)}` : path;
}

const REASON_LABEL: Record<string, string> = {
  start: 'start page',
  requested: 'listed in the request',
  random: 'random sample',
  representative: 'one per URL section',
  'rare-section': 'rare URL section',
  proportional: 'share of a large section',
  linked: 'found by following links',
};

/** A readable form of a family signal ("c:drupal-view:frontpage" -> "component drupal-view:frontpage"). */
function signal(s: string): string {
  const [kind, ...rest] = s.split(':');
  const value = rest.join(':');
  const label = { c: 'component', l: 'landmark', t: 'template', u: 'URL pattern' }[kind!] ?? kind;
  return `${label} <code>${esc(value)}</code>`;
}

/** How the pages were chosen, for crawls. */
function samplingBlock(s: CrawlSampling | undefined): string {
  if (!s) return '';
  const counts = new Map<string, number>();
  for (const r of Object.values(s.reasons ?? {})) counts.set(r, (counts.get(r) ?? 0) + 1);
  const method =
    s.method === 'adaptive'
      ? 'a seeded sample spread across the URL sections of the site’s sitemap'
      : s.method === 'sitemap'
        ? 'a seeded random sample of the site’s sitemap'
        : 'following links from the start page';
  const strata = s.strata?.length
    ? `<div class="scroll"><table>
    <caption>URL sections in the sitemap${s.strataTotal && s.strataTotal > s.strata.length ? ` (${s.strata.length} of ${s.strataTotal} shown: the largest and every one a page came from)` : ''}</caption>
    <thead><tr><th scope="col">Section</th><th scope="col">Pages listed</th><th scope="col">Pages measured</th><th scope="col">Rare</th></tr></thead>
    <tbody>${s.strata
      .map(
        (x) =>
          `<tr><th scope="row"><code>${esc(x.section)}</code>${x.sitemap ? ` <span class="note">(${esc(x.sitemap)})</span>` : ''}</th>` +
          `<td>${x.listed}</td><td>${x.picked}</td><td>${x.rare ? 'yes' : 'no'}</td></tr>`,
      )
      .join('')}</tbody>
  </table></div>`
    : '';
  return `<h3 id="sampling-h">How the pages were chosen</h3>
  <p>${s.picked} page${s.picked === 1 ? '' : 's'} by ${method}${s.listed !== undefined ? `, from ${s.listed} pages the sitemap lists` : ''}.
  ${counts.size ? `Reasons: ${[...counts].map(([r, n]) => `${n} ${esc(REASON_LABEL[r] ?? r)}`).join(', ')}.` : ''}</p>
  ${strata}
  ${s.limitations?.length ? `<ul class="note">${s.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}`;
}

/**
 * Page families section of the static report: the measured pages grouped by
 * how they are built. A table, then one disclosure per family for its signals
 * and pages, so the page works without scripts, by keyboard and in forced
 * colours.
 */
export function familiesSection(families: FamilyReport | undefined, sampling: CrawlSampling | undefined): string {
  if (!families && !sampling) return '';
  const body = families
    ? `<p>${families.pagesGrouped} measured pages group into <strong>${families.families.length}</strong>
  famil${families.families.length === 1 ? 'y' : 'ies'} by how they are built. A family is a grouping for
  investigation, not a measurement: start with its representative page, then check the outliers.</p>
  <div class="scroll"><table class="families">
    <caption>Page families, largest first (medians of the pages measured in each)</caption>
    <thead><tr>
      <th scope="col">Family</th><th scope="col">Pages</th><th scope="col">Representative page</th>
      <th scope="col">DOM nodes, median (range)</th><th scope="col">Transfer KB, median (range)</th>
      <th scope="col">Requests, median</th><th scope="col">Cohesion</th><th scope="col">Outliers</th>
    </tr></thead>
    <tbody>${families.families
      .map((f) => {
        const d = f.metrics.domNodes;
        const t = f.metrics.transferBytes;
        return `<tr><th scope="row"><a href="#${esc(f.id)}">${esc(f.label)}</a><br><code class="note">${esc(f.id)}</code></th>
        <td>${f.pages.length}</td>
        <td class="text">${link(f.representative, shortPath(f.representative))}</td>
        <td>${d ? `${d.median} (${d.min}–${d.max})` : '—'}</td>
        <td>${t ? `${kb(t.median)} (${kb(t.min)}–${kb(t.max)})` : '—'}</td>
        <td>${f.metrics.requests?.median ?? '—'}</td>
        <td>${f.cohesion.toFixed(2)}</td>
        <td>${f.outliers.length}</td></tr>`;
      })
      .join('')}</tbody>
  </table></div>
  ${families.families
    .map(
      (f) => `<details id="${esc(f.id)}">
    <summary>${esc(f.label)} — ${f.pages.length} page${f.pages.length === 1 ? '' : 's'}</summary>
    <p>Shared by most of its pages: ${f.signals.length ? f.signals.slice(0, 20).map(signal).join(', ') : 'nothing beyond the site’s shared structure'}${f.signals.length > 20 ? `, and ${f.signals.length - 20} more` : ''}.</p>
    ${
      f.outliers.length
        ? `<p>Outliers, at least twice or at most half the family median:</p><ul>${f.outliers
            .map((o) => `<li>${link(o.url)}: ${esc(o.metric)} ${o.value} (${o.ratio}× the median ${o.median})</li>`)
            .join('')}</ul>`
        : ''
    }
    <p>Pages:</p>
    <ul>${f.pages.map((u) => `<li>${link(u)}${u === f.representative ? ' (representative)' : ''}</li>`).join('')}</ul>
  </details>`,
    )
    .join('\n')}
  <ul class="note">${families.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  <p class="note">Method <code>${esc(families.method)}</code>: weighted Jaccard similarity of components, scripts and stylesheets,
  landmarks, Drupal template and URL pattern, then average-linkage clustering at ${families.threshold}. Cohesion is the mean similarity
  of a family’s pages, from 0 to 1.</p>`
    : '';
  return `<section aria-labelledby="families-h">
  <h2 id="families-h">Page families</h2>
  ${body}
  ${samplingBlock(sampling)}
</section>`;
}
