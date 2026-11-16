/**
 * Removing a component from the live DOM, as an experiment's change.
 *
 * `hide` keeps an element in the document and stops rendering it. `remove`
 * detaches the element and its descendants. Neither stops the component's
 * scripts: a timer, an animation-frame loop, a worker or a request started by
 * the component keeps running when its markup is gone, unless its own code
 * checks. So every removal records what it removed and whether script
 * callbacks carried on afterwards, on both sides.
 *
 * The functions passed to page.evaluate are self-contained: Playwright sends
 * their source to the page, so they may not refer to anything outside
 * themselves. The selector is passed as an argument, never interpolated into
 * code, and no code supplied by the user is run.
 */

import type { BrowserContext, Page } from 'playwright';

/** What the removed (or, on the baseline, the matched) subtrees held. */
export interface SubtreeContent {
  elements: number;
  headings: number;
  landmarks: number;
  /** Links, buttons, form controls and other focusable or interactive elements. */
  interactive: number;
  formControls: number;
  images: number;
  media: number;
  iframes: number;
  canvases: number;
  liveRegions: number;
  /** Visible text length, in characters. */
  textChars: number;
}

export interface SubtreeIdentity {
  tag: string;
  id?: string;
  componentId?: string;
  role?: string;
  label?: string;
  /** Elements in the subtree, the root included. */
  nodes: number;
}

export type RemovalRefusal = 'invalid-selector' | 'no-match' | 'too-broad' | 'document-structure';

/** One side's checkpoint: what the selector found, and on the variant what was removed. */
export interface RemovalCheckpoint {
  matched: number;
  /** Outermost matches: the subtrees removed (or, on the baseline, that would be). */
  roots: number;
  /** Matches inside another match, removed with it and not counted again. */
  nested: number;
  /** Subtrees detached. Zero on the baseline, and whenever the removal was refused. */
  removed: number;
  /** Matches right after removal. Zero when it worked. */
  remaining: number;
  /** Why nothing was removed. Nothing is removed unless every check passes. */
  refused?: RemovalRefusal;
  refusedDetail?: string;
  /** Up to ten of the roots, for the report. */
  identities: SubtreeIdentity[];
  content: SubtreeContent;
}

/** After the idle window: did the component come back? */
export interface RemovalProbe {
  /** Elements the selector matches now. */
  matchesNow: number;
  /** Insertions of a matching element seen since the checkpoint. */
  reinsertions: number;
  /** When the first was seen, ms after the checkpoint. */
  firstReinsertionMs?: number;
  /** Removed roots that are back in the document (the same element re-attached). */
  rootsReconnected: number;
}

/** Script callbacks fired since the page loaded, counted in the main frame. */
export interface ActivityCounters {
  available: boolean;
  timeouts: number;
  intervals: number;
  animationFrames: number;
  /** CSS and Web Animations running now. */
  runningAnimations: number;
}

/** Activity between the checkpoint and the end of the idle window, per side and run. */
export interface ActivityWindow {
  ms: number;
  timeouts: number;
  intervals: number;
  animationFrames: number;
  /** Running animations at the checkpoint and after idle. */
  runningAnimations: [number, number];
}

export const DEFAULT_MAX_MATCHES = 24;
export const MAX_MATCHES_LIMIT = 500;

/** Selectors that name the document itself, refused before a page is opened. */
const STRUCTURE = /^(html|:root|head|body|\*)$/i;

/** Top-level parts of a selector list, splitting on commas outside brackets and quotes. */
export function selectorParts(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of selector) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

/**
 * A static check, before any browser starts: a selector that is the document
 * itself. The page check is the one that counts (it compares the matched
 * elements with the document's own), since `:is(body)` or `[lang]` can match
 * them too.
 */
export function namesDocumentStructure(selector: string): boolean {
  return selectorParts(selector).some((p) => STRUCTURE.test(p));
}

/**
 * Runs in the page. Finds the selector's matches, checks them, and on the
 * variant detaches the outermost ones. Every check runs before anything is
 * removed, so a refused removal leaves the page as it was.
 *
 * Live (no `html`): in the loaded page. A watcher for re-inserted matches is
 * installed on both sides, so the sides stay alike.
 *
 * Before load (`html` given): in a document the browser's own HTML parser
 * builds from that markup (DOMParser), which is then serialised back. Both
 * sides are parsed and serialised, so the round trip is the same on both.
 */
