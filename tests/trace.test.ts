import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyseTrace, mainThreadOf, type TraceEvent } from '../src/trace/analyse.js';
import { installedPlaywrightChromiums } from '../src/trace/run.js';
import { pickTraceUrls } from '../src/trace/select.js';
import { extractEvidence } from '../src/lighthouse/evidence.js';
import { buildGraph, type ComponentGraph } from '../src/model/graph.js';
import { validateGraph } from '../src/model/schema.js';
import { buildFamilies } from '../src/analysis/families.js';
import type { BenchmarkResult } from '../src/core/types.js';
import type { TraceRecord } from '../src/trace/run.js';
import type { LighthouseSummary } from '../src/lighthouse/summary.js';
import { tracesSection } from '../src/report/traces-html.js';
import { focusableScrollRegions } from '../src/report/scroll-regions.js';

/**
 * A synthetic trace, in microseconds: page renderer pid 1, a cross-site iframe
 * in pid 2. Load is [0, 1 s), idle [1 s, 3 s).
 */
function syntheticTrace(): TraceEvent[] {
  const ev: TraceEvent[] = [
    { name: 'thread_name', ph: 'M', ts: 0, pid: 1, tid: 10, args: { name: 'CrRendererMain' } },
    { name: 'thread_name', ph: 'M', ts: 0, pid: 2, tid: 20, args: { name: 'CrRendererMain' } },
    { name: 'FrameCommittedInBrowser', ph: 'I', ts: 1, pid: 9, tid: 1, args: { data: { processId: 1, url: 'https://a.test/', isOutermostMainFrame: true } } },
    { name: 'FrameCommittedInBrowser', ph: 'I', ts: 2, pid: 9, tid: 1, args: { data: { processId: 2, url: 'https://widget.test/frame', isOutermostMainFrame: false } } },
    // Load: an 80 ms task evaluating app.js.
    { name: 'RunTask', ph: 'X', ts: 100_000, dur: 80_000, pid: 1, tid: 10 },
    { name: 'EvaluateScript', ph: 'X', ts: 100_000, dur: 75_000, pid: 1, tid: 10, args: { data: { url: 'https://a.test/app.js' } } },
    // The browser's own favicon fetch, and a real idle request from the page.
    { name: 'ResourceSendRequest', ph: 'I', ts: 1_100_000, pid: 1, tid: 10, args: { data: { url: 'https://a.test/favicon.ico', resourceType: 'Other' } } },
    { name: 'ResourceSendRequest', ph: 'I', ts: 1_200_000, pid: 1, tid: 10, args: { data: { url: 'https://a.test/poll', resourceType: 'Fetch' } } },
    // A CSS animation running throughout.
    { name: 'Animation', ph: 'b', ts: 50_000, pid: 1, tid: 10, id: 'a1', args: { data: { displayName: 'spin', nodeId: 7, nodeName: 'DIV', state: 'running' } } },
    // An animation that ended during load does not count as idle work.
    { name: 'Animation', ph: 'b', ts: 60_000, pid: 1, tid: 10, id: 'a2', args: { data: { displayName: 'fade', nodeId: 8, state: 'running' } } },
    { name: 'Animation', ph: 'e', ts: 500_000, pid: 1, tid: 10, id: 'a2' },
    // A timer installed from tick.js, firing twice while idle.
    { name: 'TimerInstall', ph: 'I', ts: 150_000, pid: 1, tid: 10, args: { data: { timerId: 5, timeout: 1000, singleShot: false, stackTrace: [{ url: 'https://a.test/tick.js', lineNumber: 4 }] } } },
    // The iframe's timer has the same id in its own process: it must not relabel the page's.
    { name: 'TimerInstall', ph: 'I', ts: 160_000, pid: 2, tid: 20, args: { data: { timerId: 5, timeout: 250, singleShot: false, stackTrace: [{ url: 'https://widget.test/w.js', lineNumber: 1 }] } } },
  ];
  // Idle: 40 animation frames over 2 s (20 a second), each running anim.js inside an untitled
  // callback and requesting the next frame from inside it, as a render loop does.
  for (let k = 0; k < 40; k++) {
    const ts = 1_000_000 + k * 50_000;
    ev.push(
      { name: 'RequestAnimationFrame', ph: 'I', ts: ts + 1_200, pid: 1, tid: 10, args: { data: { stackTrace: [{ url: 'https://a.test/anim.js', lineNumber: 3 }] } } },
      { name: 'RunTask', ph: 'X', ts, dur: 2_000, pid: 1, tid: 10 },
      { name: 'FireAnimationFrame', ph: 'X', ts, dur: 1_500, pid: 1, tid: 10, args: { data: {} } },
      { name: 'FunctionCall', ph: 'X', ts: ts + 100, dur: 1_000, pid: 1, tid: 10, args: { data: { url: 'https://a.test/anim.js', functionName: 'frame', lineNumber: 3 } } },
    );
  }
  for (const ts of [1_525_000, 2_525_000]) {
    ev.push({ name: 'RunTask', ph: 'X', ts, dur: 1_000, pid: 1, tid: 10 }, { name: 'TimerFire', ph: 'X', ts, dur: 800, pid: 1, tid: 10, args: { data: { timerId: 5 } } });
  }
  // The iframe: a timer every 250 ms while idle, in its own process.
  for (let k = 0; k < 8; k++) {
    const ts = 1_000_000 + k * 250_000;
    ev.push({ name: 'RunTask', ph: 'X', ts, dur: 500, pid: 2, tid: 20 }, { name: 'TimerFire', ph: 'X', ts, dur: 400, pid: 2, tid: 20, args: { data: { timerId: 5 } } });
  }
  return ev;
}

