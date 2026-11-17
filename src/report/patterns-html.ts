/** The site-wide recurring patterns, as accessible tables: findings, components, resources. */
import type { SitePatterns } from '../analysis/patterns.js';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export function patternsSection(p: SitePatterns | undefined): string {
  if (!p) return '';
  const patterns = p.patterns.slice(0, 20);
  const components = p.components.filter((c) => c.findings.length > 0).slice(0, 20);
  const resources = p.resources.filter((r) => r.findings.length > 0).slice(0, 20);
  return `<section aria-labelledby="patterns-h" class="boundary">
  <h2 id="patterns-h">Site patterns</h2>
  <p>Findings grouped by the identity the graph recorded, not by a role or class name. ${p.patterns.length} recurring pattern${p.patterns.length === 1 ? '' : 's'} over ${p.pages} measured page${p.pages === 1 ? '' : 's'} and ${p.families} page famil${p.families === 1 ? 'y' : 'ies'}. A repeated observation is not proof of a shared implementation, a cause or a cost; no energy is measured here.</p>
  ${
    patterns.length
      ? `<div class="scroll"><table>
    <caption>Recurring findings, strongest evidence first</caption>
    <thead><tr><th scope="col">#</th><th scope="col">Finding</th><th scope="col">Target</th><th scope="col">Evidence</th><th scope="col">Pages</th><th scope="col">Families</th><th scope="col">Representative</th></tr></thead>
    <tbody>${patterns
      .map(
        (x) =>
          `<tr><td>${x.rank}</td><td class="text">${esc(x.kind)}<br><span class="note">${esc(x.title)}</span></td><td class="text">${esc(x.target.type)}: ${esc(x.target.label)}</td><td class="text">${esc(x.evidenceClass)}</td><td>${x.pages}</td><td>${x.families}</td><td class="text">${esc(x.representative.page)}${x.representative.selector ? `<br><code>${esc(x.representative.selector)}</code>` : ''}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
      : '<p class="note">No recurring findings in the measured pages.</p>'
  }
  ${
    components.length
      ? `<h3>Components with findings</h3><div class="scroll"><table>
    <caption>Component types, their pages and resources</caption>
    <thead><tr><th scope="col">Component</th><th scope="col">Confidence</th><th scope="col">Pages</th><th scope="col">Families</th><th scope="col">Resources</th><th scope="col">Findings</th></tr></thead>
    <tbody>${components
      .map(
        (c) =>
          `<tr><td class="text">${esc(c.signature)}${c.container ? ' <span class="note">(container)</span>' : ''}</td><td>${esc(c.confidence)}</td><td>${c.pages}</td><td>${c.families}</td><td class="text">${c.resources.length ? c.resources.map((r) => `<code>${esc(r.key)}</code>`).join('<br>') : '<span class="note">none recorded</span>'}</td><td class="text">${c.findings.map((f) => `${esc(f.kind)} (${f.pages} page${f.pages === 1 ? '' : 's'})`).join('<br>') || '<span class="note">none</span>'}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
      : ''
  }
  ${
    resources.length
      ? `<h3>Resources with findings</h3><div class="scroll"><table>
    <caption>Resources, their reach and the component types that load them</caption>
    <thead><tr><th scope="col">Resource</th><th scope="col">Scope</th><th scope="col">Pages</th><th scope="col">Component types</th><th scope="col">Findings</th></tr></thead>
    <tbody>${resources
      .map(
        (r) =>
          `<tr><td class="text"><code>${esc(r.key)}</code>${r.thirdParty ? ' <span class="note">(third party)</span>' : ''}</td><td>${esc(r.scope)}</td><td>${r.pages}</td><td class="text">${r.componentTypes.length ? r.componentTypes.map((c) => `${esc(c.signature)} (${esc(c.confidence)})`).join('<br>') : '<span class="note">no component loads it</span>'}</td><td class="text">${r.findings.map((f) => `${esc(f.kind)} (${f.pages} page${f.pages === 1 ? '' : 's'})`).join('<br>') || '<span class="note">none</span>'}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
      : ''
  }
  <ul class="note">${p.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
</section>`;
}
