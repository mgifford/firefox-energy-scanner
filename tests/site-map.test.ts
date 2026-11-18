import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildGraph } from '../src/model/graph.js';
import { buildFamilies } from '../src/analysis/families.js';
import { siteMapSection } from '../src/report/site-map-html.js';
import { toHtml } from '../src/report/html.js';
import type { BenchmarkResult } from '../src/core/types.js';

const result = (): BenchmarkResult => {
  const r = JSON.parse(readFileSync('tests/fixtures/fixture-site-result.json', 'utf8')) as BenchmarkResult;
  r.graph = buildGraph(r)!;
  r.families = buildFamilies(r.scenarios, r.sampling?.listed !== undefined ? { listed: r.sampling.listed } : {})!;
  return r;
};

describe('the report site map', () => {
  it('links site, families, pages, component types and resources', () => {
    const html = siteMapSection(result());
    expect(html).toContain('<section aria-labelledby="site-map-h"');
    expect(html).toContain('<nav aria-label="Site map sections">');
    expect(html).toContain('<caption>Measured page families</caption>');
    expect(html).toContain('<caption>Measured pages, with family, components, scripts and findings</caption>');
    expect(html).toContain('<caption>Component types and where they occur</caption>');
    expect(html).toContain('<caption>Resources, loaders and findings</caption>');
    expect(html).toContain('<caption>Source, unit and boundary for the map</caption>');
    expect(html).toMatch(/id="page-/);
    expect(html).toMatch(/id="type-/);
    expect(html).toMatch(/id="resource-/);
    expect(html).toMatch(/id="family-/);
    expect(html).toContain('href="#page-');
    expect(html).toContain('href="#type-');
    expect(html).toContain('href="#resource-');
    expect(html).toContain('href="#site-map-pages"');
  });

  it('keeps the map navigation-only and script-free', () => {
    const html = siteMapSection(result());
    expect(html).not.toContain('<script');
    expect(html).toContain('not a combined score');
    expect(html).toContain('never per element');
    expect(html).toContain('not energy and not a WCAG conformance claim');
  });

  it('is included in the full report', () => {
    const r = result();
    const html = toHtml(r);
    expect(html).toContain('id="site-map-h"');
    expect(html).toContain('<caption>Source, unit and boundary for the map</caption>');
  });
});
