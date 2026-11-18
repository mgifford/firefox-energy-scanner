/**
 * DOM validation for the Open Scans join: a CSS/XPath observation resolves to
 * one element, then the nearest recorded component ancestor is matched. No
 * energy is measured.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { readFileSync } from 'node:fs';
import { startFixtureSite } from '../fixtures/site/server.mjs';
import { ENGINE, launchTestBrowser } from './engine.js';
import { buildGraph } from '../../src/model/graph.js';
import { parseAccessibilityContext, buildAccessibilityJoin } from '../../src/analysis/accessibility.js';
import { validateAccessibilityJoinDom } from '../../src/analysis/accessibility-dom.js';
import type { BenchmarkResult } from '../../src/core/types.js';

const run = ENGINE ? describe : describe.skip;

run(`accessibility DOM validation in ${ENGINE ?? 'no browser'}`, () => {
  let browser: Browser;
  let site: { url: string; close: () => Promise<void> };
  let result: BenchmarkResult;

  beforeAll(async () => {
    site = await startFixtureSite({ port: 23_000 + Math.floor(Math.random() * 500) });
    browser = await launchTestBrowser();
    result = JSON.parse(readFileSync('tests/fixtures/fixture-site-result.json', 'utf8')) as BenchmarkResult;
    result.graph = buildGraph(result)!;
    const page = result.graph.pages.find((p) => p.url.includes('/articles/d'))!;
    page.url = `${site.url}/articles/d`;
    result.environment.viewport = { width: 1440, height: 900 };
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  it('matches CSS and XPath descendants to the nearest recorded component ancestor', async () => {
    const pageUrl = `${site.url}/articles/d`;
    const context = parseAccessibilityContext({
      schema: 'a11y-accessibility-context/1',
      site: { origin: site.url, host: 'www.site.test' },
      scan: {
        issueNumber: 1,
        issueUrl: 'https://github.com/mgifford/open-scans/issues/1',
        scannedAt: '2026-11-18T00:00:00.000Z',
        engines: ['axe'],
        scanContext: { viewport: { width: 1440, height: 900 } },
      },
      observations: [
        {
          observationId: 'css-descendant',
          rule: 'image-alt',
          engine: 'axe',
          wcagSc: ['111'],
          actRuleIds: [],
          impact: 'critical',
          pageUrl,
          selector: 'canvas',
          selectorType: 'css',
          locator: 'canvas',
          locatorSource: 'selector',
          container: { category: 'chart', label: 'Chart', element: 'figure', basis: 'selector-token', confidence: 'low', ownershipEstablished: false },
          sourceRef: 'results[0].axe',
        },
        {
          observationId: 'xpath-descendant',
          rule: 'image-alt',
          engine: 'axe',
          wcagSc: ['111'],
          actRuleIds: [],
          impact: 'critical',
          pageUrl,
          selector: '//canvas',
          selectorType: 'xpath',
          locator: '//canvas',
          locatorSource: 'selector',
          container: { category: 'chart', label: 'Chart', element: 'figure', basis: 'selector-token', confidence: 'low', ownershipEstablished: false },
          sourceRef: 'results[1].axe',
        },
        {
          observationId: 'ambiguous',
          rule: 'landmark-unique',
          engine: 'axe',
          wcagSc: ['131'],
          actRuleIds: [],
          impact: null,
          pageUrl,
          selector: 'article',
          selectorType: 'css',
          locator: 'article',
          locatorSource: 'selector',
          container: { category: 'unknown', label: 'Unassigned', element: null, basis: 'none', confidence: 'unknown', ownershipEstablished: false },
          sourceRef: 'results[2].axe',
        },
        {
          observationId: 'html-only',
          rule: 'heading-order',
          engine: 'semantica11y',
          wcagSc: ['2410'],
          actRuleIds: [],
          impact: null,
          pageUrl,
          selector: null,
          locator: '<figure><canvas></canvas></figure>',
          locatorSource: 'html',
          container: { category: 'chart', label: 'Chart', element: 'figure', basis: 'html', confidence: 'low', ownershipEstablished: false },
          sourceRef: 'results[3].semantica11y',
        },
      ],
    });
    let join = buildAccessibilityJoin(result, context);
    expect(join.matches.filter((m) => m.component)).toHaveLength(0);
    join = await validateAccessibilityJoinDom(result, join, { browser, maxObservations: 10 });
    const css = join.matches.find((m) => m.observation.observationId === 'css-descendant')!;
    expect(css.component).toMatchObject({ signature: 'component:live-chart' });
    expect(css.match).toMatchObject({ basis: 'ancestor-selector', domValidated: true, confidence: 'medium' });
    expect(css.match.reason).toMatch(/DOM-validated nearest recorded ancestor/);
    const xpath = join.matches.find((m) => m.observation.observationId === 'xpath-descendant')!;
    expect(xpath.component).toMatchObject({ signature: 'component:live-chart' });
    expect(xpath.match).toMatchObject({ basis: 'ancestor-selector', domValidated: true });
    const amb = join.matches.find((m) => m.observation.observationId === 'ambiguous')!;
    expect(amb.component).toBeUndefined();
    expect(amb.match.reason).toMatch(/dom-ambiguous-selector/);
    const html = join.matches.find((m) => m.observation.observationId === 'html-only')!;
    expect(html.component).toBeUndefined();
    expect(html.match.selectorType).toBe('html');
    expect(join.summary.componentMatched).toBe(2);
    expect(join.limitations.join(' ')).toMatch(/DOM validation opened the FES page/);
  }, 60_000);
});
