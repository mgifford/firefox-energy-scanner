/**
 * Chromium performance traces for a few pages, on request.
 *
 * Optional and budgeted: tracing every page would cost more than the scan it
 * serves. It runs after the Firefox session has closed, never inside an
 * energy window, in Chromium (the browser whose trace format exposes script
 * URLs, layout roots and paint nodes), through the network guard when the
 * scan is public-only.
 *
 * Each page is traced over its load and then an idle window, bounded by
 * performance marks. Backend node ids in the trace are resolved, while the
 * page is still open, to the DevTools node paths the Firefox records use, so
 * trace evidence can be tied to the same component instances.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { Browser, CDPSession, Page } from 'playwright';
import { analyseTrace, type TraceAnalysis, type TraceEvent } from './analyse.js';
import { BLOCKED_HEADER, BLOCKED_HEADER_VALUE, chromeGuardFlags, startNetworkGuard, type NetworkGuard } from '../collect/network-guard.js';

/** The devtools.timeline set: enough for script, style, layout, paint, timers, frames and requests, without compositor internals. */
export const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.stack',
  'v8.execute',
  'blink.user_timing',
  'loading',
  'toplevel',
];

export interface TraceOptions {
  urls: string[];
  /** Idle window after load, ms. */
  idleMs: number;
  viewport: { width: number; height: number };
  /** Traces larger than this are not analysed (and say so). */
  maxBytes: number;
  publicOnly?: boolean;
  /** Write each raw trace here, gzipped, for DevTools' Performance panel. */
  keepDir?: string;
  onProgress?: (m: string) => void;
}

export interface TraceRecord {
  url: string;
  browser: string;
  categories: string[];
  idleMs: number;
  bytes: number;
  events: number;
  /** Present unless the trace failed or was over budget. */
  analysis?: TraceAnalysis;
  /** Why there is no analysis. */
  skipped?: string;
  /** Where the raw trace was written, when kept. */
  file?: string;
}

const COMMON_CHROME = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
];

/** Where Playwright keeps its browsers: PLAYWRIGHT_BROWSERS_PATH, else its per-platform cache. */
function playwrightBrowsersDir(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright');
  return join(homedir(), '.cache', 'ms-playwright');
}

const PLAYWRIGHT_EXECUTABLES = [
  ['chrome-linux64', 'chrome'],
  ['chrome-linux', 'chrome'],
  ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ['chrome-win64', 'chrome.exe'],
  ['chrome-win', 'chrome.exe'],
];

/**
 * Chromium builds Playwright has installed, newest first. Used when the build
 * this Playwright expects is missing but another is there, as after upgrading
 * Playwright without reinstalling its browsers. Trace event names are stable
 * across builds, so a slightly older Chromium traces as well.
 */
export function installedPlaywrightChromiums(dir = playwrightBrowsersDir()): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => /^chromium-(\d+)$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .flatMap((m) => PLAYWRIGHT_EXECUTABLES.map((parts) => join(dir, m[0], ...parts)))
    .filter((p) => existsSync(p));
}

/** A Chromium to trace with: CHROME_PATH, Playwright's own, another Playwright build, then an installed Chrome. */
export async function findChromium(): Promise<string | undefined> {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  try {
    const { chromium } = await import('playwright');
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* none */
  }
  return installedPlaywrightChromiums()[0] ?? COMMON_CHROME.find((p) => existsSync(p));
}

/** Lighthouse's node path, computed on an element handed in by CDP. */
const NODE_PATH = `function () {
  const isShadow = (n) => n.nodeType === 11;
  const parentOf = (n) => (isShadow(n) ? n.host : n.parentNode);
  const index = (n) => {
    if (isShadow(n)) return 'a';
    let i = 0; let p = n;
    while ((p = p.previousSibling)) { if (p.nodeType === 3 && (p.nodeValue || '').trim().length === 0) continue; i++; }
    return i;
  };
  const path = []; let cur = this;
  while (cur && parentOf(cur)) { path.push(index(cur) + ',' + cur.nodeName); cur = parentOf(cur); }
  return path.reverse().join(',');
}`;

/** Every backend node id the analysis may want to name. */
function nodeIdsIn(events: TraceEvent[]): number[] {
  const ids = new Set<number>();
  for (const e of events) {
    const d = (e.args?.['data'] ?? {}) as Record<string, unknown>;
    if (typeof d['nodeId'] === 'number' && (e.name === 'Paint' || e.name === 'Animation' || e.name === 'InvalidateLayout')) ids.add(d['nodeId']);
    for (const r of ((e.args?.['endData'] as { layoutRoots?: { nodeId?: number }[] } | undefined)?.layoutRoots ?? [])) if (typeof r.nodeId === 'number') ids.add(r.nodeId);
  }
  return [...ids].slice(0, 500);
}