const windows = { navStart: 0, loadEnd: 1_000_000, idleStart: 1_000_000, idleEnd: 3_000_000 };

describe('analyseTrace', () => {
  const a = analyseTrace(syntheticTrace(), windows, (id) => (id === 7 ? '1,HTML,1,BODY,0,DIV' : undefined))!;

  it('picks the busiest renderer main thread as the page', () => {
    expect(mainThreadOf(syntheticTrace())).toEqual({ pid: 1, tid: 10 });
  });

  it('names the script in a long task during load', () => {
    expect(a.load.longTasks).toEqual([{ startMs: 100, durationMs: 80, urls: ['https://a.test/app.js'] }]);
    expect(a.load.scripts[0]).toMatchObject({ url: 'https://a.test/app.js', ms: 75 });
  });

  it('counts animation frames while idle, with where they were requested', () => {
    expect(a.idle!.animationFrames).toMatchObject({ fired: 40, perSecond: 20, sources: [{ url: 'https://a.test/anim.js', line: 3, count: 40 }] });
  });

  it('credits a callback with no URL to the script call inside it', () => {
    expect(a.idle!.scripts.find((s) => s.url === 'https://a.test/anim.js')).toMatchObject({ calls: 40, topFunction: { name: 'frame', line: 3 } });
    expect(a.idle!.unattributedScriptMs).toBe(1.6); // the two timer callbacks, which call nothing with a URL
  });

  it('names a timer by where it was installed, in the page’s own process', () => {
    expect(a.idle!.timers.sources).toEqual([{ url: 'https://a.test/tick.js', line: 4, timeoutMs: 1000, singleShot: false, count: 2 }]);
  });

  it('keeps animations running in the window, with their element, and drops ended ones', () => {
    expect(a.idle!.animations).toEqual([{ name: 'spin', path: '1,HTML,1,BODY,0,DIV', nodeName: 'DIV' }]);
  });

  it('leaves out the browser’s own favicon request', () => {
    expect(a.idle!.requests).toEqual([{ url: 'https://a.test/poll', resourceType: 'Fetch' }]);
  });

  it('summarises a cross-site iframe on its own, by its URL', () => {
    expect(a.frames).toHaveLength(1);
    expect(a.frames[0]).toMatchObject({ url: 'https://widget.test/frame', idle: { timers: { fired: 8, sources: [{ url: 'https://widget.test/w.js', timeoutMs: 250, count: 8 }] } } });
    expect(a.otherRenderersMs).toBe(4);
  });

  it('returns nothing without a renderer main thread', () => {
    expect(analyseTrace([{ name: 'RunTask', ph: 'X', ts: 0, dur: 1, pid: 1, tid: 1 }], windows)).toBeUndefined();
  });
});

describe('finding a Chromium', () => {
  it('falls back to the newest Chromium Playwright has installed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-'));
    for (const [build, sub] of [['1100', 'chrome-linux'], ['1194', 'chrome-linux'], ['1200', 'chrome-mac']] as const) {
      mkdirSync(join(dir, `chromium-${build}`, sub), { recursive: true });
      if (sub === 'chrome-linux') writeFileSync(join(dir, `chromium-${build}`, sub, 'chrome'), '');
    }
    mkdirSync(join(dir, 'chromium_headless_shell-1300', 'chrome-linux'), { recursive: true });
    expect(installedPlaywrightChromiums(dir)).toEqual([join(dir, 'chromium-1194', 'chrome-linux', 'chrome'), join(dir, 'chromium-1100', 'chrome-linux', 'chrome')]);
    expect(installedPlaywrightChromiums(join(dir, 'missing'))).toEqual([]);
  });
});

