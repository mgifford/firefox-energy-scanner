/**
 * Experiment variants: one change applied to a page in the browser, so its
 * effect on client energy can be measured against the page as served.
 *
 * Every variant is applied symmetrically: the baseline side goes through the
 * same interception with an identity change, so the interception itself is
 * never the difference measured. Each variant also has a probe, run after the
 * workload and outside every measured window, that shows it took effect; an
 * experiment whose variant did not apply says so instead of reporting a
 * difference that cannot be one.
 */

import type { BrowserContext, Page, Route } from 'playwright';
import {
  DEFAULT_MAX_MATCHES,
  MAX_MATCHES_LIMIT,
  describeContent,
  installActivityCounters,
  namesDocumentStructure,
  type RemovalCheckpoint,
  type RemovalProbe,
} from './dom-removal.js';

export type VariantKind = 'reduced-motion' | 'pause-animations' | 'lazy-images' | 'no-autoplay' | 'block' | 'hide' | 'remove' | 'remove-before-load';

export const VARIANT_KINDS: VariantKind[] = ['reduced-motion', 'pause-animations', 'lazy-images', 'no-autoplay', 'block', 'hide', 'remove', 'remove-before-load'];

/**
 * Kinds that take an element out of the DOM: after load (remove), or out of
 * the markup before the page is parsed (remove-before-load). They are
 * different experiments, measuring different things, and are never combined.
 */
export const REMOVAL_KINDS: VariantKind[] = ['remove', 'remove-before-load'];
export const isRemoval = (kind: string): boolean => (REMOVAL_KINDS as string[]).includes(kind);

export interface VariantSpec {
  kind: VariantKind;
  /** CSS selector the change is scoped to (pause-animations, hide, remove). */
  selector?: string;
  /** remove: refuse a selector matching more elements than this (default 24). */
  maxMatches?: number;
  /** Hosts whose requests are refused (block); subdomains included. */
  hosts?: string[];
  /** URLs refused (block), compared without query strings. */
  urls?: string[];
  /** lazy-images: the first N images keep loading eagerly (the LCP image is usually among them). */
  keepEager?: number;
}

/** What the interception did on one side. */
export interface VariantCounts {
  documentsRewritten: number;
  changes: number;
  blockedRequests: number;
}

export const emptyCounts = (): VariantCounts => ({ documentsRewritten: 0, changes: 0, blockedRequests: 0 });

/** What the live page showed after the workload. */
export interface VariantProbe {
  matched: number;
  runningAnimations: number;
  hidden: number;
  reducedMotion: boolean;
  lazyImages: number;
  playingVideos: number;
  /** Accessibility structure, compared between the sides. */
  landmarks: number;
  headings: number;
  imagesWithoutAlt: number;
  focusable: number;
  /** Links, buttons and form controls. Absent in results made before it was recorded. */
  interactive?: number;
  formControls?: number;
  liveRegions?: number;
}

export function describeVariant(v: VariantSpec): string {
  switch (v.kind) {
    case 'reduced-motion':
      return 'prefers-reduced-motion: reduce';
    case 'pause-animations':
      return `CSS animations and transitions paused in ${v.selector ?? 'the whole page'}`;
    case 'lazy-images':
      return `loading="lazy" on images without a loading attribute, after the first ${v.keepEager ?? 2}`;
    case 'no-autoplay':
      return 'autoplay removed from videos';
    case 'block':
      return `requests refused to ${[...(v.hosts ?? []), ...(v.urls ?? [])].join(', ')}`;
    case 'hide':
      return `${v.selector} not rendered (display: none)`;
    case 'remove':
      return `${v.selector} removed from the DOM after the page loaded (detached, with its descendants)`;
    case 'remove-before-load':
      return `${v.selector} removed from the page's markup before it is parsed`;
  }
}

/**
 * A selector safe to place in a style element: no way out of the element or
 * the rule. Child combinators (>) are allowed; angle-bracket tags are not.
 */
export function safeSelector(selector: string | undefined): string | undefined {
  if (!selector) return undefined;
  const s = selector.trim();
  if (!s || s.length > 300 || /[<{};]|\/\*|\\/.test(s)) return undefined;
  return s;
}

