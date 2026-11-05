import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { rewriteHtml, safeSelector, validateVariant, variantApplied, emptyCounts, type VariantProbe } from '../src/experiments/variants.js';
import { accessibilityChanges, buildReport, parseSpec, summarizeExperiment, type SideState } from '../src/experiments/experiment.js';
import { specFromQueue } from '../src/experiments/from-queue.js';
import { checkJourneySource } from '../src/experiments/journey-lint.js';
import { experimentCsv } from '../src/report/experiment-csv.js';
import { experimentSection } from '../src/report/experiment-html.js';
import type { BenchmarkResult, StepResult } from '../src/core/types.js';
import type { InvestigationItem } from '../src/analysis/investigation.js';
import { REMEDIATIONS } from '../src/analysis/remediation.js';

describe('rewriteHtml', () => {
  const page = '<!doctype html><html><head><title>x</title></head><body><img src="a.png"><img src="b.png"><img src="c.png" loading="eager"><img src=d.png alt="d"><video src="v.mp4" autoplay muted></video><video autoplay="autoplay" src="w.mp4"></video></body></html>';

  it('adds loading="lazy" after the eager images, leaving set attributes alone', () => {
    const { html, changes } = rewriteHtml(page, { kind: 'lazy-images', keepEager: 2 }, true);
    expect(changes).toBe(1);
    expect(html).toContain('<img src="a.png">');
    expect(html).toContain('<img src="c.png" loading="eager">');
    expect(html).toContain('<img loading="lazy" src=d.png alt="d">');
  });

  it('removes autoplay in its spellings', () => {
    const { html, changes } = rewriteHtml(page, { kind: 'no-autoplay' }, true);
    expect(changes).toBe(2);
    expect(html).not.toMatch(/autoplay/);
    expect(html).toContain('<video src="v.mp4" muted>');
  });

  it('injects a scoped style for pause and hide, right after <head>', () => {
    expect(rewriteHtml(page, { kind: 'pause-animations', selector: 'main > .carousel' }, true).html).toContain(
      '<head><style data-web-energy-experiment>main > .carousel, main > .carousel *, main > .carousel::before',
    );
    expect(rewriteHtml('<p>no head</p>', { kind: 'hide', selector: '.promo' }, true).html).toBe(
      '<style data-web-energy-experiment>.promo { display: none !important; }</style><p>no head</p>',
    );
  });

  it('leaves the baseline side unchanged', () => {
    for (const kind of ['lazy-images', 'no-autoplay', 'pause-animations', 'hide'] as const) {
      expect(rewriteHtml(page, { kind, selector: '.x' }, false)).toEqual({ html: page, changes: 0 });
    }
  });

  it('refuses selectors that could leave the style element', () => {
    expect(safeSelector('main > div.carousel')).toBe('main > div.carousel');
    for (const bad of ['</style><script>x()</script>', 'a{}', 'a;b', '/* x */', 'a\\66']) expect(safeSelector(bad)).toBeUndefined();
    expect(rewriteHtml('<head></head>', { kind: 'hide', selector: '</style>' }, true).changes).toBe(0);
    expect(validateVariant({ kind: 'hide', selector: '</style>' })[0]).toMatch(/cannot be used/);
    expect(validateVariant({ kind: 'block' })[0]).toMatch(/host or URL/);
  });
});

const probe = (o: Partial<VariantProbe> = {}): VariantProbe => ({
  matched: 1, runningAnimations: 0, hidden: 0, reducedMotion: false, lazyImages: 0, playingVideos: 0,
  landmarks: 4, headings: 3, imagesWithoutAlt: 0, focusable: 20, ...o,
});
const counts = (o: Partial<ReturnType<typeof emptyCounts>> = {}) => ({ ...emptyCounts(), ...o });