export function checkpointInPage(args: { selector: string; apply: boolean; maxMatches: number; html?: string }): RemovalCheckpoint & { html?: string } {
  const { selector, apply, maxMatches } = args;
  const live = args.html === undefined;
  const document = live ? window.document : new DOMParser().parseFromString(args.html!, 'text/html');
  const empty = { elements: 0, headings: 0, landmarks: 0, interactive: 0, formControls: 0, images: 0, media: 0, iframes: 0, canvases: 0, liveRegions: 0, textChars: 0 };
  const refuse = (refused: RemovalRefusal, matched: number, refusedDetail: string): RemovalCheckpoint => ({
    matched, roots: 0, nested: 0, removed: 0, remaining: matched, refused, refusedDetail, identities: [], content: { ...empty },
  });
  let matches: Element[];
  try {
    matches = Array.from(document.querySelectorAll(selector));
  } catch (e) {
    return refuse('invalid-selector', 0, `The browser could not parse the selector: ${(e as Error).message}`);
  }
  if (matches.length === 0) {
    return refuse('no-match', 0, live
      ? 'The selector matches no element on this page.'
      : 'The selector matches nothing in the page’s markup: the element may be created by script after the page loads. A post-load removal (remove) can remove it.');
  }
  const structural = matches.filter((el) => el === document.documentElement || el === document.head || el === document.body);
  if (structural.length) {
    return refuse('document-structure', matches.length, `The selector matches the document's own ${structural.map((el) => `<${el.tagName.toLowerCase()}>`).join(', ')}; removing it would remove the page.`);
  }
  if (matches.length > maxMatches) {
    return refuse('too-broad', matches.length, `The selector matches ${matches.length} elements, more than the limit of ${maxMatches}. Narrow it, or raise max_matches if that many is intended.`);
  }
  const set = new Set(matches);
  const roots = matches.filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
    return true;
  });

  const content = { ...empty };
  const count = (root: Element, sel: string) => (root.matches(sel) ? 1 : 0) + root.querySelectorAll(sel).length;
  const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
  const LANDMARK = 'main, nav, aside, header, footer, form[aria-label], form[aria-labelledby], section[aria-label], section[aria-labelledby], search, [role="main"], [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"], [role="region"], [role="form"]';
  const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="switch"], [role="slider"]';
  const identities: SubtreeIdentity[] = [];
  for (const root of roots) {
    content.elements += 1 + root.querySelectorAll('*').length;
    content.headings += count(root, HEADING);
    content.landmarks += count(root, LANDMARK);
    content.interactive += count(root, INTERACTIVE);
    content.formControls += count(root, 'input:not([type="hidden"]), select, textarea, button');
    content.images += count(root, 'img, svg, picture');
    content.media += count(root, 'video, audio');
    content.iframes += count(root, 'iframe, frame, embed, object');
    content.canvases += count(root, 'canvas');
    content.liveRegions += count(root, '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"], output');
    // innerText needs layout, which a parsed-only document does not have.
    content.textChars += ((live ? (root as HTMLElement).innerText : undefined) ?? root.textContent ?? '').replace(/\s+/g, ' ').trim().length;
    if (identities.length < 10) {
      const label = root.getAttribute('aria-label') ?? undefined;
      identities.push({
        tag: root.tagName.toLowerCase(),
        ...(root.id ? { id: root.id } : {}),
        ...(root.getAttribute('data-component-id') ? { componentId: root.getAttribute('data-component-id')! } : {}),
        ...(root.getAttribute('role') ? { role: root.getAttribute('role')! } : {}),
        ...(label ? { label: label.slice(0, 80) } : {}),
        nodes: 1 + root.querySelectorAll('*').length,
      });
    }
  }

  if (!live) {
    let removed = 0;
    if (apply) {
      for (const root of roots) {
        root.remove();
        removed++;
      }
    }
    const dt = document.doctype;
    const doctype = dt
      ? `<!DOCTYPE ${dt.name}${dt.publicId ? ` PUBLIC "${dt.publicId}"` : ''}${dt.systemId ? `${dt.publicId ? '' : ' SYSTEM'} "${dt.systemId}"` : ''}>`
      : '';
    return {
      matched: matches.length,
      roots: roots.length,
      nested: matches.length - roots.length,
      removed,
      remaining: document.querySelectorAll(selector).length,
      identities,
      content,
      html: doctype + document.documentElement.outerHTML,
    };
  }

  // A watcher for re-inserted matches, on both sides. WeakRefs so that holding
  // a removed subtree never keeps it alive for the garbage collector.
  const started = performance.now();
  const state = { reinsertions: 0, firstMs: undefined as number | undefined, roots: roots.map((r) => new WeakRef(r)), selector };
  try {
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of Array.from(r.addedNodes)) {
          if (!(n instanceof Element)) continue;
          if (n.matches(selector) || n.querySelector(selector)) {
            state.reinsertions++;
            if (state.firstMs === undefined) state.firstMs = Math.round(performance.now() - started);
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  } catch {
    /* no observer: the probe's match count still shows a return */
  }
  Object.defineProperty(window, '__webEnergyRemoval', { value: state, configurable: true, enumerable: false });

  let removed = 0;
  if (apply) {
    for (const root of roots) {
      root.remove();
      removed++;
    }
  }
  return {
    matched: matches.length,
    roots: roots.length,
    nested: matches.length - roots.length,
    removed,
    remaining: document.querySelectorAll(selector).length,
    identities,
    content,
  };
}