export function validateVariant(v: VariantSpec): string[] {
  const errors: string[] = [];
  if (!VARIANT_KINDS.includes(v.kind)) errors.push(`Unknown experiment kind "${v.kind}". Use one of: ${VARIANT_KINDS.join(', ')}.`);
  if (v.kind === 'hide' && !v.selector) errors.push('A hide experiment needs a selector.');
  if (isRemoval(v.kind) && !v.selector) errors.push(`A ${v.kind} experiment needs a selector.`);
  if (isRemoval(v.kind) && v.selector && namesDocumentStructure(v.selector)) {
    errors.push(`The selector "${v.selector}" names the document itself (html, head, body or *): removing it would remove the page.`);
  }
  if (v.maxMatches !== undefined && (!Number.isInteger(v.maxMatches) || v.maxMatches < 1 || v.maxMatches > MAX_MATCHES_LIMIT)) {
    errors.push(`max_matches must be a whole number from 1 to ${MAX_MATCHES_LIMIT}.`);
  }
  if (v.selector !== undefined && !safeSelector(v.selector)) errors.push(`The selector "${v.selector}" cannot be used: it must not contain < { } ; \\ or /*.`);
  if (v.kind === 'block' && !(v.hosts?.length || v.urls?.length)) errors.push('A block experiment needs at least one host or URL.');
  if (v.keepEager !== undefined && (!Number.isInteger(v.keepEager) || v.keepEager < 0)) errors.push('keepEager must be a whole number, 0 or more.');
  return errors;
}

const STYLE_ATTR = 'data-web-energy-experiment';

function injectStyle(html: string, css: string): string {
  const style = `<style ${STYLE_ATTR}>${css}</style>`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + style + html.slice(head.index + head[0].length);
  const htmlTag = /<html(\s[^>]*)?>/i.exec(html);
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + style + html.slice(htmlTag.index + htmlTag[0].length);
  return style + html;
}

/**
 * The document as the variant serves it, and how many changes were made.
 * Pure, so it is tested directly. With `apply` false it returns the document
 * unchanged: the baseline side of the same interception.
 */
export function rewriteHtml(html: string, v: VariantSpec, apply: boolean): { html: string; changes: number } {
  if (!apply) return { html, changes: 0 };
  switch (v.kind) {
    case 'lazy-images': {
      const keep = v.keepEager ?? 2;
      let seen = 0;
      let changes = 0;
      const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
        seen++;
        if (seen <= keep || /\sloading\s*=/i.test(tag)) return tag;
        changes++;
        return tag.replace(/^<img\b/i, '<img loading="lazy"');
      });
      return { html: out, changes };
    }
    case 'no-autoplay': {
      let changes = 0;
      const out = html.replace(/<video\b[^>]*>/gi, (tag) =>
        tag.replace(/\sautoplay(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?(?=[\s>/])/gi, () => {
          changes++;
          return '';
        }),
      );
      return { html: out, changes };
    }
    case 'pause-animations': {
      const sel = safeSelector(v.selector);
      const scope = sel ? `${sel}, ${sel} *, ${sel}::before, ${sel}::after, ${sel} *::before, ${sel} *::after` : '*, *::before, *::after';
      return { html: injectStyle(html, `${scope} { animation-play-state: paused !important; transition: none !important; }`), changes: 1 };
    }
    case 'hide': {
      const sel = safeSelector(v.selector);
      return sel ? { html: injectStyle(html, `${sel} { display: none !important; }`), changes: 1 } : { html, changes: 0 };
    }
    default:
      return { html, changes: 0 };
  }
}

const REWRITES: VariantKind[] = ['lazy-images', 'no-autoplay', 'pause-animations', 'hide'];