describe('variantApplied', () => {
  it('says when a change took effect, and when it could not', () => {
    const pause = { kind: 'pause-animations' as const, selector: '.c' };
    expect(variantApplied(pause, { probe: probe({ runningAnimations: 2 }), counts: counts() }, { probe: probe(), counts: counts() }).ok).toBe(true);
    expect(variantApplied(pause, { probe: probe(), counts: counts() }, { probe: probe(), counts: counts() }).note).toMatch(/nothing to pause/);
    expect(variantApplied(pause, { probe: probe({ runningAnimations: 2 }), counts: counts() }, { probe: probe({ runningAnimations: 1 }), counts: counts() }).note).toMatch(/script-driven/);
    const motion = { kind: 'reduced-motion' as const };
    expect(variantApplied(motion, { probe: probe({ runningAnimations: 3 }), counts: counts() }, { probe: probe({ reducedMotion: true, runningAnimations: 3 }), counts: counts() }).note).toMatch(/does not respond/);
    const lazy = { kind: 'lazy-images' as const };
    expect(variantApplied(lazy, { probe: probe(), counts: counts() }, { probe: probe(), counts: counts({ documentsRewritten: 4, changes: 40 }) }).note).toMatch(/^10 images/);
    expect(variantApplied({ kind: 'hide', selector: '.x' }, { probe: probe({ matched: 0 }), counts: counts() }, { probe: probe({ matched: 0 }), counts: counts() }).ok).toBe(false);
  });
});

describe('parseSpec', () => {
  it('fills defaults and refuses what cannot run', () => {
    const s = parseSpec({ name: 'x', url: 'https://a.org/', kind: 'reduced-motion' });
    expect(s).toMatchObject({ idle_ms: 10_000, assertions: [] });
    expect(() => parseSpec({ name: 'x', url: 'https://a.org/', kind: 'teleport' })).toThrow(/kind/);
    expect(() => parseSpec({ name: 'x', url: 'not a url', kind: 'hide', selector: '.a' })).toThrow(/url/);
    expect(() => parseSpec({ name: 'x', url: 'https://a.org/', kind: 'hide' })).toThrow(/needs a selector/);
    expect(() => parseSpec({ name: 'x', url: 'https://a.org/', kind: 'reduced-motion', assertions: [{ name: 'only a name' }] })).toThrow(/role, text or label/);
  });

  it('reads the example spec', () => {
    const s = parseSpec(parseYaml(readFileSync('examples/experiments/carousel-animation.yaml', 'utf8')));
    expect(s).toMatchObject({ kind: 'pause-animations', selector: 'div.hero-carousel', runs: 10 });
    expect(s.assertions).toHaveLength(2);
  });
});

function run(scenario: string, step: string, mwh: number | undefined, i: number, duration = 1000, bytes = 10_000): StepResult {
  return {
    scenario, step, run: i, warmup: false, url: 'https://a.org/', startedAt: 0, endedAt: 1, timing: { durationMs: duration },
    network: { requests: 1, transferBytes: bytes, thirdPartyRequests: 0, thirdPartyBytes: 0, byType: {} },
    ...(mwh !== undefined
      ? { energy: { raw: { adapterId: 'x', measurementType: 'observed', measurementScope: 'process', available: true, durationMs: 1000, sampleCount: 10 }, incrementalJoules: mwh * 3.6 } as StepResult['energy'] }
      : {}),
    valid: true, warnings: [],
  };
}
const series = (scenario: string, step: string, values: (number | undefined)[]) => values.map((v, i) => run(scenario, step, v, i));
const around = (centre: number, n: number) => Array.from({ length: n }, (_, i) => centre + ((i % 5) - 2) * 0.001);

describe('summarizeExperiment', () => {
  it('reports not measured on a machine without energy, keeping time and transfer', () => {
    const [d] = summarizeExperiment(series('baseline', 'idle', [undefined, undefined]), series('variant', 'idle', [undefined, undefined]));
    expect(d).toMatchObject({ verdict: 'not-measured', durationMs: [1000, 1000], transferBytes: [10_000, 10_000] });
    expect(d!.energy).toBeUndefined();
  });

  it('reads a lower variant only beyond both spreads, with enough runs', () => {
    const [d] = summarizeExperiment(series('baseline', 'idle', around(0.1, 10)), series('variant', 'idle', around(0.06, 10)));
    expect(d!.verdict).toBe('lower');
    expect(d!.indicative).toBe(false);
    expect(d!.energy!.differenceMwh).toBeCloseTo(-0.04, 6);
    expect(d!.energy!.percent).toBe(-40);
    expect(d!.reading).toMatch(/0\.040 mWh less/);
  });

  it('says within spread, below resolution, and indicative when it should', () => {
    expect(summarizeExperiment(series('b', 'idle', around(0.1, 10)), series('v', 'idle', around(0.1005, 10)))[0]!.verdict).toBe('within-spread');
    expect(summarizeExperiment(series('b', 'idle', [0.01, -0.02, 0.03, -0.01]), series('v', 'idle', around(0.1, 4)))[0]!.verdict).toBe('below-resolution');
    const few = summarizeExperiment(series('b', 'idle', around(0.1, 3)), series('v', 'idle', around(0.2, 3)))[0]!;
    expect(few).toMatchObject({ verdict: 'higher', indicative: true });
    expect(few.reading).toMatch(/Indicative/);
  });

  it('never converts anything else into energy', () => {
    const [d] = summarizeExperiment(series('b', 'load', [undefined]), [run('v', 'load', undefined, 0, 500, 2_000)]);
    expect(d!.energy).toBeUndefined();
    expect(d!.transferBytes).toEqual([10_000, 2_000]);
  });
});