/** Runs in the page after the idle window: is the component back? */
export function removalProbeInPage(selector: string): RemovalProbe {
  const state = (window as unknown as { __webEnergyRemoval?: { reinsertions: number; firstMs?: number; roots: WeakRef<Element>[] } }).__webEnergyRemoval;
  let matchesNow = 0;
  try {
    matchesNow = document.querySelectorAll(selector).length;
  } catch {
    matchesNow = 0;
  }
  return {
    matchesNow,
    reinsertions: state?.reinsertions ?? 0,
    ...(state?.firstMs !== undefined ? { firstReinsertionMs: state.firstMs } : {}),
    rootsReconnected: (state?.roots ?? []).filter((r) => r.deref()?.isConnected).length,
  };
}

/**
 * An init script, installed on both sides before the page loads: counts the
 * timer and animation-frame callbacks the page's scripts receive. It wraps
 * the callbacks only; what the page schedules, and when, is unchanged. The
 * same wrapper runs on both sides, so its small cost is in both.
 */
export function activityCountersInit(): void {
  const w = window as unknown as Record<string, unknown> & Window;
  if (w.top !== w || Object.prototype.hasOwnProperty.call(w, '__webEnergyActivity')) return;
  const c = { timeouts: 0, intervals: 0, animationFrames: 0 };
  Object.defineProperty(w, '__webEnergyActivity', { value: c, enumerable: false });
  const st = w.setTimeout;
  const si = w.setInterval;
  const raf = w.requestAnimationFrame;
  const wrap = (fn: unknown, key: 'timeouts' | 'intervals' | 'animationFrames') =>
    typeof fn === 'function'
      ? function (this: unknown, ...a: unknown[]) {
          c[key]++;
          return (fn as (...x: unknown[]) => unknown).apply(this, a);
        }
      : fn;
  w.setTimeout = function (this: unknown, fn: unknown, ...rest: unknown[]) {
    return (st as (...x: unknown[]) => number).call(this, wrap(fn, 'timeouts'), ...rest);
  } as typeof setTimeout;
  w.setInterval = function (this: unknown, fn: unknown, ...rest: unknown[]) {
    return (si as (...x: unknown[]) => number).call(this, wrap(fn, 'intervals'), ...rest);
  } as typeof setInterval;
  if (typeof raf === 'function') {
    w.requestAnimationFrame = function (this: unknown, fn: FrameRequestCallback) {
      return raf.call(this, wrap(fn, 'animationFrames') as FrameRequestCallback);
    };
  }
}

