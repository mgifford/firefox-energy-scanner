/**
 * The removal code, run in a real browser on the fixture site's pages: the
 * selector checks, the removal itself, re-insertion, what the removed
 * subtrees held, and whether script work carried on. No energy is measured.
 *
 * Runs in Firefox when Playwright's Firefox is installed, else in Chromium;
 * skipped when neither is (see engine.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { startFixtureSite } from '../fixtures/site/server.mjs';
import { ENGINE, launchTestBrowser } from './engine.js';
import {
  activityBetween,
  checkpoint,
  essentialContent,
  installActivityCounters,
  readActivity,
  removalProbe,
} from '../../src/experiments/dom-removal.js';
import { activityFindings } from '../../src/experiments/experiment.js';
import { installPreloadRemoval } from '../../src/experiments/preload-removal.js';
import { emptyCounts } from '../../src/experiments/variants.js';

const run = ENGINE ? describe : describe.skip;

run(`DOM removal in ${ENGINE ?? 'no browser'}`, () => {
  let browser: Browser;
  let site: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    site = await startFixtureSite({ port: 18_000 + Math.floor(Math.random() * 1_000) });
    browser = await launchTestBrowser();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  async function open(path: string, counters = true): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    if (counters) await installActivityCounters(context);
    const page = await context.newPage();
    await page.goto(`${site.url}${path}`, { waitUntil: 'load' });
    return { context, page };
  }
  const count = (page: Page, sel: string) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

  it('removes the subtree, leaves the rest of the page, and keeps it removed', async () => {
    const { context, page } = await open('/lab/static');
    const before = await count(page, '*');
    const cp = await checkpoint(page, '[data-component-id="archive"]', true, 24);
    expect(cp).toMatchObject({ matched: 1, roots: 1, nested: 0, removed: 1, remaining: 0 });
    expect(cp.refused).toBeUndefined();
    expect(cp.content.elements).toBe(1 + 1 + 1500); // section, ul, 1500 li
    expect(cp.identities[0]).toMatchObject({ tag: 'section', componentId: 'archive', nodes: 1502 });
    expect(await count(page, '*')).toBe(before - 1502);
    // Unrelated components are intact.
    for (const id of ['site-header', 'site-nav', 'site-footer', 'badge']) expect(await count(page, `[data-component-id="${id}"]`)).toBe(1);
    await page.waitForTimeout(400);
    expect(await removalProbe(page, '[data-component-id="archive"]')).toEqual({ matchesNow: 0, reinsertions: 0, rootsReconnected: 0 });
    await context.close();
  });

  it('on the baseline side, finds the same matches and changes nothing', async () => {
    const { context, page } = await open('/lab/static');
    const before = await count(page, '*');
    const cp = await checkpoint(page, '[data-component-id="archive"]', false, 24);
    expect(cp).toMatchObject({ matched: 1, roots: 1, removed: 0, remaining: 1 });
    expect(cp.content.elements).toBe(1502);
    expect(await count(page, '*')).toBe(before);
    await context.close();
  });

  it('removes nested matches once, with their outermost match', async () => {
    const { context, page } = await open('/articles/a');
    const cp = await checkpoint(page, '[data-component-id="card"], [data-component-id="card-list"]', true, 24);
    expect(cp).toMatchObject({ matched: 5, roots: 1, nested: 4, removed: 1, remaining: 0 });
    expect(cp.content.headings).toBe(4);
    // The shared script's own element went with the list; the site script did not.
    expect(await count(page, 'script[src="/js/cards.js"]')).toBe(0);
    expect(await count(page, 'script[src="/js/site.js"]')).toBe(1);
    await context.close();
  });

  it('refuses invalid, empty, too broad and whole-document selectors, removing nothing', async () => {
    const { context, page } = await open('/big-list');
    const before = await count(page, '*');
    const cases: [string, string][] = [
      ['li[', 'invalid-selector'],
      ['.does-not-exist', 'no-match'],
      ['li', 'too-broad'],
      ['body', 'document-structure'],
      [':is(html)', 'document-structure'],
      ['main, body', 'document-structure'],
    ];
    for (const [sel, reason] of cases) {
      const cp = await checkpoint(page, sel, true, 24);
      expect(cp.refused, sel).toBe(reason);
      expect(cp.removed, sel).toBe(0);
    }
    expect(await count(page, '*')).toBe(before);
    // Raising the limit is a deliberate choice, and then it is allowed (2,000 items and the navigation's 8).
    expect((await checkpoint(page, 'li', true, 2_100)).removed).toBe(2_008);
    await context.close();
  });

  it('sees a component the page puts back', async () => {
    const { context, page } = await open('/lab/remount');
    const cp = await checkpoint(page, '[data-component-id="promo"]', true, 24);
    expect(cp.removed).toBe(1);
    await page.waitForTimeout(700);
    const probe = await removalProbe(page, '[data-component-id="promo"]');
    expect(probe.matchesNow).toBe(1);
    expect(probe.reinsertions).toBeGreaterThanOrEqual(1);
    expect(probe.rootsReconnected).toBe(1);
    expect(probe.firstReinsertionMs).toBeGreaterThanOrEqual(0);
    await context.close();
  });

  it('records that a removed component’s timer keeps running', async () => {
    const side = async (apply: boolean) => {
      const { context, page } = await open('/lab/ticker');
      const a = await readActivity(page);
      const t0 = Date.now();
      await checkpoint(page, '[data-component-id="ticker"]', apply, 24);
      const ticks0 = await page.evaluate(() => (window as unknown as { tickerCount?: number }).tickerCount ?? 0);
      await page.waitForTimeout(1_000);
      const ticks1 = await page.evaluate(() => (window as unknown as { tickerCount?: number }).tickerCount ?? 0);
      const w = activityBetween(a, await readActivity(page), Date.now() - t0)!;
      await context.close();
      return { w, ticks: ticks1 - ticks0 };
    };
    const base = await side(false);
    const removed = await side(true);
    // The element is gone, and its interval still fires about ten times a second.
    expect(removed.ticks).toBeGreaterThanOrEqual(5);
    expect(removed.w.intervals).toBeGreaterThanOrEqual(5);
    const f = activityFindings(base.w, removed.w);
    expect(f.continued.some((c) => c.startsWith('timer callbacks'))).toBe(true);
    expect(f.note).toMatch(/carried on/);
  });

  it('records that a timer which checks for its element stops', async () => {
    const side = async (apply: boolean) => {
      const { context, page } = await open('/lab/polite');
      const a = await readActivity(page);
      const t0 = Date.now();
      await checkpoint(page, '[data-component-id="polite-ticker"]', apply, 24);
      await page.waitForTimeout(1_000);
      const w = activityBetween(a, await readActivity(page), Date.now() - t0)!;
      await context.close();
      return w;
    };
    const f = activityFindings(await side(false), await side(true));
    expect(f.fell.some((c) => c.startsWith('timer callbacks'))).toBe(true);
    expect(f.continued).toEqual([]);
  });

  it('records that an animation-frame loop keeps running after its canvas is removed', async () => {
    const { context, page } = await open('/articles/d');
    const a = await readActivity(page);
    const t0 = Date.now();
    const cp = await checkpoint(page, '[data-component-id="live-chart"]', true, 24);
    expect(cp.content.canvases).toBe(1);
    await page.waitForTimeout(1_000);
    const w = activityBetween(a, await readActivity(page), Date.now() - t0)!;
    // Headless browsers still run animation frames for a visible page.
    expect(w.animationFrames).toBeGreaterThanOrEqual(10);
    await context.close();
  });

  it('stops a CSS animation with its element', async () => {
    const { context, page } = await open('/spinner');
    const a = await readActivity(page);
    expect(a.runningAnimations).toBeGreaterThanOrEqual(1);
    await checkpoint(page, '[data-component-id="spinner"]', true, 24);
    const b = await readActivity(page);
    expect(b.runningAnimations).toBe(0);
    await context.close();
  });

  it('unloads an iframe when its element is removed', async () => {
    const { context, page } = await open('/embed');
    await page.waitForTimeout(300);
    const frames = page.frames().length;
    const cp = await checkpoint(page, '[data-component-id="widget-embed"]', true, 24);
    expect(cp.content.iframes).toBe(1);
    await page.waitForTimeout(300);
    expect(page.frames().length).toBe(frames - 1);
    await context.close();
  });

  it('says what people would lose when a component they use is removed', async () => {
    const { context, page } = await open('/table');
    const cp = await checkpoint(page, '[data-component-id="data-table"]', true, 24);
    expect(cp.content.formControls).toBeGreaterThanOrEqual(1);
    expect(essentialContent(cp.content).join(' ')).toMatch(/form control/);
    expect(await page.getByRole('button', { name: 'Sort by value' }).count()).toBe(0);
    await context.close();
  });

  it('counts callbacks in the top frame only, and leaves the page’s timers working', async () => {
    const { context, page } = await open('/lab/ticker');
    await page.waitForTimeout(350);
    const ticks = await page.evaluate(() => (window as unknown as { tickerCount: number }).tickerCount);
    expect(ticks).toBeGreaterThanOrEqual(2);
    const act = await readActivity(page);
    expect(act.available).toBe(true);
    expect(act.intervals).toBeGreaterThanOrEqual(ticks);
    await context.close();
  });
});

run(`pre-load removal in ${ENGINE ?? 'no browser'}`, () => {
  let browser: Browser;
  // The document is fetched from Node, which does not share the browser's host mapping.
  let site: { url: string; port: number; close: () => Promise<void> };

  beforeAll(async () => {
    site = await startFixtureSite({ port: 19_000 + Math.floor(Math.random() * 1_000) });
    site.url = `http://127.0.0.1:${site.port}`;
    browser = await launchTestBrowser();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await site?.close();
  });

  async function side(path: string, selector: string, apply: boolean) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const counts = emptyCounts();
    const snap = await installPreloadRemoval(context, page, `${site.url}${path}`, selector, apply, 24, counts);
    await page.goto(`${site.url}${path}`, { waitUntil: 'load' });
    return { context, page, counts, snap };
  }
  const count = (page: Page, sel: string) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

  it('serves the page without the component, parsed and serialised by the browser', async () => {
    const v = await side('/lab/static', '[data-component-id="archive"]', true);
    expect(v.snap.checkpoint).toMatchObject({ matched: 1, roots: 1, removed: 1, remaining: 0 });
    expect(v.snap.checkpoint.content.elements).toBe(1502);
    expect(await count(v.page, '[data-component-id="archive"]')).toBe(0);
    expect(await count(v.page, '[data-component-id="badge"]')).toBe(1);
    expect(await count(v.page, '[data-component-id="site-nav"]')).toBe(1);
    expect(v.counts).toMatchObject({ documentsRewritten: 1, changes: 1 });
    expect(await v.page.evaluate(() => document.compatMode)).toBe('CSS1Compat'); // the doctype survived
    expect(v.snap.bytes).toBeLessThan(v.snap.originalBytes);
    await v.context.close();
  });

  it('on the baseline, the round trip changes nothing the browser sees', async () => {
    const b = await side('/lab/static', '[data-component-id="archive"]', false);
    expect(b.snap.checkpoint).toMatchObject({ matched: 1, removed: 0 });
    const plain = await browser.newContext();
    const p = await plain.newPage();
    await p.goto(`${site.url}/lab/static`, { waitUntil: 'load' });
    const shape = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('*')).map((e) => e.tagName).join(','));
    expect(await shape(b.page)).toBe(await shape(p));
    expect(await b.page.title()).toBe(await p.title());
    expect(b.counts).toMatchObject({ documentsRewritten: 1, changes: 0 });
    await b.context.close();
    await plain.close();
  });

  it('removes a component’s inline script before it can run', async () => {
    const v = await side('/articles/a', '[data-component-id="card-list"]', true);
    expect(await count(v.page, 'script[src="/js/cards.js"]')).toBe(0);
    expect(await v.page.evaluate(() => (window as unknown as { cardsReady?: boolean }).cardsReady ?? false)).toBe(false);
    await v.context.close();
  });

  it('sees a component the page’s script creates when the markup lacks it', async () => {
    const v = await side('/lab/ensure', '[data-component-id="notice"]', true);
    expect(v.snap.checkpoint.removed).toBe(1);
    const probe = await removalProbe(v.page, '[data-component-id="notice"]');
    expect(probe.matchesNow).toBe(1);
    expect(probe.reinsertions).toBeGreaterThanOrEqual(1);
    await v.context.close();
  });

  it('refuses a redirect, a file, and a selector the markup does not hold', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await expect(installPreloadRemoval(context, page, `${site.url}/lab/moved`, 'p', true, 24, emptyCounts())).rejects.toThrow(/redirects \(HTTP 301 to .*\/lab\/static\)/);
    await expect(installPreloadRemoval(context, page, `${site.url}/files/data.csv`, 'p', true, 24, emptyCounts())).rejects.toThrow(/not an HTML page/);
    const snap = await installPreloadRemoval(context, page, `${site.url}/lab/static`, '.made-by-script', true, 24, emptyCounts());
    expect(snap.checkpoint.refused).toBe('no-match');
    expect(snap.checkpoint.refusedDetail).toMatch(/created by script/);
    expect(snap.bytes).toBe(snap.originalBytes); // refused: served as fetched
    await context.close();
  });
});
