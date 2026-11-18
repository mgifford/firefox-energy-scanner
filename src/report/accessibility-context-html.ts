/** Optional Open Scans accessibility evidence, clearly separate from energy. */
import type { AccessibilityJoin, AccessibilityMatch } from '../model/accessibility-join.js';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const link = (join: AccessibilityJoin): string => {
  const s = join.sourceContext.scan;
  const report = s?.reportUrl;
  const url = report ?? s?.issueUrl;
  if (!url || !/^https?:\/\//i.test(url)) return '<span class="note">source link not published</span>';
  const label = report ? 'Open Scans report' : s?.issueNumber ? `Open Scans issue #${s.issueNumber}` : 'Open Scans scan';
  return `<a href="${esc(url)}">${esc(label)}</a>`;
};

const observation = (m: AccessibilityMatch): string =>
  `${esc(m.observation.rule)} <span class="note">(${esc(m.observation.engine)})</span>${m.observation.impact ? ` <span class="note">impact ${esc(m.observation.impact)}</span>` : ''}`;

const container = (m: AccessibilityMatch): string => {
  const c = m.observation.container;
  if (!c) return '<span class="note">none recorded</span>';
  return `${esc(c.label ?? c.category ?? c.element ?? 'container candidate')} <span class="note">(${esc(c.category ?? 'unknown category')}, ${esc(c.confidence ?? 'confidence not stated')}; ownership not established)</span>`;
};

const wcag = (m: AccessibilityMatch): string => {
  const sc = m.observation.wcagSc.length ? m.observation.wcagSc.map(esc).join(', ') : '—';
  const act = m.observation.actRuleIds.length ? m.observation.actRuleIds.map(esc).join(', ') : '—';
  return `WCAG ${sc}<br><span class="note">ACT ${act}</span>`;
};

const component = (m: AccessibilityMatch): string =>
  m.component ? `${esc(m.component.signature)}<br><code>${esc(m.component.selector)}</code>` : '<span class="note">page-level only; no component match</span>';

const match = (m: AccessibilityMatch): string =>
  `${esc(m.match.basis)} (${esc(m.match.confidence)}; selector: ${esc(m.match.selectorType)}${m.match.selectorTypeSource ? `, ${esc(m.match.selectorTypeSource)}` : ''})${m.match.reason ? `<br><span class="note">${esc(m.match.reason)}</span>` : ''}`;

export function accessibilityContextSection(join: AccessibilityJoin | undefined, fesViewport?: { width: number; height: number }): string {
  if (!join) return '';
  const rows = join.matches;
  const unmatched = join.unmatched;
  const source = join.sourceContext;
  const scanContext = source.scan?.scanContext;
  const sourceViewport =
    scanContext && typeof scanContext === 'object' && 'viewport' in scanContext
      ? (scanContext as { viewport?: { width?: unknown; height?: unknown } }).viewport
      : undefined;
  const sourceVp =
    sourceViewport && typeof sourceViewport.width === 'number' && typeof sourceViewport.height === 'number'
      ? { width: sourceViewport.width, height: sourceViewport.height }
      : undefined;
  const viewportMatch = sourceVp && fesViewport ? (sourceVp.width === fesViewport.width && sourceVp.height === fesViewport.height ? 'same' : 'different') : 'unknown';
  const pageRows = new Map<string, { observations: number; components: number; pageLevel: number; htmlOnly: number; engines: Set<string> }>();
  for (const m of [...rows, ...unmatched]) {
    const url = m.page?.url ?? m.observation.pageUrl;
    const row = pageRows.get(url) ?? { observations: 0, components: 0, pageLevel: 0, htmlOnly: 0, engines: new Set<string>() };
    row.observations += 1;
    if (m.component) row.components += 1;
    else row.pageLevel += 1;
    if (m.match.selectorType === 'html') row.htmlOnly += 1;
    row.engines.add(m.observation.engine);
    pageRows.set(url, row);
  }
  return `<section aria-labelledby="a11y-h" class="boundary">
  <h2 id="a11y-h">Related accessibility evidence</h2>
  <p class="note"><strong>This is accessibility evidence from Open Scans, not an energy finding and not a WCAG conformance claim.</strong></p>
  <p>${join.summary.observations} observation${join.summary.observations === 1 ? '' : 's'} from Open Scans: ${join.summary.pageMatched} matched to a measured page (${join.summary.componentMatched} to a recorded component instance, ${join.summary.pageLevel} page-level) and ${join.summary.unmatched} unmatched. Components are matched only by exact CSS selector text where the engine is known to use CSS; a container candidate is never treated as ownership.</p>
  <p>Source: ${link(join)}${source.scan?.scanTitle ? ` — ${esc(source.scan.scanTitle)}` : ''}${source.scan?.scannedAt ? ` <span class="note">(scanned ${esc(source.scan.scannedAt)})</span>` : ''}</p>
  <p><strong>Run pairing:</strong> this is accessibility evidence from an Open Scans scan, not the FES run. Source scan viewport ${sourceVp ? `${sourceVp.width}×${sourceVp.height}` : 'not published'}; FES run viewport ${fesViewport ? `${fesViewport.width}×${fesViewport.height}` : 'not recorded'}; viewport match: <strong>${viewportMatch}</strong>. Page URLs are matched; component selectors are exact CSS text and are not DOM-validated across viewports.</p>
  ${
    pageRows.size
      ? `<h3>Summary by page</h3><div class="scroll"><table>
    <caption>Accessibility observations by measured page</caption>
    <thead><tr><th scope="col">Page</th><th scope="col">Observations</th><th scope="col">Component matches</th><th scope="col">Page-level</th><th scope="col">HTML-only</th><th scope="col">Engines</th></tr></thead>
    <tbody>${[...pageRows.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([url, r]) =>
          `<tr><th scope="row" class="text">${esc(url)}</th><td>${r.observations}</td><td>${r.components}</td><td>${r.pageLevel}</td><td>${r.htmlOnly}</td><td class="text">${[...r.engines].sort().map(esc).join(', ')}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
      : ''
  }
  ${
    rows.length
      ? `<h3>All matched observations</h3><div class="scroll"><table>
    <caption>Accessibility observations matched to a measured page</caption>
    <thead><tr><th scope="col">Observation</th><th scope="col">Page</th><th scope="col">Component</th><th scope="col">Selector</th><th scope="col">Match</th><th scope="col">WCAG / ACT</th><th scope="col">Pattern</th><th scope="col">Container candidate</th><th scope="col">Source</th></tr></thead>
    <tbody>${rows
      .map(
        (m) =>
          `<tr><th scope="row" class="text">${observation(m)}</th><td class="text">${esc(m.page?.url ?? m.observation.pageUrl)}</td><td class="text">${component(m)}</td><td class="text">${m.observation.selector ? `<code>${esc(m.observation.selector)}</code>` : '<span class="note">none</span>'}<br><span class="note">${esc(m.observation.locatorSource)}</span></td><td class="text">${match(m)}</td><td class="text">${wcag(m)}</td><td class="text">${esc(m.observation.patternDisplayId ?? m.observation.patternId ?? '—')}</td><td class="text">${container(m)}</td><td class="text">${m.observation.sourceRef ? `<code>${esc(m.observation.sourceRef)}</code>` : '—'}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
      : '<p class="note">No observations matched a measured page.</p>'
  }
  ${
    unmatched.length
      ? `<h3>Accessibility observations not matched to a measured page</h3><div class="scroll"><table>
    <caption>Unmatched accessibility observations, kept visible</caption>
    <thead><tr><th scope="col">Observation</th><th scope="col">Open Scans page</th><th scope="col">Selector</th><th scope="col">Why unmatched</th><th scope="col">Source</th></tr></thead>
    <tbody>${unmatched
      .map(
        (m) =>
          `<tr><th scope="row" class="text">${observation(m)}</th><td class="text">${esc(m.observation.pageUrl)}</td><td class="text">${m.observation.selector ? `<code>${esc(m.observation.selector)}</code>` : '<span class="note">none</span>'}</td><td class="text">${esc(m.match.reason ?? 'page-not-in-scan')}</td><td class="text">${m.observation.sourceRef ? `<code>${esc(m.observation.sourceRef)}</code>` : '—'}</td></tr>`,
      )
      .join('')}</tbody></table></div>`
      : ''
  }
  <ul class="note">${join.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
</section>`;
}