/**
 * An init script for pre-load removal, on both sides: counts matching
 * elements inserted into the document from the start, the parser's own
 * insertions included. On the variant the markup no longer holds them, so any
 * insertion there was made by the page's scripts.
 */
export function preloadWatchInit(selector: string): void {
  const w = window as unknown as Record<string, unknown> & Window;
  if (w.top !== w || Object.prototype.hasOwnProperty.call(w, '__webEnergyRemoval')) return;
  const started = performance.now();
  const state = { reinsertions: 0, firstMs: undefined as number | undefined, roots: [] as WeakRef<Element>[], selector };
  Object.defineProperty(w, '__webEnergyRemoval', { value: state, configurable: true, enumerable: false });
  try {
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of Array.from(r.addedNodes)) {
          if (!(n instanceof Element)) continue;
          let hit = false;
          try {
            hit = n.matches(selector) || !!n.querySelector(selector);
          } catch {
            hit = false;
          }
          if (hit) {
            state.reinsertions++;
            if (state.firstMs === undefined) state.firstMs = Math.round(performance.now() - started);
          }
        }
      }
    }).observe(document, { childList: true, subtree: true });
  } catch {
    /* no observer: the probe's match count still shows the element */
  }
}

/** Runs in the page: the counters, and the animations running now. */
export function readActivityInPage(): ActivityCounters {
  const c = (window as unknown as { __webEnergyActivity?: { timeouts: number; intervals: number; animationFrames: number } }).__webEnergyActivity;
  let running = 0;
  try {
    running = document.getAnimations().filter((a) => a.playState === 'running').length;
  } catch {
    running = 0;
  }
  return { available: !!c, timeouts: c?.timeouts ?? 0, intervals: c?.intervals ?? 0, animationFrames: c?.animationFrames ?? 0, runningAnimations: running };
}

export async function installActivityCounters(context: BrowserContext): Promise<void> {
  await context.addInitScript(activityCountersInit);
}

export async function checkpoint(page: Page, selector: string, apply: boolean, maxMatches: number): Promise<RemovalCheckpoint> {
  return page.evaluate(checkpointInPage, { selector, apply, maxMatches });
}

export async function removalProbe(page: Page, selector: string): Promise<RemovalProbe> {
  return page.evaluate(removalProbeInPage, selector);
}

export async function readActivity(page: Page): Promise<ActivityCounters> {
  return page.evaluate(readActivityInPage).catch(() => ({ available: false, timeouts: 0, intervals: 0, animationFrames: 0, runningAnimations: 0 }));
}

export function activityBetween(a: ActivityCounters, b: ActivityCounters, ms: number): ActivityWindow | undefined {
  if (!a.available || !b.available) return undefined;
  return {
    ms,
    timeouts: Math.max(0, b.timeouts - a.timeouts),
    intervals: Math.max(0, b.intervals - a.intervals),
    animationFrames: Math.max(0, b.animationFrames - a.animationFrames),
    runningAnimations: [a.runningAnimations, b.runningAnimations],
  };
}

/** Elements removed that people use: headings, landmarks, controls, live regions, media. */
export function essentialContent(c: SubtreeContent): string[] {
  const out: string[] = [];
  const add = (n: number, one: string, many: string) => n && out.push(`${n} ${n === 1 ? one : many}`);
  add(c.headings, 'heading', 'headings');
  add(c.landmarks, 'landmark', 'landmarks');
  add(c.interactive, 'interactive control or link', 'interactive controls and links');
  add(c.formControls, 'form control', 'form controls');
  add(c.liveRegions, 'live region', 'live regions');
  add(c.media, 'audio or video element', 'audio and video elements');
  return out;
}

export function describeContent(c: SubtreeContent): string {
  const parts = [
    `${c.elements} element${c.elements === 1 ? '' : 's'}`,
    ...essentialContent(c),
    c.images ? `${c.images} image${c.images === 1 ? '' : 's'}` : '',
    c.iframes ? `${c.iframes} iframe${c.iframes === 1 ? '' : 's'}` : '',
    c.canvases ? `${c.canvases} canvas${c.canvases === 1 ? '' : 'es'}` : '',
    c.textChars ? `${c.textChars} characters of text` : '',
  ].filter(Boolean);
  return parts.join(', ');
}
