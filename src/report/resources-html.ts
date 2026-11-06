import type { ComponentGraph, GraphResource } from '../model/graph.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const kb = (b: number) => (b < 1024 ? `${Math.round(b)} B` : `${Math.round(b / 1024).toLocaleString('en')} KB`);
/** Shortened in the middle, keeping the host and the file name. */
const short = (key: string) => {
  const bare = key.replace(/…#[0-9a-f]+$/, '…');
  if (bare.length <= 70) return bare;
  const file = bare.replace(/[?#].*$/, '').split('/').pop() ?? '';
  const host = bare.split('/')[0] ?? '';
  const tail = file.length > 40 ? `${file.slice(0, 18)}…${file.slice(-18)}` : file;
  return `${host}/…/${tail}`;
};

function table(caption: string, rows: GraphResource[], graph: ComponentGraph, pageColumn: boolean): string {
  if (!rows.length) return '';
  const pageOf = (r: GraphResource) => graph.pages.find((p) => p.resources.includes(r.id))?.url ?? '';
  return `<div class="scroll"><table class="families">
    <caption>${esc(caption)}</caption>
    <thead><tr><th scope="col" class="text">Resource</th><th scope="col" class="text">Kind</th><th scope="col">Pages</th>
      <th scope="col">Transfer per page, median</th><th scope="col" class="text">Loaded by</th>${pageColumn ? '<th scope="col" class="text">Page</th>' : ''}</tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr><th scope="row"><code>${esc(short(r.key))}</code>${r.thirdParty ? ' <span class="note">(third party)</span>' : ''}</th>
        <td class="text">${esc(r.kind)}</td><td>${r.pages}</td><td>${kb(r.transferBytes.median)}</td>
        <td class="text">${r.loadedBy.length ? `${r.loadedBy.length} component instance${r.loadedBy.length === 1 ? '' : 's'}` : 'page-level: no recorded component’s element loads it'}${r.referencedWithoutTransfer ? `<br><span class="note">referenced but not transferred on ${r.referencedWithoutTransfer} more page${r.referencedWithoutTransfer === 1 ? '' : 's'}</span>` : ''}</td>
        ${pageColumn ? `<td class="text">${esc(short(pageOf(r)))}</td>` : ''}</tr>`,
      )
      .join('')}</tbody></table></div>`;
}

/**
 * Resources by reach: what nearly every page loads, what a family loads, and
 * the heaviest things only one page loads. Transfer is per page; nothing is
 * added up across pages or turned into energy.
 */
export function resourcesSection(graph: ComponentGraph | undefined): string {
  if (!graph || !graph.resources.length) return '';
  const by = (scope: GraphResource['scope']) => graph.resources.filter((r) => r.scope === scope);
  const heaviest = (list: GraphResource[], n: number, key: 'median' | 'max' = 'median') =>
    [...list].sort((a, b) => b.transferBytes[key] - a.transferBytes[key] || (a.key < b.key ? -1 : 1)).slice(0, n);
  const site = by('site-wide');
  const fam = by('family-wide');
  const unique = by('page-unique');
  return `<section aria-labelledby="resources-h">
  <h2 id="resources-h">Resources</h2>
  <p>${graph.resources.length} resources on ${graph.pages.length} pages: ${site.length} on nearly every page (site-wide), ${fam.length} on most pages of one family,
  ${by('shared').length} on some pages, ${unique.length} on one page only. Scripts and stylesheets in the document head, and resources loaded by script,
  belong to no component: they are page-level, and are listed here by the pages that load them. So are images loaded from CSS
  and resources of components beyond the 24 recorded per page.</p>
  ${table('Loaded on nearly every page, heaviest first', heaviest(site, 12), graph, false)}
  ${table('Loaded on most pages of one family, heaviest first', heaviest(fam, 8), graph, false)}
  ${table('Heaviest resources that only one measured page loads', heaviest(unique, 10, 'max'), graph, true)}
  <p class="note">Transfer is per page that loaded the resource, as Firefox recorded it. It says how much was downloaded, not what it cost to run.</p>
</section>`;
}
