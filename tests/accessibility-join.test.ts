import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { buildGraph } from '../src/model/graph.js';
import { buildAccessibilityJoin, loadAccessibilityContext, parseAccessibilityContext, selectorTypeOf } from '../src/analysis/accessibility.js';
import { accessibilityJoinJsonSchema, validateAccessibilityJoin } from '../src/model/accessibility-join.js';
import { accessibilityContextSection } from '../src/report/accessibility-context-html.js';
import { toHtml } from '../src/report/html.js';
import type { BenchmarkResult } from '../src/core/types.js';

const fixture = (): BenchmarkResult => {
  const r = JSON.parse(readFileSync('tests/fixtures/fixture-site-result.json', 'utf8')) as BenchmarkResult;
  r.graph = buildGraph(r)!;
  return r;
};
const CONTEXT = 'tests/fixtures/accessibility/context.json';

describe('the Open Scans accessibility join', () => {
  it('matches pages, exact CSS selectors, and keeps XPath/HTML/unknown page-level', async () => {
    const result = fixture();
    const context = await loadAccessibilityContext(CONTEXT);
    const join = buildAccessibilityJoin(result, context);

    expect(validateAccessibilityJoin(join)).toEqual([]);
    expect(join.summary).toMatchObject({ observations: 10, pageMatched: 9, componentMatched: 3, pageLevel: 6, unmatched: 1 });

    const figure = join.matches.find((m) => m.observation.observationId === 'obs-exact-figure')!;
    expect(figure.component).toMatchObject({ signature: 'component:live-chart', selector: 'figure' });
    expect(figure.match).toMatchObject({ basis: 'exact-selector', selectorType: 'css', confidence: 'medium' });
    // The Open Scans container label says "Navigation"; identity is the exact
    // selector, not the label.
    expect(figure.component!.signature).not.toBe('component:site-nav');

    const nav = join.matches.find((m) => m.observation.observationId === 'obs-exact-nav')!;
    expect(nav.component).toMatchObject({ signature: 'component:site-nav' });

    const xpath = join.matches.find((m) => m.observation.observationId === 'obs-xpath-figure')!;
    expect(xpath.component).toBeUndefined();
    expect(xpath.match).toMatchObject({ basis: 'page', selectorType: 'xpath', confidence: 'none' });
    expect(xpath.match.reason).toMatch(/xpath-selector-not-compared/);

    const unknown = join.matches.find((m) => m.observation.observationId === 'obs-unknown-engine')!;
    expect(unknown.component).toBeUndefined();
    expect(unknown.match).toMatchObject({ selectorType: 'unknown' });
    expect(unknown.match.reason).toMatch(/selector-language-unknown/);

    const ancestor = join.matches.find((m) => m.observation.observationId === 'obs-ancestor')!;
    expect(ancestor.component).toBeUndefined();
    expect(ancestor.match.reason).toMatch(/ancestor\/descendant/);

    const html = join.matches.find((m) => m.observation.observationId === 'obs-html')!;
    expect(html.match).toMatchObject({ basis: 'page', selectorType: 'html' });
    expect(html.component).toBeUndefined();

    const unmatched = join.unmatched.find((m) => m.observation.observationId === 'obs-unmatched-page')!;
    expect(unmatched.page).toBeUndefined();
    expect(unmatched.match).toMatchObject({ basis: 'none', reason: 'page-not-in-scan' });
  });

  it('preserves duplicate observations rather than deduplicating them', async () => {
    const join = buildAccessibilityJoin(fixture(), await loadAccessibilityContext(CONTEXT));
    expect(join.matches.filter((m) => m.observation.observationId === 'obs-exact-figure')).toHaveLength(2);
  });

  it('never promotes a container candidate to ownership', async () => {
    const join = buildAccessibilityJoin(fixture(), await loadAccessibilityContext(CONTEXT));
    for (const m of [...join.matches, ...join.unmatched]) {
      if (m.observation.container) expect(m.observation.container.ownershipEstablished).toBe(false);
    }
    expect(join.limitations.join(' ')).toMatch(/ownership/);
  });

  it('records selector type from a known engine and refuses unknown ones', async () => {
    const context = await loadAccessibilityContext(CONTEXT);
    for (const o of context.observations) {
      const t = selectorTypeOf(o);
      if ((o.engine === 'axe' || o.engine === 'accesslint') && o.locatorSource === 'selector' && o.selector) expect(t).toBe('css');
      if (o.engine === 'equalaccess' && o.locatorSource === 'selector') expect(t).toBe('xpath');
      if (o.engine === 'mystery-engine') expect(t).toBe('unknown');
      if (o.locatorSource === 'html') expect(t).toBe('html');
    }
  });

  it('escapes all context text in the report and uses accessible tables', async () => {
    const join = buildAccessibilityJoin(fixture(), await loadAccessibilityContext(CONTEXT));
    const html = accessibilityContextSection(join);
    expect(html).toContain('<h2 id="a11y-h">Related accessibility evidence</h2>');
    expect(html).toContain('This is accessibility evidence from Open Scans, not an energy finding and not a WCAG conformance claim.');
    expect(html).toContain('<caption>Accessibility observations matched to a measured page</caption>');
    expect(html).toContain('<th scope="row"');
    expect(html).not.toMatch(/<script|<img\s/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/score/i);
  });

  it('rejects malformed and oversized context files', async () => {
    expect(() => parseAccessibilityContext({})).toThrow(/Invalid Open Scans accessibility context/);
    expect(() => parseAccessibilityContext({ schema: 'a11y-accessibility-context/1', observations: [{ pageUrl: 'x' }] })).toThrow(/Invalid/);
    const dir = mkdtempSync(pathJoin(tmpdir(), 'a11y-context-'));
    const big = pathJoin(dir, 'big.json');
    writeFileSync(big, JSON.stringify({ schema: 'a11y-accessibility-context/1', observations: [] }));
    try {
      await expect(loadAccessibilityContext(big, 10)).rejects.toThrow(/larger than/);
      writeFileSync(big, 'not json');
      await expect(loadAccessibilityContext(big)).rejects.toThrow(/not JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the report unchanged when no context is supplied', () => {
    const result = fixture();
    expect(result.accessibilityContext).toBeUndefined();
    expect(accessibilityContextSection(undefined)).toBe('');
    expect(toHtml(result)).not.toContain('Related accessibility evidence');
  });

  it('keeps the published join schema in step with the code', () => {
    expect(JSON.parse(readFileSync('schema/fes-accessibility-join.schema.json', 'utf8'))).toEqual(accessibilityJoinJsonSchema());
  });
});
