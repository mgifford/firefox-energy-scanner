import type { ComponentInventory, ComponentRecord } from '../analysis/components.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const link = (url: string, text = url) => (/^https?:\/\//i.test(url) ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));

function shortPath(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname + u.search;
    return p.length > 40 ? `…${p.slice(-39)}` : p;
  } catch {
    return url;
  }
}

const value = (v: number | undefined, unit: string | undefined) =>
  v === undefined ? '—' : unit === 'bytes' ? `${Math.round(v / 1024)} KB` : unit === 'ms' ? `${Math.round(v)} ms` : unit === 'score' ? v.toFixed(3) : String(v);

const MATCHED: Record<string, string> = {
  'node-path': 'element inside it',
  'tag-path': 'element inside it (by element names; positions differ)',
  'script-in-component': 'loaded by an element inside it',
};

/** Records worth listing: components that recur or carry a signal, and regions with evidence. */
const listed = (inv: ComponentInventory) =>
  inv.components.filter((c) => (c.kind === 'component' && (c.pages > 1 || c.signals.length > 0)) || c.evidence.length > 0).slice(0, 25);

function detailsFor(c: ComponentRecord): string {
  const evidence = c.evidence.length
    ? `<div class="scroll"><table>
      <caption>Lighthouse findings tied to it (Chromium lab, not Firefox energy)</caption>
      <thead><tr><th scope="col">Page</th><th scope="col">Finding</th><th scope="col">Value</th><th scope="col">How it was tied</th></tr></thead>
      <tbody>${c.evidence
        .map(
          (e) =>
            `<tr><td class="text">${link(e.page, shortPath(e.page))}</td><td class="text">${esc(e.detail ?? e.title)}${e.kind === 'context' ? ' <span class="note">(context, not a problem)</span>' : ''}${e.target ? `<br><code class="note">${esc(e.target.slice(0, 120))}</code>` : ''}</td>` +
            `<td>${value(e.value, e.unit)}</td><td class="text">${esc(MATCHED[e.matchedBy] ?? e.matchedBy)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '';
  return `<details id="${esc(c.id)}">
    <summary>${esc(c.signature)}${c.names.length ? ` — ${esc(c.names[0])}` : ''}</summary>
    <dl class="meta">
      <dt>Recognised by</dt><dd>${esc(c.method)} (${esc(c.confidence)} confidence)</dd>
      <dt>Pages</dt><dd>${c.pages}${c.families.length ? `, families ${c.families.map((f) => `<code>${esc(f)}</code>`).join(' ')}` : ''}</dd>
      <dt>Elements</dt><dd>median ${c.nodes.median}, at most ${c.nodes.max}${c.shareOfPage !== undefined ? `, ${Math.round(c.shareOfPage * 100)}% of a page` : ''}</dd>
      ${c.roles.length ? `<dt>Role</dt><dd>${c.roles.map(esc).join(', ')}</dd>` : ''}
      ${c.examples.length ? `<dt>Where</dt><dd>${c.examples.map((e) => `${link(e.page, shortPath(e.page))} <code>${esc(e.selector)}</code>${e.belowFold ? ' (below the first screen)' : ''}`).join('<br>')}</dd>` : ''}
      ${c.resources.length ? `<dt>Loads</dt><dd>${c.resources.map((r) => `${esc(r.kind)} ${link(r.url, shortPath(r.url))}${r.transferBytes !== undefined ? ` (${Math.round(r.transferBytes / 1024)} KB${r.thirdParty ? ', third party' : ''})` : ''}`).join('<br>')}</dd>` : ''}
    </dl>
    ${c.signals.length ? `<ul>${c.signals.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
    ${evidence}
    ${c.limitations.length ? `<ul class="note">${c.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
  </details>`;
}

/**
 * Components section of the static report: what the pages are built from,
 * what recurs, and the Lighthouse evidence tied to each. No energy figures,
 * because none are measured per component.
 */
export function componentsSection(inv: ComponentInventory | undefined): string {
  if (!inv) return '';
  const rows = listed(inv);
  const table = rows.length
    ? `<div class="scroll"><table class="families">
    <caption>Components that recur or carry a signal, recurring first</caption>
    <thead><tr><th scope="col">Component</th><th scope="col">Pages</th><th scope="col">Elements, median</th>
      <th scope="col">Confidence</th><th scope="col">Signals</th><th scope="col">Lighthouse findings</th></tr></thead>
    <tbody>${rows
      .map(
        (c) => `<tr><th scope="row"><a href="#${esc(c.id)}">${esc(c.signature)}</a>${c.kind === 'region' ? ' <span class="note">(page region)</span>' : ''}</th>
      <td>${c.pages}</td><td>${c.nodes.median}</td><td class="text">${esc(c.confidence)}</td>
      <td class="text">${c.signals.length ? `<ul>${c.signals.slice(0, 3).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '—'}</td>
      <td>${c.evidence.length}</td></tr>`,
      )
      .join('')}</tbody></table></div>
  ${rows.map(detailsFor).join('\n')}`
    : '<p>No component recurs across pages or carries a signal.</p>';
  const unattributed = inv.unattributed.length
    ? `<details>
    <summary>Lighthouse findings not tied to a component (${inv.unattributed.length})</summary>
    <div class="scroll"><table>
      <caption>Unattributed findings and why</caption>
      <thead><tr><th scope="col">Page</th><th scope="col">Finding</th><th scope="col">Value</th><th scope="col">Why not tied</th></tr></thead>
      <tbody>${inv.unattributed
        .slice(0, 25)
        .map(
          (u) =>
            `<tr><td class="text">${link(u.page, shortPath(u.page))}</td><td class="text">${esc(u.detail ?? u.title)}${u.target ? `<br><code class="note">${esc(u.target.slice(0, 120))}</code>` : ''}</td>` +
            `<td>${value(u.value, u.unit)}</td><td class="text">${esc(u.reason)}</td></tr>`,
        )
        .join('')}</tbody></table></div>
  </details>`
    : '';
  return `<section aria-labelledby="components-h">
  <h2 id="components-h">Components</h2>
  <p>${inv.components.length} components recognised on ${inv.pages} page${inv.pages === 1 ? '' : 's'}${inv.lighthousePages ? `, with Lighthouse evidence for ${inv.lighthousePages}` : ''}.
  These are the structures that drive browser work and the findings tied to them. <strong>None of these figures is a component’s energy.</strong></p>
  ${table}
  ${unattributed}
  <ul class="note">${inv.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
</section>`;
}