/** Resolve backend node ids to node paths while the page is open. Nodes since removed stay unresolved. */
async function resolvePaths(cdp: CDPSession, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  try {
    await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = (await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: ids })) as { nodeIds: number[] };
    for (const [i, nodeId] of nodeIds.entries()) {
      if (!nodeId) continue;
      try {
        const { object } = (await cdp.send('DOM.resolveNode', { nodeId })) as { object: { objectId?: string } };
        if (!object.objectId) continue;
        const r = (await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: NODE_PATH, returnByValue: true })) as { result: { value?: unknown } };
        if (typeof r.result.value === 'string' && r.result.value) out.set(ids[i]!, r.result.value);
      } catch {
        /* the node is gone */
      }
    }
  } catch {
    /* DOM domain unavailable */
  }
  return out;
}

const GUARD_REFUSED = 'The network guard refused it: the address is private or local.';

const markTs = (events: TraceEvent[], name: string) => events.find((e) => e.name === name && (e.cat ?? '').includes('blink.user_timing'))?.ts;

async function traceOne(browser: Browser, url: string, options: TraceOptions, version: string, n: number): Promise<TraceRecord> {
  const base: Omit<TraceRecord, 'bytes' | 'events'> = { url, browser: version, categories: TRACE_CATEGORIES, idleMs: options.idleMs };
  const context = await browser.newContext({ viewport: options.viewport });
  const page: Page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    await browser.startTracing(page, { categories: TRACE_CATEGORIES });
    // A refused or failed page is not traced: its error page would be analysed as if it were the page.
    let refused: string | undefined;
    try {
      const res = await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
      if (res?.headers()[BLOCKED_HEADER] === BLOCKED_HEADER_VALUE) refused = GUARD_REFUSED;
      else if (res && res.status() >= 400) refused = `The page answered HTTP ${res.status()}.`;
    } catch (err) {
      refused = options.publicOnly && /ERR_TUNNEL_CONNECTION_FAILED/.test((err as Error).message) ? GUARD_REFUSED : 'The page did not finish loading.';
    }
    if (refused) {
      await browser.stopTracing().catch(() => {});
      return { ...base, bytes: 0, events: 0, skipped: refused };
    }
    await page.evaluate(() => performance.mark('web-energy:idle-start')).catch(() => {});
    await page.waitForTimeout(options.idleMs);
    await page.evaluate(() => performance.mark('web-energy:idle-end')).catch(() => {});
    const buf = await browser.stopTracing();
    let file: string | undefined;
    if (options.keepDir) {
      await mkdir(options.keepDir, { recursive: true });
      file = join(options.keepDir, `trace-${n + 1}.json.gz`);
      await writeFile(file, gzipSync(buf));
    }
    if (buf.length > options.maxBytes) {
      return { ...base, bytes: buf.length, events: 0, skipped: `The trace was ${Math.round(buf.length / 1e6)} MB, over the ${Math.round(options.maxBytes / 1e6)} MB budget.`, ...(file ? { file } : {}) };
    }
    const parsed = JSON.parse(buf.toString('utf8')) as { traceEvents?: TraceEvent[] } | TraceEvent[];
    const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
    const nav = events.find((e) => e.name === 'ResourceSendRequest' && ((e.args?.['data'] ?? {}) as Record<string, unknown>)['resourceType'] === 'Document')?.ts;
    const idleStart = markTs(events, 'web-energy:idle-start');
    const idleEnd = markTs(events, 'web-energy:idle-end');
    if (nav === undefined || idleStart === undefined || idleEnd === undefined) {
      return { ...base, bytes: buf.length, events: events.length, skipped: 'The trace has no navigation or idle marks to bound its windows.', ...(file ? { file } : {}) };
    }
    const paths = await resolvePaths(cdp, nodeIdsIn(events));
    const analysis = analyseTrace(events, { navStart: nav, loadEnd: idleStart, idleStart, idleEnd }, (id) => paths.get(id));
    return { ...base, bytes: buf.length, events: events.length, ...(analysis ? { analysis } : { skipped: 'No renderer main thread was found in the trace.' }), ...(file ? { file } : {}) };
  } catch (err) {
    return { ...base, bytes: 0, events: 0, skipped: `Tracing failed: ${(err as Error).message.split('\n')[0]}` };
  } finally {
    await context.close().catch(() => {});
  }
}

/** Trace each URL in turn, in one Chromium. */
export async function traceChromium(options: TraceOptions): Promise<{ records: TraceRecord[]; browser?: string; error?: string }> {
  const executablePath = await findChromium();
  if (!executablePath) {
    return { records: [], error: 'No Chromium or Chrome was found for tracing. Install Google Chrome, set CHROME_PATH, or run `npx playwright install chromium`.' };
  }
  let guard: NetworkGuard | undefined;
  let browser: Browser | undefined;
  try {
    if (options.publicOnly) guard = await startNetworkGuard();
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ executablePath, headless: true, args: guard ? chromeGuardFlags(guard.url) : [] });
    const version = `Chromium ${browser.version()}`;
    const records: TraceRecord[] = [];
    for (const [n, url] of options.urls.entries()) {
      options.onProgress?.(`Tracing ${n + 1}/${options.urls.length} in Chromium: ${url}`);
      records.push(await traceOne(browser, url, options, version, n));
    }
    return { records, browser: version };
  } catch (err) {
    return { records: [], error: `Tracing failed: ${(err as Error).message.split('\n')[0]}` };
  } finally {
    await browser?.close().catch(() => {});
    await guard?.close().catch(() => {});
  }
}