function blocked(url: string, v: VariantSpec): boolean {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = url.replace(/[?#].*$/, '');
  return (
    (v.hosts ?? []).some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`)) ||
    (v.urls ?? []).some((u) => u.replace(/[?#].*$/, '') === bare)
  );
}

/**
 * Install the variant on a browser context, for one side. Both sides get the
 * same interception; only `apply` differs. Other route handlers (the network
 * guard) still run, through fallback.
 */
export async function installVariant(context: BrowserContext, page: Page, v: VariantSpec, apply: boolean, counts: VariantCounts): Promise<void> {
  if (v.kind === 'reduced-motion') {
    await page.emulateMedia({ reducedMotion: apply ? 'reduce' : 'no-preference' });
    return;
  }
  if (isRemoval(v.kind)) {
    // The removal itself happens at the checkpoint after the load step
    // (remove), or in the snapshot the experiment prepares (remove-before-load).
    // Here, on both sides alike, only the callback counters that show whether
    // script work carried on.
    await installActivityCounters(context);
    return;
  }
  if (REWRITES.includes(v.kind)) {
    await context.route('**/*', async (route: Route) => {
      const req = route.request();
      if (req.resourceType() !== 'document' || req.frame() !== page.mainFrame()) return route.fallback();
      try {
        const res = await route.fetch();
        const type = res.headers()['content-type'] ?? '';
        if (!/html/i.test(type)) return route.fulfill({ response: res });
        const { html, changes } = rewriteHtml(await res.text(), v, apply);
        counts.documentsRewritten++;
        counts.changes += changes;
        const headers = Object.fromEntries(Object.entries(res.headers()).filter(([k]) => !/^(content-length|content-encoding)$/i.test(k)));
        return route.fulfill({ response: res, body: html, headers });
      } catch {
        return route.fallback();
      }
    });
    return;
  }
  if (v.kind === 'block') {
    await context.route('**/*', async (route: Route) => {
      if (apply && blocked(route.request().url(), v)) {
        counts.blockedRequests++;
        return route.abort('blockedbyclient');
      }
      return route.fallback();
    });
  }
}

/** Read what the page shows after the workload: the variant's effect and the accessibility structure. */
export async function probeVariant(page: Page, v: VariantSpec): Promise<VariantProbe> {
  const selector = safeSelector(v.selector) ?? null;
  return page.evaluate((sel) => {
    let scope: Element[] = [];
    try {
      scope = sel ? Array.from(document.querySelectorAll(sel)) : [];
    } catch {
      scope = [];
    }
    let animations: Animation[] = [];
    try {
      animations = document.getAnimations();
    } catch {
      /* none */
    }
    const target = (a: Animation) => {
      const t = (a.effect as KeyframeEffect | null)?.target;
      return t instanceof Element ? t : null;
    };
    const inScope = sel ? animations.filter((a) => scope.some((el) => { const t = target(a); return !!t && el.contains(t); })) : animations;
    return {
      matched: scope.length,
      runningAnimations: inScope.filter((a) => a.playState === 'running').length,
      hidden: scope.filter((el) => getComputedStyle(el).display === 'none').length,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      lazyImages: document.querySelectorAll('img[loading="lazy"]').length,
      playingVideos: Array.from(document.querySelectorAll('video')).filter((x) => !x.paused && !x.ended).length,
      landmarks: document.querySelectorAll('main, nav, aside, [role="main"], [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"], body > header, body > footer').length,
      headings: document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]').length,
      imagesWithoutAlt: document.querySelectorAll('img:not([alt])').length,
      focusable: document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])').length,
      interactive: document.querySelectorAll('a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="switch"], [role="slider"]').length,
      formControls: document.querySelectorAll('input:not([type="hidden"]), select, textarea, button').length,
      liveRegions: document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"], output').length,
    };
  }, selector);
}

/**
 * Did the variant take effect? From both sides' probes and counts. A variant
 * that changed nothing cannot show a difference, so the experiment says so.
 */
export interface AppliedSide {
  probe?: VariantProbe;
  counts: VariantCounts;
  /** Removal kinds: each run's checkpoint and the probe after its idle window. */
  removals?: RemovalCheckpoint[];
  removalProbes?: RemovalProbe[];
}

export function variantApplied(v: VariantSpec, a: AppliedSide, b: AppliedSide): { ok: boolean; note: string } {
  if (isRemoval(v.kind)) return removalApplied(v, a, b);
  const pa = a.probe;
  const pb = b.probe;
  if (!pa || !pb) return { ok: false, note: 'The page could not be probed, so whether the change applied is unknown.' };
  // Counts add up over every run; per load is what a reader needs.
  const perLoad = Math.round(b.counts.changes / Math.max(1, b.counts.documentsRewritten));
  switch (v.kind) {
    case 'reduced-motion': {
      if (!pb.reducedMotion || pa.reducedMotion) return { ok: false, note: 'The reduced-motion preference did not take effect.' };
      const reacted = pa.runningAnimations - pb.runningAnimations;
      return {
        ok: true,
        note:
          reacted > 0
            ? `Reduced motion on: the page stopped ${reacted} of ${pa.runningAnimations} running animations.`
            : `Reduced motion on, but the page ran ${pb.runningAnimations} animations either way: it does not respond to prefers-reduced-motion with CSS animations.`,
      };
    }
    case 'pause-animations':
      if (v.selector && pb.matched === 0) return { ok: false, note: `No element matches ${v.selector}.` };
      if (pa.runningAnimations === 0) return { ok: false, note: 'No CSS animation was running on the baseline side, so there was nothing to pause.' };
      if (pb.runningAnimations > 0) {
        return { ok: false, note: `${pb.runningAnimations} animations still ran: they are not CSS animations (script-driven animation is not paused by this experiment).` };
      }
      return { ok: true, note: `Paused ${pa.runningAnimations} running animation${pa.runningAnimations === 1 ? '' : 's'}.` };
    case 'lazy-images':
      return b.counts.changes > 0
        ? { ok: true, note: `${perLoad} image${perLoad === 1 ? '' : 's'} given loading="lazy" per page load.` }
        : { ok: false, note: 'No image without a loading attribute was found after the eager ones.' };
    case 'no-autoplay':
      return b.counts.changes > 0
        ? { ok: true, note: `autoplay removed from ${perLoad} video${perLoad === 1 ? '' : 's'} per page load; ${pa.playingVideos} → ${pb.playingVideos} playing after load.` }
        : { ok: false, note: 'No video with autoplay was found.' };
    case 'block':
      return b.counts.blockedRequests > 0
        ? { ok: true, note: `${b.counts.blockedRequests} request${b.counts.blockedRequests === 1 ? '' : 's'} refused, over all runs.` }
        : { ok: false, note: 'No request matched the hosts or URLs to refuse.' };
    case 'hide':
      if (pa.matched === 0) return { ok: false, note: `No element matches ${v.selector}.` };
      return pb.hidden >= pb.matched && pb.matched > 0
        ? { ok: true, note: `${pb.matched} element${pb.matched === 1 ? '' : 's'} not rendered.` }
        : { ok: false, note: 'The elements were still rendered.' };
    case 'remove':
    case 'remove-before-load':
      return removalApplied(v, a, b);
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Did the removal take, and hold? Every variant run must have removed the
 * matches at its checkpoint, left none behind, and seen none come back
 * through the settle and idle windows. A refused removal, or a component
 * the page put back, is an experiment that did not happen: no difference is
 * reported from it, and it is never read as "no saving".
 */
export function removalApplied(v: VariantSpec, a: AppliedSide, b: AppliedSide): { ok: boolean; note: string } {
  const cb = b.removals ?? [];
  const ca = a.removals ?? [];
  // A refusal first: the experiment stops at the first refused checkpoint, on either side.
  const refused = cb.find((c) => c.refused) ?? ca.find((c) => c.refused);
  if (refused) return { ok: false, note: `Removal refused, nothing was removed: ${refused.refusedDetail ?? refused.refused}` };
  if (!cb.length || !ca.length) return { ok: false, note: 'No checkpoint was reached on one side, so whether the element was removed is unknown.' };
  if (cb.some((c) => c.removed === 0)) return { ok: false, note: `In ${plural(cb.filter((c) => c.removed === 0).length, 'variant run')}, nothing was removed.` };
  const left = cb.find((c) => c.remaining > 0);
  if (left) return { ok: false, note: `${plural(left.remaining, 'element')} still matched ${v.selector} right after removal.` };
  const probes = b.removalProbes ?? [];
  if (probes.length < cb.length) return { ok: false, note: 'The page could not be checked after the idle window, so whether the element stayed removed is unknown.' };
  const back = probes.filter((p) => p.matchesNow > 0 || p.reinsertions > 0 || p.rootsReconnected > 0);
  if (back.length) {
    const first = back.find((p) => p.firstReinsertionMs !== undefined)?.firstReinsertionMs;
    return {
      ok: false,
      note:
        v.kind === 'remove-before-load'
          ? `The page's scripts created the component themselves in ${plural(back.length, 'variant run')} of ${probes.length}` +
            `${first !== undefined ? `, ${first} ms after the document started` : ''}: removing it from the markup did not keep it out of the page.`
          : `The page put the component back in ${plural(back.length, 'variant run')} of ${probes.length}` +
            `${first !== undefined ? `, the first time ${first} ms after it was removed` : ''}: the intervention did not hold, so the idle window did not measure the page without it.`,
    };
  }
  const roots = cb[0]!.roots;
  const nested = cb[0]!.nested;
  const differs = ca.some((c) => c.matched !== cb[0]!.matched);
  return {
    ok: true,
    note:
      `Removed ${plural(roots, 'subtree')} (${describeContent(cb[0]!.content)})` +
      `${nested ? `; ${plural(nested, 'further match', 'further matches')} sat inside them and went with them, counted once` : ''}` +
      (v.kind === 'remove-before-load'
        ? ` from the markup before parsing, in each of ${plural(cb.length, 'variant run')}; the page did not create it during load or idle.`
        : ` in each of ${plural(cb.length, 'variant run')}; none came back during the settle and idle windows.`) +
      (differs ? ` The selector matched ${ca.map((c) => c.matched).join('/')} on the baseline and ${cb.map((c) => c.matched).join('/')} on the variant at the checkpoint: the pages were not in the same state.` : ''),
  };
}

export { DEFAULT_MAX_MATCHES };