describe('buildReport', () => {
  const spec = parseSpec({ name: 'x', url: 'https://a.org/', kind: 'pause-animations', selector: '.c', assertions: [{ role: 'main' }] });
  const side = (p: VariantProbe, failures: string[] = []): SideState => ({ counts: emptyCounts(), probes: [p], assertionFailures: failures, runs: 1 });

  it('reports no difference when the change did not apply', () => {
    const r = buildReport(spec, { a: side(probe()), b: side(probe()) }, { a: series('b', 'idle', around(0.1, 10)), b: series('v', 'idle', around(0.05, 10)) }, 's', ['a', 'b']);
    expect(r.applied.ok).toBe(false);
    expect(r.differences).toEqual([]);
  });

  it('keeps failed checks and accessibility changes, and warns when only the variant broke something', () => {
    const r = buildReport(
      spec,
      { a: side(probe({ runningAnimations: 1 })), b: side(probe({ headings: 2 }), ['role main not visible']) },
      { a: series('b', 'idle', around(0.1, 10)), b: series('v', 'idle', around(0.05, 10)) },
      's',
      ['a', 'b'],
    );
    expect(r.applied.ok).toBe(true);
    expect(r.assertions).toEqual({ checked: 1, baseline: [], variant: ['role main not visible'] });
    expect(r.accessibility.changed).toEqual(['headings: 3 → 2']);
    expect(r.limitations.join(' ')).toMatch(/broke something/);
    expect(r.limitations[0]).toMatch(/not an energy figure for the component/);
    expect(accessibilityChanges(probe(), probe())).toEqual([]);
  });
});

describe('specFromQueue', () => {
  const item = (o: Partial<InvestigationItem>): InvestigationItem => ({
    rank: 1, kind: 'component', id: 'cmp-1', title: 'component:carousel', evidence: 'structure', because: [],
    reach: { pages: 1, of: 1, families: 1 }, workload: {}, remediation: [], confidence: 'high',
    where: [{ page: 'https://a.org/', selector: 'div.carousel' }], audits: [], ...o,
  });
  const result = (items: InvestigationItem[], thirdPartyHosts: string[] = []) =>
    ({
      investigation: { method: 'queue-v1', order: [], items, limitations: [] },
      components: { components: [{ id: 'cmp-1', thirdPartyHosts, resources: [{ url: 'https://a.org/c.js', kind: 'script' }] }] },
    }) as unknown as BenchmarkResult;

  it('turns a remedy into the matching experiment, scoped to the item', () => {
    expect(specFromQueue(result([item({ remediation: [REMEDIATIONS['stop-endless-animation']!] })]), 1).spec).toMatchObject({
      kind: 'pause-animations', selector: 'div.carousel', url: 'https://a.org/',
    });
    expect(specFromQueue(result([item({ remediation: [REMEDIATIONS['facade-iframe']!] })], ['player.example.net']), 1).spec).toMatchObject({ kind: 'block', hosts: ['player.example.net'] });
    expect(specFromQueue(result([item({ remediation: [REMEDIATIONS['facade-iframe']!] })]), 1).spec).toMatchObject({ kind: 'hide', selector: 'div.carousel' });
    expect(specFromQueue(result([item({ remediation: [REMEDIATIONS['reduce-dom']!] })]), 1).spec.kind).toBe('hide');
    expect(specFromQueue(result([item({ remediation: [REMEDIATIONS['lazy-load-images']!] })]), 1).spec).toMatchObject({ kind: 'lazy-images', keep_eager: 2 });
    const script = item({ kind: 'script', title: '…/js/all.js', url: 'https://a.org/js/all.js?v=3', remediation: [REMEDIATIONS['audit-global-script']!], where: [{ page: 'https://a.org/' }] });
    expect(specFromQueue(result([script]), 1).spec).toMatchObject({ kind: 'block', urls: ['https://a.org/js/all.js?v=3'] });
  });

  it('says when no experiment fits', () => {
    expect(() => specFromQueue(result([item({ remediation: [REMEDIATIONS['compare-with-family']!] })]), 1)).toThrow(/No experiment fits/);
    expect(() => specFromQueue(result([]), 3)).toThrow(/No item 3/);
  });
});