/** The fixture site, recorded in Chromium (synthetic content; see the file's note). */
const fixture = (): BenchmarkResult => {
  const r = JSON.parse(readFileSync('tests/fixtures/fixture-site-result.json', 'utf8')) as BenchmarkResult;
  r.families = buildFamilies(r.scenarios);
  return r;
};
/** Six fixture pages traced in Chromium 141 by `traceChromium` (real traces of the synthetic site). */
const fixtureTraces = (): TraceRecord[] => JSON.parse(readFileSync('tests/fixtures/fixture-site-traces.json', 'utf8')) as TraceRecord[];

describe('choosing pages to trace', () => {
  const r = fixture();
  it('takes the requested URLs in order in measure mode', () => {
    const urls = r.scenarios.map((s) => s.step);
    expect(pickTraceUrls(r.scenarios, [urls[3]!, urls[1]!], 'measure', 3)).toEqual([urls[3], urls[1]]);
  });
  it('takes one page per family first in a crawl, then the heaviest', () => {
    const picked = pickTraceUrls(r.scenarios, [], 'crawl', 4, r.families);
    const reps = r.families!.families.map((f) => f.representative);
    expect(picked).toHaveLength(4);
    expect(picked.slice(0, Math.min(4, reps.length))).toEqual(reps.slice(0, 4));
    expect(new Set(picked).size).toBe(4);
  });
});

describe('trace findings in the component graph', () => {
  const r = fixture();
  r.traces = fixtureTraces();
  const g = buildGraph(r)!;
  const page = (path: string) => g.pages.find((p) => new URL(p.url).pathname === path)!;
  const on = (path: string, kind: string) => g.findings.filter((f) => f.page === page(path).id && f.kind === `trace:${kind}`);
  const sig = (g2: ComponentGraph, id: string) => g2.types.find((t) => t.id === g2.instances.find((i) => i.id === id)!.type)!.signature;
  const res = (id: string) => g.resources.find((x) => x.id === id)!.key;

  it('validates, records Chromium as a source, and measures no energy', () => {
    expect(validateGraph(g)).toEqual([]);
    expect(g.sources.some((s) => s.id === 'chromium-trace' && s.browser?.startsWith('Chromium'))).toBe(true);
    const trace = g.findings.filter((f) => f.kind.startsWith('trace:'));
    expect(trace.length).toBeGreaterThan(0);
    for (const f of trace) {
      expect(f.evidenceClass).toBe('trace-supported');
      expect(f.energy).toEqual({ status: 'not-measured', measuredWorkloadDeltaMwh: null });
      expect(f.evidence[0]!.source).toBe('chromium-trace');
    }
  });

  it('ties idle CSS animations to the components that run them', () => {
    const [spin] = on('/spinner', 'running-animation');
    expect(spin!.target.type).toBe('instance');
    expect(sig(g, spin!.target.id!)).toBe('component:spinner');
    expect(sig(g, on('/', 'running-animation')[0]!.target.id!)).toBe('component:hero');
  });

  it('ties continuous animation frames and a long task to the scripts behind them', () => {
    const [raf] = on('/articles/d', 'continuous-animation-frames');
    expect(raf!.target.type).toBe('resource');
    expect(res(raf!.target.id!)).toBe('www.site.test/js/chart.js');
    expect(raf!.metric).toMatchObject({ unit: 'per-second', source: 'chromium-trace' });
    expect(raf!.metric!.value).toBeGreaterThan(50);
    const [task] = on('/compute', 'long-task');
    expect(res(task!.target.id!)).toBe('www.site.test/js/compute.js');
    expect(task!.metric!.value).toBeGreaterThan(250);
  });

  it('ties a third-party iframe’s idle work to the component that embeds it', () => {
    const [frame] = on('/embed', 'iframe-idle-work');
    expect(frame!.target.type).toBe('instance');
    expect(sig(g, frame!.target.id!)).toBe('component:widget-embed');
    expect(frame!.evidence[0]!.detail).toMatch(/thirdparty\.test:8082\/widget\.js:1$/);
  });

  it('raises nothing for a timer that does negligible work', () => {
    expect(g.findings.filter((f) => f.page === page('/tiny-work').id && f.kind.startsWith('trace:'))).toEqual([]);
  });

  it('marks a script it cannot place as unattributed, naming the script', () => {
    const r2 = fixture();
    const t = fixtureTraces();
    const compute = t.find((x) => x.url.endsWith('/compute'))!;
    compute.analysis!.load.longTasks[0]!.urls = ['http://cdn.elsewhere.test/lib.js'];
    r2.traces = t;
    const g2 = buildGraph(r2)!;
    const pid = g2.pages.find((p) => p.url.endsWith('/compute'))!.id;
    const [task] = g2.findings.filter((f) => f.page === pid && f.kind === 'trace:long-task');
    expect(task!.target).toEqual({ type: 'unattributed', reason: 'cdn.elsewhere.test/lib.js is not among the resources Firefox recorded for this page.' });
    expect(validateGraph(g2)).toEqual([]);
  });
});

