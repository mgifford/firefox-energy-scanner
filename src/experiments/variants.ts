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

export type VariantKind = 'reduced-motion' | 'pause-animations' | 'lazy-images' | 'no-autoplay' | 'block' | 'hide';

export const VARIANT_KINDS: VariantKind[] = ['reduced-motion', 'pause-animations', 'lazy-images', 'no-autoplay', 'block', 'hide'];

export interface VariantSpec {
  kind: VariantKind;
  /** CSS selector the change is scoped to (pause-animations, hide). */
  selector?: string;
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
    };
  }, selector);
}

/**
 * Did the variant take effect? From both sides' probes and counts. A variant
 * that changed nothing cannot show a difference, so the experiment says so.
 */
export function variantApplied(
  v: VariantSpec,
  a: { probe?: VariantProbe; counts: VariantCounts },
  b: { probe?: VariantProbe; counts: VariantCounts },
): { ok: boolean; note: string } {
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
  }
}
