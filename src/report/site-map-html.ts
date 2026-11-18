/**
 * A no-script navigation map: site -> families -> pages -> component types and
 * resources -> evidence. Counts come from the measured pages only and are not
 * an energy figure.
 */
import type { BenchmarkResult } from '../core/types.js';
import type { ComponentGraph, GraphPage, GraphResource } from '../model/graph.js';

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const familyOf = (page: GraphPage, families: BenchmarkResult['families']): string | undefined =>
  page.family ?? families?.pageFamily?.[page.url];

const link = (anchor: string, text: string): string => `<a href="#${esc(anchor)}">${esc(text)}</a>`;
const pageLink = (page: GraphPage): string => link(`page-${page.id}`, page.url);
const familyLink = (id: string | undefined, label: string): string => (id ? link(`family-${id}`, label) : esc(label));
const typeLink = (id: string, signature: string): string => link(`type-${id}`, signature);
const resourceLink = (resource: GraphResource): string => link(`resource-${resource.id}`, resource.key);

export function siteMapSection(result: BenchmarkResult): string {
  const graph = result.graph;
  if (!graph) return '';
  const types = new Map(graph.types.map((t) => [t.id, t]));
  const instances = new Map(graph.instances.map((i) => [i.id, i]));
  const resources = new Map(graph.resources.map((r) => [r.id, r]));
  const pages = new Map(graph.pages.map((p) => [p.id, p]));
  const familyName = new Map((result.families?.families ?? []).map((f) => [f.id, f]));
  const instancesByPage = new Map<string, typeof graph.instances>();
  for (const i of graph.instances) instancesByPage.set(i.page, [...(instancesByPage.get(i.page) ?? []), i]);
  const findingsByPage = new Map<string, number>();
  const findingsByType = new Map<string, number>();
  const findingsByResource = new Map<string, number>();
  for (const f of graph.findings) {
    findingsByPage.set(f.page, (findingsByPage.get(f.page) ?? 0) + 1);
    if (f.target.type === 'instance' && f.target.id) {
      const t = instances.get(f.target.id)?.type;
      if (t) findingsByType.set(t, (findingsByType.get(t) ?? 0) + 1);
    } else if (f.target.type === 'resource' && f.target.id) {
      findingsByResource.set(f.target.id, (findingsByResource.get(f.target.id) ?? 0) + 1);
      for (const ci of resources.get(f.target.id)?.loadedBy ?? []) {
        const t = instances.get(ci)?.type;
        if (t) findingsByType.set(t, (findingsByType.get(t) ?? 0) + 1);
      }
    }
  }
  const familyTypes = new Map<string, Set<string>>();
  const familyPages = new Map<string, GraphPage[]>();
  const familyResources = new Map<string, Set<string>>();
  for (const p of graph.pages) {
    const fid = familyOf(p, result.families);
    if (!fid) continue;
    familyPages.set(fid, [...(familyPages.get(fid) ?? []), p]);
    const pageTypes = new Set((instancesByPage.get(p.id) ?? []).map((i) => i.type));
    const set = familyTypes.get(fid) ?? new Set<string>();
    for (const t of pageTypes) set.add(t);
    familyTypes.set(fid, set);
    const rs = familyResources.get(fid) ?? new Set<string>();
    for (const r of p.resources) rs.add(r);
    familyResources.set(fid, rs);
  }
  const pageCount = graph.pages.length;
  const familyCount = familyName.size;
  const typeCount = graph.types.length;
  const resourceCount = graph.resources.length;
  const familyRows = (result.families?.families ?? []).map((f) => {
    const fps = familyPages.get(f.id) ?? [];
    const ftypes = familyTypes.get(f.id) ?? new Set();
    const frs = familyResources.get(f.id) ?? new Set();
    const findings = fps.reduce((n, p) => n + (findingsByPage.get(p.id) ?? 0), 0);
    return { f, fps, ftypes, frs, findings };
  });
  const pageRows = graph.pages
    .slice()
    .sort((a, b) => a.url.localeCompare(b.url))
    .map((p) => {
      const fid = familyOf(p, result.families);
      const pageInstances = instancesByPage.get(p.id) ?? [];
      const pageTypeIds = [...new Set(pageInstances.map((i) => i.type))];
      const scripts = p.resources.map((id) => resources.get(id)).filter((r): r is GraphResource => r?.kind === 'script');
      return { p, fid, pageInstances, pageTypeIds, scripts, findings: findingsByPage.get(p.id) ?? 0 };
    });
  const typeRows = graph.types
    .slice()
    .sort((a, b) => a.signature.localeCompare(b.signature))
    .map((t) => ({
      t,
      pageIds: [...new Set(graph.instances.filter((i) => i.type === t.id).map((i) => i.page))],
      families: t.families,
      findings: findingsByType.get(t.id) ?? 0,
      resources: [...new Set(graph.instances.filter((i) => i.type === t.id).flatMap((i) => i.resources))],
    }));
  const resourceRows = graph.resources
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => ({
      r,
      loadedTypes: [...new Set((r.loadedBy ?? []).map((ci) => instances.get(ci)?.type).filter((x): x is string => !!x))],
      findings: findingsByResource.get(r.id) ?? 0,
    }));
  const mapHref = (anchor: string) => `#${anchor}`;
  const sourceRows: [string, string, string, string][] = [
    ['Pages, families, components, resources', 'component graph and page families', 'count of measured pages/items', 'measured sample only; no whole-site extrapolation'],
    ['Findings shown as counts', 'graph findings (structure, Lighthouse, Chromium trace)', 'observations', 'each finding keeps its own evidence class; no energy'],
    ['Energy', 'not shown in this map', 'mWh only where a measured experiment/finding exists', 'same machine and run; never per element'],
    ['Accessibility', 'optional Open Scans join', 'observations / page-level evidence', 'not energy and not a WCAG conformance claim'],
  ];
  return `<section aria-labelledby="site-map-h" class="boundary">
  <h2 id="site-map-h">Site map: pages, families, components and resources</h2>
  <p>Navigation for the measured sample: ${pageCount} page${pageCount === 1 ? '' : 's'}, ${familyCount} famil${familyCount === 1 ? 'y' : 'ies'}, ${typeCount} component type${typeCount === 1 ? '' : 's'} and ${resourceCount} resource${resourceCount === 1 ? '' : 's'}. A count is an observation about the measured pages, not an energy figure.</p>
  <p class="note">Run: ${esc(result.session.mode)} ${esc(result.session.id)}, started ${esc(result.session.startedAt)}; viewport ${result.environment.viewport.width}×${result.environment.viewport.height}; energy tier ${esc(result.capabilities?.tier ?? 'unknown')}.</p>
  <nav aria-label="Site map sections"><ul>
    <li><a href="${mapHref('site-map-families')}">Families</a></li>
    <li><a href="${mapHref('site-map-pages')}">Pages</a></li>
    <li><a href="${mapHref('site-map-types')}">Component types</a></li>
    <li><a href="${mapHref('site-map-resources')}">Resources</a></li>
    <li><a href="${mapHref('site-map-source')}">What the counts mean</a></li>
  </ul></nav>

  <h3 id="site-map-families">Families</h3>
  ${
    familyRows.length
      ? `<div class="scroll"><table>
    <caption>Measured page families</caption>
    <thead><tr><th scope="col">Family</th><th scope="col">Pages</th><th scope="col">Representative</th><th scope="col">Component types</th><th scope="col">Resources</th><th scope="col">Findings</th></tr></thead>
    <tbody>${familyRows
      .map(
        ({ f, fps, ftypes, frs, findings }) =>
          `<tr><th scope="row" class="text">${familyLink(f.id, f.label)}</th><td>${fps.length}</td><td class="text">${esc(f.representative)}</td><td>${ftypes.size}</td><td>${frs.size}</td><td>${findings}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
      : '<p class="note">No page families were recorded.</p>'
  }
  ${familyRows
    .map(
      ({ f, fps, ftypes, frs }) =>
        `<details id="family-${esc(f.id)}" open><summary>${esc(f.label)} (${fps.length} page${fps.length === 1 ? '' : 's'})</summary>
    <p>Representative: ${esc(f.representative)}. Cohesion ${f.cohesion.toFixed(2)}. ${ftypes.size} component types, ${frs.size} resources.</p>
    <p><strong>Pages:</strong> ${fps.map((p) => pageLink(p)).join('; ')}</p>
    <p><strong>Component types:</strong> ${[...ftypes].map((id) => (types.get(id) ? typeLink(id, types.get(id)!.signature) : esc(id))).join('; ')}</p>
  </details>`,
    )
    .join('')}

  <h3 id="site-map-pages">Pages</h3>
  <div class="scroll"><table>
  <caption>Measured pages, with family, components, scripts and findings</caption>
  <thead><tr><th scope="col">Page</th><th scope="col">Family</th><th scope="col">Components</th><th scope="col">Scripts</th><th scope="col">Findings</th><th scope="col">Evidence</th></tr></thead>
  <tbody>${pageRows
    .map(
      ({ p, fid, pageTypeIds, scripts, findings }) =>
        `<tr id="page-${esc(p.id)}"><th scope="row" class="text">${esc(p.url)}</th><td class="text">${fid && familyName.get(fid) ? familyLink(fid, familyName.get(fid)!.label) : '—'}</td><td class="text">${pageTypeIds.length ? pageTypeIds.map((id) => (types.get(id) ? typeLink(id, types.get(id)!.signature) : esc(id))).join('<br>') : '—'}</td><td class="text">${scripts.length ? scripts.map((r) => resourceLink(r)).join('<br>') : '—'}</td><td>${findings}</td><td class="text"><a href="#patterns-h">Patterns</a> · <a href="#investigate-h">Investigation</a></td></tr>`,
    )
    .join('')}</tbody></table></div>

  <h3 id="site-map-types">Component types</h3>
  <div class="scroll"><table>
  <caption>Component types and where they occur</caption>
  <thead><tr><th scope="col">Component type</th><th scope="col">Method</th><th scope="col">Pages</th><th scope="col">Families</th><th scope="col">Findings</th><th scope="col">Resources</th></tr></thead>
  <tbody>${typeRows
    .map(
      ({ t, pageIds, families, findings, resources: trs }) =>
        `<tr id="type-${esc(t.id)}"><th scope="row" class="text">${esc(t.signature)}<br><span class="note">${esc(t.identification)}; ${esc(t.confidence)} confidence</span></th><td class="text">${esc(t.method)}</td><td class="text">${pageIds.slice(0, 4).map((id) => (pages.get(id) ? pageLink(pages.get(id)!) : esc(id))).join('<br>')}${pageIds.length > 4 ? `<br><span class="note">+${pageIds.length - 4} more</span>` : ''}</td><td class="text">${families.map((fid) => (familyName.get(fid) ? familyLink(fid, familyName.get(fid)!.label) : esc(fid))).join('<br>') || '—'}</td><td>${findings}</td><td>${trs.length}</td></tr>`,
    )
    .join('')}</tbody></table></div>

  <h3 id="site-map-resources">Resources</h3>
  <details open><summary>All ${resourceRows.length} resources</summary>
  <div class="scroll"><table>
  <caption>Resources, loaders and findings</caption>
  <thead><tr><th scope="col">Resource</th><th scope="col">Kind</th><th scope="col">Pages</th><th scope="col">Families</th><th scope="col">Loaded by component types</th><th scope="col">Findings</th></tr></thead>
  <tbody>${resourceRows
    .map(
      ({ r, loadedTypes, findings }) =>
        `<tr id="resource-${esc(r.id)}"><th scope="row" class="text">${resourceLink(r)}<br><span class="note">${esc(r.host)}${r.thirdParty ? '; third party' : ''}</span></th><td class="text">${esc(r.kind)}</td><td>${r.pages}</td><td class="text">${r.families.map((fid) => (familyName.get(fid) ? familyLink(fid, familyName.get(fid)!.label) : esc(fid))).join('<br>') || '—'}</td><td class="text">${loadedTypes.length ? loadedTypes.map((id) => (types.get(id) ? typeLink(id, types.get(id)!.signature) : esc(id))).join('<br>') : '<span class="note">no component loads it</span>'}</td><td>${findings}</td></tr>`,
    )
    .join('')}</tbody></table></div>
  </details>

  <h3 id="site-map-source">What the counts mean</h3>
  <div class="scroll"><table>
  <caption>Source, unit and boundary for the map</caption>
  <thead><tr><th scope="col">Map item</th><th scope="col">Source</th><th scope="col">Unit</th><th scope="col">Boundary</th></tr></thead>
  <tbody>${sourceRows.map(([item, source, unit, boundary]) => `<tr><th scope="row" class="text">${esc(item)}</th><td class="text">${esc(source)}</td><td class="text">${esc(unit)}</td><td class="text">${esc(boundary)}</td></tr>`).join('')}</tbody></table></div>
  <p class="note">This section is navigation, not a combined score. Accessibility, performance, carbon estimates and energy keep their own sources and units.</p>
</section>`;
}