describe('Lighthouse resource evidence (Lighthouse 13, fixture /assets page)', () => {
  const lhr = JSON.parse(readFileSync('tests/fixtures/lhr13-fixture-assets.json', 'utf8'));
  const e = extractEvidence(lhr);

  it('reads unused code, render blocking and the longest chain', () => {
    const r = (audit: string, file: string) => e.resources!.find((x) => x.audit === audit && x.url.endsWith(file));
    expect(r('unused-css-rules', '/css/big.css')).toMatchObject({ unit: 'bytes', kind: 'finding' });
    expect(r('unused-css-rules', '/css/big.css')!.value).toBeGreaterThan(200_000);
    expect(r('unused-javascript', '/js/big.js')!.value).toBeGreaterThan(100_000);
    expect(r('render-blocking-insight', '/css/big.css')).toMatchObject({ unit: 'ms' });
    expect(e.chain).toMatchObject({ audit: 'network-dependency-tree-insight', urls: ['http://www.site.test:8083/assets', 'http://www.site.test:8083/js/big.js'] });
  });

  it('targets only resources Firefox recorded on that page; the rest stay unattributed', () => {
    // The /assets evidence attached to /light, where Firefox recorded site.css but not big.css or big.js.
    const r = fixture();
    const light = r.scenarios.find((s) => s.step.endsWith('/light'))!.step;
    r.lighthouse = { results: [{ requestedUrl: light, evidence: e }] } as unknown as LighthouseSummary;
    const g = buildGraph(r)!;
    const pid = g.pages.find((p) => p.url === light)!.id;
    const lh = g.findings.filter((f) => f.page === pid && f.kind === 'lighthouse:render-blocking-insight');
    const site = lh.find((f) => f.evidence[0]!.ref.endsWith('/css/site.css'))!;
    expect(site.target.type).toBe('resource');
    expect(g.resources.find((x) => x.id === site.target.id)!.key).toBe('www.site.test/css/site.css');
    const big = lh.find((f) => f.evidence[0]!.ref.endsWith('/css/big.css'))!;
    expect(big.target.type).toBe('unattributed');
    expect(big.evidenceClass).toBe('resource-association');
    const chain = g.findings.find((f) => f.page === pid && f.kind === 'lighthouse:network-dependency-tree-insight')!;
    expect(chain.target.type).toBe('page');
    expect(validateGraph(g)).toEqual([]);
  });
});

describe('the trace report section', () => {
  const r = fixture();
  r.traces = [...fixtureTraces(), { url: 'http://www.site.test:8082/nope', browser: 'Chromium 141', categories: [], idleMs: 3000, bytes: 0, events: 0, skipped: 'The page answered HTTP 404.' }];
  const html = tracesSection(r.traces, buildGraph(r));

  it('says what a trace is and is not', () => {
    expect(html).toContain('<h2 id="traces-h">Chromium traces</h2>');
    expect(html).toContain('it is not energy');
    expect(html).toContain('of <code>http://www.site.test:8082</code>');
  });

  it('uses captioned tables with row and column headers', () => {
    expect(html).toContain('<caption>Main-thread work on each traced page</caption>');
    expect(html).toContain('<th scope="row"><code>/articles/d</code></th>');
    expect(html).toContain('<th scope="col">Idle: busy, of 3 s</th>');
  });

  it('names what each observation is tied to, and lists pages it could not analyse', () => {
    expect(html).toContain('Component <code>component:spinner</code>');
    expect(html).toContain('Resource <code>www.site.test/js/chart.js</code>');
    expect(html).toContain('<li><code>/nope</code>: The page answered HTTP 404.</li>');
  });

  it('is empty without traces', () => {
    expect(tracesSection(undefined, undefined)).toBe('');
  });
});

describe('scrolling table regions', () => {
  it('makes each one a named region that takes keyboard focus', () => {
    const out = focusableScrollRegions('<div class="scroll"><table class="x">\n<caption>Pages <span class="note">(3)</span> & "more"</caption></table></div><div class="scroll"><p>no table</p></div>');
    expect(out).toContain('<div class="scroll" role="region" tabindex="0" aria-label="Pages (3) & &quot;more&quot;"><table class="x">\n<caption>');
    expect(out).toContain('<div class="scroll" role="region" tabindex="0" aria-label="Table"><p>no table</p>');
  });
});