describe('checkJourneySource', () => {
  const ok = readFileSync('examples/journeys/home-idle.journey.js', 'utf8');
  const rules = (src: string) => checkJourneySource(src).map((i) => `${i.level}:${i.rule}`);

  it('passes the example journey', () => {
    expect(checkJourneySource(ok)).toEqual([]);
  });

  it('catches sleeps, markup locators, credentials, session data and missing boundaries', () => {
    const bad = `import { defineJourney } from 'x';
export default defineJourney({ name: 'b', async run({ page, measure }) {
  await measure('search', async () => {
    await page.locator('//div[@id="x"]').click();
    await page.locator('#search > li:nth-child(2)').click();
    await page.waitForTimeout(3000);
    const password = 'hunter2hunter2';
    await page.getByLabel('Password').fill('hunter2');
    await page.context().storageState({ path: '.auth/state.json' });
  });
}});`;
    const r = rules(bad);
    expect(r).toEqual(expect.arrayContaining(['error:semantic-locators', 'warning:semantic-locators', 'error:no-sleep', 'error:no-credentials', 'warning:no-session-data', 'warning:assertions', 'warning:setup-boundary']));
    expect(rules("import { test } from '@playwright/test'; test('x', async ({ page }) => {});")).toEqual(
      expect.arrayContaining(['error:define-journey', 'error:not-a-test', 'error:measurement-boundary']),
    );
  });

  it('allows an idle window that says it is one', () => {
    const idle = ok.replace("await page.waitForTimeout(IDLE_MS);", 'await page.waitForTimeout(5000); // intentional idle');
    expect(rules(idle)).toEqual([]);
  });
});

describe('experiment output', () => {
  const spec = parseSpec({ name: 'carousel', url: 'https://a.org/', kind: 'pause-animations', selector: '.c' });
  const side = (p: VariantProbe): SideState => ({ counts: emptyCounts(), probes: [p], assertionFailures: [], runs: 10 });
  const report = buildReport(spec, { a: side(probe({ runningAnimations: 1 })), b: side(probe()) }, { a: series('b', 'idle', around(0.1, 10)), b: series('v', 'idle', around(0.06, 10)) }, 'seed-1', ['a', 'b']);
  const result = { experiment: report } as unknown as BenchmarkResult;

  it('writes one CSV row per step, with both sides and the verdict', () => {
    const [head, row] = experimentCsv(result).trim().split('\n');
    expect(head!.split(',')).toContain('energy_difference_mwh');
    expect(row).toMatch(/^carousel,https:\/\/a\.org\/,pause-animations,/);
    expect(row).toContain(',lower,false,');
  });

  it('renders the difference as a difference, and refuses to show one when the change did not apply', () => {
    const html = experimentSection(report);
    expect(html).toContain('<caption>Measured difference per step: observed incremental energy in mWh (baseline → with the change)</caption>');
    expect(html).toContain('lower with the change');
    expect(html).not.toMatch(/<script|<canvas/i);
    const notApplied = buildReport(spec, { a: side(probe()), b: side(probe()) }, { a: [], b: [] }, 's', []);
    const html2 = experimentSection(notApplied);
    expect(html2).toContain('<strong>Applied: no.</strong>');
    expect(html2).not.toContain('<caption>Measured difference');
  });
});
